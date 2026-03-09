import {
  type ScopeValue,
  configureSyncTelemetry,
  createBlobManager,
  createDatabaseBlobStorageAdapter,
  createDefaultScopeCacheKey,
  createHmacTokenSigner,
  createMemoryScopeCache,
  createServerHandler,
  ensureBlobStorageSchemaPostgres,
  ensureSyncSchema,
  notifyExternalDataChange,
  notifyExternalRowChanges,
  type ScopeCacheBackend,
  type SyncBlobDb,
  type SyncTelemetry,
  type SyncCoreDb,
} from '@syncular/server';
import { createPostgresServerDialect } from '@syncular/server-dialect-postgres';
import {
  createBlobRoutes,
  createSyncServer,
} from '@syncular/server-hono';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

interface BenchDb extends SyncCoreDb, SyncBlobDb {
  organizations: {
    id: string;
    name: string;
  };
  projects: {
    id: string;
    org_id: string;
    name: string;
  };
  app_users: {
    id: string;
    org_id: string;
    email: string;
  };
  project_memberships: {
    project_id: string;
    user_id: string;
    role: string;
  };
  tasks: {
    id: string;
    org_id: string;
    project_id: string;
    owner_id: string;
    title: string;
    completed: boolean;
    server_version: number;
    updated_at: Date;
  };
  task_blob_entries: {
    id: string;
    project_id: string;
    blob_hash: string | null;
    blob_size: number | null;
    blob_mime_type: string | null;
    server_version: number;
    updated_at: Date;
  };
}

interface BenchAuth {
  actorId: string;
}

function resolveProjectScopeValues(
  scopeValues: Partial<Record<string, ScopeValue>>
) {
  const projectScope = scopeValues.project_id;
  if (projectScope === undefined) {
    return [];
  }
  return Array.isArray(projectScope) ? projectScope : [projectScope];
}

async function snapshotTasks(args: {
  db: Kysely<BenchDb>;
  scopeValues: Partial<Record<string, ScopeValue>>;
  cursor: string | null;
  limit: number;
}): Promise<{ rows: Array<BenchDb['tasks']>; nextCursor: string | null }> {
  const projectIds = resolveProjectScopeValues(args.scopeValues);
  if (projectIds.length === 0) {
    return { rows: [], nextCursor: null };
  }

  const pageSize = Math.max(1, args.limit);
  const rows = await args.db
    .selectFrom('tasks')
    .select([
      'id',
      'org_id',
      'project_id',
      'owner_id',
      'title',
      'completed',
      'server_version',
      'updated_at',
    ])
    .$if(projectIds.length === 1, (qb) =>
      qb.where('project_id', '=', projectIds[0] ?? '')
    )
    .$if(projectIds.length > 1, (qb) => qb.where('project_id', 'in', projectIds))
    .$if(args.cursor !== null, (qb) => qb.where('id', '>', args.cursor ?? ''))
    .orderBy('id', 'asc')
    .limit(pageSize + 1)
    .execute();

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const lastRow = pageRows[pageRows.length - 1];

  return {
    rows: pageRows,
    nextCursor: hasMore ? lastRow?.id ?? null : null,
  };
}

