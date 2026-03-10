import { Hono } from 'hono';
import postgres from 'postgres';

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

interface OrganizationRow {
  id: string;
  name: string;
}

interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
}

interface ReplicacheCookie {
  order: number;
  orgCount: number;
  projectCount: number;
  taskCount: number;
  maxUpdatedAt: string;
  versionSum: number;
}

interface PullRequestV1 {
  pullVersion: 1;
  schemaVersion: string;
  profileID: string;
  cookie: ReplicacheCookie | null;
  clientGroupID: string;
}

interface PullResponseV1 {
  cookie: ReplicacheCookie;
  lastMutationIDChanges: Record<string, number>;
  patch: Array<
    | {
        op: 'clear';
      }
    | {
        op: 'put';
        key: string;
        value: {
          id: string;
          name: string;
        };
      }
    | {
        op: 'put';
        key: string;
        value: {
          id: string;
          orgId: string;
          name: string;
        };
      }
    | {
        op: 'put';
        key: string;
        value: {
          id: string;
          orgId: string;
          projectId: string;
          ownerId: string;
          title: string;
          completed: boolean;
          serverVersion: number;
          updatedAt: string;
        };
      }
  >;
}

interface PushRequestV1 {
  pushVersion: 1;
  schemaVersion: string;
  profileID: string;
  clientGroupID: string;
  mutations: Array<{
    id: number;
    name: string;
    args: {
      taskId?: string;
      title?: string;
      completed?: boolean;
    } | null;
    timestamp: number;
    clientID: string;
  }>;
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';
const port = Number(process.env.PORT ?? '3000');
const sql = postgres(databaseUrl, { max: 5 });
type QueryRunner = Pick<typeof sql, 'unsafe'>;

await ensureTables();

const app = new Hono();

app.get('/health', async (c) => {
  const result = await sql<{ ok: number }[]>`select 1 as ok`;
  return c.json({ ok: result[0]?.ok === 1 });
});

app.post('/replicache/pull', async (c) => {
  const request = await c.req.json<PullRequestV1>();
  const actorId = c.req.query('actorId') ?? null;
  if (request.pullVersion !== 1) {
    return c.json({ error: 'VersionNotSupported', versionType: 'pull' }, 400);
  }

  const cookie = await computeCookie(actorId);
  const cookieChanged = !areCookiesEqual(request.cookie, cookie);
  const lastMutationIDChanges = cookieChanged
    ? await getLastMutationIDChanges()
    : {};
  const patch = cookieChanged ? await buildFullPatch(actorId) : [];

  const response: PullResponseV1 = {
    cookie,
    lastMutationIDChanges,
    patch,
  };

  return c.json(response);
});

app.post('/replicache/push', async (c) => {
  const request = await c.req.json<PushRequestV1>();
  if (request.pushVersion !== 1) {
    return c.json({ error: 'VersionNotSupported', versionType: 'push' }, 400);
  }

  await sql.begin(async (tx) => {
    for (const mutation of request.mutations) {
      const currentState = await tx.unsafe<{
        last_mutation_id: number;
      }[]>(
        `
          select last_mutation_id
          from replicache_clients
          where client_id = $1
          for update
        `,
        [mutation.clientID]
      );

      const lastMutationId = currentState[0]?.last_mutation_id ?? 0;
      if (mutation.id <= lastMutationId) {
        continue;
      }
      if (mutation.id > lastMutationId + 1) {
        throw new Error(
          `Replicache mutation gap for ${mutation.clientID}: expected ${
            lastMutationId + 1
          }, got ${mutation.id}`
        );
      }

      await applyMutation(tx, mutation);

      await tx.unsafe(
        `
          insert into replicache_clients (
            client_id,
            last_mutation_id,
            updated_at
          )
          values (
            $1,
            $2,
            now()
          )
          on conflict (client_id) do update
          set
            last_mutation_id = excluded.last_mutation_id,
            updated_at = excluded.updated_at
        `,
        [mutation.clientID, mutation.id]
      );
    }
  });

  return c.body(null, 200);
});

app.post('/benchmark/revoke-membership', async (c) => {
  const request = await c.req.json<{
    actorId?: string;
    projectId?: string;
  }>();

  if (!request.actorId || !request.projectId) {
    return c.json({ error: 'actorId and projectId are required' }, 400);
  }

  await sql`
    delete from project_memberships
    where user_id = ${request.actorId}
      and project_id = ${request.projectId}
  `;

  return c.json({ ok: true });
});

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`[replicache-bench-app] listening on :${port}`);

async function ensureTables(): Promise<void> {
  await sql`
    create table if not exists tasks (
      id text primary key,
      org_id text not null default '',
      project_id text not null default '',
      owner_id text not null default '',
      title text not null,
      completed boolean not null default false,
      server_version integer not null default 1,
      updated_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists replicache_clients (
      client_id text primary key,
      last_mutation_id integer not null default 0,
      updated_at timestamptz not null default now()
    )
  `;
}

