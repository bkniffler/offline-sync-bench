import Database from 'better-sqlite3';
import { BasicIndex, createCollection, createLiveQueryCollection, eq, queryOnce, type InitialQueryBuilder } from '@tanstack/db';
import { electricCollectionOptions, type ElectricCollectionUtils } from '@tanstack/electric-db-collection';
import { createNodeSQLitePersistence, persistedCollectionOptions } from '@tanstack/node-db-sqlite-persistence';
import { screenOwnerId, screenProjectId, taskRecord, type Row } from '../contracts/screens.ts';
import type { RecoveryClientConfig, RecoveryDriver } from '../recovery/protocol.ts';
import type { JsonObject } from '../types.ts';
import { readPersistedSnapshot } from './persisted-snapshot.ts';

interface Task extends Row { id: string; title: string; project_id: string; owner_id: string; completed: boolean }

export async function createTanStackStartupDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (!config.appBaseUrl) throw new Error('TanStack startup requires the scoped application shape route');
  const database = new Database(config.dbPath);
  const abort = new AbortController();
  const id = `${config.clientId}-tasks`;
  const options = persistedCollectionOptions<Task, string | number, never, ElectricCollectionUtils<Task>>({
    ...electricCollectionOptions<Task>({ id, getKey: row => row.id,
      shapeOptions: { url: `${config.appBaseUrl}/benchmark/shape/tasks`, params: { userId: config.actorId },
        subscribe: false, signal: abort.signal, parser: { int8: (value: string) => Number(value) } },
    }), persistence: createNodeSQLitePersistence({ database }), schemaVersion: 1,
  });
  const adapter = options.persistence.adapter;
  if (!adapter.scanRows) { database.close(); throw new Error('TanStack SQLite adapter lacks native row inspection'); }
  const persisted = async () => (await adapter.scanRows!(id)).map(row => row.value);
  const initialPersisted = await persisted();
  const collection = createCollection<Task, string | number, ElectricCollectionUtils<Task>>(options);
  collection.createIndex(task => task.project_id, { indexType: BasicIndex });
  collection.createIndex(task => task.owner_id, { indexType: BasicIndex });
  collection.createIndex(task => task.completed, { indexType: BasicIndex });
  collection.createIndex(task => task.id, { indexType: BasicIndex });
  const initial = { collectionId: id, store: config.dbPath, activeRows: collection.size, persistedRows: initialPersisted.length };
  if (!config.reopen && (initial.activeRows !== 0 || initial.persistedRows !== 0)) { await collection.cleanup(); database.close(); throw new Error('TanStack startup cache is not empty'); }
  if (config.reopen && initial.persistedRows === 0) { await collection.cleanup(); database.close(); throw new Error('TanStack reopened store has no persisted rows'); }
  const screenQuery = (q: InitialQueryBuilder) => q.from({ task: collection })
    .where(({ task }) => eq(task.project_id, screenProjectId))
    .where(({ task }) => eq(task.owner_id, screenOwnerId))
    .where(({ task }) => eq(task.completed, false))
    .select(({ task }) => ({ id: task.id, title: task.title, completed: task.completed }))
    .orderBy(({ task }) => task.id, 'desc').limit(50);
  const offlineScreen = config.reopen ? createLiveQueryCollection(screenQuery) : null;
  if (offlineScreen) offlineScreen.startSyncImmediate();
  let snapshot: JsonObject | null = null;
  const readonly = async () => { throw new Error('The TanStack startup driver is read-only'); };
  return {
    firstScreen: async () => {
      if (offlineScreen) {
        // Native live-query state can expose restored rows before the remote
        // source is ready. queryOnce waits for preload/remote readiness.
        const deadline = performance.now() + 30_000;
        while (offlineScreen.size < 50) {
          if (performance.now() >= deadline) throw new Error('TanStack persisted screen hydration timed out');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return offlineScreen.toArray.map((row) => ({ id: row.id, title: row.title, completed: Number(row.completed) }));
      }
      return (await queryOnce(screenQuery)).map((row) => ({ id: row.id, title: row.title, completed: Number(row.completed) }));
    },
    count: async () => collection.size,
    rows: async () => {
      const count = collection.size;
      const loaded = await readPersistedSnapshot(persisted, count);
      snapshot = { method: 'native-sqlite-adapter-scanRows', collectionId: id, store: config.dbPath,
        activeRows: count, persistedRows: loaded.rows.length, scans: loaded.scans };
      return loaded.rows;
    },
    pending: async () => 0,
    read: async () => ({ rows: collection.toArray.map(taskRecord), pending: 0, rejected: null, conflicts: null,
      nativeState: { startupPersistence: { initial, snapshot } } }),
    write: readonly, remove: readonly, probeSync: readonly,
    sync: () => collection.preload(),
    close: async () => { abort.abort(); await offlineScreen?.cleanup(); await collection.cleanup(); if (database.open) database.close(); },
    diagnostics: { localStorage: 'tanstack-node-sqlite-cache', queryEngine: config.reopen ? 'native live query over product-hydrated collection; four task indexes' : 'native TanStack queryOnce with four task indexes',
      initialization: 'SQLite persistence, Electric collection and indexes constructed before preload',
      initialCache: initial, fullSnapshot: 'native persistence adapter scanRows before full-data receipt',
      authorization: 'application shape proxy derives scope from actor memberships', outbox: 'none; read-only startup does not create an offline executor' },
  };
}
