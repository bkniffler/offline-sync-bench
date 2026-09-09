import { Hono } from 'hono';
import postgres from 'postgres';
import { mustGetMutator, mustGetQuery } from '@rocicorp/zero';
import { mutators } from './mutators.ts';
import { schema, queries } from './schema.ts';
import { handleMutateRequest, handleQueryRequest } from '@rocicorp/zero/server';
import { zeroPostgresJS } from '@rocicorp/zero/server/adapters/postgresjs';
import { authenticate, authorizeQuery } from './auth.ts';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';
const port = Number(process.env.PORT ?? '3000');
const sql = postgres(databaseUrl, { max: 5 });

await ensureTasksTable();


const app = new Hono();
const dbProvider = zeroPostgresJS(schema, sql);

app.get('/health', async (c) => {
  const result = await sql`select 1 as ok`;
  return c.json({ ok: result[0]?.ok === 1 });
});

app.post('/zero/query', async (c) => {
  let auth;
  try { auth = await authenticate(c.req.header('authorization')); }
  catch { return c.json({ error: 'Unauthorized' }, 401); }
  const result = await handleQueryRequest({
    handler: (name, args) => { authorizeQuery(auth, name); return mustGetQuery(queries, name).fn({ args, ctx: auth }); },
    schema, request: c.req.raw, userID: auth.userId,
  });

  return c.json(result);
});

app.post('/zero/mutate', async (c) => {
  let auth;
  try { auth = await authenticate(c.req.header('authorization')); }
  catch { return c.json({ error: 'Unauthorized' }, 401); }
  if (auth.profile !== 'global') return c.json({ error: 'Access grant is read-only' }, 403);
  const result = await handleMutateRequest(
    dbProvider,
    (transact) =>
      transact((tx, name, args) =>
        mustGetMutator(mutators, name).fn({ tx, args, ctx: undefined })
      ),
    c.req.raw
  );

  return c.json(result);
});

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`[zero-bench-app] listening on :${port}`);

async function ensureTasksTable() {
  await sql`create table if not exists project_memberships (project_id text not null, user_id text not null, role text not null default 'member', primary key (project_id, user_id))`;
  await sql`
    create table if not exists organizations (
      id text primary key,
      name text not null
    )
  `;
  await sql`
    create table if not exists projects (
      id text primary key,
      org_id text not null default '',
      name text not null
    )
  `;
  await sql`
    create table if not exists tasks (
      id text primary key,
      org_id text not null default '',
      project_id text not null default '',
      owner_id text not null default '',
      title text not null,
      completed boolean not null default false,
      server_version integer not null default 0,
      updated_at timestamptz not null default now()
    )
  `;
}
