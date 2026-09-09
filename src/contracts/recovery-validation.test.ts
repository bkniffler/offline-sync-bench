import { recoveryOutageFixture, recoveryPolicy } from '../test-fixtures/recovery-outage.ts';
import { expect, test } from 'bun:test';
import { assertRows } from './screens.ts';
import { RECOVERY_CONTRACT, recoveryExpected, recoveryMutations, recoverySeed } from './recovery.ts';
import { JAZZ_EDGE_LOCAL_QUERY, jazzPendingRows, validateJazzRecoveryState } from './jazz-recovery.ts';
import { validateRecoveryResult } from './recovery-validation.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

function fixture(): Pick<BenchmarkResult, 'scenarioId' | 'status' | 'metrics' | 'metadata'> {
  const initial = recoveryExpected(), final = recoveryExpected(recoveryMutations(1_000));
  const initialDigest = assertRows('initial', initial, initial), finalDigest = assertRows('final', final, final);
  return { scenarioId: 'offline-restart', status: 'completed', metrics: { queue_1000_local_commit_ms: 1, queue_1000_drain_ms: 2, queue_1000_mirror_visible_ms: 3, queue_1000_reopen_local_ms: 4 },
    metadata: { outagePolicy: recoveryPolicy(), guarantees: { localStore: 'persistent-file', queueStore: 'persistent-file', offlineQueue: 'product-managed', restart: 'SIGKILL-and-reopen-offline' }, workloadContract: RECOVERY_CONTRACT, fixture: recoverySeed, scales: [{ queueSize: 1_000, acknowledgedWrites: 1_000, pendingBefore: 1_000, pendingAfter: 0,
      localQueueCommitMs: 1, queueDrainMs: 2, mirrorVisibleMs: 3,
      validation: { taskCount: 2_000, initialWriterDigest: initialDigest, initialReaderDigest: initialDigest, offlineReaderDigest: initialDigest, queuedDigest: finalDigest, finalWriterDigest: finalDigest, finalReaderDigest: finalDigest },
      outage: recoveryOutageFixture(),
      restart: { signal: 'SIGKILL', oldPid: 101, newPid: 102, sameProductStore: true, networkBlockedAtReopen: true, restoredDigest: finalDigest, pendingAfterReopen: 1_000, reopenLocalMs: 4 },
      resources: { method: 'external-ps-process-tree-v1', samples: [{ atMs: 0 }] },
    }] } };
}
test('publication rejects same-process reopen, missing writes and a leaky outage', () => {
  expect(() => validateRecoveryResult(fixture())).not.toThrow();
  for (const corrupt of [
    (scale: JsonObject) => { (scale.restart as JsonObject).newPid = 101; },
    (scale: JsonObject) => { (scale.restart as JsonObject).signal = 'SIGTERM'; },
    (scale: JsonObject) => { (scale.restart as JsonObject).restoredDigest = 'wrong'; },
    (scale: JsonObject) => { (scale.validation as JsonObject).finalReaderDigest = 'wrong'; },
    (scale: JsonObject) => { ((scale.outage as JsonObject).after as JsonObject).requestBytes = 101; },
  ]) {
    const result = fixture(); corrupt((result.metadata.scales as JsonObject[])[0]);
    expect(() => validateRecoveryResult(result)).toThrow('Invalid measurement');
  }
});

