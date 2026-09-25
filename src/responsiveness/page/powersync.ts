import { PowerSyncDatabase, Schema, Table, column, type AbstractPowerSyncDatabase, type PowerSyncBackendConnector } from '@powersync/web';
import { installApp } from './app.ts';
import { LIST_SQL, powerSyncScreenIndexes, progressQuery, toTask } from './screen.ts';

// The same client schema as adapters/powersync-runner.ts.
const schema = new Schema({
  tasks: new Table({ org_id: column.text, project_id: column.text, owner_id: column.text, title: column.text, completed: column.integer, server_version: column.integer, updated_at: column.text }),
});

installApp(async config => {
  // SDK defaults, with the worker URL a bundler would emit for new URL(...).
  const db = new PowerSyncDatabase({ schema, database: { dbFilename: `${config.clientId}.sqlite`, worker: '/powersync-worker.js' }, sync: { worker: '/powersync-worker.js' } });
  await db.init();
  for (const statement of powerSyncScreenIndexes) await db.execute(statement);
  await db.database.refreshSchema();
  const connector: PowerSyncBackendConnector = {
    fetchCredentials: async () => {
      const response = await fetch(`${config.origin}/powersync-app/api/auth/token?user_id=${encodeURIComponent(config.actorId)}`);
      if (!response.ok) throw new Error(`PowerSync token endpoint failed: ${response.status}`);
      return { endpoint: config.urls.powersync, token: (await response.json()).token };
    },
    uploadData: async (_database: AbstractPowerSyncDatabase) => {},
  };
  let failure: unknown;
  db.connect(connector).catch(error => { failure = error; });
  const check = () => { if (failure) throw failure; };
  return {
    diagnostics: { storage: 'wa-sqlite (SDK default VFS)', syncThread: 'SDK default (shared sync worker when available)', queryThread: 'database worker via RPC', flags: (db as any).resolvedFlags ?? null },
    screen: async () => { check(); return (await db.getAll<Record<string, unknown>>(LIST_SQL)).map(toTask); },
    progress: async prefix => { check(); const [sql, params] = progressQuery(prefix); const row = (await db.get<Record<string, unknown>>(sql, params)); return { rows: Number(row.n), updated: Number(row.updated) }; },
    rows: async () => (await db.getAll<Record<string, unknown>>('SELECT id, title, completed FROM tasks ORDER BY id')).map(toTask),
    close: () => db.close(),
  };
}, 'powersync');
