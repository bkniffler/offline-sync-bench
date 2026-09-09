import { validateElectricConflictEvidence } from './electric-conflicts.ts';
import { assertRows, ContractError, fixtureTasks, hash, taskRecord, type Row } from './screens.ts';
import { recoverySeed } from './recovery.ts';
import { validateOutage } from './outage.ts';
import { validateJazzConflictEvidence } from './jazz-conflicts.ts';
import { validateZeroConflictEvidence } from './zero-conflicts.ts';
import type { RecoveryState } from '../recovery/protocol.ts';
import type { BenchmarkResult, JsonObject, StackId } from '../types.ts';

export const CONFLICT_CONTRACT = 'conflicting-edits-v1';
export type ConflictCase = 'conflict-update-update' | 'conflict-update-delete';
export const conflictTarget = 'org-1-project-1-task-000001';
export const offlineTitle = 'conflict-offline-writer';
export const peerTitle = 'conflict-online-peer';
export interface ConflictPolicy {
  id: string;
  enforcement: string;
  outcome: 'reject-stale-update' | 'last-arriving-patch' | 'last-written-field' | 'delete-retained';
  winner: 'offline-writer' | 'peer' | 'deleted';
  finalVersion: number | null;
  localVersion?: number;
  peerVersion?: number;
  conflicts: number | null;
  rejected: number | null;
  responseCode: string | null;
  source: string;
}
/** Expectations are declared from the configured write path before a run.
 * A different valid policy gets a different comparison profile. */
