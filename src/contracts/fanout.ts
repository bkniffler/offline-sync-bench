import { assertRows, ContractError, fixtureTasks, hash, taskRecord } from './screens.ts';
import { recoverySeed } from './recovery.ts';
import { validateOutage } from './outage.ts';
import { percentile } from '../metrics.ts';
import { validateFanoutDelivery, validateFanoutNativeCase } from './fanout-native.ts';
import type { RecoveryMutation, RecoveryState } from '../recovery/protocol.ts';
import type { BenchmarkResult, JsonObject, StackId } from '../types.ts';

export const FANOUT_CONTRACT = 'client-fanout-recovery-v1';
export type FanoutCase = 'connected-fanout' | 'reconnect-storm';
export function clientCounts() {
  const counts = (process.env.BENCH_CLIENT_COUNTS || '5,25').split(',').map(Number);
  if (!counts.length || new Set(counts).size !== counts.length || counts.some(n => !Number.isSafeInteger(n) || n < 2 || n > 1_000)) throw new ContractError('Client counts must be distinct integers from 2 through 1000');
  return counts;
}
export const fanoutReady: RecoveryMutation[] = [{ id: 'org-1-project-1-task-002000', title: 'fanout-readiness-marker' }];
export const fanoutMutations = (scenario: FanoutCase): RecoveryMutation[] => fixtureTasks(recoverySeed).slice(0, scenario === 'connected-fanout' ? 1 : 100).map((row, i) => ({ id: String(row.id), title: `fanout-update-${i + 1}` }));
export function fanoutRows(mutations: RecoveryMutation[]) {
  const changes = new Map(mutations.map(row => [row.id, row.title]));
  return fixtureTasks(recoverySeed).map(row => changes.has(String(row.id)) ? { ...row, title: changes.get(String(row.id)), server_version: 2 } : row);
}
export function validateFanoutState(label: string, state: RecoveryState, mutations: RecoveryMutation[]) {
  if (state.pending !== 0 || state.rejected !== null && state.rejected !== 0 || state.conflicts !== null && state.conflicts !== 0) throw new ContractError(`${label}: unexpected local writes or native failures`);
  return assertRows(label, state.rows.map(taskRecord).sort((a,b) => String(a.id).localeCompare(String(b.id))), fanoutRows(mutations));
}
export const fanoutProfile = (scenario: FanoutCase, stackId?: StackId) => ({ mode: scenario, clientCache: stackId === 'zero' ? 'memory' : stackId === 'electric' ? 'benchmark-owned-persistent-file' : 'product-persistent-file', durability: 'live clients; no process-restart guarantee tested', initialTasks: 2_000, readiness: 'live marker observed by every reader before timing',
  changeCount: scenario === 'connected-fanout' ? 1 : 100,
  completion: 'every reader observes every changed row; exact full snapshots checked afterward',
  network: scenario === 'connected-fanout' ? 'live native subscriptions' : 'all reader routes blocked during verified server backlog; simultaneous restore, native catch-up sync and subscription reconnect',
  clock: 'parent monotonic clock and independent reader completion receipts',
  resources: 'reader processes plus writer; controller and sampler excluded',
});
export function validateFanoutResult(result: Pick<BenchmarkResult, 'scenarioId' | 'metadata' | 'metrics'> & Partial<Pick<BenchmarkResult, 'stackId'>>) {
  const { metadata, metrics } = result;
  const scenario = result.scenarioId as FanoutCase;
  if (!['connected-fanout', 'reconnect-storm'].includes(scenario) || metadata.workloadContract !== FANOUT_CONTRACT || hash(metadata.deliveryProfile) !== hash(fanoutProfile(scenario, result.stackId))) throw new ContractError('Fanout contract/profile mismatch');
  const fixture = metadata.fixture as JsonObject, counts = fixture?.clientCounts as number[], cases = metadata.cases as JsonObject[];
  if (!Array.isArray(counts) || !counts.length || new Set(counts).size !== counts.length || counts.some(n => !Number.isSafeInteger(n) || n < 2 || n > 1_000) || hash(fixture.seed) !== hash(recoverySeed) || !Array.isArray(cases) || cases.length !== counts.length) throw new ContractError('Fanout fixture or scale cases missing');
  const digest = (changes: RecoveryMutation[]) => { const rows = fanoutRows(changes); return assertRows('expected', rows, rows); };
  const initial = digest([]), ready = digest(fanoutReady), final = digest([...fanoutReady, ...fanoutMutations(scenario)]);
  for (const [i, item] of cases.entries()) {
    if (item.clientCount !== counts[i] || item.status !== 'completed' || item.initialWriterDigest !== initial || item.finalWriterDigest !== final || item.readinessWriterDigest !== ready) throw new ContractError('Fanout writer/scale proof missing');
    if (!Number.isSafeInteger(item.writerPid) || Number(item.writerPid) < 1) throw new ContractError('Fanout writer process identity missing');
    const readers = item.readers as JsonObject[];
    if (!Array.isArray(readers) || readers.length !== counts[i] || new Set(readers.map(r => r.pid)).size !== counts[i] || new Set(readers.map(r => r.store)).size !== counts[i] || new Set(readers.map(r => r.clientId)).size !== counts[i] || readers.some(r => !Number.isSafeInteger(r.pid) || Number(r.pid) < 1 || r.pid === item.writerPid || typeof r.store !== 'string' || !r.store || typeof r.clientId !== 'string' || !r.clientId || r.initialDigest !== initial || r.readyDigest !== ready || r.finalDigest !== final || typeof r.completedMs !== 'number' || !Number.isFinite(r.completedMs) || r.completedMs < 0)) throw new ContractError('Fanout requires every distinct reader and full data validation');
    for (const reader of readers) validateFanoutDelivery(reader, scenario === 'reconnect-storm', result.stackId);
    validateFanoutNativeCase(result.stackId, item, fanoutReady, [...fanoutReady, ...fanoutMutations(scenario)], { initial, ready, final }, scenario === 'reconnect-storm');
    const samples = readers.map(r => Number(r.completedMs)), key = `clients_${counts[i]}`;
    if (metrics[`${key}_all_converged_ms`] !== Math.max(...samples) || metrics[`${key}_p50_ms`] !== percentile(samples, 50) || metrics[`${key}_p95_ms`] !== percentile(samples, 95)) throw new ContractError('Fanout summaries differ from per-client completions');
    const resources = item.resources as JsonObject;
    if (resources?.method !== 'external-ps-process-tree-v1' || resources.includeRoot !== false || !Array.isArray(resources.samples) || resources.samples.length < 2) throw new ContractError('Fanout client resource samples missing');
    const servers = item.serverResources as JsonObject;
    if (servers?.method !== 'docker-engine-stats-v1' || !Array.isArray(servers.samples) || servers.samples.length < 2) throw new ContractError('Fanout server resource evidence missing');
    const services = item.serviceIdentitiesBefore as JsonObject[];
    if (!Array.isArray(services) || !services.length || services.some(s => !s.id || !s.label || s.running !== true || !Number.isFinite(Date.parse(String(s.startedAt)))) || hash(services) !== hash(item.serviceIdentitiesAfter)) throw new ContractError('Service process changed or was not running during measurement');
    const before = item.serverBefore as JsonObject;
    if (!before?.containerId || before.running !== true || before.health !== 'healthy' || !Number.isFinite(Date.parse(String(before.startedAt)))) throw new ContractError('Healthy server identity missing');
    if (hash(item.serverBefore) !== hash(item.serverAfter)) throw new ContractError('Service changed during fanout/reconnect');
    if (scenario === 'reconnect-storm') {
      if (item.backlogCount !== 100 || item.healthyWitnessDigest !== final) throw new ContractError('Reconnect requires a verified backlog on a healthy service');
      for (const reader of readers) {
        if (reader.offlineDigest !== ready) throw new ContractError('Reader received backlog before reconnect');
        const outage = reader.outage as JsonObject;
        validateOutage(outage?.before as JsonObject, outage?.after as JsonObject);
        if (((outage.after as JsonObject).responseBytes) !== ((outage.before as JsonObject).responseBytes)) throw new ContractError('Blocked reader received network data');
      }
    }
  }
}
