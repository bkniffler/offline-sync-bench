import { SubscriptionManager, transformRows } from 'jazz-tools';
import { app, backendSecret, productVersion, createJazzNativeClient, queryTasks, type TaskRow } from '../adapters/jazz-native.ts';
import { screenProjectId, screenOwnerId, taskRecord } from '../contracts/screens.ts';
import type { RecoveryClientConfig, RecoveryDriver } from '../recovery/protocol.ts';

export async function createJazzStartupDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (!config.datasetId?.startsWith('startup-')) throw new Error('Jazz startup requires its independently seeded dataset');
  const startedAt = new Date().toISOString();
  const client = createJazzNativeClient(config.dbPath, config.syncBaseUrl, false);
  const full = app.tasks.where({ dataset_id: { eq: config.datasetId } });
  const screen = app.tasks.where({ dataset_id: { eq: config.datasetId }, project_id: { eq: screenProjectId }, owner_id: { eq: screenOwnerId }, completed: { eq: false } }).orderBy('external_id', 'desc').limit(50);
  const local = { tier: 'local', propagation: 'local-only' } as const;
  const initialRows = (await client.query(full, local)).length;
  if (config.reopen && initialRows === 0) { await client.shutdown(); throw new Error('Jazz reopened store contains no local dataset'); }
  if (!config.reopen && initialRows !== 0) { await client.shutdown(); throw new Error('Jazz startup store is not empty'); }
  let screenRows = await queryTasks(client, screen, local);
  const screenObservation = { method: 'native-sdk-subscription-manager-v1', initialScreenRows: screenRows.length, initialQueries: 1, subscriptions: 1 };
  const manager = new SubscriptionManager<TaskRow>();
  let updates = 0, screenReads = 0, closed = false, subscriptionError: Error | null = null;
  const subscription = client.subscribe(screen, delta => {
    if (closed) return;
    try {
      screenRows = manager.handleDelta(delta,
        row => transformRows<TaskRow>([row], app.wasmSchema, 'tasks')[0], app.wasmSchema.tasks.columns).all;
      updates++;
    } catch (error) { subscriptionError = error instanceof Error ? error : new Error(String(error)); }
  }, local);
  const check = () => { if (closed) throw new Error('Jazz startup reader is closed'); if (subscriptionError) throw subscriptionError; };
  const reader = { pid: process.pid, parentPid: process.ppid, store: config.dbPath, datasetId: config.datasetId, startedAt, initialRows, transportConnected: false };
  let edgeComplete = false, edgeRows: number | null = null;
  const rows = async () => { check(); return (await queryTasks(client, full, local)).map(row => taskRecord({ ...row, id: row.external_id })); };
  const readonly = async () => { throw new Error('The Jazz startup driver is read-only'); };
  return {
    rows,
    firstScreen: async () => { check(); screenReads++; return screenRows.map(row => ({ id: row.external_id, title: row.title, completed: Number(row.completed) })); },
    count: async () => { check(); return (await client.query(full, local)).length; },
    pending: async () => 0,
    read: async () => ({ rows: await rows(), pending: 0, rejected: null, conflicts: null, nativeState: { startupQuery: { edgeComplete, edgeRows }, screenSubscription: { ...screenObservation, updates, screenReads, rows: screenRows.length, managerRows: manager.size } } }),
    sync: async () => {
      client.connectTransport(config.syncBaseUrl, { backend_secret: backendSecret });
      edgeRows = (await client.query(full, { tier: 'edge', propagation: 'full' })).length;
      check(); edgeComplete = true;
    },
    write: readonly, remove: readonly, probeSync: readonly,
    close: async () => {
      if (closed) return; closed = true;
      try { client.unsubscribe(subscription); } finally { manager.clear(); screenRows = []; await client.shutdown(); }
    },
    diagnostics: { localStorage: 'jazz-napi-sqlite-file', productVersion, reader, screenObservation,
      queryEngine: 'native local filtered/ordered/limited subscription with SDK delta materialization; one initial local screen query before transport; native full local query result length for count; no native aggregate count API',
      initialization: config.reopen ? 'persistent NAPI runtime reopened with local dataset present and no transport connection' : 'persistent NAPI runtime constructed and empty local query verified before transport connection',
      idMapping: 'canonical task ID stored in external_id; product ID remains random',
      authorization: 'backend-secret benchmark client with allow-all task policy; no end-user authorization claim',
      seeding: 'separate process; native edge durability and observed exit before reader launch' },
  };
}
