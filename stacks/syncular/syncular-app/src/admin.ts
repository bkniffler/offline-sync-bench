/**
 * Syncular-flavored bench admin: the same HTTP contract as
 * services/bench-admin (same routes, same JSON shapes, same seed topology)
 * but every WRITE goes through the syncular engine (shared.ts commitWrites)
 * because relational server storage is one-way — raw SQL inserts never reach
 * sync clients. Reads use plain SQL over the materialized columns, which the
 * engine keeps as real Postgres columns.
 */
import { Hono } from 'hono';
import {
  commitWrites,
  type Db,
  type EngineWrite,
  openDb,
  PARTITION,
} from './shared';

interface SeedRequest {
  resetFirst?: boolean;
  orgCount?: number;
  projectsPerOrg?: number;
  usersPerOrg?: number;
  tasksPerProject?: number;
  membershipsPerProject?: number;
}

interface TaskRow {
  id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: boolean;
  server_version: number;
  updated_at_ms: number;
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';
const port = Number(process.env.PORT ?? '3000');
const stackId = process.env.STACK_ID ?? 'syncular';

const db: Db = await openDb(databaseUrl);

/** Commit batch size for bulk seeding (mirrors bench-admin's insert batch). */
const SEED_COMMIT_BATCH = 2_000;

const app = new Hono();

app.get('/health', async (c) => {
  const rows = await db.query<{ ok: number }>('SELECT 1 AS ok');
  return c.json({ ok: Number(rows[0]?.ok) === 1, stackId });
});

app.get('/admin/stats', async (c) => {
  return c.json(await collectStats());
});

app.get('/admin/fixtures', async (c) => {
  const sampleProjects = await db.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM projects WHERE _sync_partition = $1
     ORDER BY id LIMIT 4`,
    [PARTITION],
  );
  const project = sampleProjects[0] ?? null;

  const sampleUsers = project
    ? await db.query<{ user_id: string }>(
        `SELECT user_id FROM project_memberships
         WHERE _sync_partition = $1 AND project_id = $2
         ORDER BY user_id LIMIT 2`,
        [PARTITION, project.id],
      )
    : [];

  const sampleTask = project
    ? await db.query<{ id: string }>(
        `SELECT id FROM tasks
         WHERE _sync_partition = $1 AND project_id = $2
         ORDER BY id LIMIT 1`,
        [PARTITION, project.id],
      )
    : [];

  return c.json({
    stackId,
    sampleProjectId: project?.id ?? null,
    sampleProjectIds: sampleProjects.map((row) => row.id),
    sampleOrgId: project?.org_id ?? null,
    sampleUserIds: sampleUsers.map((row) => row.user_id),
    sampleTaskId: sampleTask[0]?.id ?? null,
  });
});

app.get('/admin/tasks', async (c) => {
  const projectId = c.req.query('projectId');
  const limit = Number(c.req.query('limit') ?? '25');
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(5_000, Math.floor(limit)))
    : 25;

  const rows = projectId
    ? await db.query<TaskRow>(
        `${TASK_SELECT} WHERE _sync_partition = $1 AND project_id = $2
         ORDER BY id LIMIT $3`,
        [PARTITION, projectId, normalizedLimit],
      )
    : await db.query<TaskRow>(
        `${TASK_SELECT} WHERE _sync_partition = $1 ORDER BY id LIMIT $2`,
        [PARTITION, normalizedLimit],
      );

  return c.json({ stackId, tasks: rows.map((row) => mapTaskRow(row)) });
});

app.get('/admin/tasks/:taskId', async (c) => {
  const taskId = c.req.param('taskId');
  const rows = await db.query<TaskRow>(
    `${TASK_SELECT} WHERE _sync_partition = $1 AND id = $2 LIMIT 1`,
    [PARTITION, taskId],
  );
  const row = rows[0];
  if (!row) return c.json({ ok: false, error: 'TASK_NOT_FOUND' }, 404);
  return c.json({ ok: true, stackId, task: mapTaskRow(row) });
});

app.post('/admin/reset', async (c) => {
  await resetData();
  return c.json({ ok: true, stackId });
});

/**
 * Seeding runs in the background and the response returns immediately with
 * `async: true` + the expected final counts: engine-mediated writes are
 * slower than raw SQL (per-row upsert + commit-log append), and a 100k seed
 * outlives both Bun's fetch timeout and idle-connection limits. Callers
 * (stack-manager.seedStack) poll /admin/stats until the counts match.
 */
let seedInProgress = false;

app.post('/admin/seed', async (c) => {
  const request = await c.req.json<SeedRequest>();
  const options = {
    resetFirst: request.resetFirst ?? true,
    orgCount: request.orgCount ?? 2,
    projectsPerOrg: request.projectsPerOrg ?? 5,
    usersPerOrg: request.usersPerOrg ?? 12,
    tasksPerProject: request.tasksPerProject ?? 500,
    membershipsPerProject: request.membershipsPerProject ?? 6,
  };

  if (seedInProgress) {
    return c.json({ ok: false, error: 'SEED_IN_PROGRESS' }, 409);
  }
  seedInProgress = true;
  const expected = {
    organizations: options.orgCount,
    projects: options.orgCount * options.projectsPerOrg,
    users: options.orgCount * options.usersPerOrg,
    memberships:
      options.orgCount *
      options.projectsPerOrg *
      Math.min(options.membershipsPerProject, options.usersPerOrg),
    tasks: options.orgCount * options.projectsPerOrg * options.tasksPerProject,
  };
  // Reset synchronously so the caller's completion poll can never match the
  // PREVIOUS scenario's identical topology; counts then climb monotonically
  // to `expected` (tasks land last), so an intermediate state never matches.
  try {
    if (options.resetFirst) await resetData();
  } catch (error) {
    seedInProgress = false;
    throw error;
  }
  void (async () => {
    try {
      await seedData(options);
    } catch (error) {
      console.error('[syncular-admin] seed failed:', error);
    } finally {
      seedInProgress = false;
    }
  })();

  return c.json({ ok: true, stackId, async: true, options, expected });
});

app.post('/admin/write', async (c) => {
  const request = await c.req.json<{
    taskId: string;
    title?: string;
    completed?: boolean;
  }>();

  const rows = await db.query<TaskRow>(
    `${TASK_SELECT} WHERE _sync_partition = $1 AND id = $2 LIMIT 1`,
    [PARTITION, request.taskId],
  );
  const current = rows[0];
  if (!current) return c.json({ ok: false, error: 'TASK_NOT_FOUND' }, 404);

  const next = {
    id: current.id,
    org_id: current.org_id,
    project_id: current.project_id,
    owner_id: current.owner_id,
    title: request.title ?? current.title,
    completed: request.completed ?? current.completed,
    server_version: Number(current.server_version) + 1,
    updated_at_ms: Date.now(),
  };
  await commitWrites(db, [{ table: 'tasks', op: 'upsert', values: next }]);

  return c.json({
    ok: true,
    stackId,
    row: {
      id: next.id,
      title: next.title,
      completed: next.completed,
      server_version: next.server_version,
    },
  });
});

app.post('/admin/revoke-membership', async (c) => {
  const request = await c.req.json<{ actorId?: string; projectId?: string }>();
  if (!request.actorId || !request.projectId) {
    return c.json({ ok: false, error: 'ACTOR_AND_PROJECT_REQUIRED' }, 400);
  }

  const rowId = `${request.projectId}:${request.actorId}`;
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM project_memberships
     WHERE _sync_partition = $1 AND id = $2 LIMIT 1`,
    [PARTITION, rowId],
  );
  if (existing.length > 0) {
    await commitWrites(db, [
      { table: 'project_memberships', op: 'delete', rowId },
    ]);
  }

  return c.json({
    ok: existing.length > 0,
    stackId,
    deletedCount: existing.length,
  });
});

