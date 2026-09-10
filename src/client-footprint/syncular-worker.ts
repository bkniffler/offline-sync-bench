import { SyncClient, httpSyncTransport } from '@syncular/client';
import { openPersistentWasmDatabase } from '@syncular/client/wasm';
const schema = { version: 1, tables: [{ name: 'tasks', primaryKey: 'id', columns: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }], scopes: ['task:{id}'] }] } as any;
self.onmessage = async ({ data: phase }) => {
 try {
  const database = await openPersistentWasmDatabase('footprint');
  const client = new SyncClient({ database, schema, clientId: 'footprint', transport: httpSyncTransport('/sync') });
  await client.start();
  if (phase === 'write') client.mutate([{ table: 'tasks', op: 'upsert', values: { id: 'task-1', title: 'footprint' } }]);
  const rows = client.query('SELECT id, title FROM tasks ORDER BY id');
  await client.close(); self.postMessage({ rows, storage: 'SQLite WASM / OPFS' });
 } catch (error) { self.postMessage({ error: String(error), stack: (error as Error).stack }); }
};
