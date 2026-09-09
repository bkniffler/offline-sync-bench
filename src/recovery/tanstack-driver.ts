import { validateElectricConflictReceipt } from '../contracts/electric-conflict-receipt.ts';
import { matchingDeliveryRows, pollDelivery } from '../fanout/observe.ts';
import Database from 'better-sqlite3';
import 'fake-indexeddb/auto';
import { createCollection } from '@tanstack/db';
import { electricCollectionOptions, type ElectricCollectionUtils } from '@tanstack/electric-db-collection';
import { createNodeSQLitePersistence, persistedCollectionOptions } from '@tanstack/node-db-sqlite-persistence';
import { IndexedDBAdapter, startOfflineExecutor, type OfflineTransactionAPI } from '@tanstack/offline-transactions';
import { taskRecord, hash, arrayScreenQuery, type Row } from '../contracts/screens.ts';
import type { JsonObject } from '../types.ts';
import type { RecoveryClientConfig, RecoveryDriver } from './protocol.ts';

interface Task extends Row { id: string; title: string; completed: boolean; server_version: number }
const ordered = (rows: Row[]) => rows.map(taskRecord).sort((a,b) => String(a.id).localeCompare(String(b.id)));
export async function createTanStackRecoveryDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (!config.appBaseUrl || config.reopen) throw new Error('TanStack recovery requires an application route and a live process; fake-indexeddb cannot reopen a queue');
  const database = new Database(config.dbPath), abort = new AbortController();
  const collectionId = `${config.clientId}-tasks`, outboxId = `${config.clientId}-outbox`;
  const options = persistedCollectionOptions<Task, string | number, never, ElectricCollectionUtils<Task>>({
    ...electricCollectionOptions<Task>({ id: collectionId, getKey: row => row.id,
      shapeOptions: { url: `${config.appBaseUrl}/benchmark/shape/tasks`, params: { userId: config.actorId }, signal: abort.signal,
        parser: { int8: (value: string) => Number(value) } },
    }), persistence: createNodeSQLitePersistence({ database }), schemaVersion: 1,
  });
  const persistence = options.persistence.adapter;
  if (!persistence.scanRows) { database.close(); throw new Error('TanStack persistence cannot expose complete rows'); }
  const persisted = async () => (await persistence.scanRows!(collectionId)).map(row => row.value);
  const tasks = createCollection<Task, string | number, ElectricCollectionUtils<Task>>(options);
  const initialCache = { collectionId, outboxId, store: config.dbPath, activeRows: tasks.size, persistedRows: (await persisted()).length };
  const storage = new IndexedDBAdapter(outboxId, 'transactions');
  const delivery = { method: 'tanstack-native-electric-stream', connects: 0, pauses: 0, observations: 0 };
  const started = performance.now(), attempts: JsonObject[] = [], errors: string[] = [];
  const issued: { id: string; taskId: string; settled: boolean; operation?: string }[] = [], commits: Promise<unknown>[] = [];
  let closed = false, wrote = false;
  const executor = startOfflineExecutor({ collections: { tasks }, storage,
    mutationFns: { syncTasks: async ({ transaction, idempotencyKey }) => {
      const attempt: JsonObject = { id: transaction.id, idempotencyKey, startMs: performance.now() - started, taskIds: transaction.mutations.map(m => String(m.key)), status: 'pending' };
      attempts.push(attempt);
      try {
        const mutation = transaction.mutations[0];
        if (config.conflicts && (transaction.mutations.length !== 1 || !['update', 'delete'].includes(mutation!.type))) throw new Error('Conflict transaction requires one native update or delete');
        const operation = mutation?.type;
        const response = await fetch(`${config.appBaseUrl}/benchmark/tasks/${config.conflicts ? 'conflict' : 'batch'}`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify(config.conflicts ? { taskId: String(mutation!.key), operation, title: (mutation!.modified as Task).title } : { updates: transaction.mutations.map(m => ({ taskId: String(m.key), title: (m.modified as Task).title, completed: (m.modified as Task).completed })) }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
        });
        if (!response.ok) throw new Error(`Mutation HTTP ${response.status}`);
        const result = await response.json() as JsonObject;
        if (config.conflicts) { validateElectricConflictReceipt(result, { taskId: String(mutation!.key), operation: operation!, idempotencyKey }); attempt.conflictReceipt = result; }
        else if (!Number.isSafeInteger(result.txid) || (result.replayed !== true && result.updated !== transaction.mutations.length)) throw new Error('Mutation response lacks complete update/transaction receipt');
        attempt.serverAcceptedMs = performance.now() - started; attempt.txid = result.txid!; attempt.replayed = result.replayed === true;
        if (config.conflicts && result.affectedRows === 0) {
          // A SQL no-op emits no task change to the shape. Native transaction
          // completion releases optimism; the controller still requires full
          // persisted/active and independent-client convergence afterward.
          attempt.shapeAcknowledgment = 'no-task-change; application receipt only';
        } else { await tasks.utils.awaitTxId(Number(result.txid), 60_000); if (config.conflicts) attempt.shapeAcknowledgment = 'native-awaitTxId'; }
        attempt.status = 'success'; attempt.appliedMs = performance.now() - started;
      } catch (error) { attempt.status = 'retry-error'; attempt.error = String(error); throw error; }
    } },
    // Node has no browser connectivity events. Do not suppress attempted writes;
    // native retry/backoff handles the TCP outage without a harness wakeup.
    onlineDetector: { isOnline: () => true, subscribe: () => () => {}, notifyOnline: () => {}, dispose: () => {} },
    leaderElection: { requestLeadership: async () => true, releaseLeadership: () => {}, isLeader: () => true, onLeadershipChange: () => () => {} },
    jitter: false,
  });
  await executor.waitForInit();
  if (!executor.isOfflineEnabled || initialCache.activeRows || initialCache.persistedRows || (await executor.peekOutbox()).length) throw new Error('TanStack recovery client is not fresh or offline executor unavailable');
  const check = () => { if (closed || errors.length) throw Object.assign(new Error(`TanStack recovery failed: ${errors.join('; ') || 'closed'}`), { evidence: { tanstackRecovery: { errors: [...errors], attempts: [...attempts] } } }); };
  const wait = async (predicate: () => Promise<boolean>, label: string) => {
    const deadline = performance.now() + 90_000;
    while (!await predicate()) { check(); if (performance.now() > deadline) throw new Error(`TanStack ${label} timed out`); await new Promise(resolve => setTimeout(resolve, 10)); }
    check();
  };
  const queue = async () => (await executor.peekOutbox()).map(tx => ({ id: tx.id, idempotencyKey: tx.idempotencyKey, mutationFnName: tx.mutationFnName,
    retryCount: tx.retryCount, nextAttemptAt: tx.nextAttemptAt, mutations: tx.mutations.map(m => ({ taskId: String(m.key), type: m.type,
      original: taskRecord(m.original) as JsonObject, modified: taskRecord(m.modified) as JsonObject })) }));
  const commit = (tx: OfflineTransactionAPI, taskId: string, operation: string) => {
    const receipt = { id: tx.id, taskId, settled: false, ...(config.conflicts ? { operation } : {}) }; issued.push(receipt);
    const pending = tx.commit().then(() => { receipt.settled = true; }).catch(error => { errors.push(String(error)); throw error; });
    void pending.catch(() => {}); commits.push(pending);
    return pending;
  };
  return {
    rows: async () => tasks.toArray.map(taskRecord), count: async () => tasks.size,
    firstScreen: async () => arrayScreenQuery('list', { tasks: tasks.toArray }),
    pending: async () => (await executor.peekOutbox()).length,
    read: async () => { if (config.fanout) await wait(async () => hash(ordered(await persisted())) === hash(ordered(tasks.toArray)), 'local cache snapshot'); const outbox = await queue(); return { rows: tasks.toArray.map(taskRecord), pending: outbox.length, rejected: errors.length, conflicts: null,
      nativeState: { ...(config.fanout ? { delivery: { ...delivery } } : {}), method: 'tanstack-native-outbox-v1', collectionId, outboxId, store: config.dbPath, queueStore: 'fake-indexeddb-memory',
        outbox, issued: issued.map(i => ({ ...i })), schedulerPending: executor.getPendingCount(), schedulerRunning: executor.getRunningCount(),
        persistedRows: (await persisted()).map(row => taskRecord(row) as JsonObject), attempts: attempts.map(a => ({ ...a })), errors: [...errors] } }; },
    write: async mutations => {
      check(); if (wrote && !config.fanout) throw new Error('One write group per fresh TanStack recovery client'); wrote = true;
      for (const mutation of mutations) {
        const tx = executor.createOfflineTransaction({ mutationFnName: 'syncTasks', autoCommit: false }) as OfflineTransactionAPI;
        tx.mutate(() => { tasks.update(mutation.id, draft => { draft.title = mutation.title; draft.server_version = 2; }); });
        commit(tx, mutation.id, 'update');
      }
      // Fanout writes online, including a completed readiness group. Its clock
      // spans the whole write, so use native server/shape commit completion.
      // Already-drained transactions cannot remain in the serialized outbox.
      if (config.fanout || config.conflictRole === 'peer') { await Promise.all(commits); check(); return; }
      // commit() waits for eventual upload. Local acknowledgment instead requires
      // the SDK's complete serialized outbox to contain every native transaction.
      await wait(async () => { const all = await executor.peekOutbox(); return all.length === issued.length && issued.every(i => all.some(tx => tx.id === i.id)); }, 'local outbox acknowledgment');
    },
    sync: async () => {
      check(); await tasks.preload(); await Promise.all(commits);
      await wait(async () => (await executor.peekOutbox()).length === 0 && hash(ordered(await persisted())) === hash(ordered(tasks.toArray)), 'native queue and persisted cache convergence');
    },
    ...(config.fanout ? {
      connectDelivery: async () => { await tasks.preload(); check(); delivery.connects++; },
      pauseDelivery: async () => { delivery.pauses++; },
      observeDelivery: async expected => { delivery.observations++; await pollDelivery(expected, async () => { check(); return matchingDeliveryRows(expected, tasks.toArray); }); },
    } : {}),
    probeSync: async () => { await wait(async () => attempts.some(a => a.status === 'retry-error'), 'failed native upload probe'); },
    remove: async taskId => {
      check(); if (!config.conflicts || config.conflictRole !== 'peer' || wrote) throw new Error('TanStack deletion requires a fresh conflict peer');
      wrote = true;
      const tx = executor.createOfflineTransaction({ mutationFnName: 'syncTasks', autoCommit: false }) as OfflineTransactionAPI;
      tx.mutate(() => { tasks.delete(taskId); });
      await commit(tx, taskId, 'delete');
    },
    close: async () => { if (closed) return; closed = true; executor.dispose(); abort.abort(); await tasks.cleanup(); if (database.open) database.close(); },
    diagnostics: { localStorage: 'tanstack-node-sqlite-cache', initialCache, outbox: 'official offline-transactions IndexedDBAdapter using fake-indexeddb in Node memory',
      ...(config.conflicts ? { conflictPolicy: 'application SQL UPDATE/DELETE with exact persisted disposition; awaitTxId only for row changes; no-op commit still requires full independent convergence' } : {}),
      localCommit: config.fanout || config.conflictRole === 'peer' ? 'fanout write completion includes native commit, server acceptance and shape visibility; no isolated local commit timing' : 'all issued native transactions visible in peekOutbox and optimistic collection; commit promises still pending',
      sync: 'native commit completion after HTTP transaction receipt and Electric awaitTxId; complete persisted/active equality',
      connectivity: 'always-online Node detector; SDK retries actual failed requests; jitter false; one leader for each isolated outbox',
      persistence: 'SQLite cache persists confirmed data; offline queue has no process durability', authorization: 'application scoped shape and benchmark mutation endpoint' },
  };
}
