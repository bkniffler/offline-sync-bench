import {
  configureSyncTelemetry,
  createDefaultScopeCacheKey,
  createMemoryScopeCache,
  createServerHandler,
  ensureSyncSchema,
  notifyExternalDataChange,
  notifyExternalRowChanges,
  type SyncTelemetry,
  type SyncCoreDb,
} from '../../packages/server/src/index.ts';
import { createPostgresServerDialect } from '../../packages/server-dialect-postgres/src/index.ts';
import { createSyncServer } from '../../packages/server-hono/src/index.ts';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';

interface BenchDb extends SyncCoreDb {
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
}

interface BenchAuth {
  actorId: string;
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench';
const port = Number(process.env.PORT ?? '3000');
const snapshotBundleMaxBytes = Math.max(
  64 * 1024,
  Number(process.env.SYNCULAR_BENCH_SNAPSHOT_BUNDLE_MAX_BYTES ?? 4 * 1024 * 1024)
);
const scopeCache = createMemoryScopeCache();

const pool = new Pool({ connectionString: databaseUrl });
const db = new Kysely<BenchDb>({
  dialect: new PostgresDialect({ pool }),
});
const dialect = createPostgresServerDialect();

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
  snapshotBundleMaxBytes,
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
    handlers: [tasksHandler],
  },
  scopeCache,
  routes: {
    rateLimit: false,
  },
  upgradeWebSocket,
});

const app = new Hono();

app.route('/api/sync', syncRoutes);

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

const server = Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
  idleTimeout: 0,
});

console.log(`[syncular-bench] listening on ${server.url}`);

async function ensureBenchmarkSchema(): Promise<void> {
  const schemaLockId = 32010;
  await sql`select pg_advisory_lock(${schemaLockId})`.execute(db);
  try {
    await db.schema
      .createTable('organizations')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('projects')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('org_id', 'text', (col) =>
        col.notNull().references('organizations.id').onDelete('cascade')
      )
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('app_users')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('org_id', 'text', (col) =>
        col.notNull().references('organizations.id').onDelete('cascade')
      )
      .addColumn('email', 'text', (col) => col.notNull().unique())
      .execute();

    await db.schema
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

    await db.schema
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
  } finally {
    await sql`select pg_advisory_unlock(${schemaLockId})`.execute(db);
  }
}
