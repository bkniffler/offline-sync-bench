import { matchingDeliveryRows, pollDelivery } from '../fanout/observe.ts';
import { SubscriptionManager, transformRows, toWriteRecord, type WriteHandle } from 'jazz-tools';
import { app, backendSecret, createJazzNativeClient, productVersion, queryTasks, type TaskRow } from '../adapters/jazz-native.ts';
import { screenOwnerId, screenProjectId, taskRecord } from '../contracts/screens.ts';
import { jazzPendingRows, JAZZ_EDGE_LOCAL_QUERY } from '../contracts/jazz-recovery.ts';
import type { JsonObject } from '../types.ts';
import type { RecoveryClientConfig, RecoveryDriver } from './protocol.ts';

export async function createJazzRecoveryDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (!config.datasetId?.startsWith('startup-2000-')) throw new Error('Jazz recovery requires an independently seeded canonical dataset');
  const client = createJazzNativeClient(config.dbPath, config.syncBaseUrl, false);
  const full = app.tasks.where({ dataset_id: { eq: config.datasetId } });
  const local = { tier: 'local', propagation: 'local-only' } as const;
  const initialRows = (await client.query(full, local)).length;
  if (config.reopen ? initialRows !== 2_000 : initialRows !== 0) { await client.shutdown(); throw new Error('Jazz recovery store initialization differs from the declared lifecycle'); }
  let connected = false, wrote = false;
  const delivery = { method: 'jazz-native-edge-subscription', connects: 0, pauses: 0, observations: 0, subscriptions: 0, updates: 0 };
  const manager = new SubscriptionManager<TaskRow>();
  let deliveredRows: TaskRow[] = [], subscription: ReturnType<typeof client.subscribe> | undefined, deliveryError: Error | undefined;
  const errors: JsonObject[] = [];
  const receipts: JsonObject[] = [];
  const record = (taskId: string, nativeId: string, operation: string, handle: WriteHandle) => {
    const receipt: JsonObject = { taskId, nativeId, operation, batchId: handle.batchId, local: 'pending', edge: 'pending' };
    receipts.push(receipt);
    // Register before any local wait: a later lookup can lose historical batch evidence.
    void handle.wait({ tier: 'edge' }).then(() => { receipt.edge = 'success'; }, error => { receipt.edge = 'error'; receipt.edgeError = String(error); });
    return handle.wait({ tier: 'local' }).then(() => { receipt.local = 'success'; }, error => { receipt.local = 'error'; receipt.localError = String(error); throw error; });
  };
  client.onMutationError(event => errors.push({ batchId: event.batch.batchId, code: event.code, reason: event.reason }));
  const connect = () => { if (!connected) { client.connectTransport(config.syncBaseUrl, { backend_secret: backendSecret }); connected = true; } };
  const canonical = (data: Awaited<ReturnType<typeof queryTasks>>) => data.map(row => taskRecord({ ...row, id: row.external_id }));
  const rows = async () => canonical(await queryTasks(client, full, local));
  const snapshot = async () => {
    const localRows = await rows();
    const edgeRows = canonical(await queryTasks(client, full, JAZZ_EDGE_LOCAL_QUERY));
    const pendingTaskIds = jazzPendingRows(localRows, edgeRows);
    return { rows: localRows, pending: config.conflicts ? receipts.filter(r => r.edge === 'pending').length : pendingTaskIds.length, rejected: errors.length, conflicts: null,
      nativeState: { ...(config.conflicts ? { receipts: receipts.map(r => ({ ...r })), receiptMethod: 'immediate-native-write-handle-edge-wait' } : {}), ...(config.fanout ? { delivery: { ...delivery, rows: manager.size } } : {}), method: 'native-tiered-local-queries', nativeQueueCount: null, edgeQuery: JAZZ_EDGE_LOCAL_QUERY,
        edgeRows: edgeRows as JsonObject[], pendingTaskIds, mutationErrors: [...errors] } };
  };
  return {
    rows,
    firstScreen: async () => (await queryTasks(client, app.tasks.where({ dataset_id: { eq: config.datasetId }, project_id: { eq: screenProjectId }, owner_id: { eq: screenOwnerId }, completed: { eq: false } }).orderBy('external_id', 'desc').limit(50), local)).map(row => ({ id: row.external_id, title: row.title, completed: Number(row.completed) })),
    count: async () => (await client.query(full, local)).length,
    pending: async () => (await snapshot()).pending,
    read: snapshot,
    write: async mutations => {
      if (wrote && !config.fanout) throw new Error('Jazz recovery accepts one measured write group per process');
      wrote = true;
      const ids = new Map((await queryTasks(client, full, local)).map(row => [row.external_id, row.id]));
      const handles = mutations.map(mutation => {
        const id = ids.get(mutation.id); if (!id) throw new Error('Missing canonical Jazz task');
        const handle = client.update(id, toWriteRecord({ title: mutation.title, server_version: 2, updated_at: new Date() }, app.wasmSchema, 'tasks'));
        return config.conflicts ? record(mutation.id, id, 'update', handle) : handle.wait({ tier: 'local' });
      });
      await Promise.all(handles);
    },
    remove: async taskId => {
      if (!config.conflicts || wrote) throw new Error('Jazz deletion requires a fresh conflict client');
      wrote = true;
      const row = (await queryTasks(client, full, local)).find(row => row.external_id === taskId);
      if (!row) throw new Error('Missing canonical Jazz delete target');
      await record(taskId, row.id, 'delete', client.delete(row.id));
    },
    sync: async () => {
      connect();
      const deadline = performance.now() + 90_000;
      do {
        // Deferred updates expose only edge-durable values. A full query also
        // waits for remote propagation; local-only snapshots below send no data.
        await client.query(full, { ...JAZZ_EDGE_LOCAL_QUERY, propagation: 'full' });
        const state = await snapshot();
        if (config.conflicts && receipts.some(r => r.edge === 'error' || r.local === 'error')) throw Object.assign(new Error('Jazz conflict native receipt failed'), { evidence: { state } });
        if (state.rejected) throw new Error('Jazz recovery observed a native mutation rejection');
        if (!state.pending) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (performance.now() < deadline);
      throw new Error('Jazz edge-durable application rows did not converge within 90 seconds');
    },
    ...(config.fanout ? {
      connectDelivery: async () => {
        connect(); delivery.connects++;
        if (subscription === undefined) {
          subscription = client.subscribe(full, delta => {
            try { deliveredRows = manager.handleDelta(delta, row => transformRows<TaskRow>([row], app.wasmSchema, 'tasks')[0], app.wasmSchema.tasks.columns).all; delivery.updates++; }
            catch (error) { deliveryError = error instanceof Error ? error : new Error(String(error)); }
          }, { tier: 'edge', propagation: 'full', localUpdates: 'deferred' });
          delivery.subscriptions++;
        }
      },
      pauseDelivery: async () => { client.disconnectTransport(); connected = false; delivery.pauses++; },
      observeDelivery: async expected => {
        delivery.observations++;
        await pollDelivery(expected, async () => {
          if (deliveryError) throw deliveryError;
          return matchingDeliveryRows(expected, canonical(deliveredRows));
        });
      },
    } : {}),
    probeSync: async () => {
      if (config.conflicts) {
        // Keep the native connection and its immediate receipt waiter alive.
        // The gate drops the connection and the SDK owns retry scheduling.
        await new Promise(resolve => setTimeout(resolve, 1_000));
        try { await fetch(config.syncBaseUrl, { signal: AbortSignal.timeout(2_000) }); } catch {}
        return;
      }
      // Exercise the actual native transport without creating an uncancellable
      // edge-receipt waiter that could survive into the measured recovery.
      client.disconnectTransport(); connected = false; connect();
      try { await new Promise(resolve => setTimeout(resolve, 1_000)); }
      finally { client.disconnectTransport(); connected = false; }
    },
    close: async () => { if (subscription !== undefined) client.unsubscribe(subscription); manager.clear(); deliveredRows = []; await client.shutdown(); },
    diagnostics: { localStorage: 'jazz-napi-sqlite-file', productVersion, outbox: 'native persistent Jazz batches; no harness mutation replay after reopen',
      ...(config.conflicts ? { conflicts: 'Native update and soft delete; immediate local/edge receipts for the issued write. No harness replay or tombstone repair.' } : {}),
      pendingObservation: config.conflicts ? 'unsettled immediate edge receipts for this client’s issued conflict write; aggregate native queue count unavailable' : 'canonical application rows differing between native local and deferred edge-durable views; aggregate native queue count unavailable',
      reader: { pid: process.pid, parentPid: process.ppid, store: config.dbPath, datasetId: config.datasetId, initialRows, transportConnectedAtInitialization: false },
      sync: config.conflicts ? 'native full edge query and immediate issued-write edge receipts; the controller separately verifies complete multi-client convergence' : 'native full edge query with deferred local updates, followed by local/edge snapshot convergence',
      authorization: 'backend-secret client and allow-all policy; no end-user authorization claim' },
  };
}
