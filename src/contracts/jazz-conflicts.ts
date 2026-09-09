import { assertRows, ContractError, fixtureTasks, hash, taskRecord, type Row } from './screens.ts';
import { JAZZ_EDGE_LOCAL_QUERY, jazzPendingRows } from './jazz-recovery.ts';
import { conflictFinalRows, conflictPolicy, conflictRows, conflictTarget, offlineTitle, peerTitle, type ConflictCase } from './conflicts.ts';
import { recoverySeed } from './recovery.ts';
import type { JsonObject } from '../types.ts';

/** Full local datasets are checked by the common controller. Retain and check
 * complete edge datasets too: successful receipts alone do not prove convergence. */
export function validateJazzConflictEvidence(metadata: JsonObject, scenario: ConflictCase) {
  const clients = metadata.clients as JsonObject[], seed = metadata.seeding as JsonObject;
  const initial = fixtureTasks(recoverySeed), final = conflictFinalRows(conflictPolicy('jazz-v2', scenario));
  if (!Array.isArray(clients) || clients.length !== 3 || hash(clients.map(c => c.role)) !== hash(['writer', 'peer', 'observer'])) throw new ContractError('Jazz conflict clients missing');
  if (!Number.isSafeInteger(seed?.pid) || Number(seed.pid) < 1 || !Number.isSafeInteger(seed.parentPid) || Number(seed.parentPid) < 1
    || seed.edgeDurable !== true || seed.taskCount !== 2_000 || seed.tasksDigest !== assertRows('Jazz conflict seed', initial, initial)
    || seed.exitCode !== 0 || seed.exitSignal !== null || seed.exitObservedBeforeReaderSpawn !== true
    || !Number.isFinite(Date.parse(String(seed.exitedAt))) || typeof seed.store !== 'string' || !seed.store
    || typeof seed.datasetId !== 'string' || !seed.datasetId.startsWith('startup-2000-')) throw new ContractError('Jazz conflict independent seeding evidence missing');
  const seen = new Map<string, Set<unknown>>();
  const check = (native: JsonObject, local: Row[], edge: Row[], operation?: string, accepted = true) => {
    if (native?.method !== 'native-tiered-local-queries' || native.nativeQueueCount !== null || hash(native.edgeQuery) !== hash(JAZZ_EDGE_LOCAL_QUERY)
      || native.receiptMethod !== 'immediate-native-write-handle-edge-wait' || !Array.isArray(native.receipts)
      || !Array.isArray(native.edgeRows) || !Array.isArray(native.mutationErrors) || native.mutationErrors.length) throw new ContractError('Jazz conflict native snapshot evidence missing');
    assertRows('Jazz conflict full edge data', (native.edgeRows as Row[]).map(taskRecord).sort((a,b) => String(a.id).localeCompare(String(b.id))), edge);
    if (hash(native.pendingTaskIds) !== hash(jazzPendingRows(local, edge))) throw new ContractError('Jazz conflict local/edge difference evidence differs');
    const receipts = native.receipts as JsonObject[];
    if (receipts.length !== (operation ? 1 : 0)) throw new ContractError('Jazz conflict issued receipt count differs');
    if (!operation) return;
    const r = receipts[0];
    if (r.taskId !== conflictTarget || r.operation !== operation || typeof r.nativeId !== 'string' || !r.nativeId || typeof r.batchId !== 'string' || !r.batchId
      || r.local !== 'success' || r.edge !== (accepted ? 'success' : 'pending') || r.localError || r.edgeError) throw new ContractError('Jazz conflict native receipt disposition differs');
    return r;
  };
  const finalReceipts: JsonObject[] = [];
  for (const client of clients) {
    const diagnostics = client.diagnostics as JsonObject, reader = diagnostics?.reader as JsonObject;
    if (!Number.isSafeInteger(client.pid) || Number(client.pid) < 1 || client.pid === seed.pid || reader?.pid !== client.pid || reader.parentPid !== seed.parentPid
      || reader.store !== client.store || reader.store === seed.store || reader.datasetId !== seed.datasetId || reader.initialRows !== 0
      || reader.transportConnectedAtInitialization !== false || diagnostics.productVersion !== seed.productVersion) throw new ContractError('Jazz conflict client is not independently initialized');
    for (const field of ['pid', 'store', 'clientId']) {
      const value = client[field], ids = seen.get(field) ?? new Set(); seen.set(field, ids);
      if ((field !== 'pid' && (typeof value !== 'string' || !value)) || ids.has(value)) throw new ContractError('Jazz conflict client identity reused');
      ids.add(value);
    }
    check(client.initialNative as JsonObject, initial, initial);
    const operation = client.role === 'observer' ? undefined : client.role === 'peer' && scenario === 'conflict-update-delete' ? 'delete' : 'update';
    const receipt = check(client.finalNative as JsonObject, final, final, operation);
    if (receipt) finalReceipts.push(receipt);
    if (client.role === 'writer') {
      for (const key of ['nativeQueued', 'nativeIsolated']) {
        const queued = check(metadata[key] as JsonObject, conflictRows(offlineTitle), initial, 'update', false)!;
        if (queued.batchId !== receipt?.batchId || queued.nativeId !== receipt?.nativeId) throw new ContractError('Jazz conflict queued batch identity changed');
      }
      // Writer disposition can precede its local query reflecting the winner.
      const outcome = (metadata.writerOutcome as JsonObject)?.nativeState as JsonObject;
      const issued = outcome?.receipts as JsonObject[];
      if (outcome?.receiptMethod !== 'immediate-native-write-handle-edge-wait' || issued?.length !== 1 || hash(issued[0]) !== hash(receipt)) throw new ContractError('Jazz conflict writer settlement receipt missing');
    }
    if (client.role === 'observer') {
      const peer = conflictRows(scenario === 'conflict-update-delete' ? null : peerTitle);
      check(metadata.nativeAcceptedPeer as JsonObject, peer, peer);
    }
  }
  if (finalReceipts[0].batchId === finalReceipts[1].batchId || finalReceipts[0].nativeId !== finalReceipts[1].nativeId) throw new ContractError('Jazz conflict writes do not identify distinct batches on one native row');
  if (metadata.clientStorage !== 'product persistent store and queue') throw new ContractError('Jazz conflict storage profile differs');
}
