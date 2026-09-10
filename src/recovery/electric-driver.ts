import { validateElectricConflictReceipt } from '../contracts/electric-conflict-receipt.ts';
import { matchingDeliveryRows, pollDelivery } from '../fanout/observe.ts';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { Shape, ShapeStream } from '@electric-sql/client';
import { taskRecord, arrayScreenQuery, type Row } from '../contracts/screens.ts';
import type { JsonObject } from '../types.ts';
import type { RecoveryClientConfig, RecoveryDriver } from './protocol.ts';

type Queued = { sequence: number; taskId: string; title: string; idempotencyKey: string; operation: 'update' | 'delete' };
/** An explicit benchmark-owned reference app: SQLite cache/outbox, HTTP writes,
 * and native Electric Shape delivery. No native Electric queue is claimed. */
export async function createElectricRecoveryDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (!config.appBaseUrl) throw new Error('Electric recovery requires the gated application route');
  const db = new Database(config.dbPath, { readwrite: true, create: !config.reopen });
  db.run('PRAGMA journal_mode = WAL'); db.run('PRAGMA synchronous = FULL');
  db.run('CREATE TABLE IF NOT EXISTS recovery_tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS recovery_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT UNIQUE NOT NULL, title TEXT NOT NULL, idempotencyKey TEXT UNIQUE NOT NULL, operation TEXT NOT NULL DEFAULT \'update\')');
  const rows = () => db.query<{ record: string }, []>('SELECT record FROM recovery_tasks ORDER BY id').all().map(row => JSON.parse(row.record) as Row);
  const queue = () => db.query<Queued, []>('SELECT sequence, taskId, title, idempotencyKey, operation FROM recovery_outbox ORDER BY sequence').all();
  const initialCache = { id: config.clientId, store: config.dbPath, rows: rows().length, pending: queue().length, reopened: config.reopen === true };
  if (config.reopen ? initialCache.rows === 0 : initialCache.rows !== 0 || initialCache.pending !== 0) { db.close(); throw new Error('Electric application cache initialization differs from lifecycle'); }
  const abort = new AbortController(), started = performance.now();
  let stream: ShapeStream | undefined, shape: Shape | undefined;
  let unsubscribe: (() => void) | undefined;
  const remoteRows = () => shape?.currentRows ?? [];
  const upsert = db.query('INSERT INTO recovery_tasks(id,record) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record');
  const remove = db.query('DELETE FROM recovery_tasks WHERE id = ?');
  let closed = false, failure: string | null = null, updates = 0;
  const apply = db.transaction(() => {
    const pending = new Set(queue().map(row => row.taskId));
    const local = new Map(rows().map(row => [String(row.id), JSON.stringify(row)]));
    for (const raw of remoteRows()) {
      const row = taskRecord(raw), id = String(row.id), serialized = JSON.stringify(row);
      if (!pending.has(id) && local.get(id) !== serialized) upsert.run(id, serialized);
      local.delete(id);
    }
    for (const id of local.keys()) if (!pending.has(id)) remove.run(id);
    updates++;
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
  const delivery = { method: 'electric-shape-application-sqlite', connects: 0, pauses: 0, observations: 0 };
  const attempts: JsonObject[] = [];
  const nativeState = (): JsonObject => ({ ...(config.fanout ? { delivery: { ...delivery } } : {}), method: 'application-sqlite-outbox-electric-shape-v1', store: config.dbPath, cacheId: config.clientId,
    queue: queue().map(q => ({ ...q })), remoteRows: remoteRows().map(row => taskRecord(row) as JsonObject), shapeUpdates: updates,
    attempts: attempts.map(a => ({ ...a })), failure });
  const check = () => { if (closed || failure) throw Object.assign(new Error(`Electric reference cache failed: ${failure ?? 'closed'}`), { evidence: { electricRecovery: closed ? { closed: true } : nativeState() } }); };
  const waitRemote = async (item: Queued, receipt?: JsonObject) => {
    const deadline = performance.now() + 60_000;
    while (receipt && receipt.disposition !== 'updated' ? remoteRows().some(row => row.id === item.taskId) : !remoteRows().some(row => row.id === item.taskId && row.title === item.title && Number(row.server_version) === (receipt?.serverVersion ?? 2))) {
      check(); if (performance.now() > deadline) throw new Error('Electric reference write visibility timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const upload = async (item: Queued) => {
    const attempt: JsonObject = { taskId: item.taskId, idempotencyKey: item.idempotencyKey, startMs: performance.now() - started, status: 'pending' }; attempts.push(attempt);
    try {
      const response = await fetch(`${config.appBaseUrl}/benchmark/tasks/${config.conflicts ? 'conflict' : 'batch'}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': item.idempotencyKey },
        body: JSON.stringify(config.conflicts ? { taskId: item.taskId, title: item.title, operation: item.operation } : { updates: [{ taskId: item.taskId, title: item.title }] }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new Error(`Electric reference mutation HTTP ${response.status}`);
      const receipt = await response.json() as JsonObject;
      if (config.conflicts) { validateElectricConflictReceipt(receipt, item); attempt.conflictReceipt = receipt; }
      else if (!Number.isSafeInteger(receipt.txid) || (receipt.replayed !== true && receipt.updated !== 1)) throw new Error('Electric reference mutation lacks complete server receipt');
      attempt.txid = receipt.txid!; attempt.serverAcceptedMs = performance.now() - started; attempt.replayed = receipt.replayed === true;
      await waitRemote(item, config.conflicts ? receipt : undefined);
      db.transaction(() => {
        const row = remoteRows().find(row => row.id === item.taskId);
        if (row) upsert.run(item.taskId, JSON.stringify(taskRecord(row))); else remove.run(item.taskId);
        db.query('DELETE FROM recovery_outbox WHERE sequence = ?').run(item.sequence);
      })();
      attempt.status = 'success'; attempt.appliedMs = performance.now() - started;
    } catch (error) { attempt.status = 'retry-error'; attempt.error = String(error); throw error; }
  };
  return {
    rows: async () => rows(), count: async () => rows().length, firstScreen: async () => arrayScreenQuery('list', { tasks: rows() }), pending: async () => queue().length,
    read: async () => { check(); return { rows: rows(), pending: queue().length, rejected: null, conflicts: null, nativeState: nativeState() }; },
    write: async mutations => { check(); db.transaction(() => {
      if (queue().length) throw new Error('Electric reference write group already pending');
      const insert = db.query('INSERT INTO recovery_outbox(taskId,title,idempotencyKey) VALUES (?,?,?)');
      for (const mutation of mutations) {
        const stored = db.query<{ record: string }, [string]>('SELECT record FROM recovery_tasks WHERE id = ?').get(mutation.id);
        if (!stored) throw new Error(`Electric reference cache missing ${mutation.id}`);
        const row = { ...JSON.parse(stored.record), title: mutation.title, server_version: 2 };
        upsert.run(mutation.id, JSON.stringify(row)); insert.run(mutation.id, mutation.title, randomUUID());
      }
    })(); },
    sync: async () => { check(); await connect().rows; for (const item of queue()) await upload(item); check(); apply(); },
    ...(config.fanout ? {
      connectDelivery: async () => { await connect().rows; check(); delivery.connects++; },
      pauseDelivery: async () => { delivery.pauses++; },
      observeDelivery: async expected => { delivery.observations++; await pollDelivery(expected, async () => { check(); return matchingDeliveryRows(expected, rows()); }); },
    } : {}),
    probeSync: async () => { check(); const first = queue()[0]; if (!first) throw new Error('No Electric reference write to probe'); await upload(first); },
    remove: async taskId => {
      check(); if (!config.conflicts) throw new Error('Electric deletion requires a conflict client');
      db.transaction(() => {
        if (queue().length || !rows().some(row => row.id === taskId)) throw new Error('Electric delete target or fresh queue missing');
        remove.run(taskId);
        db.query("INSERT INTO recovery_outbox(taskId,title,idempotencyKey,operation) VALUES (?,?,?,'delete')").run(taskId, '', randomUUID());
      })();
    },
    close: async () => { if (closed) return; closed = true; abort.abort(); unsubscribe?.(); shape?.unsubscribeAll(); stream?.unsubscribeAll(); db.close(); },
    diagnostics: { localStorage: 'benchmark-sqlite-cache', initialCache, outbox: 'benchmark-owned SQLite transaction with optimistic rows and idempotent HTTP outbox',
      ...(config.conflicts ? { conflictPolicy: 'application SQL UPDATE/DELETE, persisted exact idempotent disposition, missing-row no-op; native Shape proves final visibility' } : {}),
      localCommit: 'application SQLite transaction commit; WAL with synchronous FULL', sync: 'application sequential HTTP uploads plus native Electric Shape visibility before removing each outbox row',
      persistence: 'application cache and queue use the same SQLite file; no native Electric queue claim', authorization: 'application scoped shape and benchmark mutation endpoint' },
  };
}