test('Jazz restart requires complete native local and deferred edge durability evidence', () => {
  const result = { ...fixture(), stackId: 'jazz-v2' as const }, scale = (result.metadata.scales as JsonObject[])[0];
  const validation = scale.validation as JsonObject;
  const ids = recoveryMutations(1_000).map(row => row.id).sort();
  const state = (localDigest: JsonObject[string], edgeDigest: JsonObject[string], pending: string[]) => ({ method: 'native-tiered-local-queries', nativeQueueCount: null,
    edgeQuery: JAZZ_EDGE_LOCAL_QUERY, taskCount: 2_000, localDigest, edgeDigest, pendingTaskIds: [...pending], mutationErrors: [] });
  scale.nativeInitial = state(validation.initialWriterDigest, validation.initialWriterDigest, []);
  scale.nativeBefore = state(validation.queuedDigest, validation.initialWriterDigest, ids);
  scale.nativeState = state(validation.finalWriterDigest, validation.finalWriterDigest, []);
  (scale.restart as JsonObject).nativeState = state(validation.queuedDigest, validation.initialWriterDigest, ids);
  const datasetId = 'startup-2000-fixture';
  scale.clients = { writerInitialPid: 101, writerFinalPid: 102, readerPid: 103, writerStore: '/writer', readerStore: '/reader', datasetId };
  scale.seeding = { pid: 104, store: '/seed', datasetId, taskCount: 2_000, tasksDigest: validation.initialWriterDigest, edgeDurable: true, exitCode: 0, exitSignal: null, exitObservedBeforeReaderSpawn: true };
  expect(() => validateRecoveryResult(result)).not.toThrow();
  for (const change of [
    (s: any) => { s.writeReceipt = { mutations: [{ title: 'reconstructed outbox' }] }; },
    (s: any) => { s.nativeState.edgeDigest = s.validation.initialWriterDigest; },
    (s: any) => { s.restart.nativeState.localDigest = s.validation.initialWriterDigest; },
    (s: any) => { s.restart.nativeState.edgeDigest = s.validation.finalWriterDigest; },
    (s: any) => { s.nativeBefore.pendingTaskIds.pop(); },
    (s: any) => { s.nativeBefore.edgeQuery.localUpdates = 'immediate'; },
    (s: any) => { s.nativeBefore.nativeQueueCount = 1_000; },
    (s: any) => { s.nativeBefore.mutationErrors = [{ code: 'rejected' }]; },
    (s: any) => { s.seeding.pid = 101; },
    (s: any) => { s.clients.writerStore = '/reader'; },
  ]) { const changed = structuredClone(result); change((changed.metadata.scales as JsonObject[])[0]); expect(() => validateRecoveryResult(changed)).toThrow('Jazz'); }
});

test('Jazz controller validates actual edge rows before retaining compact evidence', () => {
  const mutations = recoveryMutations(1_000), rows = recoveryExpected(mutations), edgeRows = recoveryExpected();
  const pendingTaskIds = jazzPendingRows(rows, edgeRows);
  const state = { rows, pending: 1_000, rejected: 0, conflicts: null, nativeState: { method: 'native-tiered-local-queries', nativeQueueCount: null,
    edgeQuery: JAZZ_EDGE_LOCAL_QUERY, edgeRows: edgeRows as JsonObject[], pendingTaskIds, mutationErrors: [] } };
  expect(pendingTaskIds).toEqual(mutations.map(row => row.id).sort());
  expect(validateJazzRecoveryState(state, mutations, false).taskCount).toBe(2_000);
  expect(() => validateJazzRecoveryState(state, mutations, true)).toThrow('Jazz edge-durable');
  const wrong = structuredClone(state); wrong.nativeState.edgeRows[1_999].title = 'wrong untouched row';
  expect(() => validateJazzRecoveryState(wrong, mutations, false)).toThrow('Jazz edge-durable');
  const duplicate = structuredClone(state); duplicate.nativeState.edgeRows[1_999] = duplicate.nativeState.edgeRows[1_998];
  expect(() => validateJazzRecoveryState(duplicate, mutations, false)).toThrow('Jazz edge-durable');
  const invented = structuredClone(state); invented.nativeState.pendingTaskIds[0] = 'invented';
  expect(() => validateJazzRecoveryState(invented, mutations, false)).toThrow('pending application');
  const complete = { ...state, pending: 0, nativeState: { ...state.nativeState, edgeRows: rows as JsonObject[], pendingTaskIds: [] } };
  expect(validateJazzRecoveryState(complete, mutations, true).pendingTaskIds).toEqual([]);
});