async function snapshotTaskBlobs(args: {
  db: Kysely<BenchDb>;
  scopeValues: Partial<Record<string, ScopeValue>>;
  cursor: string | null;
  limit: number;
}): Promise<{
  rows: Array<BenchDb['task_blob_entries']>;
  nextCursor: string | null;
}> {
  const projectIds = resolveProjectScopeValues(args.scopeValues);
  if (projectIds.length === 0) {
    return { rows: [], nextCursor: null };
  }

  const pageSize = Math.max(1, args.limit);
  const rows = await args.db
    .selectFrom('task_blob_entries')
    .select([
      'id',
      'project_id',
      'blob_hash',
      'blob_size',
      'blob_mime_type',
      'server_version',
      'updated_at',
    ])
    .$if(projectIds.length === 1, (qb) =>
      qb.where('project_id', '=', projectIds[0] ?? '')
    )
    .$if(projectIds.length > 1, (qb) => qb.where('project_id', 'in', projectIds))
    .$if(args.cursor !== null, (qb) => qb.where('id', '>', args.cursor ?? ''))
    .orderBy('id', 'asc')
    .limit(pageSize + 1)
    .execute();

  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const lastRow = pageRows[pageRows.length - 1];

  return {
    rows: pageRows,
    nextCursor: hasMore ? lastRow?.id ?? null : null,
  };
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench';
const port = Number(process.env.PORT ?? '3000');
const publicSyncBaseUrl =
  process.env.PUBLIC_SYNC_BASE_URL ?? 'http://localhost:3210/api/sync';
const blobTokenSecret = process.env.BLOB_TOKEN_SECRET ?? 'syncular-bench-blob-secret';
const snapshotBundleMaxBytesEnv =
  process.env.SYNCULAR_BENCH_SNAPSHOT_BUNDLE_MAX_BYTES;
const snapshotBundleMaxBytes =
  snapshotBundleMaxBytesEnv &&
  Number.isFinite(Number(snapshotBundleMaxBytesEnv)) &&
  Number(snapshotBundleMaxBytesEnv) > 0
    ? Math.max(64 * 1024, Number(snapshotBundleMaxBytesEnv))
    : undefined;
const benchmarkMaxPullLimitSnapshotRows = 20_000;
const benchmarkMaxPullMaxSnapshotPages = 100;
let activeScopeCache = createMemoryScopeCache();
const scopeCache: ScopeCacheBackend = {
  name: 'bench-memory-delegate',
  async get(args) {
    return activeScopeCache.get(args);
  },
  async set(args) {
    return activeScopeCache.set(args);
  },
  async delete(args) {
    return activeScopeCache.delete?.(args);
  },
};

const pool = new Pool({ connectionString: databaseUrl });
const db = new Kysely<BenchDb>({
  dialect: new PostgresDialect({ pool }),
});
const dialect = createPostgresServerDialect();
const blobTokenSigner = createHmacTokenSigner(blobTokenSecret);
const blobAdapter = createDatabaseBlobStorageAdapter({
  db,
  baseUrl: publicSyncBaseUrl,
  tokenSigner: blobTokenSigner,
});
const blobManager = createBlobManager({
  db,
  adapter: blobAdapter,
});

const benchmarkTelemetry: SyncTelemetry = {
  log() {},
  tracer: {
    startSpan(_options, callback) {
      return callback({
        setAttribute() {},
        setAttributes() {},
        setStatus() {},
      });
    },
  },
  metrics: {
    count() {},
    gauge() {},
    distribution() {},
  },
  captureException(error, context) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'sync.exception',
        error: message,
        ...(context ?? {}),
      })
    );
  },
};

configureSyncTelemetry(benchmarkTelemetry);

await ensureBenchmarkSchema();
await ensureSyncSchema(db, dialect);
await ensureBlobStorageSchemaPostgres(db);

const tasksHandler = createServerHandler<
  BenchDb,
  BenchDb,
  'tasks',
  BenchAuth
>({
  table: 'tasks',
  scopes: ['project:{project_id}'],
  resolveScopes: async (ctx) => {
    const memberships = await ctx.db
      .selectFrom('project_memberships')
      .select('project_memberships.project_id as project_id')
      .where('project_memberships.user_id', '=', ctx.actorId)
      .execute();

    return {
      project_id: memberships.map((row) => row.project_id),
    };
  },
  snapshot: async (ctx) =>
    snapshotTasks({
      db: ctx.db,
      scopeValues: ctx.scopeValues,
      cursor: ctx.cursor,
      limit: ctx.limit,
    }),
  ...(snapshotBundleMaxBytes ? { snapshotBundleMaxBytes } : {}),
});

const taskBlobsHandler = createServerHandler<
  BenchDb,
  BenchDb,
  'task_blob_entries',
  BenchAuth
>({
  table: 'task_blob_entries',
  scopes: ['project:{project_id}'],
  resolveScopes: async (ctx) => {
    const memberships = await ctx.db
      .selectFrom('project_memberships')
      .select('project_memberships.project_id as project_id')
      .where('project_memberships.user_id', '=', ctx.actorId)
      .execute();

    return {
      project_id: memberships.map((row) => row.project_id),
    };
  },
  snapshot: async (ctx) =>
    snapshotTaskBlobs({
      db: ctx.db,
      scopeValues: ctx.scopeValues,
      cursor: ctx.cursor,
      limit: ctx.limit,
    }),
  ...(snapshotBundleMaxBytes ? { snapshotBundleMaxBytes } : {}),
});

const { syncRoutes } = createSyncServer<BenchDb, BenchAuth>({
  db,
  dialect,
  sync: {
    authenticate: async (request) => {
      const url = new URL(request.url);
      const actorId =
        request.headers.get('x-user-id') ?? url.searchParams.get('userId');
      if (!actorId) {
        return null;
      }
      return { actorId };
    },
    handlers: [tasksHandler, taskBlobsHandler],
  },
  scopeCache,
  routes: {
    rateLimit: false,
    maxPullLimitSnapshotRows: benchmarkMaxPullLimitSnapshotRows,
    maxPullMaxSnapshotPages: benchmarkMaxPullMaxSnapshotPages,
  },
  upgradeWebSocket,
});

