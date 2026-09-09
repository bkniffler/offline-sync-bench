import { assertRows, ContractError, fixtureTasks, hash, taskRecord, type Row } from './screens.ts';
import { recoverySeed } from './recovery.ts';
import { conflictFinalRows, conflictPolicy, conflictRows, conflictTarget, offlineTitle, peerTitle, type ConflictCase } from './conflicts.ts';
import { validateElectricRecoveryState } from './electric-recovery.ts';
import { validateElectricConflictReceipt } from './electric-conflict-receipt.ts';
import type { JsonObject } from '../types.ts';

export function electricConflictStorage(stack: 'electric' | 'electric-tanstack') {
  return stack === 'electric' ? 'benchmark-owned persistent SQLite cache and outbox' : 'product persistent SQLite cache; native fake-indexeddb-memory queue, no process durability';
}
export function validateElectricConflictEvidence(stack: 'electric' | 'electric-tanstack', scenario: ConflictCase, metadata: JsonObject) {
  const tan = stack === 'electric-tanstack', initial = fixtureTasks(recoverySeed), final = conflictFinalRows(conflictPolicy(stack, scenario));
  const deletion = scenario === 'conflict-update-delete';
  const clients = metadata.clients as JsonObject[];
  if (!Array.isArray(clients) || hash(clients.map(c => c.role)) !== hash(['writer', 'peer', 'observer']) || metadata.clientStorage !== electricConflictStorage(stack)) throw new ContractError('Electric conflict client/storage evidence missing');
  const identities = new Map<string, Set<unknown>>();
  const ordered = (rows: Row[]) => rows.map(taskRecord).sort((a,b) => String(a.id).localeCompare(String(b.id)));
  for (const client of clients) {
    const cache = (client.diagnostics as JsonObject)?.initialCache as JsonObject;
    if (!cache || cache.store !== client.store || !Number.isSafeInteger(client.pid) || Number(client.pid) < 1
      || (tan ? cache.activeRows !== 0 || cache.persistedRows !== 0 : cache.rows !== 0 || cache.pending !== 0 || cache.reopened !== false || cache.id !== client.clientId)) throw new ContractError('Electric conflict client is not fresh');
    for (const [key, value] of Object.entries({ pid: client.pid, store: client.store, clientId: client.clientId, ...(tan ? { collectionId: cache.collectionId, outboxId: cache.outboxId } : {}) })) {
      const seen = identities.get(key) ?? new Set(); identities.set(key, seen);
      if ((key !== 'pid' && (typeof value !== 'string' || !value)) || seen.has(value)) throw new ContractError('Electric conflict client identity reused');
      seen.add(value);
    }
    const check = (native: JsonObject, rows: Row[], operation?: string) => {
      const queue = native?.[tan ? 'outbox' : 'queue'] as JsonObject[];
      if (native?.method !== (tan ? 'tanstack-native-outbox-v1' : 'application-sqlite-outbox-electric-shape-v1') || native.store !== cache.store
        || (tan ? native.collectionId !== cache.collectionId || native.outboxId !== cache.outboxId || native.queueStore !== 'fake-indexeddb-memory' : native.cacheId !== cache.id || native.failure !== null)
        || !Array.isArray(queue) || queue.length || !Array.isArray(native.attempts)) throw new ContractError('Electric conflict native identity/queue differs');
      const auxiliary = native[tan ? 'persistedRows' : 'remoteRows'];
      if (!Array.isArray(auxiliary)) throw new ContractError('Electric conflict auxiliary snapshot missing');
      assertRows('Electric conflict complete auxiliary data', ordered(auxiliary as Row[]), rows);
      const attempts = native.attempts as JsonObject[], success = attempts.filter(a => a.status === 'success');
      if (success.length !== (operation ? 1 : 0) || (!operation && attempts.length)) throw new ContractError('Electric conflict upload disposition missing');
      if (tan) {
        const issued = native.issued as JsonObject[];
        if (!Array.isArray(native.errors) || native.errors.length || !Array.isArray(issued) || issued.length !== (operation ? 1 : 0)
          || (operation && (issued[0].taskId !== conflictTarget || issued[0].operation !== operation || issued[0].settled !== true || issued[0].id !== success[0].id))) throw new ContractError('TanStack conflict native transaction receipt differs');
      }
      if (!operation) return;
      const attempt = success[0], receipt = validateElectricConflictReceipt(attempt.conflictReceipt as JsonObject, { taskId: conflictTarget, operation, idempotencyKey: String(attempt.idempotencyKey) });
      const missing = client.role === 'writer' && deletion;
      if (receipt.affectedRows !== (missing ? 0 : 1) || receipt.serverVersion !== (operation === 'delete' || missing ? null : client.role === 'writer' ? 3 : 2)
        || attempt.txid !== receipt.txid || typeof attempt.serverAcceptedMs !== 'number' || typeof attempt.appliedMs !== 'number' || attempt.appliedMs < attempt.serverAcceptedMs
        || (tan && attempt.shapeAcknowledgment !== (missing ? 'no-task-change; application receipt only' : 'native-awaitTxId'))) throw new ContractError('Electric conflict declared SQL outcome differs');
      return { attempt, receipt };
    };
    check(client.initialNative as JsonObject, initial);
    const operation = client.role === 'observer' ? undefined : client.role === 'peer' && deletion ? 'delete' : 'update';
    const accepted = check(client.finalNative as JsonObject, final, operation);
    if (client.role === 'writer') {
      let queueIdentity: string | undefined;
      for (const key of ['nativeQueued', 'nativeIsolated']) {
        const native = metadata[key] as JsonObject;
        validateElectricRecoveryState(stack, { rows: conflictRows(offlineTitle), pending: 1, conflicts: null, rejected: tan ? 0 : null, nativeState: native }, [{ id: conflictTarget, title: offlineTitle }], false);
        if (native.store !== cache.store || (tan ? native.collectionId !== cache.collectionId || native.outboxId !== cache.outboxId : native.cacheId !== cache.id)) throw new ContractError('Electric conflict isolated client changed');
        const entry = (native[tan ? 'outbox' : 'queue'] as JsonObject[])[0];
        const identity = hash(tan ? { id: entry.id, key: entry.idempotencyKey, mutations: entry.mutations } : entry);
        if (queueIdentity && identity !== queueIdentity) throw new ContractError('Electric conflict queued mutation changed');
        queueIdentity = identity;
        if (entry.idempotencyKey !== accepted?.receipt.idempotencyKey || (tan && entry.id !== accepted.attempt.id)) throw new ContractError('Electric conflict admitted a different queued write');
      }
      check((metadata.writerOutcome as JsonObject)?.nativeState as JsonObject, final, 'update');
    }
    if (client.role === 'observer') check(metadata.nativeAcceptedPeer as JsonObject, conflictRows(deletion ? null : peerTitle));
  }
}
