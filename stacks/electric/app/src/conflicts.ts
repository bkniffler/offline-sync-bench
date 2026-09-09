import type { Hono } from 'hono';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';

/** Application SQL policy, shared by both Electric client compositions.
 * Store the exact disposition so an HTTP retry cannot turn an applied update
 * into a misleading zero-row result. Never insert a missing task. */
export async function registerConflictEndpoint(app: Hono, sql: ReturnType<typeof postgres>) {
  await sql`create table if not exists benchmark_conflict_receipts (
    idempotency_key text primary key, request_digest text not null, receipt jsonb not null
  )`;
  app.post('/benchmark/tasks/conflict', async c => {
    const input = await c.req.json<{ taskId: string; operation: 'update' | 'delete'; title?: string }>();
    const key = c.req.header('idempotency-key');
    if (!key || !input.taskId || !['update', 'delete'].includes(input.operation) || (input.operation === 'update' && typeof input.title !== 'string')) return c.json({ error: 'Invalid conflict operation' }, 400);
    const request = { taskId: input.taskId, operation: input.operation, title: input.operation === 'update' ? input.title : null };
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const result = await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const previous = await tx<{ request_digest: string; receipt: Record<string, unknown> }[]>`select request_digest, receipt from benchmark_conflict_receipts where idempotency_key = ${key}`;
      if (previous[0]) {
        if (previous[0].request_digest !== digest) throw new HTTPException(409, { message: 'Idempotency key already identifies a different operation' });
        return { ...previous[0].receipt, replayed: true };
      }
      const [transaction] = await tx<{ txid: string }[]>`select pg_current_xact_id()::xid::text as txid`;
      const rows = input.operation === 'delete'
        ? await tx<{ server_version: number }[]>`delete from tasks where id = ${input.taskId} returning server_version`
        : await tx<{ server_version: number }[]>`update tasks set title = ${input.title!}, server_version = server_version + 1, updated_at = now() where id = ${input.taskId} returning server_version`;
      const receipt = { method: 'application-sql-conflict-receipt-v1', idempotencyKey: key, taskId: input.taskId, operation: input.operation,
        txid: Number(transaction!.txid), affectedRows: rows.length, disposition: rows.length ? input.operation === 'delete' ? 'deleted' : 'updated' : 'missing-row-noop',
        serverVersion: input.operation === 'update' && rows.length ? Number(rows[0]!.server_version) : null, replayed: false };
      await tx`insert into benchmark_conflict_receipts (idempotency_key, request_digest, receipt) values (${key}, ${digest}, ${sql.json(receipt)})`;
      return receipt;
    });
    return c.json(result);
  });
}