test('recovery requires explicit guarantees and cannot label memory replay as persistent', () => {
  for (const guarantees of [undefined, { localStore: 'memory', queueStore: 'memory', offlineQueue: 'product-managed', restart: 'SIGKILL-and-reopen-offline' }, { localStore: 'persistent-file', queueStore: 'persistent-file', offlineQueue: 'benchmark-outbox', restart: 'SIGKILL-and-reopen-offline' }]) {
    const r = fixture();
    if (guarantees) r.metadata.guarantees = guarantees; else delete r.metadata.guarantees;
    expect(() => validateRecoveryResult(r)).toThrow('guarantees');
  }
});

test('Zero live recovery requires exact native mutation outcomes and independent clients', () => {
  const r = { ...fixture(), stackId: 'zero' as const, scenarioId: 'offline-replay' as const };
  r.metadata.guarantees = { localStore: 'memory', queueStore: 'memory', offlineQueue: 'product-managed', restart: 'live-process-replay' };
  const scale = (r.metadata.scales as JsonObject[])[0];
  const ids = recoveryMutations(10).map(m => m.id).sort(), rows = recoveryExpected(recoveryMutations(10));
  const digest = assertRows('final', rows, rows);
  scale.queueSize = scale.acknowledgedWrites = scale.pendingBefore = 10; scale.restart = null;
  const validation = scale.validation as JsonObject;
  validation.queuedDigest = validation.finalWriterDigest = validation.finalReaderDigest = digest;
  r.metrics = { queue_10_local_commit_ms: 1, queue_10_drain_ms: 2, queue_10_mirror_visible_ms: 3 };
  const state = (nativeClientId: string, acceptedIds: string[], accepted: boolean): JsonObject => ({ method: 'native-mutation-promises-v1', nativeQueueCount: null,
    nativeClientId, storageKey: nativeClientId, kvStore: 'mem', acceptedLocalTaskIds: [...acceptedIds], pendingTaskIds: accepted ? [] : [...acceptedIds],
    mutationErrors: [], receipts: acceptedIds.map(taskId => ({ taskId, client: 'success', server: accepted ? 'success' : 'pending' })), views: { all: 'complete', screen: 'complete' } });
  scale.nativeInitial = state('writer', [], true); scale.nativeBefore = state('writer', ids, false); scale.nativeState = state('writer', ids, true);
  scale.nativeReaderInitial = state('reader', [], true); scale.nativeReader = state('reader', [], true);
  const cache = (id: string) => ({ id, nativeClientId: id, storageKey: id, kvStore: 'mem', rows: 0 });
  scale.clients = { writerInitialPid: 101, writerFinalPid: 101, readerPid: 102, writerCache: cache('writer'), readerCache: cache('reader') };
  expect(() => validateRecoveryResult(r)).not.toThrow();
  for (const change of [
    (s: any) => { s.nativeBefore.receipts[0].server = 'success'; },
    (s: any) => { s.nativeState.receipts[0].server = 'pending'; },
    (s: any) => { s.nativeBefore.receipts[0].client = 'pending'; },
    (s: any) => { s.nativeBefore.pendingTaskIds.pop(); },
    (s: any) => { s.nativeBefore.receipts[0].taskId = s.nativeBefore.receipts[1].taskId; },
    (s: any) => { s.nativeState.nativeQueueCount = 0; },
    (s: any) => { s.nativeState.mutationErrors.push({ message: 'rejected' }); },
    (s: any) => { s.nativeReader.nativeClientId = 'writer'; },
    (s: any) => { s.nativeBefore.nativeClientId = 'replacement'; },
    (s: any) => { s.clients.writerCache.rows = 2000; },
    (s: any) => { s.clients.readerPid = 101; },
    (s: any) => { s.clients.writerFinalPid = 103; },
  ]) { const wrong = structuredClone(r); change((wrong.metadata.scales as JsonObject[])[0]); expect(() => validateRecoveryResult(wrong)).toThrow('Zero'); }
  r.metadata.guarantees = { localStore: 'persistent-file', queueStore: 'persistent-file', offlineQueue: 'product-managed', restart: 'live-process-replay' };
  expect(() => validateRecoveryResult(r)).toThrow('guarantees');
});
