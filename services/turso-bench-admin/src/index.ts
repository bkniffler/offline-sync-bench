import { serve } from '@hono/node-server';
import { connect } from '@tursodatabase/sync';
import { Hono } from 'hono';

interface SeedRequest {
  resetFirst?: boolean;
  orgCount?: number;
  projectsPerOrg?: number;
  usersPerOrg?: number;
  tasksPerProject?: number;
  membershipsPerProject?: number;
}

interface WriteRequest {
  taskId: string;
  title?: string;
  completed?: boolean;
}

interface SqlTaskRow {
  id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: number | boolean;
  server_version: number | bigint;
  updated_at: string;
}

const port = Number(process.env.PORT ?? '3000');
const stackId = process.env.STACK_ID ?? 'turso';
const syncUrl = process.env.TURSO_SYNC_URL ?? 'http://turso:8080';
const localPath = process.env.TURSO_LOCAL_PATH ?? '/data/admin.db';

const db = await connect({
  path: localPath,
  url: syncUrl,
  clientName: 'offline-sync-bench-admin',
  pushOperationsThreshold: 2_000,
});

await ensureBenchmarkSchema();

const app = new Hono();

app.get('/health', async (c) => {
  const statement = await db.prepare('select 1 as ok');
  const row = (await statement.get()) as { ok?: number } | undefined;
  return c.json({ ok: row?.ok === 1, stackId });
});

app.get('/admin/stats', async (c) => {
  await db.pull();
  return c.json(await collectStats());
});

app.get('/admin/fixtures', async (c) => {
  await db.pull();
  const projectsStatement = await db.prepare(
    'select id, org_id from projects order by id limit 4'
  );
  const sampleProjects = (await projectsStatement.all()) as Array<{
    id: string;
    org_id: string;
  }>;
  const project = sampleProjects[0] ?? null;
  const usersStatement = await db.prepare(
    'select user_id from project_memberships where project_id = ? order by user_id limit 2'
  );
  const taskStatement = await db.prepare(
    'select id from tasks where project_id = ? order by id limit 1'
  );
  const sampleUsers = project
    ? ((await usersStatement.all(project.id)) as Array<{ user_id: string }>)
    : [];
  const sampleTask = project
    ? ((await taskStatement.all(project.id)) as Array<{ id: string }>)
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
  await db.pull();
  const projectId = c.req.query('projectId');
  const requestedLimit = Number(c.req.query('limit') ?? '25');
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(5_000, Math.floor(requestedLimit)))
    : 25;
  const statement = await db.prepare(
    projectId
      ? `select id, org_id, project_id, owner_id, title, completed,
                server_version, updated_at
         from tasks where project_id = ? order by id limit ?`
      : `select id, org_id, project_id, owner_id, title, completed,
                server_version, updated_at
         from tasks order by id limit ?`
  );
  const rows = (projectId
    ? await statement.all(projectId, limit)
    : await statement.all(limit)) as SqlTaskRow[];
  return c.json({ stackId, tasks: rows.map(mapTaskRow) });
});

app.get('/admin/tasks/:taskId', async (c) => {
  await db.pull();
  const statement = await db.prepare(
    `select id, org_id, project_id, owner_id, title, completed,
            server_version, updated_at
     from tasks where id = ? limit 1`
  );
  const row = (await statement.get(c.req.param('taskId'))) as
    | SqlTaskRow
    | undefined;
  if (!row) {
    return c.json({ ok: false, error: 'TASK_NOT_FOUND' }, 404);
  }
  return c.json({ ok: true, stackId, task: mapTaskRow(row) });
});

app.post('/admin/reset', async (c) => {
  await resetData();
  return c.json({ ok: true, stackId });
});

app.post('/admin/seed', async (c) => {
  const request = await c.req.json<SeedRequest>();
  const options: Required<SeedRequest> = {
    resetFirst: request.resetFirst ?? true,
    orgCount: request.orgCount ?? 2,
    projectsPerOrg: request.projectsPerOrg ?? 5,
    usersPerOrg: request.usersPerOrg ?? 12,
    tasksPerProject: request.tasksPerProject ?? 500,
    membershipsPerProject: request.membershipsPerProject ?? 6,
  };

  if (options.resetFirst) {
    await resetData();
  }
  await seedData(options);
  await db.push();

  return c.json({
    ok: true,
    stackId,
    options,
    stats: await collectStats(),
  });
});

app.post('/admin/write', async (c) => {
  await db.pull();
  const request = await c.req.json<WriteRequest>();
  const existingStatement = await db.prepare(
    'select id, title, completed from tasks where id = ?'
  );
  const existing = (await existingStatement.get(request.taskId)) as
    | { id: string; title: string; completed: number | boolean }
    | undefined;
  if (!existing) {
    return c.json({ ok: false, error: 'TASK_NOT_FOUND' }, 404);
  }

  const update = await db.prepare(
    `update tasks
     set title = ?, completed = ?, server_version = server_version + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where id = ?`
  );
  await update.run(
    request.title ?? existing.title,
    request.completed === undefined
      ? Number(existing.completed)
      : Number(request.completed),
    request.taskId
  );
  await db.push();
  const readUpdated = await db.prepare(
    'select id, title, completed, server_version from tasks where id = ?'
  );
  const row = (await readUpdated.get(request.taskId)) as Record<string, unknown>;
  return c.json({ ok: true, stackId, row });
});

