import { recoveryOutageFixture, recoveryPolicy } from '../test-fixtures/recovery-outage.ts';
import { test, expect } from 'bun:test';
import { assertRows } from './screens.ts';
import { recoveryExpected, recoveryMutations, recoveryGuarantees, RECOVERY_CONTRACT, recoverySeed } from './recovery.ts';
import { validateElectricRecoveryState } from './electric-recovery.ts';
import { validateRecoveryResult } from './recovery-validation.ts';
import type { JsonObject } from '../types.ts';

for (const stack of ['electric', 'electric-tanstack'] as const) test(`${stack} recovery validates actual queued payloads, complete auxiliary data and final receipts`, () => {
  const tanstack = stack === 'electric-tanstack', changes = recoveryMutations(10), initial = recoveryExpected(), final = recoveryExpected(changes);
  const native: any = tanstack ? { method: 'tanstack-native-outbox-v1', store: '/writer', collectionId: 'writer-tasks', outboxId: 'writer-outbox', queueStore: 'fake-indexeddb-memory',
    errors: [], persistedRows: initial, issued: changes.map((m,i) => ({ id: `tx-${i}`, taskId: m.id, settled: false })),
    outbox: changes.map((m,i) => ({ id: `tx-${i}`, idempotencyKey: `key-${i}`, mutationFnName: 'syncTasks', mutations: [{ type: 'update', taskId: m.id, original: initial[i], modified: final[i] }] })),
  } : { method: 'application-sqlite-outbox-electric-shape-v1', store: '/writer', cacheId: 'writer', failure: null, remoteRows: initial,
    queue: changes.map((m,i) => ({ taskId: m.id, title: m.title, sequence: i+1, idempotencyKey: `key-${i}` })) };
  native.attempts = [{ status: 'retry-error', error: 'TCP refused' }];
  const state = { rows: final, pending: 10, rejected: null, conflicts: null, nativeState: native };
  const compact = validateElectricRecoveryState(stack, state, changes, false);
  expect(compact.auxiliaryRows).toBe(2_000);
  const field = tanstack ? 'persistedRows' : 'remoteRows';
  const wrongRows = structuredClone(state); wrongRows.nativeState[field][1_999].title = 'corrupt untouched row';
  expect(() => validateElectricRecoveryState(stack, wrongRows, changes, false)).toThrow('row 1999');
  const wrongQueue = structuredClone(state);
  if (tanstack) wrongQueue.nativeState.outbox[0].mutations[0].modified.title = 'lost edit'; else wrongQueue.nativeState.queue[0].title = 'lost edit';
  expect(() => validateElectricRecoveryState(stack, wrongQueue, changes, false)).toThrow('Invalid measurement');
  const duplicate = structuredClone(state); const q = duplicate.nativeState[tanstack ? 'outbox' : 'queue']; q[1] = q[0];
  expect(() => validateElectricRecoveryState(stack, duplicate, changes, false)).toThrow('idempotency');
  const done = structuredClone(state); done.pending = 0; done.nativeState[field] = final; done.nativeState[tanstack ? 'outbox' : 'queue'] = [];
  if (tanstack) done.nativeState.issued.forEach((i:any) => { i.settled = true; });
  expect(() => validateElectricRecoveryState(stack, done, changes, true)).toThrow('receipts incomplete');
  done.nativeState.attempts = changes.map((m,i) => ({ status: 'success', taskId: m.id, taskIds: [m.id], txid: i+1, serverAcceptedMs: 1, appliedMs: 2 }));
  const finalCompact = validateElectricRecoveryState(stack, done, changes, true); expect(finalCompact.auxiliaryRows).toBe(2_000);
  const empty = structuredClone(state); empty.rows = initial; empty.pending = 0; empty.nativeState[tanstack ? 'outbox' : 'queue'] = [];
  if (tanstack) empty.nativeState.issued = [];
  const initialCompact = validateElectricRecoveryState(stack, empty, [], true);
  const readerInitial = { ...initialCompact, store: '/reader', ...(tanstack ? { collectionId: 'reader-tasks', outboxId: 'reader-outbox' } : { cacheId: 'reader' }) };
  const readerFinal = { ...finalCompact, store: '/reader', ...(tanstack ? { collectionId: 'reader-tasks', outboxId: 'reader-outbox', issued: [], attempts: [] } : { cacheId: 'reader', attempts: [] }) };
  const cache = (id:string): JsonObject => tanstack ? { store: `/${id}`, collectionId: `${id}-tasks`, outboxId: `${id}-outbox`, activeRows: 0, persistedRows: 0 } : { store: `/${id}`, id, rows: 0, pending: 0 };
  const initialDigest = assertRows('initial', initial, initial), finalDigest = assertRows('final', final, final);
  const scale: JsonObject = { queueSize: 10, acknowledgedWrites: 10, pendingBefore: 10, pendingAfter: 0, localQueueCommitMs: 1, queueDrainMs: 2, mirrorVisibleMs: 3,
    nativeInitial: initialCompact, nativeBefore: compact, nativeState: finalCompact, nativeReaderInitial: readerInitial, nativeReader: readerFinal,
    clients: { writerInitialPid: 101, writerFinalPid: 101, readerPid: 102, writerCache: cache('writer'), readerCache: cache('reader') },
    validation: { taskCount: 2_000, initialWriterDigest: initialDigest, initialReaderDigest: initialDigest, offlineReaderDigest: initialDigest, queuedDigest: finalDigest, finalWriterDigest: finalDigest, finalReaderDigest: finalDigest },
    outage: recoveryOutageFixture(),
    restart: null, resources: { method: 'external-ps-process-tree-v1', samples: [{ atMs: 0 }] } };
  const result = { stackId: stack, scenarioId: 'offline-replay' as const, status: 'completed' as const, metrics: { queue_10_local_commit_ms: 1, queue_10_drain_ms: 2, queue_10_mirror_visible_ms: 3 },
    metadata: { outagePolicy: recoveryPolicy(), workloadContract: RECOVERY_CONTRACT, guarantees: recoveryGuarantees(stack, 'offline-replay'), fixture: recoverySeed, scales: [scale] } };
  expect(() => validateRecoveryResult(result)).not.toThrow();
  const wrong = structuredClone(result); (wrong.metadata.scales[0].nativeReader as JsonObject).store = '/writer';
  expect(() => validateRecoveryResult(wrong)).toThrow('identity changed');
  const guarantee = structuredClone(result); guarantee.metadata.guarantees.queueStore = tanstack ? 'persistent-file' : 'memory';
  expect(() => validateRecoveryResult(guarantee)).toThrow('guarantees');
});
