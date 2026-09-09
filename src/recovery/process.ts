import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { RecoveryClientConfig, RecoveryMutation, RecoveryObservation, RecoveryState } from './protocol.ts';
import type { JsonObject } from '../types.ts';

export class RecoveryProcess {
  #child: ChildProcessWithoutNullStreams;
  #sequence = 0;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; onEvent?: (event: string, data: unknown) => void }>();
  #exited: Promise<{ code: number | null; signal: string | null }>;
  #stderr = '';
  #pid: number;
  #killIssued = false;
  diagnostics: JsonObject = {};
  get pid() { return this.#pid; }
  constructor(runtime: 'bun' | 'node' = 'bun') {
    this.#child = spawn(runtime === 'node' ? 'node' : process.execPath, [...(runtime === 'node' ? ['--experimental-strip-types'] : []), fileURLToPath(new URL('./worker.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, BENCH_RECOVERY_PARENT_PID: String(process.pid) } });
    // Keep the original process identity and never signal special PID values.
    this.#pid = this.#child.pid ?? 0;
    this.#child.stderr.on('data', chunk => { this.#stderr = (this.#stderr + chunk.toString()).slice(-4000); });
    this.#child.stdin.on('error', error => this.#fail(error));
    this.#exited = new Promise(resolve => {
      this.#child.on('error', error => { this.#fail(error); resolve({ code: null, signal: null }); });
      this.#child.on('close', (code, signal) => { this.#fail(new Error(`Recovery worker exited ${code}/${signal}: ${this.#stderr}`)); resolve({ code, signal }); });
    });
    const lines = createInterface({ input: this.#child.stdout });
    lines.on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { return; } // Product diagnostics may use stdout.
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      if (response.event) { pending.onEvent?.(response.event, response.data); return; }
      this.#pending.delete(response.id);
      response.error ? pending.reject(Object.assign(new Error(response.error), response.evidence ? { evidence: response.evidence } : {})) : pending.resolve(response.value);
    });
  }
  #fail(error: Error) { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); }
  async open(config: RecoveryClientConfig): Promise<void> {
    const result = await this.call<{ pid: number; diagnostics: JsonObject }>('init', config);
    if (result.pid !== this.pid) throw new Error('Recovery worker process identity mismatch');
    this.diagnostics = result.diagnostics;
  }
  call<T = null>(method: string, params: unknown = null, onEvent?: (event: string, data: unknown) => void): Promise<T> {
    if (this.#killIssued || this.#child.exitCode !== null || this.#child.signalCode !== null) return Promise.reject(new Error(`Recovery ${method} requested after worker exit`));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Recovery ${method} timed out`)); void this.kill(); }, 120_000);
      this.#pending.set(id, { onEvent, resolve: value => { clearTimeout(timer); resolve(value as T); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  read() { return this.call<RecoveryState>('read'); }
  write(mutations: RecoveryMutation[]) { return this.call<null>('write', mutations); }
  remove(id: string) { return this.call('remove', { id }); }
  sync() { return this.call<{ pending: number }>('sync'); }
  observe(mutations: RecoveryObservation[]) { return this.call('observe', mutations); }
  async kill() {
    if (!this.#killIssued && Number.isSafeInteger(this.#pid) && this.#pid > 1) {
      this.#killIssued = true;
      try { process.kill(-this.#pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    return this.#exited;
  }
  async close() {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      try {
        await this.call('close');
        const timeout = setTimeout(() => { void this.kill(); }, 2_000);
        let exit;
        try { exit = await this.#exited; } finally { clearTimeout(timeout); }
        // The driver acknowledged closing its native resources and exited.
        // Signalling that dead group can race OS process teardown (EPERM).
        this.#killIssued = true;
        if (exit.code !== 0) throw new Error(`Recovery worker did not exit cleanly after product close: ${exit.code}/${exit.signal}`);
      } catch (error) { await this.kill(); throw error; }
    }
  }
}
