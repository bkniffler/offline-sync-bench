import { validateRestoration } from './recovery-policy.ts';
import { ContractError, assertRows } from './screens.ts';
import { validateOutage } from './outage.ts';
import { RECOVERY_CONTRACT, recoveryGuarantees, recoveryExpected, recoveryMutations, recoverySeed, recoverySizes, type RecoveryCase } from './recovery.ts';
import { JAZZ_EDGE_LOCAL_QUERY } from './jazz-recovery.ts';
import { validateElectricRecoveryState } from './electric-recovery.ts';
import { validateZeroRecoveryState } from './zero-recovery.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

export function validateRecoveryResult(result: Pick<BenchmarkResult, 'scenarioId' | 'status' | 'metrics' | 'metadata'> & Partial<Pick<BenchmarkResult, 'stackId'>>): void {
  const { metadata, metrics, scenarioId } = result;
  if (metadata.workloadContract !== RECOVERY_CONTRACT || !['offline-replay', 'large-offline-queue', 'offline-restart'].includes(scenarioId)) throw new ContractError('Missing or mismatched recovery contract');
  const sizes = recoverySizes(scenarioId as RecoveryCase);
  if (!Array.isArray(metadata.scales) || metadata.scales.length !== sizes.length) throw new ContractError('Missing recovery scales');
  if (JSON.stringify(metadata.fixture) !== JSON.stringify(recoverySeed)) throw new ContractError('Recovery fixture mismatch');
  const guarantees = metadata.guarantees as JsonObject;
  const expectedGuarantees = recoveryGuarantees(result.stackId, scenarioId as RecoveryCase);
  if (Object.entries(expectedGuarantees).some(([key,value]) => guarantees?.[key] !== value)
    || (scenarioId === 'offline-restart' && (guarantees.localStore !== 'persistent-file' || guarantees.queueStore !== 'persistent-file'))) throw new ContractError('Recovery guarantees missing or incompatible');

  const initial = recoveryExpected();
  const initialDigest = assertRows('expected initial', initial, initial);
  const seenDatasets = new Set<string>();
  const seenZeroClients = new Set<string>(), seenZeroStores = new Set<string>();
  for (const [index, value] of metadata.scales.entries()) {
    const scale = value as JsonObject;
    const size = sizes[index];
    if (scale.queueSize !== size || scale.acknowledgedWrites !== size || typeof scale.pendingBefore !== 'number' || scale.pendingBefore < 1 || scale.pendingAfter !== 0) throw new ContractError('Incomplete recovery queue evidence');
    for (const [field, metric] of [['localQueueCommitMs', 'local_commit_ms'], ['queueDrainMs', 'drain_ms'], ['mirrorVisibleMs', 'mirror_visible_ms']]) {
      if (typeof scale[field] !== 'number' || !Number.isFinite(scale[field]) || Number(scale[field]) < 0 || metrics[`queue_${size}_${metric}`] !== scale[field]) throw new ContractError(`Missing or inconsistent recovery ${field}`);
    }
    const expected = recoveryExpected(recoveryMutations(size));
    const expectedDigest = assertRows('expected recovered', expected, expected);
    const validation = scale.validation as JsonObject;
    if (validation?.taskCount !== recoverySeed.tasksPerProject) throw new ContractError('Recovery task count mismatch');
    for (const field of ['initialWriterDigest', 'initialReaderDigest', 'offlineReaderDigest']) if (validation[field] !== initialDigest) throw new ContractError(`Invalid recovery ${field}`);
    for (const field of ['queuedDigest', 'finalWriterDigest', 'finalReaderDigest']) if (validation[field] !== expectedDigest) throw new ContractError(`Invalid recovery ${field}`);
    if (result.stackId === 'electric' || result.stackId === 'electric-tanstack') {
      const stackId = result.stackId, tanstack = stackId === 'electric-tanstack', mutations = recoveryMutations(size);
      const check = (value: unknown, changes: typeof mutations, accepted: boolean, reopened = false, reader = false) => {
        const native = value as JsonObject;
        validateElectricRecoveryState(stackId, { rows: [], pending: accepted ? 0 : size!, rejected: null, conflicts: null, nativeState: native }, changes, accepted, reopened, reader, true);
      };
      check(scale.nativeInitial, [], true); check(scale.nativeReaderInitial, [], true);
      check(scale.nativeBefore, mutations, false); check(scale.nativeState, mutations, true, tanstack && scenarioId === 'offline-restart'); check(scale.nativeReader, mutations, true, false, true);
      const clients = scale.clients as JsonObject, writer = clients?.writerCache as JsonObject, reader = clients?.readerCache as JsonObject;
      if (scale.pendingBefore !== size || ['writerInitialPid', 'writerFinalPid', 'readerPid'].some(key => !Number.isSafeInteger(clients?.[key]) || Number(clients[key]) < 1)
        || clients.readerPid === clients.writerInitialPid || clients.readerPid === clients.writerFinalPid
        || typeof writer?.store !== 'string' || typeof reader?.store !== 'string' || writer.store === reader.store
        || (tanstack ? writer.activeRows !== 0 || writer.persistedRows !== 0 || reader.activeRows !== 0 || reader.persistedRows !== 0 || writer.collectionId === reader.collectionId || writer.outboxId === reader.outboxId : writer.rows !== 0 || reader.rows !== 0 || writer.pending !== 0 || reader.pending !== 0 || writer.id === reader.id)) throw new ContractError('Electric independent recovery client/store proof missing');
      for (const [cache, fields] of [[writer, ['nativeInitial', 'nativeBefore', 'nativeState']], [reader, ['nativeReaderInitial', 'nativeReader']]] as const) {
        for (const field of fields) { const n = scale[field] as JsonObject;
          if (n.store !== cache.store || (tanstack ? n.collectionId !== cache.collectionId || n.outboxId !== cache.outboxId : n.cacheId !== cache.id)) throw new ContractError('Electric recovery client identity changed');
        }
      }
      if (scenarioId === 'offline-restart') {
        const restart = scale.restart as JsonObject, restored = restart?.nativeState as JsonObject;
        check(restored, mutations, false, true);
        const before = scale.nativeBefore as JsonObject;
        const identities = (state: JsonObject) => (state.outbox as JsonObject[]).map(tx => ({ id: tx.id, idempotencyKey: tx.idempotencyKey, mutations: tx.mutations })).sort((a,b) => String(a.id).localeCompare(String(b.id)));
        if (restored.store !== writer.store || (tanstack
          ? restored.collectionId !== writer.collectionId || restored.outboxId !== writer.outboxId || before.queueStore !== 'sqlite-full-sync' || restored.queueStore !== 'sqlite-full-sync' || JSON.stringify((scale.nativeState as JsonObject).restoredTransactions) !== JSON.stringify(restored.restoredTransactions) || JSON.stringify(identities(restored)) !== JSON.stringify(identities(before))
          : restored.cacheId !== writer.id || JSON.stringify(restored.queue) !== JSON.stringify(before.queue))
          || restart.oldPid !== clients.writerInitialPid || restart.newPid !== clients.writerFinalPid) throw new ContractError('Electric reference restart lost stored queue identities');

      } else if (clients.writerInitialPid !== clients.writerFinalPid) throw new ContractError('Electric live writer process changed');
    }
    if (result.stackId === 'zero') {
      const ids = recoveryMutations(size).map(row => row.id);
      validateZeroRecoveryState(scale.nativeInitial as JsonObject, [], true);
      validateZeroRecoveryState(scale.nativeBefore as JsonObject, ids, false);
      validateZeroRecoveryState(scale.nativeState as JsonObject, ids, true);
      validateZeroRecoveryState(scale.nativeReaderInitial as JsonObject, [], true);
      validateZeroRecoveryState(scale.nativeReader as JsonObject, [], true);
      const clients = scale.clients as JsonObject;
      if (scale.pendingBefore !== size || ['writerInitialPid', 'writerFinalPid', 'readerPid'].some(key => !Number.isSafeInteger(clients?.[key]) || Number(clients[key]) < 1)
        || clients.writerInitialPid !== clients.writerFinalPid || clients.readerPid === clients.writerInitialPid) throw new ContractError('Zero independent live recovery process proof missing');
      for (const [cacheKey, fields] of [['writerCache', ['nativeInitial', 'nativeBefore', 'nativeState']], ['readerCache', ['nativeReaderInitial', 'nativeReader']]] as const) {
        const cache = clients[cacheKey] as JsonObject;
        if (cache?.kvStore !== 'mem' || cache.rows !== 0 || typeof cache.id !== 'string' || !cache.id || typeof cache.nativeClientId !== 'string' || typeof cache.storageKey !== 'string'
          || seenZeroClients.has(cache.nativeClientId) || seenZeroStores.has(cache.storageKey)
          || fields.some(field => { const state = scale[field] as JsonObject; return state.nativeClientId !== cache.nativeClientId || state.storageKey !== cache.storageKey; })) throw new ContractError('Zero fresh native memory client identity proof missing');
        seenZeroClients.add(cache.nativeClientId); seenZeroStores.add(cache.storageKey);
      }
    }
    if (result.stackId === 'jazz-v2') {
      const seed = scale.seeding as JsonObject, clients = scale.clients as JsonObject;
      if ('writeReceipt' in scale) throw new ContractError('Jazz recovery must not depend on controller-restored receipt state');
      if (scale.pendingBefore !== size) throw new ContractError('Jazz pending application row count differs');
      const pendingIds = recoveryMutations(size).map(row => row.id).sort();
      const checkSnapshot = (state: JsonObject | undefined, localDigest: string, edgeDigest: string, pending: string[]) => {
        if (state?.method !== 'native-tiered-local-queries' || state.nativeQueueCount !== null || JSON.stringify(state.edgeQuery) !== JSON.stringify(JAZZ_EDGE_LOCAL_QUERY) || state.taskCount !== 2_000 || state.localDigest !== localDigest || state.edgeDigest !== edgeDigest || JSON.stringify(state.pendingTaskIds) !== JSON.stringify(pending) || !Array.isArray(state.mutationErrors) || state.mutationErrors.length) throw new ContractError('Jazz native durability snapshot proof missing');
      };
      checkSnapshot(scale.nativeInitial as JsonObject, initialDigest, initialDigest, []);
      checkSnapshot(scale.nativeBefore as JsonObject, expectedDigest, initialDigest, pendingIds);
      checkSnapshot(scale.nativeState as JsonObject, expectedDigest, expectedDigest, []);
      if (scenarioId === 'offline-restart') checkSnapshot((scale.restart as JsonObject)?.nativeState as JsonObject, expectedDigest, initialDigest, pendingIds);
      if (!Number.isSafeInteger(seed?.pid) || Number(seed.pid) < 1 || seed.edgeDurable !== true || seed.taskCount !== 2_000 || seed.tasksDigest !== initialDigest || seed.exitCode !== 0 || seed.exitSignal !== null || seed.exitObservedBeforeReaderSpawn !== true || typeof seed.datasetId !== 'string' || !seed.datasetId.startsWith('startup-2000-') || seenDatasets.has(seed.datasetId) || clients?.datasetId !== seed.datasetId || typeof clients.writerStore !== 'string' || typeof clients.readerStore !== 'string' || clients.writerStore === clients.readerStore || [clients.writerStore, clients.readerStore].includes(String(seed.store)) || ['writerInitialPid', 'writerFinalPid', 'readerPid'].some(key => !Number.isSafeInteger(clients[key]) || Number(clients[key]) < 1 || clients[key] === seed.pid) || clients.readerPid === clients.writerInitialPid || clients.readerPid === clients.writerFinalPid) throw new ContractError('Jazz independent recovery seeding/client proof missing');
      seenDatasets.add(seed.datasetId);
      const restart = scale.restart as JsonObject;
      if (scenarioId === 'offline-restart' ? restart?.oldPid !== clients.writerInitialPid || restart.newPid !== clients.writerFinalPid : clients.writerInitialPid !== clients.writerFinalPid) throw new ContractError('Jazz recovery process receipts differ');
    }
    const outage = scale.outage as JsonObject;
    const before = outage?.before as JsonObject, after = outage?.after as JsonObject;
    if (outage?.method !== 'client-only-tcp-gate' || outage.healthyReaderSync !== true) throw new ContractError('Recovery outage evidence missing');
    validateOutage(before, after);
    validateRestoration(metadata.outagePolicy as JsonObject, outage.restoration as JsonObject, before, after);
    const resources = scale.resources as JsonObject;
    if (resources?.method !== 'external-ps-process-tree-v1' || !Array.isArray(resources.samples) || resources.samples.length < 1) throw new ContractError('Recovery resource evidence missing');
    if (scenarioId === 'offline-restart') {
      const restart = scale.restart as JsonObject;
      if (restart?.signal !== 'SIGKILL' || !Number.isSafeInteger(restart.oldPid) || !Number.isSafeInteger(restart.newPid) || restart.oldPid === restart.newPid || restart.sameProductStore !== true || restart.networkBlockedAtReopen !== true || restart.restoredDigest !== expectedDigest || restart.pendingAfterReopen !== scale.pendingBefore || typeof restart.reopenLocalMs !== 'number' || !Number.isFinite(restart.reopenLocalMs) || restart.reopenLocalMs < 0 || metrics[`queue_${size}_reopen_local_ms`] !== restart.reopenLocalMs) throw new ContractError('Missing actual process restart evidence');
    } else if (scale.restart !== null) throw new ContractError('Unexpected restart in live replay case');
  }
}