app.post('/admin/revoke-membership', (c) => {
  return c.json(
    {
      ok: false,
      stackId,
      error: 'UNSUPPORTED',
      message: 'Turso whole-database sync has no row-level revocation equivalent.',
    },
    501
  );
});

const server = serve({ fetch: app.fetch, port });
console.log(`[turso-bench-admin] listening on :${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    server.close();
    await db.close();
    process.exit(0);
  });
}

async function ensureBenchmarkSchema(): Promise<void> {
  await db.pull();
  const statements = [
    `create table if not exists organizations (
       id text primary key,
       name text not null
     )`,
    `create table if not exists projects (
       id text primary key,
       org_id text not null,
       name text not null
     )`,
    `create table if not exists app_users (
       id text primary key,
       org_id text not null,
       email text not null unique
     )`,
    `create table if not exists project_memberships (
       project_id text not null,
       user_id text not null,
       role text not null default 'member',
       primary key (project_id, user_id)
     )`,
    `create table if not exists tasks (
       id text primary key,
       org_id text not null,
       project_id text not null,
       owner_id text not null,
       title text not null,
       completed integer not null default 0,
       server_version integer not null default 1,
       updated_at text not null
     )`,
    'create index if not exists idx_projects_org_id on projects (org_id)',
    'create index if not exists idx_users_org_id on app_users (org_id)',
    'create index if not exists idx_memberships_user_id on project_memberships (user_id)',
    'create index if not exists idx_tasks_project_id on tasks (project_id)',
    'create index if not exists idx_tasks_owner_id on tasks (owner_id)',
  ];
  for (const statement of statements) {
    await db.exec(statement);
  }
  await db.push();
}

async function resetData(): Promise<void> {
  await db.pull();
  const reset = db.transaction(async () => {
    for (const table of [
      'tasks',
      'project_memberships',
      'app_users',
      'projects',
      'organizations',
    ]) {
      await db.exec(`delete from ${table}`);
    }
  });
  await reset();
  await db.push();
}

async function seedData(options: Required<SeedRequest>): Promise<void> {
  const taskBatchSize = 2_000;
  for (let orgIndex = 0; orgIndex < options.orgCount; orgIndex += 1) {
    const orgId = `org-${orgIndex + 1}`;
    const insertOrganization = await db.prepare(
      'insert into organizations (id, name) values (?, ?)'
    );
    await insertOrganization.run(orgId, `Organization ${orgIndex + 1}`);

    const userIds: string[] = [];
    const insertUsers = db.transaction(async () => {
      const insert = await db.prepare(
        'insert into app_users (id, org_id, email) values (?, ?, ?)'
      );
      for (let userIndex = 0; userIndex < options.usersPerOrg; userIndex += 1) {
        const userId = `${orgId}-user-${userIndex + 1}`;
        userIds.push(userId);
        await insert.run(userId, orgId, `${userId}@bench.local`);
      }
    });
    await insertUsers();

    for (
      let projectIndex = 0;
      projectIndex < options.projectsPerOrg;
      projectIndex += 1
    ) {
      const projectId = `${orgId}-project-${projectIndex + 1}`;
      const insertProject = await db.prepare(
        'insert into projects (id, org_id, name) values (?, ?, ?)'
      );
      await insertProject.run(projectId, orgId, `Project ${projectIndex + 1}`);

      const membershipCount = Math.min(
        options.membershipsPerProject,
        userIds.length
      );
      const insertMemberships = db.transaction(async () => {
        const insert = await db.prepare(
          `insert into project_memberships (project_id, user_id, role)
           values (?, ?, 'member')`
        );
        for (let index = 0; index < membershipCount; index += 1) {
          await insert.run(projectId, userIds[index]);
        }
      });
      await insertMemberships();

      for (
        let batchStart = 0;
        batchStart < options.tasksPerProject;
        batchStart += taskBatchSize
      ) {
        const batchEnd = Math.min(
          options.tasksPerProject,
          batchStart + taskBatchSize
        );
        const insertTasks = db.transaction(async () => {
          const insert = await db.prepare(
            `insert into tasks
             (id, org_id, project_id, owner_id, title, completed, server_version, updated_at)
             values (?, ?, ?, ?, ?, ?, 1, ?)`
          );
          for (let taskIndex = batchStart; taskIndex < batchEnd; taskIndex += 1) {
            const taskOrdinal = String(taskIndex + 1).padStart(6, '0');
            await insert.run(
              `${projectId}-task-${taskOrdinal}`,
              orgId,
              projectId,
              userIds[taskIndex % membershipCount],
              `Task ${taskIndex + 1} in ${projectId}`,
              taskIndex % 3 === 0 ? 1 : 0,
              '2026-01-01T00:00:00.000Z'
            );
          }
        });
        await insertTasks();
        await db.push();
      }
    }
  }
}

async function collectStats() {
  const counts = await Promise.all(
    [
      ['organizations', 'organizations'],
      ['projects', 'projects'],
      ['app_users', 'users'],
      ['project_memberships', 'memberships'],
      ['tasks', 'tasks'],
    ].map(async ([table, key]) => {
      const statement = await db.prepare(`select count(*) as count from ${table}`);
      const row = (await statement.get()) as { count: number | bigint };
      return [key, Number(row.count)] as const;
    })
  );
  return { stackId, ...Object.fromEntries(counts) };
}

function mapTaskRow(row: SqlTaskRow) {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    title: row.title,
    completed: Boolean(row.completed),
    serverVersion: Number(row.server_version),
    updatedAt: row.updated_at,
  };
}
