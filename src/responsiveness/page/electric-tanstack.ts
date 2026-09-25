import { BasicIndex, createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { electricCollectionOptions, type ElectricCollectionUtils } from '@tanstack/electric-db-collection';
import { createBrowserWASQLitePersistence, openBrowserWASQLiteOPFSDatabase, persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence';
import { installApp } from './app.ts';
import { countUpdated, screenOwnerId, screenProjectId, toTask } from './screen.ts';

type Task = Record<string, unknown> & { id: string; title: string; project_id: string; owner_id: string; completed: boolean };

installApp(async config => {
  const abort = new AbortController();
  const database = await openBrowserWASQLiteOPFSDatabase({ databaseName: `${config.clientId}.sqlite` });
  const tasks = createCollection<Task, string | number, ElectricCollectionUtils<Task>>(persistedCollectionOptions<Task, string | number, never, ElectricCollectionUtils<Task>>({
    ...electricCollectionOptions<Task>({ id: `${config.clientId}-tasks`, getKey: row => row.id,
      shapeOptions: { url: `${config.origin}/electric-app/benchmark/shape/tasks`, params: { userId: config.actorId }, signal: abort.signal, parser: { int8: (value: string) => Number(value) } } }),
    persistence: createBrowserWASQLitePersistence({ database }), schemaVersion: 1,
  }));
  // The same four indexes as the native TanStack startup driver.
  for (const field of ['project_id', 'owner_id', 'completed', 'id'] as const) tasks.createIndex(task => task[field], { indexType: BasicIndex });
  const screen = createLiveQueryCollection(q => q.from({ task: tasks })
    .where(({ task }) => eq(task.project_id, screenProjectId))
    .where(({ task }) => eq(task.owner_id, screenOwnerId))
    .where(({ task }) => eq(task.completed, false))
    .select(({ task }) => ({ id: task.id, title: task.title, completed: task.completed }))
    .orderBy(({ task }) => task.id, 'desc').limit(50));
  tasks.startSyncImmediate(); screen.startSyncImmediate();
  return {
    diagnostics: { storage: 'wa-sqlite / OPFS persistence (packaged worker)', syncThread: 'main thread (collection apply); persistence writes in worker', queryThread: 'main thread (native live query, four indexes)', updatedCount: 'application scan of the collection' },
    screen: async () => screen.toArray.map(row => toTask(row as any)),
    progress: async prefix => ({ rows: tasks.size, updated: countUpdated(tasks.values() as any, prefix) }),
    rows: async () => tasks.toArray.map(row => toTask(row)),
    close: async () => { abort.abort(); await screen.cleanup(); await tasks.cleanup(); await (database as any).close?.(); },
  };
}, 'electric-tanstack');
