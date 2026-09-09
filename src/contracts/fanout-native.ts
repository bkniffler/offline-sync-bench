import { ContractError, hash } from './screens.ts';
import { validateElectricRecoveryState } from './electric-recovery.ts';
import { validateZeroRecoveryState } from './zero-recovery.ts';
import { JAZZ_EDGE_LOCAL_QUERY } from './jazz-recovery.ts';
import type { RecoveryMutation } from '../recovery/protocol.ts';
import type { JsonObject, StackId } from '../types.ts';

const methods: Partial<Record<StackId, string>> = {
  electric: 'electric-shape-application-sqlite', 'electric-tanstack': 'tanstack-native-electric-stream',
  zero: 'zero-native-materialized-stream', 'jazz-v2': 'jazz-native-edge-subscription',
};
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

/** Readiness is a live delivery control; subsequent receipts must not conceal
 * extra controller sync/observe calls in the connected measurement. */
export function validateFanoutDelivery(reader: JsonObject, reconnect: boolean, stackId?: StackId) {
  const states = ['initialState', 'readyState', ...(reconnect ? ['offlineState'] : []), 'finalState'].map(key => object(reader[key]));
  const initial = object(states[0].protocolCalls);
  if (!Number.isSafeInteger(initial.sync) || Number(initial.sync) < 1) throw new ContractError('Fanout initial sync receipt missing');
  for (const [i, state] of states.entries()) {
    const calls = object(state.protocolCalls), final = i === states.length - 1;
    const resumed = reconnect && final ? 1 : 0, paused = reconnect && i >= 2 ? 1 : 0;
    const observations = i === 0 ? 0 : final && !reconnect ? 2 : 1;
    if (calls.init !== 1 || calls.sync !== initial.sync || (calls.connectDelivery ?? 0) !== (i ? 1 : 0)
      || (calls.observeDelivery ?? 0) !== observations || (calls.resumeDelivery ?? 0) !== resumed || (calls.pauseDelivery ?? 0) !== paused
      || ['write', 'remove', 'observe', 'probeSync', 'bootstrap', 'close'].some(key => Number(calls[key] ?? 0) !== 0)) throw new ContractError('Fanout reader protocol contains unexpected catch-up or mutation calls');
    if (stackId && methods[stackId]) {
      const delivery = object(state.delivery);
      if (delivery.method !== methods[stackId] || delivery.connects !== (i ? 1 + resumed : 0) || delivery.pauses !== paused || delivery.observations !== observations + resumed) throw new ContractError('Fanout native delivery receipts differ');
      if (stackId === 'jazz-v2' && (delivery.subscriptions !== (i ? 1 : 0) || delivery.rows !== (i ? 2_000 : 0)
        || !Number.isSafeInteger(delivery.updates) || Number(delivery.updates) < (i ? 1 : 0))) throw new ContractError('Jazz fanout retained subscription proof missing');
    }
  }
}

/** Auxiliary snapshots were checked in full before compaction. Recheck their
 * digests, native receipts, fresh stores and identities at publication time. */
