import { expect, test } from 'bun:test';
import { fixtureTasks, assertRows } from './screens.ts';
import { recoverySeed } from './recovery.ts';
import { conflictPolicy, conflictRows, conflictFinalRows, offlineTitle, peerTitle, conflictTarget, validateConflictResult, type ConflictCase } from './conflicts.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

function fixture(): Pick<BenchmarkResult, 'stackId' | 'scenarioId' | 'metadata' | 'metrics'> {
  const initial = fixtureTasks(recoverySeed), queued = conflictRows(offlineTitle), accepted = conflictRows(peerTitle);
  const firstDigest = assertRows('initial', initial, initial), queuedDigest = assertRows('queued', queued, queued), finalDigest = assertRows('accepted', accepted, accepted);
  return { stackId: 'syncular', scenarioId: 'conflict-update-update', metrics: { writer_settled_ms: 1, all_clients_converged_ms: 2 }, metadata: {
    workloadContract: 'conflicting-edits-v1', fixture: recoverySeed, policy: { ...conflictPolicy('syncular', 'conflict-update-update') }, pendingBefore: 1, peerAcceptedBeforeReconnect: true,
    validation: { initialTaskCount: 2_000, finalTaskCount: 2_000, initialWriter: firstDigest, initialPeer: firstDigest, initialObserver: firstDigest, queuedWriter: queuedDigest, isolatedWriter: queuedDigest, acceptedPeer: finalDigest, finalWriter: finalDigest, finalPeer: finalDigest, finalObserver: finalDigest },
    outage: { method: 'client-only-tcp-gate', before: { blocked: true, rejectedConnections: 0, forwardedConnections: 1, requestBytes: 1, responseBytes: 0 }, after: { blocked: true, rejectedConnections: 1, forwardedConnections: 1, requestBytes: 1, responseBytes: 0 } },
    writerOutcome: { pending: 0, conflicts: 1, rejected: 0, nativeState: { conflicts: [{ code: 'sync.version_conflict', rowId: conflictTarget }] } },
    resources: { method: 'external-ps-process-tree-v1', samples: [{ atMs: 0 }] },
  } };
}
test('publication requires ordering, complete validation and the predeclared conflict policy', () => {
  expect(() => validateConflictResult(fixture())).not.toThrow();
  for (const corrupt of [
    (m: JsonObject) => { m.peerAcceptedBeforeReconnect = false; },
    (m: JsonObject) => { (m.policy as JsonObject).winner = 'offline-writer'; },
    (m: JsonObject) => { (m.validation as JsonObject).finalObserver = 'matching-count-only'; },
    (m: JsonObject) => { (m.validation as JsonObject).isolatedWriter = (m.validation as JsonObject).acceptedPeer; },
    (m: JsonObject) => { delete ((m.outage as JsonObject).after as JsonObject).rejectedConnections; },
    (m: JsonObject) => { (m.writerOutcome as JsonObject).pending = 1; },
  ]) {
    const result = fixture(); corrupt(result.metadata);
    expect(() => validateConflictResult(result)).toThrow('Invalid measurement');
  }
});

function zeroFixture(scenario: ConflictCase) {
  const result = fixture(); result.stackId = 'zero'; result.scenarioId = scenario;
  const m = result.metadata, policy = conflictPolicy('zero', scenario);
  m.policy = { ...policy }; m.clientStorage = 'memory; native Zero mutation queue, no process durability';
  const digest = (rows: ReturnType<typeof conflictRows>) => assertRows('fixture', rows, rows);
  const v = m.validation as JsonObject;
  v.queuedWriter = v.isolatedWriter = digest(conflictRows(offlineTitle, 1));
  v.acceptedPeer = digest(conflictRows(scenario === 'conflict-update-delete' ? null : peerTitle, 1));
  v.finalWriter = v.finalPeer = v.finalObserver = digest(conflictFinalRows(policy));
  v.finalTaskCount = scenario === 'conflict-update-delete' ? 1_999 : 2_000;
  const native = (id: string, issued: boolean, accepted = true): JsonObject => ({ method: 'native-mutation-promises-v1', kvStore: 'mem', nativeQueueCount: null,
    nativeClientId: `native-${id}`, storageKey: `store-${id}`, mutationErrors: [], views: { all: 'complete', screen: 'complete' },
    acceptedLocalTaskIds: issued ? [conflictTarget] : [], pendingTaskIds: issued && !accepted ? [conflictTarget] : [],
    receipts: issued ? [{ taskId: conflictTarget, client: 'success', server: accepted ? 'success' : 'pending' }] : [] });
  m.clients = ['writer', 'peer', 'observer'].map((role, i) => ({ role, pid: i + 10, clientId: role, store: role,
    diagnostics: { initialCache: { id: role, kvStore: 'mem', rows: 0, nativeClientId: `native-${role}`, storageKey: `store-${role}` } },
    initialNative: native(role, false), finalNative: native(role, role !== 'observer') }));
  m.nativeQueued = native('writer', true, false); m.nativeIsolated = native('writer', true, false); m.nativeAcceptedPeer = native('observer', false);
  m.writerOutcome = { pending: 0, conflicts: null, rejected: 0, nativeState: native('writer', true) };
  m.serverBefore = m.serverAfter = { containerId: 'zero-cache', running: true, health: 'healthy' };
  return result;
}
test('Zero conflict policy retains its existing title-only patch and native independent-client evidence', () => {
  for (const scenario of ['conflict-update-update', 'conflict-update-delete'] as const) {
    const good = zeroFixture(scenario);
    expect(() => validateConflictResult(good)).not.toThrow();
    expect(conflictPolicy('zero', scenario).localVersion).toBe(1);
    for (const corrupt of [
      (m: JsonObject) => { (m.policy as JsonObject).localVersion = 2; },
      (m: JsonObject) => { (m.nativeQueued as JsonObject).pendingTaskIds = []; },
      (m: JsonObject) => { (m.nativeIsolated as JsonObject).nativeClientId = 'replacement'; },
      (m: JsonObject) => { (m.clients as JsonObject[])[1].pid = 10; },
      (m: JsonObject) => { (((m.clients as JsonObject[])[0].diagnostics as JsonObject).initialCache as JsonObject).rows = 2_000; },
      (m: JsonObject) => { ((m.writerOutcome as JsonObject).nativeState as JsonObject).receipts = []; },
      (m: JsonObject) => { m.clientStorage = 'persistent'; },
      (m: JsonObject) => { m.serverAfter = { containerId: 'replacement', running: true, health: 'healthy' }; },
    ]) { const bad = structuredClone(good); corrupt(bad.metadata); expect(() => validateConflictResult(bad)).toThrow('Invalid measurement'); }
  }
});
