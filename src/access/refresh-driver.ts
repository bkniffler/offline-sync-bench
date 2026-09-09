import type { ElectricCollectionUtils } from '@tanstack/electric-db-collection';
import { rm, access } from 'node:fs/promises';
import { Shape, ShapeStream } from '@electric-sql/client';
import { assertRows, taskRecord, type Row } from '../contracts/screens.ts';
import type { RecoveryClientConfig, RecoveryDriver } from '../recovery/protocol.ts';
import type { JsonObject } from '../types.ts';

/** Application-managed replacement of a scoped cache. This is deliberately
 * separate from native permission purge within a persistent replica. */
export async function createAccessRefreshDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  let rows: () => Row[] = () => [], dispose: (() => Promise<void>) | undefined;
  let generation = 0, cache: JsonObject = {}, persisted: (() => Promise<Row[]>) | undefined;
  const sqlite = config.stackId === 'electric-tanstack';
  const readonly = async () => { throw new Error('This driver implements only read-only access refresh'); };
  const readPersisted = async () => {
    const current = rows().map(taskRecord);
    if (persisted) cache.persistedDigest = assertRows('persisted replacement cache', (await persisted()).map(taskRecord), current);
    return current;
  };
  return {
    rows: async () => rows(), firstScreen: async () => rows().slice(0, 50), count: async () => rows().length,
    pending: async () => 0, write: readonly, remove: readonly, probeSync: readonly,
    read: async () => ({ rows: await readPersisted(), pending: 0, rejected: null, conflicts: null, nativeState: { accessCache: { ...cache } } }),
    sync: async () => {
      const hadCache = generation > 0;
      if (dispose) await dispose();
      dispose = undefined; rows = () => []; persisted = undefined;
      if (sqlite && hadCache) {
        for (const suffix of ['', '-wal', '-shm']) await rm(`${config.dbPath}${suffix}`, { force: true });
        for (const suffix of ['', '-wal', '-shm']) {
          try { await access(`${config.dbPath}${suffix}`); throw new Error('Old cache file survived application reset'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      generation++;
      cache = { generation, kind: sqlite ? 'sqlite' : 'memory', store: sqlite ? config.dbPath : config.clientId,
        previousCacheDisposed: hadCache, previousFileRemoved: sqlite && hadCache ? true : null };
      const shapeOptions = { url: `${config.appBaseUrl}/benchmark/shape/tasks`, params: { userId: config.actorId }, subscribe: false, parser: { int8: (value: string) => Number(value) } };
      if (!sqlite) {
        const abort = new AbortController();
        const stream = new ShapeStream({ ...shapeOptions, signal: abort.signal });
        const shape = new Shape(stream);
        dispose = async () => { abort.abort(); shape.unsubscribeAll(); stream.unsubscribeAll(); };
        await shape.rows; rows = () => shape.currentRows as Row[];
      } else {
        const [{ default: Database }, { createCollection }, { electricCollectionOptions }, { createNodeSQLitePersistence, persistedCollectionOptions }] = await Promise.all([
          import('better-sqlite3'), import('@tanstack/db'), import('@tanstack/electric-db-collection'), import('@tanstack/node-db-sqlite-persistence'),
        ]);
        const database = new Database(config.dbPath);
        const persistence = createNodeSQLitePersistence({ database });
        const id = `${config.clientId}-tasks`;
        const options = persistedCollectionOptions<Row, string | number, never, ElectricCollectionUtils<Row>>({ ...electricCollectionOptions<Row>({ id, shapeOptions, getKey: (row: Row) => String(row.id) }), persistence, schemaVersion: 1 });
        const collection = createCollection<Row, string | number, ElectricCollectionUtils<Row>>(options);
        dispose = async () => { await collection.cleanup(); if (database.open) database.close(); };
        await collection.preload(); rows = () => [...collection.values()] as Row[];
        const adapter = options.persistence.adapter;
        if (!adapter.scanRows) throw new Error('SQLite persistence adapter lacks native row inspection');
        persisted = async () => (await adapter.scanRows!(id)).map(row => row.value);
        const deadline = performance.now() + 30_000;
        while (true) {
          const stored = await persisted();
          if (stored.length === rows().length) { await readPersisted(); break; }
          if (performance.now() > deadline) throw new Error('Replacement cache persistence timed out');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    },
    close: async () => { await dispose?.(); dispose = undefined; },
    diagnostics: { localStorage: sqlite ? 'tanstack-node-sqlite-cache' : 'electric-shape-memory', authorization: 'benchmark application derives server shape from actor memberships', refresh: 'application disposes prior scoped cache and creates a fresh snapshot; native purge is not claimed' },
  };
}