export function conflictPolicy(stack: StackId, scenario: ConflictCase): ConflictPolicy {
  const deletion = scenario === 'conflict-update-delete';
  if (stack === 'electric' || stack === 'electric-tanstack') return {
    id: 'application-sql-patch-persisted-disposition', enforcement: 'Shared application SQL UPDATE/DELETE by primary key; persist exact affected-row count and version under the idempotency key; absent-row update is a no-op',
    outcome: deletion ? 'delete-retained' : 'last-arriving-patch', winner: deletion ? 'deleted' : 'offline-writer', finalVersion: deletion ? null : 3,
    conflicts: null, rejected: stack === 'electric' ? null : 0, responseCode: null,
    source: 'stacks/electric/app/src/conflicts.ts: application SQL policy and persisted idempotent receipts; not an Electric or TanStack product-wide policy',
  };
  if (stack === 'jazz-v2') return {
    id: deletion ? 'native-soft-delete-required-convergence' : 'native-per-column-timestamp-lww',
    enforcement: deletion ? 'Benchmark requires the accepted soft deletion to remain visible as absence after the earlier offline update; the precise native race policy is unverified' : 'Native update uses the default per-column timestamp merge; the peer writes later on the same host before writer restoration',
    outcome: deletion ? 'delete-retained' : 'last-written-field', winner: deletion ? 'deleted' : 'peer', finalVersion: deletion ? null : 2,
    conflicts: null, rejected: 0, responseCode: null,
    source: 'jazz-tools 2.0.0-alpha.53 native update/delete and immediate WriteHandle edge receipt; https://jazz.tools/docs/reference/internals (policy reference, not pinned-race proof)',
  };
  if (stack === 'zero') return {
    id: 'application-title-patch-missing-row-noop', enforcement: 'Existing shared tasks.update mutator patches title only when the row exists; tasks.remove uses native keyed delete',
    outcome: deletion ? 'delete-retained' : 'last-arriving-patch', winner: deletion ? 'deleted' : 'offline-writer',
    localVersion: 1, peerVersion: 1, finalVersion: deletion ? null : 1,
    conflicts: null, rejected: 0, responseCode: null,
    source: 'services/zero-bench-app/src/mutators.ts: tasks.update and tasks.remove shared client/server mutators',
  };
  if (stack === 'syncular' || stack === 'syncular-rust') return {
    id: 'explicit-version-precondition', enforcement: 'Native upsert with the original local row version as baseVersion',
    outcome: deletion ? 'delete-retained' : 'reject-stale-update', winner: deletion ? 'deleted' : 'peer', finalVersion: deletion ? null : 2,
    conflicts: deletion ? 0 : 1, rejected: deletion ? 1 : 0,
    responseCode: deletion ? 'sync.row_missing' : 'sync.version_conflict',
    source: '@syncular/server/src/push.ts: version precondition and absent-row upsert branches',
  };
  if (stack === 'powersync' || stack === 'turso') return {
    id: stack === 'powersync' ? 'application-sql-patch' : 'native-sql-update-replay',
    enforcement: stack === 'powersync' ? 'Benchmark application backend PATCH uses SQL UPDATE by primary key without a version predicate' : 'Native CDC replays changed columns with SQL UPDATE by primary key',
    outcome: deletion ? 'delete-retained' : 'last-arriving-patch', winner: deletion ? 'deleted' : 'offline-writer', finalVersion: deletion ? null : stack === 'powersync' ? 3 : 2,
    conflicts: null, rejected: null, responseCode: null,
    source: stack === 'powersync' ? 'services/powersync-bench-app/src/index.ts: PATCH and DELETE handlers' : 'https://github.com/tursodatabase/turso/blob/v0.7.2/sync/engine/src/database_replay_generator.rs#L369',
  };
  throw new ContractError(`Conflict policy not implemented for ${stack}`);
}
export function conflictRows(title: string | null, version = 2): Row[] {
  return fixtureTasks(recoverySeed).flatMap(row => row.id !== conflictTarget ? [row] : title === null ? [] : [{ ...row, title, server_version: version }]);
}
export function conflictFinalRows(policy: ConflictPolicy): Row[] {
  return conflictRows(policy.winner === 'deleted' ? null : policy.winner === 'peer' ? peerTitle : offlineTitle, policy.finalVersion ?? 2);
}
export function assertConflictRows(label: string, state: RecoveryState, expected: Row[]): string {
  return assertRows(label, state.rows.map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id))), expected);
}
export function assertConflictOutcome(state: RecoveryState, policy: ConflictPolicy): void {
  if (state.pending !== 0 || state.conflicts !== policy.conflicts || state.rejected !== policy.rejected) throw new ContractError(`Unexpected conflict disposition: pending=${state.pending}, conflicts=${state.conflicts}, rejected=${state.rejected}`);
  if (policy.responseCode) {
    const records = [...((state.nativeState?.conflicts ?? []) as JsonObject[]), ...((state.nativeState?.rejections ?? []) as JsonObject[])];
    if (records.length !== 1 || records[0].code !== policy.responseCode || (records[0].rowId ?? (records[0].operation as JsonObject | undefined)?.rowId) !== conflictTarget) throw new ContractError(`Expected native ${policy.responseCode} evidence for ${conflictTarget}`);
  }
}
export function validateConflictResult(result: Pick<BenchmarkResult, 'stackId' | 'scenarioId' | 'metadata' | 'metrics'>): void {
  const { metadata, metrics } = result;
  if (metadata.workloadContract !== CONFLICT_CONTRACT || !['conflict-update-update', 'conflict-update-delete'].includes(result.scenarioId)) throw new ContractError('Missing conflict contract');
  const policy = conflictPolicy(result.stackId, result.scenarioId as ConflictCase);
  if (hash(metadata.policy) !== hash(policy) || hash(metadata.fixture) !== hash(recoverySeed)) throw new ContractError('Conflict policy or fixture mismatch');
  const validation = metadata.validation as JsonObject;
  const initial = fixtureTasks(recoverySeed), queued = conflictRows(offlineTitle, policy.localVersion ?? 2), peer = conflictRows(result.scenarioId === 'conflict-update-delete' ? null : peerTitle, policy.peerVersion ?? 2), final = conflictFinalRows(policy);
  const digest = (rows: Row[]) => assertRows('expected', rows, rows);
  for (const [field, expected] of Object.entries({ initialWriter: initial, initialPeer: initial, initialObserver: initial, queuedWriter: queued, isolatedWriter: queued, acceptedPeer: peer, finalWriter: final, finalPeer: final, finalObserver: final })) {
    if (validation?.[field] !== digest(expected)) throw new ContractError(`Missing conflict ${field} validation`);
  }
  if (validation.initialTaskCount !== 2_000 || validation.finalTaskCount !== final.length || metadata.pendingBefore !== 1) throw new ContractError('Conflict fixture or pending-write count mismatch');
  const outage = metadata.outage as JsonObject, before = outage?.before as JsonObject, after = outage?.after as JsonObject;
  if (outage?.method !== 'client-only-tcp-gate' || metadata.peerAcceptedBeforeReconnect !== true) throw new ContractError('Conflict ordering or outage proof missing');
  validateOutage(before, after);
  const server = metadata.serverBefore as JsonObject;
  if (['zero', 'jazz-v2', 'electric', 'electric-tanstack'].includes(result.stackId) && (!server?.containerId || server.running !== true || server.health !== 'healthy' || hash(server) !== hash(metadata.serverAfter))) throw new ContractError('Conflict service was not healthy and stable');
  assertConflictOutcome({ rows: [], ...(metadata.writerOutcome as unknown as Omit<RecoveryState, 'rows'>) }, policy);
  if (result.stackId === 'zero') validateZeroConflictEvidence(metadata);
  if (result.stackId === 'electric' || result.stackId === 'electric-tanstack') validateElectricConflictEvidence(result.stackId, result.scenarioId as ConflictCase, metadata);
  if (result.stackId === 'jazz-v2') validateJazzConflictEvidence(metadata, result.scenarioId as ConflictCase);
  for (const name of ['writer_settled_ms', 'all_clients_converged_ms']) if (typeof metrics[name] !== 'number' || !Number.isFinite(metrics[name]) || Number(metrics[name]) < 0) throw new ContractError('Missing conflict timing');
  if (Number(metrics.all_clients_converged_ms) < Number(metrics.writer_settled_ms)) throw new ContractError('Conflict convergence predates writer disposition');
  const resources = metadata.resources as JsonObject;
  if (resources?.method !== 'external-ps-process-tree-v1' || !Array.isArray(resources.samples) || !resources.samples.length) throw new ContractError('Missing conflict resource samples');
}