async function computeCookie(actorId: string | null): Promise<ReplicacheCookie> {
  const rows = await sql<{
    org_count: string;
    project_count: string;
    task_count: string;
    max_updated_at: string | null;
    version_sum: string;
  }[]>`
    select
      count(distinct organizations.id)::text as org_count,
      count(distinct projects.id)::text as project_count,
      count(*)::text as task_count,
      max(updated_at)::text as max_updated_at,
      coalesce(sum(server_version), 0)::text as version_sum
    from tasks
    join projects on projects.id = tasks.project_id
    join organizations on organizations.id = projects.org_id
    ${actorId
      ? sql`
          where exists (
            select 1
            from project_memberships
            where project_memberships.project_id = tasks.project_id
              and project_memberships.user_id = ${actorId}
          )
        `
      : sql``}
  `;
  const row = rows[0];

  return {
    order: Number(row?.version_sum ?? '0'),
    orgCount: Number(row?.org_count ?? '0'),
    projectCount: Number(row?.project_count ?? '0'),
    taskCount: Number(row?.task_count ?? '0'),
    maxUpdatedAt: row?.max_updated_at ?? '',
    versionSum: Number(row?.version_sum ?? '0'),
  };
}

async function getLastMutationIDChanges(): Promise<Record<string, number>> {
  const rows = await sql<{
    client_id: string;
    last_mutation_id: number;
  }[]>`
    select client_id, last_mutation_id
    from replicache_clients
  `;

  return Object.fromEntries(
    rows.map((row) => [row.client_id, row.last_mutation_id] as const)
  );
}

async function buildFullPatch(actorId: string | null): Promise<PullResponseV1['patch']> {
  const organizations = await sql<OrganizationRow[]>`
    select distinct
      organizations.id,
      organizations.name
    from organizations
    ${actorId
      ? sql`
          where exists (
            select 1
            from project_memberships
            join projects on projects.id = project_memberships.project_id
            where projects.org_id = organizations.id
              and project_memberships.user_id = ${actorId}
          )
        `
      : sql``}
    order by organizations.id
  `;

  const projects = await sql<ProjectRow[]>`
    select
      projects.id,
      projects.org_id,
      projects.name
    from projects
    ${actorId
      ? sql`
          where exists (
            select 1
            from project_memberships
            where project_memberships.project_id = projects.id
              and project_memberships.user_id = ${actorId}
          )
        `
      : sql``}
    order by projects.id
  `;

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
    ${actorId
      ? sql`
          where exists (
            select 1
            from project_memberships
            where project_memberships.project_id = tasks.project_id
              and project_memberships.user_id = ${actorId}
          )
        `
      : sql``}
    order by id
  `;

  return [
    { op: 'clear' },
    ...organizations.map((row) => ({
      op: 'put' as const,
      key: `org/${row.id}`,
      value: {
        id: row.id,
        name: row.name,
      },
    })),
    ...projects.map((row) => ({
      op: 'put' as const,
      key: `project/${row.id}`,
      value: {
        id: row.id,
        orgId: row.org_id,
        name: row.name,
      },
    })),
    ...rows.map((row) => ({
      op: 'put' as const,
      key: `task/${row.id}`,
      value: {
        id: row.id,
        orgId: row.org_id,
        projectId: row.project_id,
        ownerId: row.owner_id,
        title: row.title,
        completed: row.completed,
        serverVersion: row.server_version,
        updatedAt: row.updated_at,
      },
    })),
  ];
}

function areCookiesEqual(
  left: ReplicacheCookie | null,
  right: ReplicacheCookie
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.order === right.order &&
    left.orgCount === right.orgCount &&
    left.projectCount === right.projectCount &&
    left.taskCount === right.taskCount &&
    left.maxUpdatedAt === right.maxUpdatedAt &&
    left.versionSum === right.versionSum
  );
}

async function applyMutation(
  tx: QueryRunner,
  mutation: PushRequestV1['mutations'][number]
): Promise<void> {
  if (mutation.name !== 'updateTask') {
    throw new Error(`Unsupported Replicache mutator: ${mutation.name}`);
  }

  const taskId = mutation.args?.taskId;
  if (!taskId) {
    throw new Error('Replicache updateTask requires taskId');
  }

  await tx.unsafe(
    `
      update tasks
      set
        title = coalesce($1, title),
        completed = coalesce($2, completed),
        server_version = server_version + 1,
        updated_at = now()
      where id = $3
    `,
    [mutation.args?.title ?? null, mutation.args?.completed ?? null, taskId]
  );
}
