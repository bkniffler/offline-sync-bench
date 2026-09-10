import { PowerSyncDatabase, Schema, Table, column, WASQLiteVFS } from '@powersync/web';
(globalThis as any).sizeProbe = async (phase: string) => {
 const db = new PowerSyncDatabase({ schema: new Schema({ tasks: new Table({ title: column.text }) }),
  database: { dbFilename: 'footprint.sqlite', vfs: WASQLiteVFS.AccessHandlePoolVFS, enableMultiTabs: false, useWebWorker: true, worker: '/powersync-worker.js' } });
 try {
  await db.init();
  if (phase === 'write') await db.execute('INSERT INTO tasks (id, title) VALUES (?, ?)', ['task-1', 'footprint']);
  return { rows: await db.getAll('SELECT id, title FROM tasks ORDER BY id'), storage: 'wa-sqlite / OPFS', crud: (await db.getAll('SELECT * FROM ps_crud')).length };
 } finally { await db.close(); }
};
