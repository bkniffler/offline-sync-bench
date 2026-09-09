import { randomUUID } from 'node:crypto';
import { PacketNetwork, packetRoutes, readPacketAudit, validatePacketImpairment, type PacketImpairment } from './emulator.ts';
import { applyClientRouting, clientEndpoints, routingVariable, type ClientRouting } from './routing.ts';
import { getStack } from '../stacks.ts';
import { hash } from '../contracts/screens.ts';
import type { BenchmarkResult, JsonObject, ScenarioId, StackId } from '../types.ts';

export interface PacketNetworkProfile extends PacketImpairment { id: 'private-veth-netem-v1'; imageId: string }
export function describeNetworkProfile(network: JsonObject): string {
  validateNetworkProfile(network, ['online-propagation']);
  return network.id === 'local-loopback' ? 'local service routes, no injected delay or loss'
    : `${network.oneWayDelayMs} ms configured packet delay each way, ${network.lossPct}% random packet loss, with host port forwarding`;
}
export function validateNetworkProfile(network: JsonObject, scenarios: ScenarioId[]): void {
  if (network?.id === 'local-loopback' && network.injectedLatencyMs === 0 && network.injectedLossPct === 0 && Object.keys(network).sort().join(',') === 'id,injectedLatencyMs,injectedLossPct') return;
  if (network?.id !== 'private-veth-netem-v1') throw new Error('Network profile is not implemented');
  if (Object.keys(network).sort().join(',') !== 'id,imageId,lossPct,oneWayDelayMs,packetLimit,seed' || !/^sha256:[a-f0-9]{64}$/.test(String(network.imageId))) throw new Error('Packet profile requires an immutable image and exact impairment parameters');
  if (['oneWayDelayMs', 'lossPct', 'seed', 'packetLimit'].some(key => typeof network[key] !== 'number')) throw new Error('Packet impairment parameters must be numbers');
  validatePacketImpairment(impairment(network));
  if (scenarios.some(id => id !== 'online-propagation')) throw new Error('Packet campaign routing is currently implemented for collaboration; other suites require endpoint and outage-policy integration');
}
function impairment(network: JsonObject): PacketImpairment {
  return { oneWayDelayMs: Number(network.oneWayDelayMs), lossPct: Number(network.lossPct), seed: Number(network.seed), packetLimit: Number(network.packetLimit) };
}
export async function withTrialNetwork(
  network: JsonObject,
  identity: { runId: string; stackId: StackId; scenarioId: ScenarioId },
  run: (routing: string) => Promise<BenchmarkResult>,
): Promise<BenchmarkResult> {
  validateNetworkProfile(network, [identity.scenarioId]);
  if (network.id === 'local-loopback') return run('');
  const emulator = new PacketNetwork(String(network.imageId), clientEndpoints(getStack(identity.stackId)), impairment(network));
  const startedAt = new Date().toISOString(), started = performance.now();
  const evidence: JsonObject = { version: 1, networkId: emulator.id, declared: network, stage: 'setup', startedAt, before: null, after: null, cleanup: {}, commands: [],
    scope: 'All declared client endpoint fields use the same two forwarding namespaces. Administrative/provisioning addresses and server-to-server callbacks retain their original paths. Client fixture initialization also uses its routed connection. Both directional netem streams use the declared seed.' };
  let result: BenchmarkResult | undefined;
  try {
    await emulator.start();
    evidence.before = await emulator.snapshot() as unknown as JsonObject;
    const routing: ClientRouting = { version: 1, stackId: identity.stackId, networkId: emulator.id, endpoints: emulator.urls };
    applyClientRouting(getStack(identity.stackId), JSON.stringify(routing));
    evidence.routing = routing as unknown as JsonObject; evidence.stage = 'trial';
    result = await run(JSON.stringify(routing));
    evidence.stage = 'after-trial';
    evidence.after = await emulator.snapshot() as unknown as JsonObject;
  } catch (error) {
    evidence.error = String(error);
    if (result) { result.status = 'invalid'; result.notes.push(`Network evidence failed: ${String(error)}`); }
    else result = { ...identity, resultId: randomUUID(), startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - started, status: 'invalid', metrics: {}, notes: [`Network setup or trial failed: ${String(error)}`], metadata: {} };
  } finally {
    try { await emulator.close(); evidence.cleanup = { ...emulator.cleanup }; }
    catch (error) { evidence.cleanup = { ...emulator.cleanup }; evidence.cleanupError = String(error); if (result) { result.status = 'invalid'; result.notes.push(`Network cleanup failed: ${String(error)}`); } }
    evidence.commands = emulator.commands as unknown as JsonObject[]; evidence.finishedAt = new Date().toISOString();
  }
  result!.metadata.network = evidence;
  try { validateTrialNetwork(result!, network); }
  catch (error) { result!.status = 'invalid'; result!.notes.push(String(error)); evidence.validationError = String(error); }
  return result!;
}