const app = new Hono();
const blobRoutes = createBlobRoutes({
  blobManager,
  db,
  authenticate: async (c) => {
    const actorId =
      c.req.header('x-user-id') ?? c.req.query('userId') ?? null;
    if (!actorId) {
      return null;
    }
    return { actorId };
  },
  tokenSigner: blobTokenSigner,
  canAccessBlob: async ({ actorId, hash, partitionId }) => {
    const record = await blobManager.getUploadRecord(hash, { partitionId });
    return record?.status === 'complete' && record.actorId === actorId;
  },
});

app.route('/api/sync', syncRoutes);
app.route('/api/sync', blobRoutes);

app.get('/health', async (c) => {
  await db.selectFrom('tasks').select('id').limit(1).execute();
  return c.json({ ok: true, stackId: 'syncular' });
});

app.get('/benchmark/config', async (c) => {
  const sampleUser = await db.selectFrom('app_users').select('id').orderBy('id').limit(1).executeTakeFirst();
  return c.json({
    stackId: 'syncular',
    syncPath: '/api/sync',
    sampleUserId: sampleUser?.id ?? null,
    subscriptionShape: {
      id: 'project-subscription',
      table: 'tasks',
      scopes: {
        project_id: '<project-id>',
      },
    },
  });
});

app.post('/benchmark/external-write', async (c) => {
  const request = await c.req.json<{
    taskId: string;
    title?: string;
    completed?: boolean;
  }>();

  const row = await db
    .updateTable('tasks')
    .set({
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.completed !== undefined
        ? { completed: request.completed }
        : {}),
      server_version: sql`server_version + 1`,
      updated_at: sql`now()`,
    })
    .where('id', '=', request.taskId)
    .returning([
      'id',
      'org_id',
      'project_id',
      'owner_id',
      'title',
      'completed',
      'server_version',
      'updated_at',
    ])
    .executeTakeFirst();

  if (!row) {
    return c.json({ ok: false, error: 'TASK_NOT_FOUND' }, 404);
  }

  const notifyResult = await notifyExternalRowChanges({
    db,
    dialect,
    changes: [
      {
        table: 'tasks',
        rowId: row.id,
        op: 'upsert',
        rowJson: {
          id: row.id,
          org_id: row.org_id,
          project_id: row.project_id,
          owner_id: row.owner_id,
          title: row.title,
          completed: row.completed,
          server_version: row.server_version,
          updated_at: row.updated_at,
        },
        rowVersion: row.server_version,
        scopes: {
          project_id: row.project_id,
        },
      },
    ],
  });

  return c.json({
    ok: true,
    row,
    notify: notifyResult,
  });
});

app.post('/benchmark/revoke-membership', async (c) => {
  const request = await c.req.json<{
    projectId: string;
    userId: string;
  }>();

  const deletedMembership = await db
    .deleteFrom('project_memberships')
    .where('project_id', '=', request.projectId)
    .where('user_id', '=', request.userId)
    .returning(['project_id', 'user_id'])
    .executeTakeFirst();

  if (!deletedMembership) {
    return c.json({ ok: false, error: 'MEMBERSHIP_NOT_FOUND' }, 404);
  }

  await scopeCache.delete?.({
    db,
    auth: {
      actorId: request.userId,
    },
    table: 'tasks',
    cacheKey: createDefaultScopeCacheKey({
      table: 'tasks',
      auth: {
        actorId: request.userId,
      },
    }),
  });

  const notifyResult = await notifyExternalDataChange({
    db,
    dialect,
    tables: ['tasks'],
  });

  return c.json({
    ok: true,
    membership: deletedMembership,
    notify: notifyResult,
  });
});

app.post('/benchmark/reset-scope-cache', async (c) => {
  activeScopeCache = createMemoryScopeCache();
  return c.json({ ok: true });
});

app.post('/benchmark/init-task-blobs', async (c) => {
  const request = await c.req
    .json<{ projectId?: string }>()
    .catch(() => ({ projectId: undefined }));

  const inserted = await sql<{ count: number }>`
    with source_tasks as (
      select tasks.id as task_id, tasks.project_id
      from tasks
      ${request.projectId ? sql`where tasks.project_id = ${request.projectId}` : sql``}
    ),
    inserted_rows as (
      insert into task_blob_entries (
        id,
        project_id,
        blob_hash,
        blob_size,
        blob_mime_type,
        server_version,
        updated_at
      )
      select
        source_tasks.task_id,
        source_tasks.project_id,
        null,
        null,
        null,
        1,
        now()
      from source_tasks
      left join task_blob_entries
        on task_blob_entries.id = source_tasks.task_id
      where task_blob_entries.id is null
      returning 1
    )
    select count(*)::int as count from inserted_rows
  `.execute(db);

  return c.json({
    ok: true,
    inserted: inserted.rows[0]?.count ?? 0,
  });
});

