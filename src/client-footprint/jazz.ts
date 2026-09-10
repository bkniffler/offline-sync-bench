import { createDb, schema } from 'jazz-tools';
const app = schema.defineApp({ tasks: schema.table({ external_id: schema.string(), title: schema.string() }) });
(globalThis as any).sizeProbe = async (phase: string) => {
 const db = await createDb({ appId: 'footprint', driver: { type: 'persistent', dbName: 'footprint' },
  runtimeSources: { wasmUrl: '/jazz_wasm_bg.wasm', workerUrl: '/jazz-worker.js', brokerWorkerUrl: '/jazz-broker-worker.js' } });
 try {
  if (phase === 'write') await db.insert(app.tasks, { external_id: 'task-1', title: 'footprint' }).wait({ tier: 'local' });
  return { rows: (await db.all(app.tasks, { tier: 'local', propagation: 'local-only' })).map(row => ({ id: row.external_id, title: row.title })), storage: 'Jazz WASM / OPFS' };
 } finally { await db.shutdown(); }
};