function equal(a: unknown, b: unknown, label: string) { if (hash(a) !== hash(b)) throw new Error(`Network ${label} mismatch`); }
export function validateTrialNetwork(result: BenchmarkResult, profile: JsonObject): void {
  validateNetworkProfile(profile, [result.scenarioId]);
  if (profile.id === 'local-loopback') {
    if (result.metadata.network || result.metadata.clientRouting) throw new Error('Local profile contains undeclared client routing');
    return;
  }
  const e = result.metadata.network as JsonObject;
  if (!e || e.version !== 1) throw new Error('Network trial evidence missing');
  equal(e.declared, profile, 'declared profile');
  // A setup failure retains its partial record; it cannot supply latency data.
  if (result.status !== 'completed' && (!e.before || !e.after || e.cleanupError || e.error)) return;
  const before = e.before as any, after = e.after as any;
  const endpoints = clientEndpoints(getStack(result.stackId));
  for (const snapshot of [before, after]) {
    if (!snapshot || snapshot.version !== 1 || snapshot.method !== profile.id || snapshot.id !== e.networkId || snapshot.imageId !== profile.imageId || !snapshot.kernel || !snapshot.packages) throw new Error('Network runtime identity missing or changed');
    equal(snapshot.impairment, impairment(profile), 'applied settings'); equal(snapshot.endpoints, endpoints, 'endpoint inventory'); equal(snapshot.routes, packetRoutes(endpoints), 'route plan');
    if (snapshot.containers?.length !== 2) throw new Error('Network forwarding namespace evidence missing');
    for (const [index, container] of snapshot.containers.entries()) {
      if (container.identity?.image !== profile.imageId || container.identity.labels?.['bench.packet-network.owner'] !== e.networkId) throw new Error('Network namespace ownership or image changed');
      equal(container.identity.caps.slice().sort(), ['CAP_NET_ADMIN', 'CAP_NET_RAW'], 'capabilities'); equal(container.identity.capDrop, ['ALL'], 'capability restriction'); equal(container.identity.sysctls, { 'net.ipv4.ip_forward': '1' }, 'namespace forwarding');
      equal(container.audit, readPacketAudit(container.auditRules), 'packet audit');
      if (container.audit.oversized !== 0) throw new Error('Oversized packets reached the impairment path');
      const queues = container.qdisc.filter((q: any) => q.kind === 'netem'), parent = container.qdisc.find((q: any) => q.kind === 'prio');
      if (queues.length !== 1 || queues[0].handle !== '30:' || queues[0].parent !== '1:3' || parent?.handle !== '1:') throw new Error('Network queue topology changed');
      const options = queues[0].options;
      equal({ oneWayDelayMs: (options.delay?.delay ?? 0) * 1000, lossPct: (options['loss-random']?.loss ?? 0) * 100, seed: options.seed, packetLimit: options.limit }, impairment(profile), 'kernel impairment');
      for (const flags of [container.eth0Offloads, container.hopOffloads]) for (const flag of ['tcp-segmentation-offload', 'generic-segmentation-offload', 'generic-receive-offload', 'tx-gso-list', 'tx-checksumming']) if (!new RegExp(`^${flag}: off(?: \\[fixed\\])?$`, 'm').test(flags)) throw new Error('Network segmentation configuration changed');
      if (!container.links.some((link: any) => link.ifname === 'hop0' && link.mtu === 1500)) throw new Error('Private packet link missing');
      const target = index === 0 ? '169.254.254.2' : snapshot.hostIp;
      const natLines = container.nat.split('\n') as string[];
      equal(natLines.filter(line => line.startsWith('-A PREROUTING ')).sort(), snapshot.routes.map((route: any) => `-A PREROUTING -p tcp -m tcp --dport ${route.port} -j DNAT --to-destination ${target}:${index === 0 ? route.port : route.upstreamPort}`).sort(), 'forwarding destinations');
      equal(natLines.filter(line => line.startsWith('-A POSTROUTING ') && !line.includes('127.0.0.11/32')).sort(), snapshot.routes.map((route: any) => `-A POSTROUTING -d ${target}/32 -p tcp -m tcp --dport ${index === 0 ? route.port : route.upstreamPort} -j MASQUERADE`).sort(), 'return routing');
      const auditRoutes = container.auditRules.split('\n').filter((line: string) => line.includes('-A FORWARD ')).map((line: string) => line.replace(/^\[\d+:\d+\] /, ''));
      equal(auditRoutes.sort(), snapshot.routes.map((route: any) => index === 0 ? `-A FORWARD -s 169.254.254.2/32 -p tcp -m tcp --sport ${route.port} -j NETEM_AUDIT` : `-A FORWARD -d ${target}/32 -p tcp -m tcp --dport ${route.upstreamPort} -j NETEM_AUDIT`).sort(), 'audited routes');
      const filters = container.filters.split(/(?=filter parent)/).filter((part: string) => part.includes('flowid'));
      const actualKeys = filters.map((part: string) => { if (!part.includes('flowid 1:3 ')) throw new Error('Client packets select an unshaped queue'); return [...part.matchAll(/match ([a-f0-9]{8})\/([a-f0-9]{8}) at (\d+)/g)].map(match => [match[1], match[2], Number(match[3])]); });
      const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
      const targetHex = String(target).split('.').map((part: string) => Number(part).toString(16).padStart(2, '0')).join('');
      const expectedKeys = snapshot.routes.map((route: any) => [['00060000', '00ff0000', 8], ...(index === 0 ? [[hex(route.port << 16), 'ffff0000', 20]] : [[targetHex, 'ffffffff', 16], [hex(route.upstreamPort), '0000ffff', 20]])]);
      equal(actualKeys, expectedKeys, 'packet classification');
      if (snapshot === after && container.identity.id !== before.containers[index].identity.id) throw new Error('Network namespace replaced during trial');
    }
    applyClientRouting(getStack(result.stackId), JSON.stringify({ version: 1, stackId: result.stackId, networkId: e.networkId, endpoints: snapshot.urls }));
    for (const route of snapshot.routes) for (const name of route.names) {
      const binding = snapshot.containers[0].identity.ports[`${route.port}/tcp`];
      if (binding?.length !== 1 || binding[0].HostIp !== '127.0.0.1' || binding[0].HostPort !== new URL(snapshot.urls[name]).port) throw new Error('Client endpoint does not reach the declared published port');
    }
  }
  equal(before.urls, after.urls, 'stable client routes');
  equal(e.routing, { version: 1, stackId: result.stackId, networkId: e.networkId, endpoints: before.urls }, 'controller routing');
  if (result.status === 'completed') {
    equal(result.metadata.clientRouting, e.routing, 'child routing receipt');
    for (const [index, container] of after.containers.entries()) if (container.audit.packets <= before.containers[index].audit.packets) throw new Error('No client packets traversed the declared impairment');
  }
  const cleanup = e.cleanup as JsonObject;
  if (Object.keys(cleanup).length !== 4 || Object.values(cleanup).some(value => value !== 'removed' && value !== 'absent')) throw new Error('Network namespace cleanup incomplete');
  if (!Array.isArray(e.commands) || !e.commands.length) throw new Error('Network command provenance missing');
}

export function networkTrialEnvironment(base: NodeJS.ProcessEnv, routing: string): NodeJS.ProcessEnv {
  return { ...base, [routingVariable]: routing };
}
