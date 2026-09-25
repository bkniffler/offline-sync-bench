import { createSyncClientHandle } from '@syncular/client';
import { schema as generatedSchema } from '../../../stacks/syncular/syncular-app/src/syncular.generated.ts';
import { installApp } from './app.ts';
import { LIST_SQL, progressQuery, taskScreenIndexes, toTask } from './screen.ts';

const schema = { ...generatedSchema, tables: generatedSchema.tables.map(table => table.name === 'tasks' ? {
  ...table, indexes: [...table.indexes, ...Object.entries(taskScreenIndexes).map(([name, columns]) => ({ name, columns: [...columns], unique: false }))],
} : table) };

installApp(async config => {
  // The documented browser mode: the whole core (sync, apply, SQLite on OPFS)
  // runs in a dedicated worker; the page holds an async RPC handle.
  const handle = await createSyncClientHandle({
    worker: () => new Worker('/syncular-worker.js', { type: 'module' }),
    schema: schema as any, clientId: config.clientId, multiTab: false,
    database: { mode: 'persistent', name: config.clientId },
    endpoints: { syncUrl: `${config.origin}/syncular/sync`, segmentsUrl: `${config.origin}/syncular/segments`,
      realtimeUrl: `${config.urls.realtime}?actorId=${encodeURIComponent(config.actorId)}&clientId={clientId}` },
  });
  await handle.subscribe({ id: `tasks:${config.projectId}`, table: 'tasks', scopes: { project_id: [config.projectId] } });
  let syncError: unknown;
  void handle.syncUntilIdle().then(() => handle.connectRealtime()).catch(error => { syncError = error; });
  const check = () => { if (syncError) throw syncError; };
  return {
    diagnostics: { storage: 'SQLite WASM / OPFS (opfs-sahpool)', syncThread: 'dedicated worker', queryThread: 'dedicated worker via RPC', role: handle.role, delivery: 'syncUntilIdle, then realtime WebSocket' },
    screen: async () => { check(); return (await handle.query(LIST_SQL)).map(toTask); },
    progress: async prefix => { check(); const [sql, params] = progressQuery(prefix); const row = (await handle.query(sql, params))[0]!; return { rows: Number(row.n), updated: Number(row.updated) }; },
    rows: async () => (await handle.query('SELECT id, title, completed FROM tasks ORDER BY id')).map(toTask),
    close: () => handle.close(),
  };
}, 'syncular');
