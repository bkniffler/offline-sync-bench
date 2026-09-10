import { createCollection } from '@tanstack/db';
import { electricCollectionOptions, type ElectricCollectionUtils } from '@tanstack/electric-db-collection';
import { createBrowserWASQLitePersistence, openBrowserWASQLiteOPFSDatabase, persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence';
import { IndexedDBAdapter, startOfflineExecutor } from '@tanstack/offline-transactions';
type Task = Record<string, unknown> & { id: string; title: string };
(globalThis as any).sizeProbe = async (phase: string) => {
 const abort = new AbortController();
 const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: 'footprint.sqlite' });
 const persistence = createBrowserWASQLitePersistence({ database });
 const tasks = createCollection<Task, string | number, ElectricCollectionUtils<Task>>(persistedCollectionOptions<Task, string | number, never, ElectricCollectionUtils<Task>>({
  ...electricCollectionOptions<Task>({ id: 'footprint', getKey: (row: any) => row.id,
   shapeOptions: { url: `${location.origin}/shape`, params: { table: 'tasks', where: "id = 'org-1-project-1-task-000001'" }, signal: abort.signal } }),
  persistence, schemaVersion: 1,
 }));
 const executor = startOfflineExecutor({ collections: { tasks }, storage: new IndexedDBAdapter('footprint-outbox', 'transactions'), mutationFns: {
  update: async ({ transaction }) => {
   const response = await fetch('/mutations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(transaction.mutations) });
   if (!response.ok) throw new Error(`Mutation HTTP ${response.status}`);
  },
 } });
 try {
  await executor.waitForInit();
  tasks.startSyncImmediate();
  const deadline = Date.now() + 20000;
  while (tasks.size !== 1 || (await persistence.adapter.scanRows!('footprint')).length !== 1) {
   if (Date.now() > deadline) throw new Error('Persistent Electric collection did not hydrate one row');
   await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { rows: tasks.toArray.map((row: any) => ({ id: row.id, title: row.title })), storage: 'wa-sqlite / OPFS + IndexedDB outbox', offlineOutbox: executor.isOfflineEnabled, phase };
 } finally { abort.abort(); executor.dispose(); await tasks.cleanup(); await database.close?.(); }
};
