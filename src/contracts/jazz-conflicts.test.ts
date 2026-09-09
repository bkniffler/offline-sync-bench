import { expect, test } from 'bun:test';
import type { JsonObject } from '../types.ts';
import { validateJazzConflictEvidence } from './jazz-conflicts.ts';
import { assertRows, fixtureTasks } from './screens.ts';
import { conflictRows, offlineTitle, peerTitle, conflictTarget, type ConflictCase } from './conflicts.ts';
import { JAZZ_EDGE_LOCAL_QUERY, jazzPendingRows } from './jazz-recovery.ts';
import { recoverySeed } from './recovery.ts';

function fixture(scenario: ConflictCase = 'conflict-update-update') {
  const initial = fixtureTasks(recoverySeed), queued = conflictRows(offlineTitle), final = conflictRows(scenario === 'conflict-update-delete' ? null : peerTitle);
  const receipt = (role: string, accepted = true) => ({ taskId: conflictTarget, nativeId: 'native-task', batchId: `${role}-batch`, operation: role === 'peer' && scenario === 'conflict-update-delete' ? 'delete' : 'update', local: 'success', edge: accepted ? 'success' : 'pending' });
  const native = (local: typeof initial, edge: typeof initial, role?: string, accepted = true) => ({ method: 'native-tiered-local-queries', nativeQueueCount: null, edgeQuery: JAZZ_EDGE_LOCAL_QUERY, receiptMethod: 'immediate-native-write-handle-edge-wait', receipts: role ? [receipt(role, accepted)] : [], edgeRows: edge, pendingTaskIds: jazzPendingRows(local, edge), mutationErrors: [] });
  return {
    clientStorage: 'product persistent store and queue',
    seeding: { pid: 50, parentPid: 10, store: '/seed', datasetId: 'startup-2000-test', taskCount: 2_000, tasksDigest: assertRows('seed', initial, initial), edgeDurable: true, exitCode: 0, exitSignal: null, exitedAt: '2026-09-06T00:00:00.000Z', exitObservedBeforeReaderSpawn: true, productVersion: 'test-version' },
    clients: ['writer', 'peer', 'observer'].map((role, i) => ({ role, pid: 51 + i, clientId: role, store: `/${role}`, diagnostics: { productVersion: 'test-version', reader: { pid: 51 + i, parentPid: 10, store: `/${role}`, datasetId: 'startup-2000-test', initialRows: 0, transportConnectedAtInitialization: false } }, initialNative: native(initial, initial), finalNative: native(final, final, role === 'observer' ? undefined : role) })),
    nativeQueued: native(queued, initial, 'writer', false), nativeIsolated: native(queued, initial, 'writer', false),
    nativeAcceptedPeer: native(final, final), writerOutcome: { nativeState: native(final, final, 'writer') },
  };
}

test('Jazz conflict success requires actual losing-write receipts and independent full edge data', () => {
  const valid = fixture();
  expect(() => validateJazzConflictEvidence(valid as unknown as JsonObject, 'conflict-update-update')).not.toThrow();
  for (const change of [
    (m: typeof valid) => { m.clients[0].finalNative.receipts[0].edge = 'pending'; },
    (m: typeof valid) => { m.nativeQueued.receipts[0].batchId = 'different-batch'; },
    (m: typeof valid) => { m.nativeQueued.receipts[0].edge = 'success'; },
    (m: typeof valid) => { m.clients[2].finalNative.edgeRows[1999].title = 'wrong untouched task'; },
    (m: typeof valid) => { m.clients[1].finalNative.receipts[0].nativeId = 'different-task'; },
    (m: typeof valid) => { m.seeding.exitObservedBeforeReaderSpawn = false; },
    (m: typeof valid) => { m.clients[0].pid = m.seeding.pid; },
    (m: typeof valid) => { m.writerOutcome.nativeState.receipts = []; },
  ]) {
    const invalid = structuredClone(valid); change(invalid);
    expect(() => validateJazzConflictEvidence(invalid as unknown as JsonObject, 'conflict-update-update')).toThrow();
  }
});

test('Jazz delete receipt success cannot conceal a retained row in one edge view', () => {
  const valid = fixture('conflict-update-delete');
  expect(() => validateJazzConflictEvidence(valid as unknown as JsonObject, 'conflict-update-delete')).not.toThrow();
  const invalid = structuredClone(valid);
  invalid.clients[0].finalNative.edgeRows = conflictRows(offlineTitle);
  expect(() => validateJazzConflictEvidence(invalid as unknown as JsonObject, 'conflict-update-delete')).toThrow('1999');
});
