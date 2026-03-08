import { Hono } from 'hono';
import { makeElectricUrl, toTableName } from '@livestore/sync-electric';
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

interface TaskArgs {
  [key: string]: string | number | boolean;
  id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: boolean;
  server_version: number;
  updated_at: string;
}

interface TaskRow extends TaskArgs {}

interface LiveStorePushRequest {
  _tag: '@livestore/sync-electric.Push';
  storeId: string;
  batch: Array<{
    name: string;
    args: TaskArgs;
    seqNum: number;
    parentSeqNum: number;
    clientId: string;
    sessionId: string;
  }>;
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';
const port = Number(process.env.PORT ?? '3000');
const stackId = process.env.STACK_ID ?? 'livestore';
const electricUrl = process.env.ELECTRIC_URL ?? 'http://electric:3000';
const storeId = process.env.LIVESTORE_STORE_ID ?? 'benchmark';
const eventlogTableName = toTableName(storeId);
const sql = postgres(databaseUrl, { max: 5 });
type QueryRunner = Pick<typeof sql, 'unsafe'>;

await retryUntilReady({
  label: 'LiveStore benchmark database',
  task: ensureBenchmarkSchema,
});

const app = new Hono();

app.get('/health', async (c) => {
  const result = await sql<{ ok: number }[]>`select 1 as ok`;
  return c.json({ ok: result[0]?.ok === 1, stackId, storeId });
});

app.get('/admin/stats', async (c) => {
  return c.json(await collectStats());
});

app.get('/admin/fixtures', async (c) => {
  const sampleProject = await sql<{
    id: string;
    org_id: string;
  }[]>`
    select id, org_id
    from projects
    order by id
    limit 1
  `;
  const project = sampleProject[0] ?? null;

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
  const updated = await sql<TaskRow[]>`
    update tasks
    set
      title = coalesce(${request.title ?? null}, title),
      completed = coalesce(${request.completed ?? null}, completed),
      server_version = server_version + 1,
      updated_at = now()
    where id = ${request.taskId}
    returning
      id,
      org_id,
      project_id,
      owner_id,
      title,
      completed,
      server_version,
      updated_at::text as updated_at
  `;

  const row = updated[0];
  if (!row) {
    return c.json({ ok: false, error: 'TASK_NOT_FOUND' }, 404);
  }

  await appendServerEvent(sql, row);

  return c.json({ ok: true, stackId, row: mapTaskRow(row) });
});

app.on('HEAD', '/livestore/events', (c) => {
  return c.body(null, 204);
});

app.get('/livestore/events', async (c) => {
  const searchParams = new URL(c.req.url).searchParams;
  if (!searchParams.has('args')) {
    return c.body(null, 204);
  }

  const upstream = makeElectricUrl({
    electricHost: electricUrl,
    searchParams,
  });

  const response = await fetch(upstream.url);
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
});

app.post('/livestore/events', async (c) => {
  const request = await c.req.json<LiveStorePushRequest>();
  if (request.storeId !== storeId) {
    return c.json({ success: false, error: 'INVALID_STORE_ID' }, 400);
  }

  await sql.begin(async (tx) => {
    for (const event of request.batch) {
      if (event.name !== 'taskUpserted') {
        throw new Error(`Unsupported LiveStore event: ${event.name}`);
      }

      const inserted = await tx.unsafe<{ seqNum: number }[]>(
        `
          insert into ${quoteIdent(eventlogTableName)} (
            "seqNum",
            "parentSeqNum",
            "name",
            "args",
            "clientId",
            "sessionId"
          )
          values ($1, $2, $3, $4::jsonb, $5, $6)
          on conflict ("seqNum") do nothing
          returning "seqNum"
        `,
        [
          event.seqNum,
          event.parentSeqNum,
          event.name,
          event.args,
          event.clientId,
          event.sessionId,
        ]
      );

      if (inserted.length === 0) {
        continue;
      }

      await upsertTask(tx, event.args);
    }
  });

  return c.json({ success: true });
});

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`[livestore-bench-app] listening on :${port}`);

async function retryUntilReady(args: {
  label: string;
  task: () => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 60_000;
  const intervalMs = args.intervalMs ?? 1_000;
  const startedAt = Date.now();
  let lastError: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await args.task();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await Bun.sleep(intervalMs);
    }
  }

  throw new Error(
    `${args.label} did not become ready within ${timeoutMs}ms${lastError ? `: ${lastError}` : ''}`
  );
}

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
  await sql.unsafe(`
    create table if not exists ${quoteIdent(eventlogTableName)} (
      "seqNum" bigint primary key,
      "parentSeqNum" bigint not null,
      "name" text not null,
      "args" jsonb not null,
      "clientId" text not null,
      "sessionId" text not null
    )
  `);
}

