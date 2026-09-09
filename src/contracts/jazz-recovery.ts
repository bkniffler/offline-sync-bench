import { assertRows, ContractError, taskRecord, type Row } from './screens.ts';
import { recoveryExpected } from './recovery.ts';
import type { RecoveryMutation, RecoveryState } from '../recovery/protocol.ts';
import type { JsonObject } from '../types.ts';

export const JAZZ_EDGE_LOCAL_QUERY = { tier: 'edge', propagation: 'local-only', localUpdates: 'deferred' } as const;

/** Scoped application differences, never an aggregate native queue counter. */
export function jazzPendingRows(local: Row[], edge: Row[]): string[] {
  const records = (rows: Row[]) => new Map(rows.map(row => [String(row.id), JSON.stringify(taskRecord(row))]));
  const a = records(local), b = records(edge);
  return [...new Set([...a.keys(), ...b.keys()])].filter(id => a.get(id) !== b.get(id)).sort();
}

/** Validate complete native snapshots in the controller before retaining compact
 * digests. The reopened worker receives only its original store/configuration. */
export function validateJazzRecoveryState(state: RecoveryState, mutations: RecoveryMutation[], accepted: boolean): JsonObject {
  const native = state.nativeState;
  if (native?.method !== 'native-tiered-local-queries' || native.nativeQueueCount !== null || JSON.stringify(native.edgeQuery) !== JSON.stringify(JAZZ_EDGE_LOCAL_QUERY) || !Array.isArray(native.edgeRows) || !Array.isArray(native.mutationErrors) || native.mutationErrors.length) throw new ContractError('Jazz native tiered snapshot evidence missing');
  const ordered = (rows: Row[]) => rows.map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const edgeRows = native.edgeRows as Row[];
  const localDigest = assertRows('Jazz local recovery snapshot', ordered(state.rows), recoveryExpected(mutations));
  const edgeDigest = assertRows('Jazz edge-durable recovery snapshot', ordered(edgeRows), recoveryExpected(accepted ? mutations : []));
  const pendingTaskIds = jazzPendingRows(state.rows, edgeRows);
  if (JSON.stringify(pendingTaskIds) !== JSON.stringify(native.pendingTaskIds) || state.pending !== pendingTaskIds.length) throw new ContractError('Jazz pending application row observation differs');
  return { method: native.method, nativeQueueCount: null, edgeQuery: JAZZ_EDGE_LOCAL_QUERY, localDigest, edgeDigest,
    taskCount: edgeRows.length, pendingTaskIds, mutationErrors: [] };
}
