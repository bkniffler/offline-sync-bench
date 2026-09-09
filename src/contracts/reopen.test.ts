import { expect, test } from 'bun:test';
import { fixtureTasks, arrayScreenQuery, assertRows } from './screens.ts';
import { recoverySeed } from './recovery.ts';
import { reopenProfile, validateReopenResult } from './reopen.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

function fixture(): Pick<BenchmarkResult, 'scenarioId' | 'metrics' | 'metadata'> {
  const rows = fixtureTasks(recoverySeed), screen = arrayScreenQuery('list', { tasks: rows });
  const digest = assertRows('rows', rows, rows);
  return { scenarioId: 'replica-reopen', metrics: { reopen_process_ms: 10, reopen_first_screen_ms: 20, reopen_all_rows_ms: 30 }, metadata: {
    workloadContract: 'persisted-replica-reopen-v1', fixture: recoverySeed, reopenProfile,
    validation: { initialDigest: digest, reopenedDigest: digest, screenDigest: assertRows('screen', screen, screen), taskCount: 2_000, pendingAfter: 0 },
    process: { oldPid: 10, newPid: 11, sameProductStore: true, productClosedBeforeReopen: true },
    outage: { before: { blocked: true, rejectedConnections: 0, forwardedConnections: 1, requestBytes: 100, responseBytes: 200 }, after: { blocked: true, rejectedConnections: 1, forwardedConnections: 1, requestBytes: 100, responseBytes: 200 } },
    resources: { method: 'external-ps-process-tree-v1', includeRoot: false, samples: [{ atMs: 0 }, { atMs: 30 }] },
  } };
}
test('replica startup rejects same-process caches, incomplete local data and network refetch', () => {
  expect(() => validateReopenResult(fixture())).not.toThrow();
  for (const corrupt of [
    (m: JsonObject) => { (m.resources as JsonObject).includeRoot = true; },
    (m: JsonObject) => { (m.process as JsonObject).newPid = 10; },
    (m: JsonObject) => { (m.validation as JsonObject).reopenedDigest = 'only-row-count-checked'; },
    (m: JsonObject) => { (m.validation as JsonObject).screenDigest = 'wrong-screen'; },
    (m: JsonObject) => { ((m.outage as JsonObject).after as JsonObject).responseBytes = 201; },
  ]) {
    const result = fixture(); corrupt(result.metadata);
    expect(() => validateReopenResult(result)).toThrow('Invalid measurement');
  }
  const result = fixture(); result.metrics.reopen_all_rows_ms = 1;
  expect(() => validateReopenResult(result)).toThrow('milestone');
});

test('TanStack reopen requires the same native collection and complete persisted and active data', () => {
  const base = fixture(), digest = (base.metadata.validation as JsonObject).initialDigest, store = '/fixture/replica.sqlite';
  const result = { ...base, stackId: 'electric-tanstack' as const };
  result.metadata.diagnostics = { initialCache: { activeRows: 0, persistedRows: 2_000, collectionId: 'same', store } };
  result.metadata.replicaPersistence = { store, existsBeforeReopen: true, bytesBeforeReopen: 10,
    initialDiagnostics: { initialCache: { activeRows: 0, persistedRows: 0, collectionId: 'same', store } },
    persistedInitialDigest: digest, persistedReopenedDigest: digest,
    reopenedState: { startupPersistence: { snapshot: { method: 'native-sqlite-adapter-scanRows', activeRows: 2_000, persistedRows: 2_000, store, collectionId: 'same' } } } };
  expect(() => validateReopenResult(result)).not.toThrow();
  for (const change of [
    (m: any) => { delete m.replicaPersistence; },
    (m: any) => { m.replicaPersistence.persistedReopenedDigest = 'count-only'; },
    (m: any) => { m.diagnostics.initialCache.collectionId = 'different'; },
    (m: any) => { m.diagnostics.initialCache.persistedRows = 0; },
    (m: any) => { m.replicaPersistence.reopenedState.startupPersistence.snapshot.activeRows = 50; },
  ]) { const changed = structuredClone(result); change(changed.metadata); expect(() => validateReopenResult(changed)).toThrow('proof missing'); }
});

test('Jazz reopen requires independent durable seeding and the existing dataset without transport', () => {
  const base = fixture(), digest = (base.metadata.validation as JsonObject).initialDigest, store = '/fixture/replica.sqlite', datasetId = 'startup-2000-fixture';
  const result = { ...base, stackId: 'jazz-v2' as const };
  const reader = { datasetId, store, transportConnected: false };
  const screenObservation = { method: 'native-sdk-subscription-manager-v1', initialScreenRows: 50, initialQueries: 1, subscriptions: 1 };
  result.metadata.diagnostics = { reader: { ...reader, pid: 11, initialRows: 2_000 }, screenObservation };
  result.metadata.replicaPersistence = { store, existsBeforeReopen: true, bytesBeforeReopen: 10,
    initialDiagnostics: { reader: { ...reader, pid: 10, initialRows: 0 } },
    seeding: { pid: 12, store: '/fixture/seed.sqlite', taskCount: 2_000, tasksDigest: digest, datasetId, edgeDurable: true, exitCode: 0, exitSignal: null, exitObservedBeforeReaderSpawn: true },
    initialState: { startupQuery: { edgeComplete: true, edgeRows: 2_000 } }, reopenedState: { startupQuery: { edgeComplete: false, edgeRows: null }, screenSubscription: { ...screenObservation, screenReads: 1, rows: 50 } } };
  expect(() => validateReopenResult(result)).not.toThrow();
  for (const change of [
    (m: any) => { m.replicaPersistence.seeding.pid = 10; },
    (m: any) => { m.replicaPersistence.seeding.edgeDurable = false; },
    (m: any) => { m.replicaPersistence.seeding.store = store; },
    (m: any) => { m.replicaPersistence.reopenedState.screenSubscription = null; },
    (m: any) => { m.replicaPersistence.reopenedState.screenSubscription.initialScreenRows = 0; },
    (m: any) => { m.replicaPersistence.reopenedState.screenSubscription.screenReads = 0; },
    (m: any) => { m.replicaPersistence.reopenedState.screenSubscription.subscriptions = 0; },
    (m: any) => { m.replicaPersistence.reopenedState.screenSubscription.rows = 49; },
    (m: any) => { m.diagnostics.screenObservation.method = 'fixture-cache'; },
    (m: any) => { m.diagnostics.reader.initialRows = 0; },
    (m: any) => { m.diagnostics.reader.datasetId = 'different'; },
    (m: any) => { m.replicaPersistence.reopenedState.startupQuery.edgeComplete = true; },
  ]) { const changed = structuredClone(result); change(changed.metadata); expect(() => validateReopenResult(changed)).toThrow('proof missing'); }
});