const server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});

console.log(`[syncular-bench] listening on ${server.url}`);

async function ensureBenchmarkSchema(): Promise<void> {
  const schemaLockId = 32010;
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(${schemaLockId})`.execute(trx);

    await trx.schema
      .createTable('organizations')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    await trx.schema
      .createTable('projects')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('org_id', 'text', (col) =>
        col.notNull().references('organizations.id').onDelete('cascade')
      )
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    await trx.schema
      .createTable('app_users')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('org_id', 'text', (col) =>
        col.notNull().references('organizations.id').onDelete('cascade')
      )
      .addColumn('email', 'text', (col) => col.notNull().unique())
      .execute();

    await trx.schema
      .createTable('project_memberships')
      .ifNotExists()
      .addColumn('project_id', 'text', (col) =>
        col.notNull().references('projects.id').onDelete('cascade')
      )
      .addColumn('user_id', 'text', (col) =>
        col.notNull().references('app_users.id').onDelete('cascade')
      )
      .addColumn('role', 'text', (col) => col.notNull().defaultTo('member'))
      .addPrimaryKeyConstraint(
        'project_memberships_pk',
        ['project_id', 'user_id']
      )
      .execute();

    await trx.schema
      .createTable('tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('org_id', 'text', (col) =>
        col.notNull().references('organizations.id').onDelete('cascade')
      )
      .addColumn('project_id', 'text', (col) =>
        col.notNull().references('projects.id').onDelete('cascade')
      )
      .addColumn('owner_id', 'text', (col) =>
        col.notNull().references('app_users.id').onDelete('cascade')
      )
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'boolean', (col) =>
        col.notNull().defaultTo(false)
      )
      .addColumn('server_version', 'bigint', (col) =>
        col.notNull().defaultTo(1)
      )
      .addColumn('updated_at', 'timestamptz', (col) =>
        col.notNull().defaultTo(sql`now()`)
      )
      .execute();

    await trx.schema
      .createTable('task_blob_entries')
      .ifNotExists()
      .addColumn('id', 'text', (col) =>
        col.primaryKey().references('tasks.id').onDelete('cascade')
      )
      .addColumn('project_id', 'text', (col) =>
        col.notNull().references('projects.id').onDelete('cascade')
      )
      .addColumn('blob_hash', 'text')
      .addColumn('blob_size', 'bigint')
      .addColumn('blob_mime_type', 'text')
      .addColumn('server_version', 'bigint', (col) =>
        col.notNull().defaultTo(1)
      )
      .addColumn('updated_at', 'timestamptz', (col) =>
        col.notNull().defaultTo(sql`now()`)
      )
      .execute();

    await sql`
      create index if not exists idx_projects_org_id
      on projects (org_id)
    `.execute(trx);

    await sql`
      create index if not exists idx_app_users_org_id
      on app_users (org_id)
    `.execute(trx);

    await sql`
      create index if not exists idx_project_memberships_user_id
      on project_memberships (user_id)
    `.execute(trx);

    await sql`
      create index if not exists idx_tasks_project_id
      on tasks (project_id)
    `.execute(trx);

    await sql`
      create index if not exists idx_tasks_project_id_id
      on tasks (project_id, id)
    `.execute(trx);

    await sql`
      create index if not exists idx_tasks_owner_id
      on tasks (owner_id)
    `.execute(trx);

    await sql`
      create index if not exists idx_task_blob_entries_project_id_id
      on task_blob_entries (project_id, id)
    `.execute(trx);

    await sql`
      alter table task_blob_entries
      add column if not exists blob_hash text
    `.execute(trx);

    await sql`
      alter table task_blob_entries
      add column if not exists blob_size bigint
    `.execute(trx);

    await sql`
      alter table task_blob_entries
      add column if not exists blob_mime_type text
    `.execute(trx);

    await sql`
      alter table tasks
      drop column if exists blob_hash
    `.execute(trx);

    await sql`
      alter table tasks
      drop column if exists blob_size
    `.execute(trx);

    await sql`
      alter table tasks
      drop column if exists blob_mime_type
    `.execute(trx);
  });
}
