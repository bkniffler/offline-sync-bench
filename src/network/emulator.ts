import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const execute = promisify(execFile);
const ownerLabel = 'bench.packet-network.owner';
const hopA = '169.254.254.1', hopB = '169.254.254.2';
export interface PacketImpairment { oneWayDelayMs: number; lossPct: number; seed: number; packetLimit: number }
export interface PacketRoute { port: number; upstreamPort: number; names: string[] }
export interface NetworkCommand { args: string[]; elapsedMs: number; stdout: string; stderr: string; exitCode: number | string | null }
export interface PacketAudit { packets: number; oversized: number }

export function validatePacketImpairment(value: PacketImpairment): void {
  if (!value || Object.keys(value).sort().join(',') !== 'lossPct,oneWayDelayMs,packetLimit,seed'
    || !Number.isFinite(value.oneWayDelayMs) || value.oneWayDelayMs < 0 || value.oneWayDelayMs > 1000
    || !Number.isFinite(value.lossPct) || value.lossPct < 0 || value.lossPct > 100
    || !Number.isSafeInteger(value.seed) || value.seed < 1 || value.seed > 0xffffffff
    || !Number.isSafeInteger(value.packetLimit) || value.packetLimit < 100 || value.packetLimit > 100000) throw new Error('Invalid packet impairment configuration');
}

/** Only explicit host-local TCP routes are supported. Service discovery, redirects,
 * presigned URLs and additional SDK endpoints need a separate coverage check. */
export function packetRoutes(endpoints: Record<string, string>): PacketRoute[] {
  if (!endpoints || !Object.keys(endpoints).length || Object.keys(endpoints).length > 32) throw new Error('Packet network requires 1–32 named endpoints');
  const routes = new Map<number, PacketRoute>();
  for (const [name, value] of Object.entries(endpoints).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) throw new Error('Invalid packet endpoint name');
    const url = new URL(value);
    if (!['http:', 'ws:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Packet network requires credential-free HTTP/WS localhost base URLs');
    const upstreamPort = Number(url.port || 80), route = routes.get(upstreamPort) ?? { port: 19000 + routes.size, upstreamPort, names: [] };
    route.names.push(name); routes.set(upstreamPort, route);
  }
  return [...routes.values()];
}

export function readPacketAudit(text: string): PacketAudit {
  const rules = text.split('\n').filter(line => line.includes('-A NETEM_AUDIT '));
  if (rules.length !== 2 || !rules[0].endsWith('-m length --length 0:65535') || !rules[1].endsWith('-m length --length 1501:65535')) throw new Error('Packet size audit rules missing or changed');
  const counts = rules.map(line => { const match = line.match(/^\[(\d+):\d+\] /); if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('Invalid packet audit counter'); return Number(match[1]); });
  // A >65535-byte skb would miss both length rules. Comparing the jump counters
  // prevents that omission from appearing to prove MTU-sized packets.
  const selected = text.split('\n').filter(line => line.includes('-A FORWARD ') && line.endsWith('-j NETEM_AUDIT')).reduce((sum, line) => {
    const match = line.match(/^\[(\d+):\d+\] /); if (!match) throw new Error('Missing packet audit route counter'); return sum + Number(match[1]);
  }, 0);
  if (selected !== counts[0] || counts[1] > counts[0]) throw new Error('Packet audit does not account for all selected traffic');
  return { packets: counts[0], oversized: counts[1] };
}

/** Two owned forwarding namespaces with a private veth link. Each direction is
 * segmented on the unshaped private hop before the peer's eth0 netem queue.
 * No host namespace, host firewall, shared service or shared mount is modified.
 * The caller owns this object outside any measured child process and must close
 * it even when that child times out or is killed. */