async function resetData(): Promise<void> {
  const tableNames = [
    'tasks',
    'project_memberships',
    'app_users',
    'projects',
    'organizations',
    eventlogTableName,
  ];

  const quotedTableNames = tableNames.map((tableName) => quoteIdent(tableName));
  await sql.unsafe(
    `truncate table ${quotedTableNames.join(', ')} restart identity cascade`
  );
}

async function seedData(options: Required<SeedRequest>): Promise<void> {
  const taskInsertBatchSize = 2_000;
  let nextSeqNum = 1;

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

    for (let projectIndex = 0; projectIndex < options.projectsPerOrg; projectIndex += 1) {
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
      for (let membershipIndex = 0; membershipIndex < membershipCount; membershipIndex += 1) {
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
        const taskRows: TaskRow[] = [];
        const eventRows: Array<{
          seqNum: number;
          parentSeqNum: number;
          name: string;
          args: TaskArgs;
          clientId: string;
          sessionId: string;
        }> = [];

        const taskBatchEnd = Math.min(
          options.tasksPerProject,
          taskBatchStart + taskInsertBatchSize
        );

        for (let taskIndex = taskBatchStart; taskIndex < taskBatchEnd; taskIndex += 1) {
          const ownerId = userIds[taskIndex % membershipCount];
          if (!ownerId) continue;
          const taskOrdinal = formatOrdinal(taskIndex + 1, 6);
          const task: TaskRow = {
            id: `${projectId}-task-${taskOrdinal}`,
            org_id: orgId,
            project_id: projectId,
            owner_id: ownerId,
            title: `Task ${taskIndex + 1} in ${projectId}`,
            completed: taskIndex % 3 === 0,
            server_version: 1,
            updated_at: new Date().toISOString(),
          };
          const currentSeqNum = nextSeqNum;
          const parentSeqNum = currentSeqNum === 1 ? 0 : currentSeqNum - 1;
          taskRows.push(task);
          eventRows.push({
            seqNum: currentSeqNum,
            parentSeqNum,
            name: 'taskUpserted',
            args: task,
            clientId: 'seed',
            sessionId: 'seed-session',
          });
          nextSeqNum += 1;
        }

        if (taskRows.length > 0) {
          await sql`
            insert into tasks ${sql(taskRows)}
          `;
          await sql`
            insert into ${sql(eventlogTableName)} ${sql(
              eventRows,
              ['seqNum', 'parentSeqNum', 'name', 'args', 'clientId', 'sessionId']
            )}
          `;
        }
      }
    }
  }
}

async function appendServerEvent(
  tx: QueryRunner,
  row: TaskRow
): Promise<void> {
  const nextSeqRows = await tx.unsafe<{ next_seq: number }[]>(
    `
      select coalesce(max("seqNum"), 0) + 1 as next_seq
      from ${quoteIdent(eventlogTableName)}
    `
  );
  const nextSeqNum = nextSeqRows[0]?.next_seq ?? 1;
  const parentSeqNum = nextSeqNum === 1 ? 0 : nextSeqNum - 1;

  await tx.unsafe(
    `
      insert into ${quoteIdent(eventlogTableName)} (
        "seqNum",
        "parentSeqNum",
        "name",
        "args",
        "clientId",
        "sessionId"
      )
      values ($1, $2, $3, $4::jsonb, $5, $6)
    `,
    [
      nextSeqNum,
      parentSeqNum,
      'taskUpserted',
      row,
      'server',
      'server-session',
    ]
  );
}

async function upsertTask(
  tx: QueryRunner,
  task: TaskArgs
): Promise<void> {
  await tx.unsafe(
    `
      insert into tasks (
        id,
        org_id,
        project_id,
        owner_id,
        title,
        completed,
        server_version,
        updated_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8
      )
      on conflict (id) do update
      set
        org_id = excluded.org_id,
        project_id = excluded.project_id,
        owner_id = excluded.owner_id,
        title = excluded.title,
        completed = excluded.completed,
        server_version = excluded.server_version,
        updated_at = excluded.updated_at
    `,
    [
      task.id,
      task.org_id,
      task.project_id,
      task.owner_id,
      task.title,
      task.completed,
      task.server_version,
      task.updated_at,
    ]
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
  const [organizations, projects, users, memberships, tasks] = await Promise.all([
    countRows('organizations'),
    countRows('projects'),
    countRows('app_users'),
    countRows('project_memberships'),
    countRows('tasks'),
  ]);

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

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
