import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import postgres from 'postgres';

interface CrudBatchRequest {
  batch?: Array<{
    op?: 'PUT' | 'PATCH' | 'DELETE';
    table?: string;
    id?: string;
    data?: Record<string, string | number | boolean | null>;
  }>;
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';
const port = Number(process.env.PORT ?? '3000');
const audience = process.env.POWERSYNC_AUDIENCE ?? 'powersync';
const issuer = process.env.POWERSYNC_ISSUER ?? 'powersync-bench';
const sql = postgres(databaseUrl, { max: 5 });

await ensureTasksTable();

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = await exportJWK(publicKey);
const keyId = 'powersync-bench-key';

const app = new Hono();

app.get('/health', async (c) => {
  const result = await sql<{ ok: number }[]>`select 1 as ok`;
  return c.json({ ok: result[0]?.ok === 1 });
});

app.get('/api/auth/keys', async (c) => {
  return c.json({
    keys: [
      {
        ...publicJwk,
        alg: 'RS256',
        kid: keyId,
        use: 'sig',
      },
    ],
  });
});

app.get('/api/auth/token', async (c) => {
  const userId = c.req.query('user_id') ?? 'bench-user';
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(userId)
    .setExpirationTime('10m')
    .sign(privateKey);

  return c.json({ token });
});

app.post('/api/data', async (c) => {
  const request = await c.req.json<CrudBatchRequest>();
  const batch = request.batch ?? [];

  for (const operation of batch) {
    if (operation.table !== 'tasks' || !operation.id) {
      continue;
    }

    if (operation.op === 'DELETE') {
      await sql`
        delete from tasks
        where id = ${operation.id}
      `;
      continue;
    }

    const title =
      typeof operation.data?.title === 'string'
        ? operation.data.title
        : undefined;
    const completed =
      typeof operation.data?.completed === 'boolean'
        ? operation.data.completed
        : typeof operation.data?.completed === 'number'
          ? operation.data.completed !== 0
          : undefined;

    if (operation.op === 'PUT') {
      await sql`
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
          ${operation.id},
          ${typeof operation.data?.org_id === 'string' ? operation.data.org_id : ''},
          ${typeof operation.data?.project_id === 'string' ? operation.data.project_id : ''},
          ${typeof operation.data?.owner_id === 'string' ? operation.data.owner_id : ''},
          ${title ?? ''},
          ${completed ?? false},
          1,
          now()
        )
        on conflict (id) do update
        set
          org_id = excluded.org_id,
          project_id = excluded.project_id,
          owner_id = excluded.owner_id,
          title = excluded.title,
          completed = excluded.completed,
          server_version = tasks.server_version + 1,
          updated_at = now()
      `;
      continue;
    }

    await sql`
      update tasks
      set
        title = coalesce(${title ?? null}, title),
        completed = coalesce(${completed ?? null}, completed),
        server_version = server_version + 1,
        updated_at = now()
      where id = ${operation.id}
    `;
  }

  return c.json({ ok: true, applied: batch.length });
});

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`[powersync-bench-app] listening on :${port}`);

async function ensureTasksTable(): Promise<void> {
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
