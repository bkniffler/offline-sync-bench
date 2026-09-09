import { ContractError, assertRows, taskRecord, type Row } from './screens.ts';
import { recoveryExpected } from './recovery.ts';
import type { RecoveryMutation, RecoveryState } from '../recovery/protocol.ts';
import type { JsonObject } from '../types.ts';

/** Validate native / application data before replacing complete auxiliary
 * snapshots with digests in the report artifact. */
export function validateElectricRecoveryState(stackId: 'electric' | 'electric-tanstack', state: RecoveryState,
  mutations: RecoveryMutation[], accepted: boolean, reopened = false, reader = false, compactSnapshot = false): JsonObject {
  const native = state.nativeState;
  if (!native) throw new ContractError('Electric recovery evidence missing');
  const tanstack = stackId === 'electric-tanstack';
  const ids = mutations.map(m => m.id).sort(), expected = new Map(recoveryExpected(mutations).map(row => [String(row.id), row]));
  const original = new Map(recoveryExpected().map(row => [String(row.id), row]));
  const queue = native[tanstack ? 'outbox' : 'queue'] as JsonObject[];
  if (native.method !== (tanstack ? 'tanstack-native-outbox-v1' : 'application-sqlite-outbox-electric-shape-v1') || typeof native.store !== 'string' || !native.store
    || !Array.isArray(queue) || queue.length !== (accepted ? 0 : ids.length) || state.pending !== queue.length) throw new ContractError('Electric recovery queue proof differs');
  const queueIds: string[] = [], keys = new Set<string>(), transactionIds = new Set<string>();
  for (const entry of queue) {
    if (typeof entry.idempotencyKey !== 'string' || !entry.idempotencyKey || keys.has(entry.idempotencyKey)) throw new ContractError('Electric recovery idempotency proof differs');
    keys.add(entry.idempotencyKey);
    if (tanstack) {
      if (entry.mutationFnName !== 'syncTasks' || typeof entry.id !== 'string' || transactionIds.has(entry.id) || !Array.isArray(entry.mutations) || entry.mutations.length !== 1) throw new ContractError('TanStack native transaction identity differs');
      transactionIds.add(entry.id);
      const m = entry.mutations[0] as JsonObject, id = String(m.taskId);
      if (m.type !== 'update' || !expected.has(id) || !original.has(id)) throw new ContractError('TanStack native mutation differs');
      assertRows('TanStack native queued original', [m.original as Row], [original.get(id)!]);
      assertRows('TanStack native queued modified', [m.modified as Row], [expected.get(id)!]);
      queueIds.push(id);
    } else {
      const id = String(entry.taskId);
      if (!Number.isSafeInteger(entry.sequence) || Number(entry.sequence) < 1 || !expected.has(id) || entry.title !== expected.get(id)!.title) throw new ContractError('Electric reference queued payload differs');
      queueIds.push(id);
    }
  }
  if (JSON.stringify(queueIds.sort()) !== JSON.stringify(accepted ? [] : ids)) throw new ContractError('Electric recovery queued task identities differ');
  if (tanstack) {
    if (native.queueStore !== 'fake-indexeddb-memory' || !Array.isArray(native.errors) || native.errors.length || !Array.isArray(native.issued)
      || JSON.stringify(native.issued.map(i => (i as JsonObject).taskId).sort()) !== JSON.stringify(reader ? [] : ids)
      || native.issued.some(i => { const r = i as JsonObject; return r.settled !== accepted || (!accepted && !transactionIds.has(String(r.id))); })) throw new ContractError('TanStack native commit receipts differ');
  } else if (native.failure !== null) throw new ContractError('Electric reference cache application failed');
  const attempts = native.attempts as JsonObject[];
  if (!Array.isArray(attempts)) throw new ContractError('Electric recovery upload receipts missing');
  if (!accepted && !reopened && ids.length && !attempts.some(a => a.status === 'retry-error')) throw new ContractError('Electric recovery failed upload probe missing');
  if (accepted && !reader && ids.length) {
    const success = attempts.filter(a => a.status === 'success');
    const uploaded = success.flatMap(a => tanstack ? a.taskIds as string[] : [String(a.taskId)]).sort();
    if (JSON.stringify(uploaded) !== JSON.stringify(ids) || success.some(a => !Number.isSafeInteger(a.txid) || typeof a.serverAcceptedMs !== 'number' || typeof a.appliedMs !== 'number' || Number(a.appliedMs) < Number(a.serverAcceptedMs))) throw new ContractError('Electric recovery server/shape receipts incomplete');
  }
  const field = tanstack ? 'persistedRows' : 'remoteRows';
  const expectedAux = !tanstack && reopened ? [] : recoveryExpected(accepted ? mutations : []);
  if (compactSnapshot) {
    if (native.auxiliaryRows !== expectedAux.length || native.auxiliaryDigest !== assertRows('expected auxiliary', expectedAux, expectedAux)) throw new ContractError('Electric recovery auxiliary digest differs');
    return native;
  }
  if (!Array.isArray(native[field])) throw new ContractError('Electric recovery auxiliary snapshot missing');
  const records = (native[field] as Row[]).map(taskRecord).sort((a,b) => String(a.id).localeCompare(String(b.id)));
  const digest = assertRows(tanstack ? 'TanStack persisted recovery cache' : 'Electric native remote shape', records, expectedAux);
  const { [field]: omitted, ...compact } = native;
  return { ...compact, auxiliaryDigest: digest, auxiliaryRows: records.length };
}