export class PacketNetwork {
  readonly id = randomUUID();
  readonly commands: NetworkCommand[] = [];
  readonly routes: PacketRoute[];
  readonly impairment: Readonly<PacketImpairment>;
  readonly endpoints: Readonly<Record<string, string>>;
  readonly imageId: string;
  readonly urls: Record<string, string> = {};
  readonly cleanup: Record<string, 'removed' | 'absent'> = {};
  #a = ''; #b = ''; #network = ''; #helper = '';
  #state: 'new' | 'starting' | 'running' | 'closed' = 'new';
  #hostIp = '';
  constructor(imageId: string, endpoints: Record<string, string>, impairment: PacketImpairment) {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Packet network requires an immutable local Docker image ID');
    validatePacketImpairment(impairment);
    this.imageId = imageId; this.routes = packetRoutes(endpoints);
    this.impairment = Object.freeze({ ...impairment }); this.endpoints = Object.freeze({ ...endpoints });
  }
  async #docker(args: string[]): Promise<string> {
    const started = performance.now();
    try {
      const result = await execute('docker', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      this.commands.push({ args, elapsedMs: performance.now() - started, stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: 0 });
      return result.stdout.trim();
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string };
      this.commands.push({ args, elapsedMs: performance.now() - started, stdout: failure.stdout?.trim() ?? '', stderr: failure.stderr?.trim() ?? '', exitCode: failure.code ?? null });
      throw error;
    }
  }
  #inside(container: string, args: string[]) { return this.#docker(['exec', container, ...args]); }
  async start(): Promise<void> {
    if (this.#state !== 'new') throw new Error('Packet network can only be started once');
    this.#state = 'starting';
    this.#network = `osb-packets-${this.id}`;
    try {
      await this.#docker(['network', 'create', '--label', `${ownerLabel}=${this.id}`, this.#network]);
      for (const role of ['a', 'b']) {
        const name = `osb-packets-${this.id}-${role}`;
        if (role === 'a') this.#a = name; else this.#b = name;
        await this.#docker(['run', '-d', '--name', name, '--label', `${ownerLabel}=${this.id}`, '--network', this.#network,
          '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW', '--sysctl', 'net.ipv4.ip_forward=1',
          ...(role === 'a' ? this.routes.flatMap(route => ['-p', `127.0.0.1::${route.port}`]) : []), this.imageId]);
      }
      this.#helper = `osb-packets-${this.id}-link`;
      // The helper sees only B's process namespace and A's network namespace.
      // Matching B's two capabilities permits access to its /proc/1/ns/net.
      await this.#docker(['run', '--rm', '--name', this.#helper, '--label', `${ownerLabel}=${this.id}`, '--network', `container:${this.#a}`, '--pid', `container:${this.#b}`,
        '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'NET_RAW', this.imageId, 'ip', 'link', 'add', 'hop0', 'type', 'veth', 'peer', 'name', 'hop0', 'netns', '1']);
      this.cleanup[this.#helper] = 'removed'; this.#helper = '';
      const host = await this.#inside(this.#b, ['getent', 'hosts', 'host.docker.internal']);
      this.#hostIp = host.split(/\s+/).find(value => isIP(value) === 4) ?? '';
      if (!this.#hostIp) throw new Error('Packet network requires a resolved host.docker.internal IPv4 route');
      for (const [container, ip] of [[this.#a, hopA], [this.#b, hopB]]) {
        await this.#inside(container, ['ip', 'address', 'add', `${ip}/30`, 'dev', 'hop0']);
        await this.#inside(container, ['ip', 'link', 'set', 'hop0', 'up']);
        for (const device of ['eth0', 'hop0']) await this.#inside(container, ['ethtool', '-K', device, 'tso', 'off', 'gso', 'off', 'gro', 'off', 'tx-gso-list', 'off', 'tx', 'off']);
        await this.#inside(container, ['tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'handle', '1:', 'prio', 'bands', '3', 'priomap', ...Array<string>(16).fill('0')]);
        await this.#inside(container, ['tc', 'qdisc', 'add', 'dev', 'eth0', 'parent', '1:3', 'handle', '30:', 'netem', 'limit', String(this.impairment.packetLimit), 'delay', `${this.impairment.oneWayDelayMs}ms`, 'loss', 'random', `${this.impairment.lossPct}%`, 'seed', String(this.impairment.seed)]);
        await this.#inside(container, ['iptables', '-t', 'mangle', '-N', 'NETEM_AUDIT']);
        for (const range of ['0:65535', '1501:65535']) await this.#inside(container, ['iptables', '-t', 'mangle', '-A', 'NETEM_AUDIT', '-m', 'length', '--length', range]);
        for (const route of this.routes) {
          const target = container === this.#a ? hopB : this.#hostIp, targetPort = container === this.#a ? route.port : route.upstreamPort;
          await this.#inside(container, ['iptables', '-t', 'nat', '-A', 'PREROUTING', '-p', 'tcp', '--dport', String(route.port), '-j', 'DNAT', '--to-destination', `${target}:${targetPort}`]);
          await this.#inside(container, ['iptables', '-t', 'nat', '-A', 'POSTROUTING', '-p', 'tcp', '-d', target, '--dport', String(targetPort), '-j', 'MASQUERADE']);
          const match = container === this.#a ? ['-s', hopB, '--sport', String(route.port)] : ['-d', this.#hostIp, '--dport', String(route.upstreamPort)];
          await this.#inside(container, ['iptables', '-t', 'mangle', '-A', 'FORWARD', '-p', 'tcp', ...match, '-j', 'NETEM_AUDIT']);
          const filter = container === this.#a ? ['match', 'ip', 'sport', String(route.port), '0xffff'] : ['match', 'ip', 'dst', this.#hostIp, 'match', 'ip', 'dport', String(route.upstreamPort), '0xffff'];
          await this.#inside(container, ['tc', 'filter', 'add', 'dev', 'eth0', 'parent', '1:', 'protocol', 'ip', 'prio', '1', 'u32', 'match', 'ip', 'protocol', '6', '0xff', ...filter, 'flowid', '1:3']);
        }
      }
      for (const route of this.routes) {
        const binding = await this.#docker(['port', this.#a, `${route.port}/tcp`]);
        if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Unexpected packet network published binding');
        for (const name of route.names) { const url = new URL(this.endpoints[name]); url.hostname = '127.0.0.1'; url.port = binding.split(':')[1]; this.urls[name] = url.href.replace(/\/$/, ''); }
      }
      this.#state = 'running';
    } catch (error) {
      try { await this.close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Packet network setup and cleanup failed'); }
      throw error;
    }
  }
  async snapshot() {
    if (this.#state !== 'running') throw new Error('Packet network is not running');
    const containers = [];
    for (const name of [this.#a, this.#b]) {
      const identity = JSON.parse(await this.#docker(['inspect', '--format', '{"id":{{json .Id}},"image":{{json .Image}},"caps":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"sysctls":{{json .HostConfig.Sysctls}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}},"labels":{{json .Config.Labels}}}', name]));
      const audit = await this.#inside(name, ['iptables-save', '-c', '-t', 'mangle']);
      containers.push({ name, identity, audit: readPacketAudit(audit), auditRules: audit,
        qdisc: JSON.parse(await this.#inside(name, ['tc', '-s', '-d', '-j', 'qdisc', 'show', 'dev', 'eth0'])),
        filters: await this.#inside(name, ['tc', '-s', '-d', 'filter', 'show', 'dev', 'eth0']), nat: await this.#inside(name, ['iptables-save', '-t', 'nat']),
        links: JSON.parse(await this.#inside(name, ['ip', '-j', 'link', 'show'])), routes: JSON.parse(await this.#inside(name, ['ip', '-j', 'route', 'show'])),
        eth0Offloads: await this.#inside(name, ['ethtool', '-k', 'eth0']), hopOffloads: await this.#inside(name, ['ethtool', '-k', 'hop0']) });
    }
    return { version: 1, method: 'private-veth-netem-v1', id: this.id, imageId: this.imageId, impairment: this.impairment, endpoints: this.endpoints, urls: { ...this.urls }, hostIp: this.#hostIp, routes: this.routes, containers,
      kernel: await this.#inside(this.#a, ['uname', '-a']), packages: await this.#inside(this.#a, ['apk', 'info', '-vv']), limitations: ['IPv4 TCP through host-published ports and host.docker.internal; host forwarding remains in the transport path.', 'Only the declared endpoints are routed. SDK redirects and additional endpoint coverage require validation.'] };
  }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const [kind, name] of [['container', this.#helper], ['container', this.#a], ['container', this.#b], ['network', this.#network]]) {
      if (!name || this.cleanup[name]) continue;
      try {
        let owner: string;
        try { owner = await this.#docker([kind, 'inspect', '--format', kind === 'network' ? `{{index .Labels "${ownerLabel}"}}` : `{{index .Config.Labels "${ownerLabel}"}}`, name]); }
        catch (error) { if (/no such (object|container|network)/i.test(String(error))) { this.cleanup[name] = 'absent'; continue; } throw error; }
        if (owner !== this.id) throw new Error(`Refusing to remove ${name}: packet network owner mismatch`);
        await this.#docker([kind, 'rm', ...(kind === 'container' ? ['-f'] : []), name]); this.cleanup[name] = 'removed';
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Packet network cleanup incomplete');
    this.#state = 'closed';
  }
}
