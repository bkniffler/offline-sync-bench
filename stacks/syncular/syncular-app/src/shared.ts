/**
 * Shared wiring for the syncular v2 bench stack: the Postgres.js PgExecutor,
 * Postgres server storage, and the engine-write helper both processes use.
 *
 * Syncular's relational server storage is ONE-WAY (push/storage API → real
 * per-app tables); raw SQL writes to those tables are invisible to sync. So
 * the bench admin writes THROUGH the engine — `upsertRow`/`deleteRow` +
 * `appendCommit` in one transaction (the same contract syncular's own bench
 * seeding uses) — and wakes the sync server's realtime sessions via the
 * engine's Postgres LISTEN/NOTIFY fanout, its supported multi-instance path.
 * Reads may use plain SQL over the materialized columns.
 */
import {
  type CompiledSchema,
  type CompiledTable,
  compileSchema,
  encodeFanoutPayload,
  FANOUT_CHANNEL,
  type NewChange,
  type PgExecutor,
  type PgQueryable,
  PostgresServerStorage,
} from '@syncular/server';
import { encodeRow } from '@syncular/core';
import postgres from 'postgres';
import { schema } from './syncular.generated';
import { serverDatabaseProfile } from './benchmark-profile';

export const PARTITION = 'bench';
export const ADMIN_ACTOR = 'bench-admin';

export const COMPILED: CompiledSchema = compileSchema(schema);

// biome-ignore lint/suspicious/noExplicitAny: driver handle is dynamic.
function queryableOver(handle: any): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ) {
      const rows = (await handle.unsafe(
        text,
        params ? [...params] : [],
      )) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
}

export interface Db {
  readonly executor: PgExecutor;
  readonly storage: PostgresServerStorage;
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<Row[]>;
  notifyCommit(commitSeq: number): Promise<void>;
  listen(handler: (payload: string) => void): Promise<void>;
}

export async function openDb(databaseUrl: string): Promise<Db> {
  const sql = postgres(databaseUrl, { max: serverDatabaseProfile.poolSize, onnotice: () => {} });
  const q = queryableOver(sql);
  const executor: PgExecutor = {
    query: q.query,
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic tx handle.
      return await sql.begin(async (tx: any) => fn(queryableOver(tx))) as T;
    },
    async close() {
      await sql.end();
    },
  };
  const storage = new PostgresServerStorage(executor);
  await storage.ensureSchema(COMPILED);
  // Catch malformed executor results before they masquerade as an auth
  // failure during high-concurrency runs. This validates a read contract;
  // it does not retry or alter storage results.
  const getClientRecord = storage.getClientRecord.bind(storage);
  storage.getClientRecord = async (partition, clientId) => {
    const record = await getClientRecord(partition, clientId);
    if (record && (record.clientId !== clientId || typeof record.actorId !== 'string')) {
      throw new Error(`Benchmark storage returned an invalid client record: ${JSON.stringify({ clientId, record })}`);
    }
    return record;
  };
  return {
    executor,
    storage,
    async query<Row = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<Row[]> {
      const result = await q.query<Row>(text, params);
      return result.rows;
    },
    async notifyCommit(commitSeq: number): Promise<void> {
      await q.query('SELECT pg_notify($1, $2)', [
        FANOUT_CHANNEL,
        encodeFanoutPayload({ partition: PARTITION, commitSeq }),
      ]);
    },
    async listen(handler: (payload: string) => void): Promise<void> {
      // A dedicated connection keeps LISTEN independent of the query pool.
      const listener = postgres(databaseUrl, { max: 1 });
      await listener.listen(FANOUT_CHANNEL, handler);
    },
  };
}

export function tableOf(name: string): CompiledTable {
  const table = COMPILED.tables.get(name);
  if (table === undefined) throw new Error(`unknown table: ${name}`);
  return table;
}

function primaryKeyOf(table: CompiledTable): string {
  const column = table.columns[table.primaryKeyIndex];
  if (column === undefined) throw new Error(`no primary key: ${table.name}`);
  return column.name;
}

export function encodeValues(
  table: CompiledTable,
  values: Record<string, unknown>,
): Uint8Array {
  return encodeRow(
    table.columns,
    table.columns.map(
      (column) => (values[column.name] ?? null) as Parameters<
        typeof encodeRow
      >[1][number],
    ),
  );
}

export function scopesOf(
  table: CompiledTable,
  values: Record<string, unknown>,
): Record<string, string> {
  const scopes: Record<string, string> = {};
  for (const pattern of table.scopePatterns) {
    scopes[pattern.variable] = String(values[pattern.column]);
  }
  return scopes;
}

export interface EngineWrite {
  readonly table: string;
  readonly op: 'upsert' | 'delete';
  /** Full row values (upsert). */
  readonly values?: Record<string, unknown>;
  /** Row id (delete). */
  readonly rowId?: string;
}

/**
 * Apply writes through the engine: rows + one appended commit in a single
 * storage transaction, then a fanout NOTIFY so sync-server sessions wake.
 * `assumeFresh` skips the per-row current-version read (bulk seeding after
 * a reset). Returns the commitSeq.
 */
export async function commitWrites(
  db: Db,
  writes: readonly EngineWrite[],
  options?: { assumeFresh?: boolean },
): Promise<number> {
  const tx = await db.storage.begin(PARTITION);
  try {
    const changes: NewChange[] = [];
    for (const write of writes) {
      const table = tableOf(write.table);
      if (write.op === 'upsert') {
        const values = write.values;
        if (values === undefined) throw new Error('upsert requires values');
        const rowId = String(values[primaryKeyOf(table)]);
        const scopes = scopesOf(table, values);
        const payload = encodeValues(table, values);
        let serverVersion = 1;
        if (options?.assumeFresh !== true) {
          const existing = await tx.getRow(table.name, rowId);
          serverVersion = (existing?.serverVersion ?? 0) + 1;
        }
        await tx.upsertRow(table.name, {
          rowId,
          serverVersion,
          scopes,
          payload,
        });
        changes.push({
          table: table.name,
          rowId,
          op: 'upsert',
          rowVersion: serverVersion,
          scopes,
          payload,
        });
      } else {
        const rowId = write.rowId;
        if (rowId === undefined) throw new Error('delete requires rowId');
        const existing = await tx.getRow(write.table, rowId);
        if (existing === undefined) continue;
        await tx.deleteRow(write.table, rowId);
        changes.push({
          table: write.table,
          rowId,
          op: 'delete',
          scopes: existing.scopes,
        });
      }
    }
    if (changes.length === 0) {
      await tx.rollback();
      return await db.storage.getMaxCommitSeq(PARTITION);
    }
    const commitSeq = await tx.appendCommit({
      clientId: ADMIN_ACTOR,
      clientCommitId: crypto.randomUUID(),
      actorId: ADMIN_ACTOR,
      createdAtMs: Date.now(),
      changes,
    });
    await tx.commit();
    await db.notifyCommit(commitSeq);
    return commitSeq;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}
