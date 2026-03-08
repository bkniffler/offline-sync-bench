import { Hono } from 'hono';
import postgres from 'postgres';

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

interface TaskRow {
  id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: boolean;
  server_version: number;
  updated_at: string;
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';
const port = Number(process.env.PORT ?? '3000');
const stackId = process.env.STACK_ID ?? 'unknown';
const sql = postgres(databaseUrl, { max: 5 });

await ensureBenchmarkSchema();

const app = new Hono();

app.get('/health', async (c) => {
  const result = await sql<{ ok: number }[]>`select 1 as ok`;
  return c.json({ ok: result[0]?.ok === 1, stackId });
});

app.get('/admin/stats', async (c) => {
  return c.json(await collectStats());
});

app.get('/admin/fixtures', async (c) => {
  const sampleProjects = await sql<{
    id: string;
    org_id: string;
  }[]>`
    select id, org_id
    from projects
    order by id
    limit 4
  `;
  const project = sampleProjects[0] ?? null;

  const sampleUsers = project
    ? await sql<{
        user_id: string;
      }[]>`
        select user_id
        from project_memberships
        where project_id = ${project.id}
        order by user_id
        limit 2
      `
    : [];

  const sampleTask = project
    ? await sql<{
        id: string;
      }[]>`
        select id
        from tasks
        where project_id = ${project.id}
        order by id
        limit 1
      `
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
    ? Math.max(1, Math.min(500, Math.floor(limit)))
    : 25;

  const rows = projectId
    ? await sql<TaskRow[]>`
        select
          id,
          org_id,
          project_id,
          owner_id,
          title,
          completed,
          server_version,
          updated_at::text as updated_at
        from tasks
        where project_id = ${projectId}
        order by id
        limit ${normalizedLimit}
      `
    : await sql<TaskRow[]>`
        select
          id,
          org_id,
          project_id,
          owner_id,
          title,
          completed,
          server_version,
          updated_at::text as updated_at
        from tasks
        order by id
        limit ${normalizedLimit}
      `;

  return c.json({
    stackId,
    tasks: rows.map((row) => mapTaskRow(row)),
  });
});

app.get('/admin/tasks/:taskId', async (c) => {
  const taskId = c.req.param('taskId');
  const rows = await sql<TaskRow[]>`
    select
      id,
      org_id,
      project_id,
      owner_id,
      title,
      completed,
      server_version,
      updated_at::text as updated_at
    from tasks
    where id = ${taskId}
    limit 1
  `;

  const row = rows[0];
  if (!row) {
    return c.json({ ok: false, error: 'TASK_NOT_FOUND' }, 404);
  }

  return c.json({
    ok: true,
    stackId,
    task: mapTaskRow(row),
  });
});

app.post('/admin/reset', async (c) => {
  await resetData();
  return c.json({ ok: true, stackId });
});

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

  if (options.resetFirst) {
    await resetData();
  }

  await seedData(options);

  return c.json({
    ok: true,
    stackId,
    options,
    stats: await collectStats(),
  });
});

app.post('/admin/write', async (c) => {
  const request = await c.req.json<WriteRequest>();

  const updated = await sql<{
    id: string;
    title: string;
    completed: boolean;
    server_version: number;
  }[]>`
    update tasks
    set
      title = coalesce(${request.title ?? null}, title),
      completed = coalesce(${request.completed ?? null}, completed),
      server_version = server_version + 1,
      updated_at = now()
    where id = ${request.taskId}
    returning id, title, completed, server_version
  `;

  const row = updated[0];
  if (!row) {
    return c.json({ ok: false, error: 'TASK_NOT_FOUND' }, 404);
  }

  return c.json({ ok: true, stackId, row });
});

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`[bench-admin] listening on :${port} for ${stackId}`);

async function ensureBenchmarkSchema(): Promise<void> {
  await sql`
    create table if not exists organizations (
      id text primary key,
      name text not null
    )
  `;
  await sql`
    create table if not exists projects (
      id text primary key,
      org_id text not null references organizations(id) on delete cascade,
      name text not null
    )
  `;
  await sql`
    create table if not exists app_users (
      id text primary key,
      org_id text not null references organizations(id) on delete cascade,
      email text not null unique
    )
  `;
  await sql`
    create table if not exists project_memberships (
      project_id text not null references projects(id) on delete cascade,
      user_id text not null references app_users(id) on delete cascade,
      role text not null default 'member',
      primary key (project_id, user_id)
    )
  `;
  await sql`
    create table if not exists tasks (
      id text primary key,
      org_id text not null references organizations(id) on delete cascade,
      project_id text not null references projects(id) on delete cascade,
      owner_id text not null references app_users(id) on delete cascade,
      title text not null,
      completed boolean not null default false,
      server_version bigint not null default 1,
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create index if not exists idx_projects_org_id on projects (org_id)
  `;
  await sql`
    create index if not exists idx_app_users_org_id on app_users (org_id)
  `;
  await sql`
    create index if not exists idx_project_memberships_user_id on project_memberships (user_id)
  `;
  await sql`
    create index if not exists idx_tasks_project_id on tasks (project_id)
  `;
  await sql`
    create index if not exists idx_tasks_owner_id on tasks (owner_id)
  `;
}