export function validateFanoutNativeCase(stackId: StackId | undefined, item: JsonObject, readyChanges: RecoveryMutation[], finalChanges: RecoveryMutation[], digests: { initial: string; ready: string; final: string }, reconnect: boolean) {
  if (!stackId || !methods[stackId]) return;
  const readers = item.readers as JsonObject[], witness = object(item.healthyWitness), seed = object(item.seeding);
  const identities = new Map<string, Set<string>>();
  const unique = (key: string, value: unknown) => {
    const seen = identities.get(key) ?? new Set<string>(); identities.set(key, seen);
    if (typeof value !== 'string' || !value || seen.has(value)) throw new ContractError(`Fanout fresh ${key} identity missing or reused`);
    seen.add(value);
  };
  if (stackId === 'jazz-v2' && (!Number.isSafeInteger(seed.pid) || Number(seed.pid) < 1 || seed.edgeDurable !== true
    || seed.taskCount !== 2_000 || seed.tasksDigest !== digests.initial || seed.exitCode !== 0 || seed.exitSignal !== null
    || seed.exitObservedBeforeReaderSpawn !== true || typeof seed.store !== 'string' || !seed.store || !Number.isSafeInteger(seed.parentPid) || Number(seed.parentPid) < 1
    || !Number.isFinite(Date.parse(String(seed.exitedAt))) || typeof seed.datasetId !== 'string' || !seed.datasetId.startsWith('startup-2000-'))) throw new ContractError('Jazz fanout independent seeding proof missing');
  const validateClient = (diagnostics: JsonObject, pid: unknown, snapshots: { native: JsonObject; changes: RecoveryMutation[]; digest: string }[], reader: boolean, evidence?: JsonObject) => {
    const cache = object(diagnostics[stackId === 'jazz-v2' ? 'reader' : 'initialCache']);
    if (stackId === 'zero') {
      if (cache.kvStore !== 'mem' || cache.rows !== 0 || evidence && (evidence.store !== cache.id || evidence.clientId !== cache.id)) throw new ContractError('Zero fanout initial memory cache proof differs');
      for (const key of ['id', 'nativeClientId', 'storageKey']) unique(key, cache[key]);
    } else {
      unique('store', cache.store);
      if (evidence && evidence.store !== cache.store) throw new ContractError('Fanout configured/native store differs');
      if (stackId === 'electric-tanstack') {
        if (cache.activeRows !== 0 || cache.persistedRows !== 0) throw new ContractError('TanStack fanout cache is not fresh');
        unique('collectionId', cache.collectionId); unique('outboxId', cache.outboxId);
      } else if (stackId === 'electric') {
        if (cache.rows !== 0 || cache.pending !== 0 || cache.reopened !== false || evidence && cache.id !== evidence.clientId) throw new ContractError('Electric fanout application cache is not fresh');
        unique('id', cache.id);
      } else if (cache.initialRows !== 0 || cache.transportConnectedAtInitialization !== false || cache.pid !== pid || pid === seed.pid || cache.parentPid !== seed.parentPid
        || cache.datasetId !== seed.datasetId || cache.store === seed.store) throw new ContractError('Jazz fanout fresh independent client proof missing');
    }
    for (const { native, changes, digest } of snapshots) {
      if (stackId === 'zero') {
        validateZeroRecoveryState(native, reader ? [] : changes.map(m => m.id), true);
        if (native.nativeClientId !== cache.nativeClientId || native.storageKey !== cache.storageKey) throw new ContractError('Zero fanout native client changed');
      } else if (stackId === 'electric' || stackId === 'electric-tanstack') {
        validateElectricRecoveryState(stackId, { rows: [], pending: 0, rejected: null, conflicts: null, nativeState: native }, changes, true, false, reader, true);
        if (native.store !== cache.store || (stackId === 'electric' ? native.cacheId !== cache.id : native.collectionId !== cache.collectionId || native.outboxId !== cache.outboxId)) throw new ContractError('Electric fanout native client changed');
      } else if (native.method !== 'native-tiered-local-queries' || native.nativeQueueCount !== null || hash(native.edgeQuery) !== hash(JAZZ_EDGE_LOCAL_QUERY)
        || native.taskCount !== 2_000 || native.localDigest !== digest || native.edgeDigest !== digest || hash(native.pendingTaskIds) !== hash([]) || hash(native.mutationErrors) !== hash([])) throw new ContractError('Jazz fanout complete native snapshot differs');
    }
  };
  validateClient(object(item.writerDiagnostics), item.writerPid, [
    { native: object(item.writerInitialState), changes: [], digest: digests.initial },
    { native: object(item.writerFinalState), changes: finalChanges, digest: digests.final },
  ], false);
  for (const reader of readers) {
    const cacheKind = stackId === 'zero' ? 'memory' : stackId === 'electric' ? 'benchmark-owned-persistent-file' : 'product-persistent-file';
    if (reader.cacheKind !== cacheKind) throw new ContractError('Fanout reader cache profile differs');
    validateFanoutDelivery(reader, reconnect, stackId);
    validateClient(object(reader.diagnostics), reader.pid, [
      { native: object(reader.initialState), changes: [], digest: digests.initial },
      { native: object(reader.readyState), changes: readyChanges, digest: digests.ready },
      ...(reconnect ? [{ native: object(reader.offlineState), changes: readyChanges, digest: digests.ready }] : []),
      { native: object(reader.finalState), changes: finalChanges, digest: digests.final },
    ], true, reader);
  }
  if (reconnect) {
    if (!Number.isSafeInteger(witness.pid) || Number(witness.pid) < 1 || witness.pid === item.writerPid || readers.some(r => r.pid === witness.pid)) throw new ContractError('Fanout healthy witness process is not independent');
    validateClient(object(witness.diagnostics), witness.pid, [{ native: object(witness.nativeState), changes: finalChanges, digest: digests.final }], true);
  }
}
