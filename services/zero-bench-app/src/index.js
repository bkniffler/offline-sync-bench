import { Hono } from 'hono';
import postgres from 'postgres';
import {
  boolean,
  createBuilder,
  createSchema,
  defineMutator,
  defineMutators,
  defineQueries,
  defineQuery,
  mustGetMutator,
  mustGetQuery,
  number,
  string,
  table,
} from '@rocicorp/zero';
import { handleMutateRequest, handleQueryRequest } from '@rocicorp/zero/server';
import { zeroPostgresJS } from '@rocicorp/zero/server/adapters/postgresjs';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';
const port = Number(process.env.PORT ?? '3000');
const sql = postgres(databaseUrl, { max: 5 });

await ensureTasksTable();

const organizations = table('organizations')
  .columns({
    id: string(),
    name: string(),
  })
  .primaryKey('id');

const projects = table('projects')
  .columns({
    id: string(),
    org_id: string(),
    name: string(),
  })
  .primaryKey('id');

const tasks = table('tasks')
  .columns({
    id: string(),
    org_id: string(),
    project_id: string(),
    owner_id: string(),
    title: string(),
    completed: boolean(),
    server_version: number(),
    updated_at: number(),
  })
  .primaryKey('id');

const schema = createSchema({
  tables: [organizations, projects, tasks],
  enableLegacyQueries: false,
  enableLegacyMutators: false,
});

const zql = createBuilder(schema);

const queries = defineQueries({
  organizations: {
    all: defineQuery(() => zql.organizations.orderBy('id', 'asc')),
  },
  projects: {
    all: defineQuery(() => zql.projects.orderBy('id', 'asc')),
  },
  tasks: {
    all: defineQuery(() => zql.tasks.orderBy('id', 'asc')),
  },
});

const mutators = defineMutators({
  tasks: {
    update: defineMutator(async ({ tx, args }) => {
      const existing = await tx.run(zql.tasks.where('id', args.id).one());
      if (!existing) {
        return;
      }

      await tx.mutate.tasks.update({
        id: args.id,
        title: args.title,
      });
    }),
  },
});

const app = new Hono();
const dbProvider = zeroPostgresJS(schema, sql);

app.get('/health', async (c) => {
  const result = await sql`select 1 as ok`;
  return c.json({ ok: result[0]?.ok === 1 });
});

app.post('/zero/query', async (c) => {
  const result = await handleQueryRequest(
    (name, args) => mustGetQuery(queries, name).fn({ args, ctx: undefined }),
    schema,
    c.req.raw
  );

  return c.json(result);
});

app.post('/zero/mutate', async (c) => {
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