async function resetData(): Promise<void> {
  const syncTables = await sql<{
    tablename: string;
  }[]>`
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename like 'sync\\_%' escape '\\'
    order by tablename
  `;

  const tableNames = [
    'tasks',
    'project_memberships',
    'app_users',
    'projects',
    'organizations',
    ...syncTables.map((row) => row.tablename),
  ];

  const quotedTableNames = tableNames.map((tableName) =>
    `"${tableName.replaceAll('"', '""')}"`
  );

  await sql.unsafe(
    `truncate table ${quotedTableNames.join(', ')} restart identity cascade`
  );
}

async function seedData(options: Required<SeedRequest>): Promise<void> {
  const taskInsertBatchSize = 2_000;

  for (let orgIndex = 0; orgIndex < options.orgCount; orgIndex += 1) {
    const orgId = `org-${orgIndex + 1}`;
    await sql`
      insert into organizations ${sql([
        {
          id: orgId,
          name: `Organization ${orgIndex + 1}`,
        },
      ])}
    `;

    const userRows: Array<{
      id: string;
      org_id: string;
      email: string;
    }> = [];
    for (let userIndex = 0; userIndex < options.usersPerOrg; userIndex += 1) {
      const userId = `${orgId}-user-${userIndex + 1}`;
      userRows.push({
        id: userId,
        org_id: orgId,
        email: `${userId}@bench.local`,
      });
    }

    if (userRows.length > 0) {
      await sql`
        insert into app_users ${sql(userRows)}
      `;
    }

    const userIds = userRows.map((row) => row.id);

    for (
      let projectIndex = 0;
      projectIndex < options.projectsPerOrg;
      projectIndex += 1
    ) {
      const projectId = `${orgId}-project-${projectIndex + 1}`;
      await sql`
        insert into projects ${sql([
          {
            id: projectId,
            org_id: orgId,
            name: `Project ${projectIndex + 1}`,
          },
        ])}
      `;

      const membershipCount = Math.min(
        options.membershipsPerProject,
        userIds.length
      );

      const membershipRows: Array<{
        project_id: string;
        user_id: string;
        role: string;
      }> = [];
      for (
        let membershipIndex = 0;
        membershipIndex < membershipCount;
        membershipIndex += 1
      ) {
        const userId = userIds[membershipIndex];
        if (!userId) continue;
        membershipRows.push({
          project_id: projectId,
          user_id: userId,
          role: 'member',
        });
      }

      if (membershipRows.length > 0) {
        await sql`
          insert into project_memberships ${sql(membershipRows)}
          on conflict do nothing
        `;
      }

      for (
        let taskBatchStart = 0;
        taskBatchStart < options.tasksPerProject;
        taskBatchStart += taskInsertBatchSize
      ) {
        const taskRows: Array<{
          id: string;
          org_id: string;
          project_id: string;
          owner_id: string;
          title: string;
          completed: boolean;
          server_version: number;
        }> = [];

        const taskBatchEnd = Math.min(
          options.tasksPerProject,
          taskBatchStart + taskInsertBatchSize
        );

        for (let taskIndex = taskBatchStart; taskIndex < taskBatchEnd; taskIndex += 1) {
          const ownerId = userIds[taskIndex % membershipCount];
          if (!ownerId) continue;
          const taskOrdinal = formatOrdinal(taskIndex + 1, 6);
          taskRows.push({
            id: `${projectId}-task-${taskOrdinal}`,
            org_id: orgId,
            project_id: projectId,
            owner_id: ownerId,
            title: `Task ${taskIndex + 1} in ${projectId}`,
            completed: taskIndex % 3 === 0,
            server_version: 1,
          });
        }

        if (taskRows.length > 0) {
          await sql`
            insert into tasks ${sql(taskRows)}
          `;
        }
      }
    }
  }
}

async function collectStats(): Promise<{
  stackId: string;
  organizations: number;
  projects: number;
  users: number;
  memberships: number;
  tasks: number;
}> {
  const [organizations, projects, users, memberships, tasks] = await Promise.all(
    [
      countRows('organizations'),
      countRows('projects'),
      countRows('app_users'),
      countRows('project_memberships'),
      countRows('tasks'),
    ]
  );

  return {
    stackId,
    organizations,
    projects,
    users,
    memberships,
    tasks,
  };
}

async function countRows(tableName: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from ${sql(tableName)}
  `;
  const count = rows[0]?.count ?? '0';
  return Number(count);
}

function formatOrdinal(value: number, width: number): string {
  return value.toString().padStart(width, '0');
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
    serverVersion: row.server_version,
    updatedAt: row.updated_at,
  };
}
