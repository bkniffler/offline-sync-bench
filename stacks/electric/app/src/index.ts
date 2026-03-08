import { Hono } from 'hono';
import postgres from 'postgres';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';
const electricBaseUrl = process.env.ELECTRIC_BASE_URL ?? 'http://electric:3000';
const port = Number(process.env.PORT ?? '3000');
const sql = postgres(databaseUrl, { max: 5 });

const app = new Hono();

app.get('/health', async (c) => {
  const result = await sql<{ ok: number }[]>`select 1 as ok`;
  return c.json({ ok: result[0]?.ok === 1 });
});

app.get('/benchmark/shape/tasks', async (c) => {
  const actorId = c.req.header('x-user-id') ?? c.req.query('userId');
  if (!actorId) {
    return c.json({ error: 'UNAUTHENTICATED' }, 401);
  }

  const projectRows = await sql<{ project_id: string }[]>`
    select project_id
    from project_memberships
    where user_id = ${actorId}
    order by project_id
  `;
  const projectIds = projectRows.map((row) => row.project_id);

  const url = new URL('/v1/shape', electricBaseUrl);
  url.searchParams.set('table', 'tasks');
  url.searchParams.set('offset', c.req.query('offset') ?? '-1');

  const handle = c.req.query('handle');
  if (handle) {
    url.searchParams.set('handle', handle);
  }

  const live = c.req.query('live');
  if (live) {
    url.searchParams.set('live', live);
  }

  const where =
    projectIds.length > 0
      ? `project_id in (${projectIds.map(quoteSqlString).join(', ')})`
      : '1 = 0';
  url.searchParams.set('where', where);

  const response = await fetch(url.toString(), {
    headers: {
      accept: 'application/json',
    },
  });

  const body = await response.arrayBuffer();
  const proxied = new Response(body, {
    status: response.status,
    headers: filterShapeHeaders(response.headers),
  });

  return proxied;
});

app.post('/benchmark/revoke-membership', async (c) => {
  const request = await c.req.json<{
    projectId: string;
    userId: string;
  }>();

  const deletedMembership = await sql<{
    project_id: string;
    user_id: string;
  }[]>`
    delete from project_memberships
    where project_id = ${request.projectId}
      and user_id = ${request.userId}
    returning project_id, user_id
  `;

  const membership = deletedMembership[0];
  if (!membership) {
    return c.json({ ok: false, error: 'MEMBERSHIP_NOT_FOUND' }, 404);
  }

  return c.json({
    ok: true,
    membership,
  });
});

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`[electric-bench-app] listening on :${port}`);

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function filterShapeHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  for (const [key, value] of headers.entries()) {
    if (
      key === 'content-type' ||
      key.startsWith('electric-') ||
      key === 'cache-control' ||
      key === 'etag'
    ) {
      filtered.set(key, value);
    }
  }
  return filtered;
}
