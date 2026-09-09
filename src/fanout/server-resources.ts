import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { resolveServiceContainerId } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import type { JsonObject, StackId } from '../types.ts';

const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function normalizeDockerStats(raw: any): JsonObject {
  const networks = raw.networks && typeof raw.networks === 'object' ? Object.values(raw.networks) as any[] : [];
  const network = (key: string) => networks.length && networks.every(n => count(n[key]) !== null) ? networks.reduce((sum, n) => sum + n[key], 0) : null;
  return { read: typeof raw.read === 'string' ? raw.read : null, cpuTotalNs: count(raw.cpu_stats?.cpu_usage?.total_usage),
    memoryBytes: count(raw.memory_stats?.usage), memoryLimitBytes: count(raw.memory_stats?.limit), rxBytes: network('rx_bytes'), txBytes: network('tx_bytes') };
}
/** Query Docker from the controller, outside measured client processes. Raw
 * counters and request/receipt bounds make the server window auditable. */
export class ServerResources {
  #socket: string;
  #containers: { label: string; id: string }[];
  #samples: JsonObject[] = [];
  #started = 0;
  #timer?: ReturnType<typeof setInterval>;
  #pending?: Promise<void>;
  constructor(stackId: StackId) {
    const host = process.env.DOCKER_HOST ?? JSON.parse(execFileSync('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim());
    if (!String(host).startsWith('unix://')) throw new Error('Server resource sampler currently requires a local Docker Unix socket');
    this.#socket = String(host).slice(7);
    const stack = getStack(stackId);
    this.#containers = Object.entries(stack.services).filter(([role, name]) => name && role !== 'admin').map(([label]) => ({ label, id: resolveServiceContainerId(stackId, label as keyof typeof stack.services) }));
  }
  identities() {
    const states = JSON.parse(execFileSync('docker', ['inspect', ...this.#containers.map(c => c.id)], { encoding: 'utf8' }));
    return this.#containers.map(container => {
      const state = states.find((item: any) => item.Id === container.id || item.Id.startsWith(container.id))?.State;
      return { ...container, startedAt: state?.StartedAt ?? null, running: state?.Running === true };
    });
  }
  async #sample() {
    const services = await Promise.all(this.#containers.map(async container => {
      const requestedAtMs = performance.now() - this.#started;
      try {
        const raw = await new Promise<any>((resolve, reject) => {
          const req = request({ socketPath: this.#socket, path: `/v1.46/containers/${container.id}/stats?stream=false&one-shot=true` }, response => {
            const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
            response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(`Docker stats HTTP ${response.statusCode}`); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } });
          });
          req.on('error', reject); req.setTimeout(5_000, () => req.destroy(new Error('Docker stats timed out'))); req.end();
        });
        return { ...container, requestedAtMs, receivedAtMs: performance.now() - this.#started, ...normalizeDockerStats(raw) };
      } catch (error) { return { ...container, requestedAtMs, receivedAtMs: performance.now() - this.#started, error: String(error), cpuTotalNs: null, memoryBytes: null, memoryLimitBytes: null, rxBytes: null, txBytes: null }; }
    }));
    this.#samples.push({ services });
  }
  async start() { this.#started = performance.now(); await this.#sample(); this.#timer = setInterval(() => { if (!this.#pending) this.#pending = this.#sample().finally(() => { this.#pending = undefined; }); }, 250); }
  async stop() { this.abort(); await this.#pending; await this.#sample(); return { method: 'docker-engine-stats-v1', intervalMs: 250, containers: this.#containers, samples: this.#samples,
    scope: 'sync, application, database and storage services; admin seeding service excluded',
    window: 'first request/receipt before client clock starts; final request/receipt after client convergence; server counters are not an additive breakdown of client latency',
    memory: 'raw cgroup usage including page cache, not process RSS', missing: 'null counters and error retained; no zero substitution' } as JsonObject; }
  abort() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
}
