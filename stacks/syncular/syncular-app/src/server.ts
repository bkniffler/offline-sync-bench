/**
 * Syncular v2 bench sync server — one Bun process serving
 * - POST /api/sync + GET /api/segments/:id + /api/blobs/* via server-hono,
 * - ws /api/sync/realtime wired to the RealtimeHub (§8),
 * - /health + /benchmark/config for the harness.
 *
 * Storage is Postgres relational server storage (real per-app tables).
 * Admin-process commits arrive via the engine's LISTEN/NOTIFY fanout
 * (PostgresFanout) — the supported multi-instance wake path.
 *
 * Authorization is the real model: `resolveScopes` derives an actor's
 * allowed projects from the materialized project_memberships table on every
 * round, so /admin/revoke-membership revokes subscriptions on the next sync.
 *
 * Blobs: MinIO (S3-compatible) with PRESIGNED upload grants + download URLs
 * (§5.9.3/§5.9.5). Two store handles share one bucket: the internal-endpoint
 * one does server-side ops; the public-endpoint one only signs URLs that the
 * host-side bench clients fetch (presigned URLs bind the Host header).
 */
import {
  createRealtimeHub,
  MemorySegmentStore,
  PostgresFanout,
  type RealtimeSession,
  type ResolveScopes,
  S3BlobStore,
  s3PresignedBlobUploads,
  s3PresignedBlobUrls,
  type SyncServerConfig,
} from '@syncular/server';
import { buildSqliteImage } from '@syncular/server/sqlite';
import { createSyncularHono } from '@syncular/server-hono';
import { Hono } from 'hono';
import { type Db, openDb, PARTITION } from './shared';
import { schema } from './syncular.generated';

const PORT = Number(process.env.PORT ?? '3000');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://bench:bench@postgres:5432/bench?sslmode=disable';

const db: Db = await openDb(databaseUrl);

// -- blobs: MinIO via presigned upload grants + download URLs ---------------

const s3Internal = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://minio:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  bucket: process.env.S3_BUCKET ?? 'syncular-blobs',
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
};
const blobs = new S3BlobStore(s3Internal);
/** Same bucket, but URLs signed against the host-reachable endpoint. */
const blobPresigner = new S3BlobStore({
  ...s3Internal,
  endpoint: process.env.S3_PUBLIC_ENDPOINT ?? s3Internal.endpoint,
});

// -- authorization: membership-derived scopes (the real model) --------------

const resolveScopes: ResolveScopes = async ({ actorId }) => {
  const [users, memberships] = await Promise.all([
    db.query<{ org_id: string }>(
      `SELECT org_id FROM app_users
       WHERE _sync_partition = $1 AND _sync_row_id = $2 LIMIT 1`,
      [PARTITION, actorId],
    ),
    db.query<{ project_id: string }>(
      `SELECT project_id FROM project_memberships
       WHERE _sync_partition = $1 AND user_id = $2`,
      [PARTITION, actorId],
    ),
  ]);
  const orgIds = users.map((row) => row.org_id);
  return {
    // organizations scope by their own `id` column; projects/app_users by
    // `org_id`; tasks/memberships/blob entries by `project_id`.
    id: orgIds,
    org_id: orgIds,
    project_id: memberships.map((row) => row.project_id),
  };
};

// -- sync server -------------------------------------------------------------

const segments = new MemorySegmentStore();
const hub = createRealtimeHub({
  schema,
  storage: db.storage,
  resolveScopes,
  segments,
});
const config: SyncServerConfig = {
  schema,
  storage: db.storage,
  segments,
  blobs,
  maxBlobBytes: 256 * 1024 * 1024,
  resolveScopes,
  realtime: hub,
  blobSignedUrls: s3PresignedBlobUrls(blobPresigner, { ttlSeconds: 900 }),
  blobUploadUrls: s3PresignedBlobUploads(blobPresigner, { ttlSeconds: 900 }),
  sqliteImageBuilder: buildSqliteImage,
};

const fanout = new PostgresFanout({
  listen: (channel, handler) => db.listen(handler),
  notify: async () => {
    // The sync server originates no admin commits; push commits notify the
    // local hub in-process via `config.realtime`.
  },
});
await fanout.install(hub);

const syncularHono = createSyncularHono({
  config,
  authenticate: async (request) => {
    const actorId =
      request.headers.get('x-actor-id') ??
      new URL(request.url).searchParams.get('actorId');
    if (actorId === null || actorId.length === 0) return null;
    return { actorId, partition: PARTITION };
  },
});

const app = new Hono();
app.get('/health', async (c) => {
  const rows = await db.query<{ ok: number }>('SELECT 1 AS ok');
  return c.json({ ok: Number(rows[0]?.ok) === 1, stackId: 'syncular' });
});
app.get('/benchmark/config', (c) =>
  c.json({
    stackId: 'syncular',
    engine: 'syncular-v2',
    schemaVersion: schema.version,
    serverStorage: 'postgres-relational',
    blobDelivery: 'presigned',
    realtime: 'websocket',
    partition: PARTITION,
  }),
);
// The syncular repo pins its own hono copy; the instance is runtime-compatible.
app.route('/api', syncularHono as unknown as Hono);

interface SocketData {
  clientId: string;
  actorId: string;
  session?: RealtimeSession;
}

const server = Bun.serve<SocketData, never>({
  port: PORT,
  idleTimeout: 240,
  async fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === '/api/sync/realtime') {
      const actorId =
        request.headers.get('x-actor-id') ?? url.searchParams.get('actorId');
      if (actorId === null || actorId.length === 0) {
        return new Response('missing actor', { status: 401 });
      }
      const clientId =
        url.searchParams.get('clientId') ?? crypto.randomUUID();
      if (bunServer.upgrade(request, { data: { clientId, actorId } })) {
        return undefined as unknown as Response;
      }
      return new Response('expected a websocket upgrade', { status: 400 });
    }
    return app.fetch(request);
  },
  websocket: {
    open(ws) {
      hub
        .connect({
          partition: PARTITION,
          actorId: ws.data.actorId,
          clientId: ws.data.clientId,
          send: (data) => {
            ws.send(data);
          },
          closeSocket: () => ws.close(1008, 'protocol violation (§8.7)'),
        })
        .then((session) => {
          ws.data.session = session;
        })
        .catch(() => ws.close(1011, 'realtime connect failed'));
    },
    message(ws, message) {
      if (typeof message === 'string') {
        ws.data.session?.handleMessage(message);
      } else {
        ws.data.session?.handleBinary(new Uint8Array(message));
      }
    },
    close(ws) {
      ws.data.session?.close();
    },
  },
});

console.log(`[syncular-server] listening on :${server.port}`);