Bun.serve({ port, fetch: app.fetch, idleTimeout: 240 });
console.log(`[syncular-admin] listening on :${port} for ${stackId}`);

const TASK_SELECT = `SELECT id, org_id, project_id, owner_id, title,
  completed, server_version, updated_at_ms FROM tasks`;

async function resetData(): Promise<void> {
  // Truncate app tables + the engine's sync_* tables — EXCEPT the schema
  // marker (sync_schema_meta), which records the applied schema version and
  // payload layouts; wiping it would desync the running processes' memoized
  // ensureSchema state.
  const syncTables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename LIKE 'sync\\_%' ESCAPE '\\'
       AND tablename <> 'sync_schema_meta'
     ORDER BY tablename`,
  );
  const tableNames = [
    'tasks',
    'task_blob_entries',
    'project_memberships',
    'app_users',
    'projects',
    'organizations',
    ...syncTables.map((row) => row.tablename),
  ];
  const quoted = tableNames.map((name) => `"${name.replaceAll('"', '""')}"`);
  await db.query(
    `TRUNCATE TABLE ${quoted.join(', ')} RESTART IDENTITY CASCADE`,
  );
}

async function seedData(
  options: Required<SeedRequest>,
): Promise<void> {
  // Collect commit batches first, then apply them with bounded concurrency:
  // seed rows are disjoint, so parallel engine transactions are safe (the
  // per-partition commit-seq update serializes only the commit append tail).
  const batches: EngineWrite[][] = [];
  let pending: EngineWrite[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    batches.push(pending);
    pending = [];
  };
  const push = async (write: EngineWrite) => {
    pending.push(write);
    if (pending.length >= SEED_COMMIT_BATCH) await flush();
  };

  for (let orgIndex = 0; orgIndex < options.orgCount; orgIndex += 1) {
    const orgId = `org-${orgIndex + 1}`;
    await push({
      table: 'organizations',
      op: 'upsert',
      values: { id: orgId, name: `Organization ${orgIndex + 1}` },
    });

    const userIds: string[] = [];
    for (let userIndex = 0; userIndex < options.usersPerOrg; userIndex += 1) {
      const userId = `${orgId}-user-${userIndex + 1}`;
      userIds.push(userId);
      await push({
        table: 'app_users',
        op: 'upsert',
        values: { id: userId, org_id: orgId, email: `${userId}@bench.local` },
      });
    }

    for (
      let projectIndex = 0;
      projectIndex < options.projectsPerOrg;
      projectIndex += 1
    ) {
      const projectId = `${orgId}-project-${projectIndex + 1}`;
      await push({
        table: 'projects',
        op: 'upsert',
        values: { id: projectId, org_id: orgId, name: `Project ${projectIndex + 1}` },
      });

      const membershipCount = Math.min(
        options.membershipsPerProject,
        userIds.length,
      );
      for (
        let membershipIndex = 0;
        membershipIndex < membershipCount;
        membershipIndex += 1
      ) {
        const userId = userIds[membershipIndex];
        if (!userId) continue;
        await push({
          table: 'project_memberships',
          op: 'upsert',
          values: {
            id: `${projectId}:${userId}`,
            project_id: projectId,
            user_id: userId,
            role: 'member',
          },
        });
      }

      const seededAtMs = Date.now();
      for (
        let taskIndex = 0;
        taskIndex < options.tasksPerProject;
        taskIndex += 1
      ) {
        const ownerId = userIds[taskIndex % membershipCount];
        if (!ownerId) continue;
        const taskOrdinal = String(taskIndex + 1).padStart(6, '0');
        await push({
          table: 'tasks',
          op: 'upsert',
          values: {
            id: `${projectId}-task-${taskOrdinal}`,
            org_id: orgId,
            project_id: projectId,
            owner_id: ownerId,
            title: `Task ${taskIndex + 1} in ${projectId}`,
            completed: taskIndex % 3 === 0,
            server_version: 1,
            updated_at_ms: seededAtMs,
          },
        });
      }
    }
  }
  await flush();

  const concurrency = 4;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next];
        next += 1;
        if (batch === undefined) break;
        await commitWrites(db, batch, { assumeFresh: true });
      }
    }),
  );
}

async function collectStats(): Promise<{
  stackId: string;
  organizations: number;
  projects: number;
  users: number;
  memberships: number;
  tasks: number;
}> {
  const count = async (table: string): Promise<number> => {
    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${table}" WHERE _sync_partition = $1`,
      [PARTITION],
    );
    return Number(rows[0]?.count ?? '0');
  };
  const [organizations, projects, users, memberships, tasks] =
    await Promise.all([
      count('organizations'),
      count('projects'),
      count('app_users'),
      count('project_memberships'),
      count('tasks'),
    ]);
  return { stackId, organizations, projects, users, memberships, tasks };
}

function mapTaskRow(row: TaskRow): {
  id: string;
  orgId: string;
  projectId: string;
  ownerId: string;
  title: string;
  completed: boolean;
  serverVersion: number;
  updatedAt: string;
} {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    title: row.title,
    completed: row.completed,
    serverVersion: Number(row.server_version),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
  };
}
