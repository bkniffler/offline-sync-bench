import { Database } from 'bun:sqlite';
import { Shape, ShapeStream } from '@electric-sql/client';
import { taskRecord, arrayScreenQuery, type Row } from '../contracts/screens.ts';
import type { RecoveryClientConfig, RecoveryDriver } from './protocol.ts';

/** Read-only application cache fed by native Electric shapes. No write queue. */
export async function createElectricReadCacheDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (!config.appBaseUrl) throw new Error('Electric read cache requires the gated application route');
  const db = new Database(config.dbPath, { readwrite: true, create: !config.reopen });
  db.run('PRAGMA journal_mode = WAL'); db.run('PRAGMA synchronous = FULL');
  db.run('CREATE TABLE IF NOT EXISTS recovery_tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
  const rows = () => db.query<{ record: string }, []>('SELECT record FROM recovery_tasks ORDER BY id').all().map(row => JSON.parse(row.record) as Row);
  const initialCache = { id: config.clientId, store: config.dbPath, rows: rows().length, pending: 0, reopened: config.reopen === true };
  if (config.reopen ? initialCache.rows === 0 : initialCache.rows !== 0) { db.close(); throw new Error('Electric application cache initialization differs from lifecycle'); }
  const abort = new AbortController();
  let stream: ShapeStream | undefined, shape: Shape | undefined;
  let unsubscribe: (() => void) | undefined;
  const remoteRows = () => shape?.currentRows ?? [];
  const upsert = db.query('INSERT INTO recovery_tasks(id,record) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record');
  const remove = db.query('DELETE FROM recovery_tasks WHERE id = ?');
  let closed = false, failure: string | null = null;
  const apply = db.transaction(() => {
    const local = new Map(rows().map(row => [String(row.id), JSON.stringify(row)]));
    for (const raw of remoteRows()) {
      const row = taskRecord(raw), id = String(row.id), serialized = JSON.stringify(row);
      if (local.get(id) !== serialized) upsert.run(id, serialized);
      local.delete(id);
    }
    for (const id of local.keys()) remove.run(id);
  });
  const connect = () => {
    if (shape) return shape;
    stream = new ShapeStream({ url: `${config.appBaseUrl}/benchmark/shape/tasks`, params: { userId: config.actorId }, signal: abort.signal,
      parser: { int8: (value: string) => Number(value) } });
    shape = new Shape(stream);
    unsubscribe = shape.subscribe(() => { if (!closed) try { apply(); } catch (error) { failure = String(error); } });
    return shape;
  };
  // A restored cache must be readable without starting a remote shape snapshot.
  // Reconnect begins only when the controller calls sync / connectDelivery.
  if (!config.reopen) connect();
  const check = () => { if (closed || failure) throw new Error(`Electric read cache failed: ${failure ?? 'closed'}`); };
  const unsupported = async () => { throw new Error('Electric client writes are not supported'); };
  return {
    rows: async () => rows(), count: async () => rows().length, firstScreen: async () => arrayScreenQuery('list', { tasks: rows() }), pending: async () => 0,
    read: async () => { check(); return { rows: rows(), pending: 0, rejected: null, conflicts: null }; },
    write: unsupported, remove: unsupported, probeSync: unsupported,
    sync: async () => { check(); await connect().rows; check(); apply(); },
    close: async () => { if (closed) return; closed = true; abort.abort(); unsubscribe?.(); shape?.unsubscribeAll(); stream?.unsubscribeAll(); db.close(); },
    diagnostics: { localStorage: 'benchmark-sqlite-cache', initialCache,
      persistence: 'read-only application SQLite cache; WAL with synchronous FULL', sync: 'native Electric Shape delivery' },
  };
}
