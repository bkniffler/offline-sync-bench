import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createClient,
  createClientHandler,
  type SyncClientPlugin,
  type MutationReceipt,
  type SyncClientDb,
  type ClientTableHandler,
} from '../../../syncular/packages/client/src/index.ts';
import {
  decodeSnapshotRows,
  type SyncCombinedRequest,
  type ScopeValues,
  type SyncCombinedResponse,
  type SyncBootstrapState,
  type SyncPullSubscriptionResponse,
} from '../../../syncular/packages/core/src/index.ts';
import { createBunSqliteDialect } from '../../../syncular/packages/dialect-bun-sqlite/src/index.ts';
import { createHttpTransport } from '../../../syncular/packages/transport-http/src/index.ts';
import { createWebSocketTransport } from '../../../syncular/packages/transport-ws/src/index.ts';
import {
  createBlobPlugin,
  type BlobClient,
  type ClientBlobStorage,
} from '../../../syncular/plugins/blob/client/src/index.ts';
import { Kysely, sql } from 'kysely';
import { createHttpMeter } from '../http-meter';
import {
  average,
  CpuSampler,
  DockerServiceSampler,
  MemorySampler,
  percentile,
  round,
} from '../metrics';
import { tempRoot } from '../paths';
import {
  ensureStackUp,
  getFixtures,
  listTasks,
  resolveServiceContainerId,
  seedStack,
  startService,
  stopService,
  waitForUrlDown,
  writeTask,
} from '../stack-manager';
import { getStack } from '../stacks';
import type {
  BenchmarkAdapter,
  BenchmarkStatus,
  BootstrapScaleResult,
  JsonValue,
  OnlinePropagationSample,
} from '../types';

interface LocalTaskRow {
  id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: boolean;
  server_version: number;
  updated_at: string;
}

interface LocalTaskBlobRow {
  id: string;
  project_id: string;
  blob_hash: string | null;
  blob_size: number | null;
  blob_mime_type: string | null;
  server_version: number;
  updated_at: string;
}

interface SyncularClientDb extends SyncClientDb {
  tasks: LocalTaskRow;
  task_blob_entries: LocalTaskBlobRow;
}

interface PushResultPayload {
  clientCommitId: string;
  status: 'applied' | 'cached' | 'rejected' | 'retriable';
}

interface SyncularClientSession {
  client: Awaited<ReturnType<typeof createClient<SyncularClientDb>>>['client'];
  db: Kysely<SyncularClientDb>;
  destroy: () => Promise<void>;
  meterSnapshot: () => {
    requestCount: number;
    requestBytes: number;
    responseBytes: number;
  };
  dbPath: string;
}

interface HttpMeterTotals {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
}

interface BootstrapPhaseTotals {
  pullRequestMs: number;
  snapshotFetchMs: number;
  snapshotDecodeMs: number;
  localApplyMs: number;
}

interface ServerBootstrapTimings {
  snapshotQueryMs: number;
  rowFrameEncodeMs: number;
  chunkCacheLookupMs: number;
  chunkGzipMs: number;
  chunkHashMs: number;
  chunkPersistMs: number;
}

const syncularCaptureBootstrapTimings =
  process.env.SYNCULAR_BENCH_CAPTURE_BOOTSTRAP_TIMINGS === '1';

interface SyncClientWithSync {
  sync(): Promise<unknown>;
  awaitBootstrapComplete(args?: { timeoutMs?: number }): Promise<unknown>;
}

const SYNCULAR_BENCH_BOOTSTRAP_LIMIT_SNAPSHOT_ROWS = 20_000;
const SYNCULAR_BENCH_BOOTSTRAP_MAX_SNAPSHOT_PAGES = 100;
const LOCAL_TASK_INSERT_BATCH_ROWS = 2_000;
async function createTempDbPath(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `${prefix}-`));
  return join(dir, 'client.sqlite');
}

function createMemoryBlobStorage(): ClientBlobStorage {
  const memory = new Map<string, Uint8Array>();

  return {
    async write(hash, data) {
      if (data instanceof ReadableStream) {
        const reader = data.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          chunks.push(chunk.value);
          totalBytes += chunk.value.length;
        }

        const combined = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        memory.set(hash, combined);
        return;
      }

      memory.set(hash, new Uint8Array(data));
    },

    async read(hash) {
      const data = memory.get(hash);
      return data ? new Uint8Array(data) : null;
    },

    async delete(hash) {
      memory.delete(hash);
    },

    async exists(hash) {
      return memory.has(hash);
    },

    async getUsage() {
      let totalBytes = 0;
      for (const value of memory.values()) {
        totalBytes += value.byteLength;
      }
      return totalBytes;
    },

    async clear() {
      memory.clear();
    },
  };
}

function hasBlobClient(
  client: SyncularClientSession['client']
): client is SyncularClientSession['client'] & { blobs: BlobClient } {
  return 'blobs' in client;
}

async function withMeteredGlobalFetch<T>(
  meteredFetch: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = meteredFetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createBlobPayload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function createOneShotFailingUploadFetch(baseFetch: typeof fetch): typeof fetch {
  let failedOnce = false;

  const flakyFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!failedOnce && request.method.toUpperCase() === 'PUT') {
        failedOnce = true;
        throw new Error('offline-sync-bench induced upload failure');
      }
      return baseFetch(request);
    },
    typeof baseFetch.preconnect === 'function'
      ? {
          preconnect: baseFetch.preconnect.bind(baseFetch),
        }
      : {}
  ) as typeof fetch;

  return flakyFetch;
}

async function readSqliteStorageBytes(dbPath: string): Promise<number> {
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  let totalBytes = 0;

  for (const candidate of candidates) {
    const fileStats = await stat(candidate).catch(() => null);
    if (!fileStats) continue;
    totalBytes += fileStats.size;
  }

  return totalBytes;
}

async function ensureLocalTables(db: Kysely<SyncularClientDb>): Promise<void> {
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('org_id', 'text', (column) => column.notNull())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('owner_id', 'text', (column) => column.notNull())
    .addColumn('title', 'text', (column) => column.notNull())
    .addColumn('completed', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('server_version', 'integer', (column) =>
      column.notNull().defaultTo(0)
    )
    .addColumn('updated_at', 'text', (column) => column.notNull())
    .execute();

  await db.schema
    .createTable('task_blob_entries')
    .ifNotExists()
    .addColumn('id', 'text', (column) => column.primaryKey())
    .addColumn('project_id', 'text', (column) => column.notNull())
    .addColumn('blob_hash', 'text')
    .addColumn('blob_size', 'integer')
    .addColumn('blob_mime_type', 'text')
    .addColumn('server_version', 'integer', (column) =>
      column.notNull().defaultTo(0)
    )
    .addColumn('updated_at', 'text', (column) => column.notNull())
    .execute();

  await sql`
    create index if not exists idx_tasks_project_owner_completed_updated_at
    on tasks (project_id, owner_id, completed, updated_at desc)
  `.execute(db);

  await sql`
    create index if not exists idx_tasks_project_owner_completed
    on tasks (project_id, owner_id, completed)
  `.execute(db);

  await sql`
    create index if not exists idx_tasks_project_id_id
    on tasks (project_id, id)
  `.execute(db);

  await sql`
    create index if not exists idx_task_blob_entries_project_id_id
    on task_blob_entries (project_id, id)
  `.execute(db);
}

function createSyncularHttpTransport(args: {
  actorId: string;
  fetchImpl?: typeof fetch;
}) {
  return createHttpTransport({
    baseUrl: getStack('syncular').syncBaseUrl,
    getHeaders: () => ({
      'x-user-id': args.actorId,
    }),
    ...(args.fetchImpl ? { fetch: args.fetchImpl } : {}),
  });
}

async function requestSyncularPull(args: {
  actorId: string;
  meterFetch: typeof fetch;
  body: SyncCombinedRequest;
  captureServerTimings?: boolean;
}): Promise<{
  response: SyncCombinedResponse;
  serverTimings: ServerBootstrapTimings | null;
}> {
  const syncRoute = `${getStack('syncular').syncBaseUrl}/sync`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-user-id': args.actorId,
  };
  if (args.captureServerTimings) {
    headers['x-syncular-bench-timings'] = '1';
  }
  const response = await args.meterFetch(syncRoute, {
    method: 'POST',
    headers,
    body: JSON.stringify(args.body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Syncular pull request failed: ${response.status} ${response.statusText} ${text}`
    );
  }

  const timingHeader = response.headers.get('x-syncular-bench-pull-timings');
  const parsedResponse = (await response.json()) as SyncCombinedResponse;
  let serverTimings: ServerBootstrapTimings | null = null;

  if (timingHeader) {
    try {
      const parsed = JSON.parse(timingHeader) as Partial<ServerBootstrapTimings>;
      serverTimings = {
        snapshotQueryMs: Number(parsed.snapshotQueryMs ?? 0),
        rowFrameEncodeMs: Number(parsed.rowFrameEncodeMs ?? 0),
        chunkCacheLookupMs: Number(parsed.chunkCacheLookupMs ?? 0),
        chunkGzipMs: Number(parsed.chunkGzipMs ?? 0),
        chunkHashMs: Number(parsed.chunkHashMs ?? 0),
        chunkPersistMs: Number(parsed.chunkPersistMs ?? 0),
      };
    } catch {
      serverTimings = null;
    }
  }

  return {
    response: parsedResponse,
    serverTimings,
  };
}

async function writeSyncularExternalTask(args: {
  taskId: string;
  title?: string;
  completed?: boolean;
}): Promise<void> {
  const response = await fetch(
    `${getStack('syncular').syncBaseUrl.replace(/\/api$/, '')}/benchmark/external-write`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Syncular benchmark external write failed: ${response.status} ${response.statusText} ${body}`
    );
  }
}

async function revokeSyncularProjectMembership(args: {
  projectId: string;
  userId: string;
}): Promise<void> {
  const response = await fetch(
    `${getStack('syncular').syncBaseUrl.replace(/\/api$/, '')}/benchmark/revoke-membership`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Syncular benchmark membership revoke failed: ${response.status} ${response.statusText} ${body}`
    );
  }
}

async function resetSyncularScopeCache(): Promise<void> {
  const response = await fetch(
    `${getStack('syncular').syncBaseUrl.replace(/\/api$/, '')}/benchmark/reset-scope-cache`,
    {
      method: 'POST',
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Syncular benchmark scope-cache reset failed: ${response.status} ${response.statusText} ${body}`
    );
  }
}

async function seedSyncularStack(
  options: Parameters<typeof seedStack>[1]
): Promise<void> {
  await seedStack('syncular', options);
  await resetSyncularScopeCache();
}

async function initializeSyncularTaskBlobs(projectId?: string): Promise<void> {
  const response = await fetch(
    `${getStack('syncular').syncBaseUrl.replace(/\/api$/, '')}/benchmark/init-task-blobs`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(
        projectId ? { projectId } : {}
      ),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Syncular benchmark task-blob init failed: ${response.status} ${response.statusText} ${body}`
    );
  }
}

async function waitForSyncularApiReady(args: {
  actorId: string;
  projectId: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let lastError = 'unreachable';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(
        `${getStack('syncular').syncBaseUrl}/sync`,
        {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': args.actorId,
        },
        body: JSON.stringify({
          clientId: 'benchmark-readiness',
          pull: {
            limitCommits: 200,
            subscriptions: [
              {
                id: 'benchmark-readiness-sub',
                table: 'tasks',
                scopes: {
                  project_id: args.projectId,
                },
                cursor: -1,
              },
            ],
          },
        }),
      }
      );

      if (response.ok) {
        return;
      }

      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for Syncular API readiness: ${lastError}`);
}

async function createSyncularClientSession(args: {
  actorId: string;
  clientId: string;
  projectIds: string[];
  realtime: boolean;
  dbPath?: string;
  pollIntervalMs?: number;
  includeBlobTable?: boolean;
  plugins?: SyncClientPlugin[];
  meter?: ReturnType<typeof createHttpMeter>;
}): Promise<SyncularClientSession> {
  const dbPath = args.dbPath ?? (await createTempDbPath(`syncular-${args.clientId}`));
  const db = new Kysely<SyncularClientDb>({
    dialect: createBunSqliteDialect({ path: dbPath }),
  });
  await ensureLocalTables(db);

  const meter = args.meter ?? createHttpMeter();
  const transportFetch = meter.fetch;
  const transport = args.realtime
    ? createWebSocketTransport({
        baseUrl: getStack('syncular').syncBaseUrl,
        getHeaders: () => ({
          'x-user-id': args.actorId,
        }),
        getRealtimeParams: () => ({
          userId: args.actorId,
        }),
        fetch: transportFetch,
        WebSocketImpl: WebSocket,
      })
    : createSyncularHttpTransport({
        actorId: args.actorId,
        fetchImpl: transportFetch,
      });

  const handler = createClientHandler<SyncularClientDb, 'tasks'>({
    table: 'tasks',
    scopes: ['project:{project_id}'],
    subscribe: {
      scopes: {
        project_id:
          args.projectIds.length === 1 ? args.projectIds[0]! : args.projectIds,
      },
    },
    versionColumn: 'server_version',
  });

  const handlers: ClientTableHandler<
    SyncularClientDb,
    keyof SyncularClientDb & string,
    string
  >[] = [handler];
  if (args.includeBlobTable) {
    handlers.push(
      createClientHandler<SyncularClientDb, 'task_blob_entries'>({
        table: 'task_blob_entries',
        scopes: ['project:{project_id}'],
        subscribe: {
          scopes: {
            project_id:
              args.projectIds.length === 1 ? args.projectIds[0]! : args.projectIds,
          },
        },
        versionColumn: 'server_version',
      })
    );
  }

  const session = await createClient({
    db,
    actorId: args.actorId,
    clientId: args.clientId,
    transport,
    handlers,
    autoStart: false,
    sync: {
      realtime: args.realtime,
      pollIntervalMs: args.pollIntervalMs ?? 10_000,
    },
    plugins: args.plugins,
  });

  return {
    client: session.client,
    db,
    destroy: async () => {
      await session.destroy();
      await db.destroy();
    },
    meterSnapshot: () => meter.snapshot(),
    dbPath,
  };
}

function diffMeterTotals(
  after: HttpMeterTotals,
  before: HttpMeterTotals
): HttpMeterTotals {
  return {
    requestCount: Math.max(0, after.requestCount - before.requestCount),
    requestBytes: Math.max(0, after.requestBytes - before.requestBytes),
    responseBytes: Math.max(0, after.responseBytes - before.responseBytes),
  };
}

async function countLocalTasks(db: Kysely<SyncularClientDb>): Promise<number> {
  const row = await db
    .selectFrom('tasks')
    .select((expressionBuilder) => expressionBuilder.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();

  return row.count;
}

async function countLocalTasksForProject(
  db: Kysely<SyncularClientDb>,
  projectId: string
): Promise<number> {
  const row = await db
    .selectFrom('tasks')
    .select((expressionBuilder) => expressionBuilder.fn.countAll<number>().as('count'))
    .where('project_id', '=', projectId)
    .executeTakeFirstOrThrow();

  return row.count;
}

async function getLocalTitle(
  db: Kysely<SyncularClientDb>,
  taskId: string
): Promise<string | null> {
  const row = await db
    .selectFrom('tasks')
    .select('title')
    .where('id', '=', taskId)
    .executeTakeFirst();

  return row?.title ?? null;
}

async function getLocalTaskBlobMetadata(
  db: Kysely<SyncularClientDb>,
  taskId: string
): Promise<{
  blobHash: string | null;
  blobSize: number | null;
  blobMimeType: string | null;
} | null> {
  const row = await db
    .selectFrom('task_blob_entries')
    .select(['blob_hash', 'blob_size', 'blob_mime_type'])
    .where('id', '=', taskId)
    .executeTakeFirst();

  if (!row) {
    return null;
  }

  return {
    blobHash: row.blob_hash,
    blobSize: row.blob_size,
    blobMimeType: row.blob_mime_type,
  };
}

async function countLocalTaskBlobs(
  db: Kysely<SyncularClientDb>
): Promise<number> {
  const row = await db
    .selectFrom('task_blob_entries')
    .select((expressionBuilder) => expressionBuilder.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();

  return row.count;
}

async function countOutbox(db: Kysely<SyncularClientDb>): Promise<number> {
  const row = await db
    .selectFrom('sync_outbox_commits')
    .select((expressionBuilder) => expressionBuilder.fn.countAll<number>().as('count'))
    .where('status', '!=', 'acked')
    .executeTakeFirstOrThrow();

  return row.count;
}

async function waitForLocalTitle(args: {
  client?: SyncClientWithSync;
  db: Kysely<SyncularClientDb>;
  taskId: string;
  expectedTitle: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const pollIntervalMs = 5;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await getLocalTitle(args.db, args.taskId)) === args.expectedTitle) {
      return;
    }
    if (args.client) {
      await args.client.sync();
    }
    await Bun.sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for local task ${args.taskId} title ${args.expectedTitle}`
  );
}

async function waitForLocalBlobMetadata(args: {
  client?: SyncClientWithSync;
  db: Kysely<SyncularClientDb>;
  taskId: string;
  expectedHash: string;
  expectedSize: number;
  expectedMimeType: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const pollIntervalMs = 5;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const metadata = await getLocalTaskBlobMetadata(args.db, args.taskId);
    if (
      metadata?.blobHash === args.expectedHash &&
      metadata.blobSize === args.expectedSize &&
      metadata.blobMimeType === args.expectedMimeType
    ) {
      return;
    }

    if (args.client) {
      await args.client.sync();
    }
    await Bun.sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for local blob metadata on task ${args.taskId}`
  );
}

async function waitForNextPushResult(
  client: SyncularClientSession['client'],
  timeoutMs = 30_000
): Promise<PushResultPayload> {
  return new Promise<PushResultPayload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for Syncular push:result'));
    }, timeoutMs);

    const unsubscribe = client.on('push:result', (payload) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve({
        clientCommitId: payload.clientCommitId,
        status: payload.status,
      });
    });
  });
}

async function waitForOutboxClear(args: {
  client: SyncClientWithSync;
  db: Kysely<SyncularClientDb>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const pollIntervalMs = 25;
  while (Date.now() - startedAt < timeoutMs) {
    if ((await countOutbox(args.db)) === 0) {
      return;
    }
    await args.client.sync();
    await Bun.sleep(pollIntervalMs);
  }

  throw new Error('Timed out waiting for Syncular outbox to clear');
}

async function waitForExpectedTaskCount(args: {
  client: SyncClientWithSync;
  db: Kysely<SyncularClientDb>;
  expectedRows: number;
  timeoutMs?: number;
}): Promise<number> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const count = await countLocalTasks(args.db);
    if (count === args.expectedRows) {
      return count;
    }
    if (count > args.expectedRows) {
      throw new Error(
        `Expected ${args.expectedRows} rows after bootstrap, got ${count}`
      );
    }

    await args.client.sync();
  }

  const finalCount = await countLocalTasks(args.db);
  throw new Error(
    `Timed out waiting for ${args.expectedRows} bootstrapped rows; got ${finalCount}`
  );
}

async function waitForLocalTaskCount(args: {
  client: SyncClientWithSync;
  db: Kysely<SyncularClientDb>;
  expectedRows: number;
  timeoutMs?: number;
}): Promise<number> {
  const timeoutMs = args.timeoutMs ?? 60_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const count = await countLocalTasks(args.db);
    if (count === args.expectedRows) {
      return count;
    }

    await args.client.sync();
    await Bun.sleep(5);
  }

  const finalCount = await countLocalTasks(args.db);
  throw new Error(
    `Timed out waiting for ${args.expectedRows} local rows; got ${finalCount}`
  );
}

async function waitForLocalTaskBlobCount(args: {
  client: SyncClientWithSync;
  db: Kysely<SyncularClientDb>;
  expectedRows: number;
  timeoutMs?: number;
}): Promise<number> {
  const timeoutMs = args.timeoutMs ?? 60_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const count = await countLocalTaskBlobs(args.db);
    if (count === args.expectedRows) {
      return count;
    }

    await args.client.sync();
    await Bun.sleep(5);
  }

  const finalCount = await countLocalTaskBlobs(args.db);
  throw new Error(
    `Timed out waiting for ${args.expectedRows} local task_blob_entries rows; got ${finalCount}`
  );
}

function normalizeTaskRow(row: Record<string, JsonValue>): LocalTaskRow {
  return {
    id: typeof row.id === 'string' ? row.id : '',
    org_id: typeof row.org_id === 'string' ? row.org_id : '',
    project_id: typeof row.project_id === 'string' ? row.project_id : '',
    owner_id: typeof row.owner_id === 'string' ? row.owner_id : '',
    title: typeof row.title === 'string' ? row.title : '',
    completed:
      typeof row.completed === 'boolean'
        ? row.completed
        : row.completed === 1 || row.completed === 'true',
    server_version:
      typeof row.server_version === 'number'
        ? row.server_version
        : Number(row.server_version ?? 0),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function materializeSyncularSnapshotRows(args: {
  snapshot: NonNullable<SyncPullSubscriptionResponse['snapshots']>[number];
  transport: ReturnType<typeof createHttpTransport>;
  scopeValues?: ScopeValues;
  phaseTotals?: BootstrapPhaseTotals;
}): Promise<LocalTaskRow[]> {
  const rows: LocalTaskRow[] = [];

  const inlineDecodeStartedAt = performance.now();
  for (const row of args.snapshot.rows ?? []) {
    if (!isJsonRecord(row)) {
      throw new Error('Syncular snapshot contained a non-object row');
    }
    rows.push(normalizeTaskRow(row));
  }
  if (args.phaseTotals) {
    args.phaseTotals.snapshotDecodeMs += performance.now() - inlineDecodeStartedAt;
  }

  for (const chunk of args.snapshot.chunks ?? []) {
    const fetchStartedAt = performance.now();
    const bytes = await args.transport.fetchSnapshotChunk({
      chunkId: chunk.id,
      scopeValues: args.scopeValues,
    });
    if (args.phaseTotals) {
      args.phaseTotals.snapshotFetchMs += performance.now() - fetchStartedAt;
    }

    const decodeStartedAt = performance.now();
    for (const decodedRow of decodeSnapshotRows(bytes)) {
      if (!isJsonRecord(decodedRow)) {
        throw new Error('Syncular snapshot chunk contained a non-object row');
      }
      rows.push(normalizeTaskRow(decodedRow));
    }
    if (args.phaseTotals) {
      args.phaseTotals.snapshotDecodeMs += performance.now() - decodeStartedAt;
    }
  }

  return rows;
}

async function insertLocalTaskRows(
  db: Kysely<SyncularClientDb>,
  rows: LocalTaskRow[],
  phaseTotals?: BootstrapPhaseTotals
): Promise<void> {
  const startedAt = performance.now();
  for (
    let index = 0;
    index < rows.length;
    index += LOCAL_TASK_INSERT_BATCH_ROWS
  ) {
    const batch = rows.slice(index, index + LOCAL_TASK_INSERT_BATCH_ROWS);
    if (batch.length === 0) continue;
    await db.insertInto('tasks').values(batch).execute();
  }
  if (phaseTotals) {
    phaseTotals.localApplyMs += performance.now() - startedAt;
  }
}

async function upsertLocalTaskRow(
  db: Kysely<SyncularClientDb>,
  row: LocalTaskRow,
  phaseTotals?: BootstrapPhaseTotals
): Promise<void> {
  const startedAt = performance.now();
  await db
    .insertInto('tasks')
    .values(row)
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        org_id: row.org_id,
        project_id: row.project_id,
        owner_id: row.owner_id,
        title: row.title,
        completed: row.completed,
        server_version: row.server_version,
        updated_at: row.updated_at,
      })
    )
    .execute();
  if (phaseTotals) {
    phaseTotals.localApplyMs += performance.now() - startedAt;
  }
}

async function applySyncularSubscriptionPayload(args: {
  db: Kysely<SyncularClientDb>;
  subscription: SyncPullSubscriptionResponse;
  transport: ReturnType<typeof createHttpTransport>;
  phaseTotals?: BootstrapPhaseTotals;
}): Promise<void> {
  await args.db.transaction().execute(async (trx) => {
    for (const snapshot of args.subscription.snapshots ?? []) {
      const rows = await materializeSyncularSnapshotRows({
        snapshot,
        transport: args.transport,
        scopeValues: args.subscription.scopes,
        phaseTotals: args.phaseTotals,
      });
      await insertLocalTaskRows(trx, rows, args.phaseTotals);
    }

    for (const commit of args.subscription.commits ?? []) {
      for (const change of commit.changes ?? []) {
        const rowId = change.row_id;
        if (!rowId) continue;

        if (change.op === 'delete') {
          const deleteStartedAt = performance.now();
          await trx.deleteFrom('tasks').where('id', '=', rowId).execute();
          if (args.phaseTotals) {
            args.phaseTotals.localApplyMs += performance.now() - deleteStartedAt;
          }
          continue;
        }

        const rowJson = change.row_json;
        if (!isJsonRecord(rowJson)) continue;
        await upsertLocalTaskRow(
          trx,
          normalizeTaskRow(rowJson),
          args.phaseTotals
        );
      }
    }
  });
}

async function runDirectBootstrap(args: {
  actorId: string;
  clientId: string;
  projectId: string;
  rowsTarget: number;
}): Promise<{
  rowsLoaded: number;
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  bytesTransferred: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
  durationMs: number;
  pullRequestMs: number;
  snapshotFetchMs: number;
  snapshotDecodeMs: number;
  localApplyMs: number;
  serverSnapshotQueryMs: number;
  serverRowFrameEncodeMs: number;
  serverChunkCacheLookupMs: number;
  serverChunkGzipMs: number;
  serverChunkHashMs: number;
  serverChunkPersistMs: number;
}> {
  const dbPath = await createTempDbPath(`syncular-bootstrap-${args.rowsTarget}`);
  const db = new Kysely<SyncularClientDb>({
    dialect: createBunSqliteDialect({ path: dbPath }),
  });
  await ensureLocalTables(db);

  const meter = createHttpMeter();
  const transport = createSyncularHttpTransport({
    actorId: args.actorId,
    fetchImpl: meter.fetch,
  });
  const sampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  sampler.start();
  cpuSampler.start();
  const startedAt = performance.now();
  let cursor = -1;
  let bootstrapState: SyncBootstrapState | null = null;
  let iterations = 0;
  const phaseTotals: BootstrapPhaseTotals = {
    pullRequestMs: 0,
    snapshotFetchMs: 0,
    snapshotDecodeMs: 0,
    localApplyMs: 0,
  };
  const serverTimings: ServerBootstrapTimings = {
    snapshotQueryMs: 0,
    rowFrameEncodeMs: 0,
    chunkCacheLookupMs: 0,
    chunkGzipMs: 0,
    chunkHashMs: 0,
    chunkPersistMs: 0,
  };

  try {
    while (iterations < 200) {
      iterations += 1;

      const pullStartedAt = performance.now();
      const { response: body, serverTimings: pullTimings } =
        await requestSyncularPull({
          actorId: args.actorId,
          meterFetch: meter.fetch,
          captureServerTimings: syncularCaptureBootstrapTimings,
          body: {
          clientId: args.clientId,
          pull: {
            limitCommits: 100,
            limitSnapshotRows: SYNCULAR_BENCH_BOOTSTRAP_LIMIT_SNAPSHOT_ROWS,
            maxSnapshotPages: SYNCULAR_BENCH_BOOTSTRAP_MAX_SNAPSHOT_PAGES,
          subscriptions: [
            {
              id: 'tasks',
              table: 'tasks',
              scopes: {
                project_id: args.projectId,
              },
              cursor,
              bootstrapState,
            },
          ],
        },
          },
        });
      phaseTotals.pullRequestMs += performance.now() - pullStartedAt;
      if (pullTimings) {
        serverTimings.snapshotQueryMs += pullTimings.snapshotQueryMs;
        serverTimings.rowFrameEncodeMs += pullTimings.rowFrameEncodeMs;
        serverTimings.chunkCacheLookupMs += pullTimings.chunkCacheLookupMs;
        serverTimings.chunkGzipMs += pullTimings.chunkGzipMs;
        serverTimings.chunkHashMs += pullTimings.chunkHashMs;
        serverTimings.chunkPersistMs += pullTimings.chunkPersistMs;
      }
      const subscription = body.pull?.subscriptions?.[0];
      if (!body.ok || !body.pull?.ok || !subscription) {
        throw new Error('Syncular direct bootstrap returned an invalid pull payload');
      }
      if (subscription.status === 'revoked') {
        throw new Error('Syncular direct bootstrap subscription was revoked');
      }

      await applySyncularSubscriptionPayload({
        db,
        subscription,
        transport,
        phaseTotals,
      });

      cursor =
        typeof subscription.nextCursor === 'number'
          ? subscription.nextCursor
          : cursor;
      bootstrapState = subscription.bootstrapState ?? null;

      if (bootstrapState === null) {
        break;
      }
    }

    const rowsLoaded = await countLocalTasks(db);
    if (rowsLoaded !== args.rowsTarget) {
      throw new Error(
        `Syncular direct bootstrap expected ${args.rowsTarget} rows, got ${rowsLoaded}`
      );
    }

    const meterSnapshot = meter.snapshot();
    const memoryMetrics = sampler.stop();
    const cpuMetrics = cpuSampler.stop();
    return {
      rowsLoaded,
      requestCount: meterSnapshot.requestCount,
      requestBytes: meterSnapshot.requestBytes,
      responseBytes: meterSnapshot.responseBytes,
      bytesTransferred: meterSnapshot.requestBytes + meterSnapshot.responseBytes,
      avgMemoryMb: memoryMetrics.avgMemoryMb,
      peakMemoryMb: memoryMetrics.peakMemoryMb,
      avgCpuPct: cpuMetrics.avgCpuPct,
      peakCpuPct: cpuMetrics.peakCpuPct,
      durationMs: performance.now() - startedAt,
      pullRequestMs: round(phaseTotals.pullRequestMs),
      snapshotFetchMs: round(phaseTotals.snapshotFetchMs),
      snapshotDecodeMs: round(phaseTotals.snapshotDecodeMs),
      localApplyMs: round(phaseTotals.localApplyMs),
      serverSnapshotQueryMs: round(serverTimings.snapshotQueryMs),
      serverRowFrameEncodeMs: round(serverTimings.rowFrameEncodeMs),
      serverChunkCacheLookupMs: round(serverTimings.chunkCacheLookupMs),
      serverChunkGzipMs: round(serverTimings.chunkGzipMs),
      serverChunkHashMs: round(serverTimings.chunkHashMs),
      serverChunkPersistMs: round(serverTimings.chunkPersistMs),
    };
  } finally {
    sampler.stop();
    cpuSampler.stop();
    await db.destroy();
    await rm(dbPath.replace(/\/client\.sqlite$/, ''), {
      recursive: true,
      force: true,
    });
  }
}

interface SyncularOfflineReplayCaseResult {
  queuedWriteCount: number;
  reconnectConvergenceMs: number;
  conflictCount: number;
  replayedWriteSuccessRate: number;
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  bytesTransferred: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
  queuedTaskIds: string[];
}

async function runSyncularOfflineReplayCase(args: {
  queueSize: number;
  titlePrefix: string;
}): Promise<SyncularOfflineReplayCaseResult> {
  await ensureStackUp('syncular');
  await seedSyncularStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: Math.max(200, args.queueSize + 25),
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('syncular');
  const actorId = fixtures.sampleUserIds[0];
  const projectId = fixtures.sampleProjectId;
  if (!actorId || !projectId) {
    throw new Error('Syncular fixtures are missing actor/project data');
  }

  const candidateTasks = await listTasks('syncular', {
    projectId,
    limit: args.queueSize + 10,
  });
  if (candidateTasks.length < args.queueSize) {
    throw new Error(
      `Need at least ${args.queueSize} tasks for Syncular offline replay`
    );
  }

  const dbPath = await createTempDbPath(args.titlePrefix);
  const clientId = `${args.titlePrefix}-client`;
  const initialSession = await createSyncularClientSession({
    actorId,
    clientId,
    projectIds: [projectId],
    realtime: false,
    dbPath,
    pollIntervalMs: 60_000,
  });

  await initialSession.client.start();
  await initialSession.client.awaitBootstrapComplete({ timeoutMs: 60_000 });
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();
  let replaySession: SyncularClientSession | null = null;
  const replayTimeoutMs = Math.max(120_000, args.queueSize * 500);

  try {
    stopService('syncular', 'sync');

    const offlineTargets = candidateTasks.slice(0, args.queueSize);
    const expectedTitles = new Map<string, string>();
    for (let index = 0; index < offlineTargets.length; index += 1) {
      const task = offlineTargets[index]!;
      const expectedTitle = `${args.titlePrefix}-${index}-${Date.now()}`;
      expectedTitles.set(task.id, expectedTitle);
      await initialSession.client.mutations.tasks.update(task.id, {
        title: expectedTitle,
      });
    }

    await Bun.sleep(300);
    const queuedWriteCount = await countOutbox(initialSession.db);
    await initialSession.destroy();

    if (queuedWriteCount < offlineTargets.length) {
      throw new Error(
        `Expected at least ${offlineTargets.length} queued writes, got ${queuedWriteCount}`
      );
    }

    startService('syncular', 'sync');
    await ensureStackUp('syncular');

    replaySession = await createSyncularClientSession({
      actorId,
      clientId,
      projectIds: [projectId],
      realtime: false,
      dbPath,
      pollIntervalMs: 60_000,
    });

    const startedAt = performance.now();
    await replaySession.client.start();
    await waitForOutboxClear({
      client: replaySession.client,
      db: replaySession.db,
      timeoutMs: replayTimeoutMs,
    });

    for (const [taskId, expectedTitle] of expectedTitles) {
      await waitForLocalTitle({
        db: replaySession.db,
        taskId,
        expectedTitle,
        timeoutMs: replayTimeoutMs,
      });
    }

    const replayMeter = replaySession.meterSnapshot();
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();
    const conflicts = await replaySession.client.getConflicts();
    const convergenceMs = performance.now() - startedAt;
    const succeeded = expectedTitles.size;

    return {
      queuedWriteCount,
      reconnectConvergenceMs: round(convergenceMs),
      conflictCount: conflicts.length,
      replayedWriteSuccessRate: round(succeeded / queuedWriteCount, 4),
      requestCount: replayMeter.requestCount,
      requestBytes: replayMeter.requestBytes,
      responseBytes: replayMeter.responseBytes,
      bytesTransferred: replayMeter.requestBytes + replayMeter.responseBytes,
      avgMemoryMb: memoryMetrics.avgMemoryMb,
      peakMemoryMb: memoryMetrics.peakMemoryMb,
      avgCpuPct: cpuMetrics.avgCpuPct,
      peakCpuPct: cpuMetrics.peakCpuPct,
      queuedTaskIds: Array.from(expectedTitles.keys()),
    };
  } finally {
    if (replaySession) {
      await replaySession.destroy();
    }
    memorySampler.stop();
    cpuSampler.stop();
    await rm(dbPath.replace(/\/client\.sqlite$/, ''), {
      recursive: true,
      force: true,
    });
  }
}

interface SyncularReconnectStormCaseResult {
  clientCount: number;
  reconnectConvergenceMs: number;
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  bytesTransferred: number;
  syncAvgCpuPct: number;
  syncPeakCpuPct: number;
  syncAvgMemoryMb: number;
  syncPeakMemoryMb: number;
  syncRxNetworkMb: number;
  syncTxNetworkMb: number;
  postgresAvgCpuPct: number;
  postgresPeakCpuPct: number;
  postgresAvgMemoryMb: number;
  postgresPeakMemoryMb: number;
  postgresRxNetworkMb: number;
  postgresTxNetworkMb: number;
}

async function runSyncularReconnectStormCase(args: {
  clientCount: number;
}): Promise<SyncularReconnectStormCaseResult> {
  await ensureStackUp('syncular');
  await seedSyncularStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('syncular');
  const actorId = fixtures.sampleUserIds[0];
  const projectId = fixtures.sampleProjectId;
  const taskId = fixtures.sampleTaskId;
  if (!actorId || !projectId || !taskId) {
    throw new Error('Syncular fixtures are missing actor/project/task data');
  }

  const sessions = await Promise.all(
    Array.from({ length: args.clientCount }, (_, index) =>
      createSyncularClientSession({
        actorId,
        clientId: `syncular-storm-${index}`,
        projectIds: [projectId],
        realtime: false,
        pollIntervalMs: 60_000,
      })
    )
  );

  try {
    await Promise.all(sessions.map((session) => session.client.start()));
    await Promise.all(
      sessions.map((session) =>
        session.client.awaitBootstrapComplete({ timeoutMs: 60_000 })
      )
    );
    const meterBaselines = sessions.map((session) => session.meterSnapshot());

    const syncContainerId = resolveServiceContainerId('syncular', 'sync');
    const postgresContainerId = resolveServiceContainerId('syncular', 'postgres');

    stopService('syncular', 'sync');
    await waitForUrlDown(
      `${getStack('syncular').syncBaseUrl.replace(/\/api$/, '')}/health`
    );
    startService('syncular', 'sync');
    await ensureStackUp('syncular');
    await waitForSyncularApiReady({ actorId, projectId });

    const sampler = new DockerServiceSampler([
      { label: 'sync', id: syncContainerId },
      { label: 'postgres', id: postgresContainerId },
    ]);
    sampler.start();
    const startedAt = performance.now();
    const expectedTitle = `syncular-storm-${Date.now()}`;
    await writeSyncularExternalTask({
      taskId,
      title: expectedTitle,
    });
    await Promise.all(sessions.map((session) => session.client.sync()));

    await Promise.all(
      sessions.map((session) =>
        waitForLocalTitle({
          client: session.client,
          db: session.db,
          taskId,
          expectedTitle,
          timeoutMs: 60_000,
        })
      )
    );

    const convergenceMs = performance.now() - startedAt;
    const containerMetrics = sampler.stop();
    const totalMeter = sessions.reduce(
      (totals, session, index) => {
        const snapshot = diffMeterTotals(
          session.meterSnapshot(),
          meterBaselines[index] ?? {
            requestCount: 0,
            requestBytes: 0,
            responseBytes: 0,
          }
        );
        return {
          requestCount: totals.requestCount + snapshot.requestCount,
          requestBytes: totals.requestBytes + snapshot.requestBytes,
          responseBytes: totals.responseBytes + snapshot.responseBytes,
        };
      },
      {
        requestCount: 0,
        requestBytes: 0,
        responseBytes: 0,
      }
    );
    const syncMetrics = containerMetrics.sync;
    const postgresMetrics = containerMetrics.postgres;

    return {
      clientCount: args.clientCount,
      reconnectConvergenceMs: round(convergenceMs),
      requestCount: totalMeter.requestCount,
      requestBytes: totalMeter.requestBytes,
      responseBytes: totalMeter.responseBytes,
      bytesTransferred: totalMeter.requestBytes + totalMeter.responseBytes,
      syncAvgCpuPct: syncMetrics?.avgCpuPct ?? 0,
      syncPeakCpuPct: syncMetrics?.peakCpuPct ?? 0,
      syncAvgMemoryMb: syncMetrics?.avgMemoryMb ?? 0,
      syncPeakMemoryMb: syncMetrics?.peakMemoryMb ?? 0,
      syncRxNetworkMb: syncMetrics?.rxNetworkMb ?? 0,
      syncTxNetworkMb: syncMetrics?.txNetworkMb ?? 0,
      postgresAvgCpuPct: postgresMetrics?.avgCpuPct ?? 0,
      postgresPeakCpuPct: postgresMetrics?.peakCpuPct ?? 0,
      postgresAvgMemoryMb: postgresMetrics?.avgMemoryMb ?? 0,
      postgresPeakMemoryMb: postgresMetrics?.peakMemoryMb ?? 0,
      postgresRxNetworkMb: postgresMetrics?.rxNetworkMb ?? 0,
      postgresTxNetworkMb: postgresMetrics?.txNetworkMb ?? 0,
    };
  } finally {
    await Promise.all(sessions.map((session) => session.destroy()));
    await Promise.all(
      sessions.map((session) =>
        rm(session.dbPath.replace(/\/client\.sqlite$/, ''), {
          recursive: true,
          force: true,
        })
      )
    );
  }
}

interface LocalQuerySample {
  elapsedMs: number;
  resultCount: number;
}

async function runSyncularLocalListQuery(args: {
  db: Kysely<SyncularClientDb>;
  projectId: string;
  ownerId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = await args.db
    .selectFrom('tasks')
    .select(['id', 'title', 'updated_at'])
    .where('project_id', '=', args.projectId)
    .where('owner_id', '=', args.ownerId)
    .where('completed', '=', false)
    .orderBy('updated_at', 'desc')
    .limit(50)
    .execute();

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

async function runSyncularLocalSearchQuery(args: {
  db: Kysely<SyncularClientDb>;
  projectId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = await args.db
    .selectFrom('tasks')
    .select(['id', 'title'])
    .where('project_id', '=', args.projectId)
    .where('id', 'like', 'org-1-project-1-task-00%')
    .orderBy('id', 'asc')
    .limit(100)
    .execute();

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

async function runSyncularLocalAggregateQuery(args: {
  db: Kysely<SyncularClientDb>;
  projectId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = await args.db
    .selectFrom('tasks')
    .select(['owner_id', 'completed'])
    .select((expressionBuilder) =>
      expressionBuilder.fn.countAll<number>().as('task_count')
    )
    .where('project_id', '=', args.projectId)
    .groupBy(['owner_id', 'completed'])
    .execute();

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

export class SyncularBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('syncular');

  async runBootstrap(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    await ensureStackUp('syncular');
    const scales = [1000, 10_000, 100_000, 250_000, 500_000];
    const scaleResults: BootstrapScaleResult[] = [];

    for (const rowsTarget of scales) {
      await seedSyncularStack({
        resetFirst: true,
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: rowsTarget,
        membershipsPerProject: 2,
      });

      const fixtures = await getFixtures('syncular');
      const actorId = fixtures.sampleUserIds[0];
      const projectId = fixtures.sampleProjectId;
      if (!actorId || !projectId) {
        throw new Error('Syncular fixtures are missing actor/project data');
      }

      const result = await runDirectBootstrap({
        actorId,
        clientId: `syncular-bootstrap-${rowsTarget}`,
        projectId,
        rowsTarget,
      });

      scaleResults.push({
        rowsTarget,
        timeToFirstQueryMs: round(result.durationMs),
        rowsLoaded: result.rowsLoaded,
        requestCount: result.requestCount,
        requestBytes: result.requestBytes,
        responseBytes: result.responseBytes,
        bytesTransferred: result.bytesTransferred,
        avgMemoryMb: result.avgMemoryMb,
        peakMemoryMb: result.peakMemoryMb,
        avgCpuPct: result.avgCpuPct,
        peakCpuPct: result.peakCpuPct,
        pullRequestMs: result.pullRequestMs,
        snapshotFetchMs: result.snapshotFetchMs,
        snapshotDecodeMs: result.snapshotDecodeMs,
        localApplyMs: result.localApplyMs,
        serverSnapshotQueryMs: result.serverSnapshotQueryMs,
        serverRowFrameEncodeMs: result.serverRowFrameEncodeMs,
        serverChunkCacheLookupMs: result.serverChunkCacheLookupMs,
        serverChunkGzipMs: result.serverChunkGzipMs,
        serverChunkHashMs: result.serverChunkHashMs,
        serverChunkPersistMs: result.serverChunkPersistMs,
      });
    }

    return {
      status: 'completed',
      metrics: Object.fromEntries(
        scaleResults.flatMap((result) => [
          [`bootstrap_${result.rowsTarget}_ms`, result.timeToFirstQueryMs],
          [`rows_loaded_${result.rowsTarget}`, result.rowsLoaded],
          [`request_count_${result.rowsTarget}`, result.requestCount],
          [`request_bytes_${result.rowsTarget}`, result.requestBytes],
          [`response_bytes_${result.rowsTarget}`, result.responseBytes],
          [`bytes_transferred_${result.rowsTarget}`, result.bytesTransferred],
          [`avg_memory_mb_${result.rowsTarget}`, result.avgMemoryMb],
          [`peak_memory_mb_${result.rowsTarget}`, result.peakMemoryMb],
          [`avg_cpu_pct_${result.rowsTarget}`, result.avgCpuPct],
          [`peak_cpu_pct_${result.rowsTarget}`, result.peakCpuPct],
          [`pull_request_ms_${result.rowsTarget}`, result.pullRequestMs ?? null],
          [
            `snapshot_fetch_ms_${result.rowsTarget}`,
            result.snapshotFetchMs ?? null,
          ],
          [
            `snapshot_decode_ms_${result.rowsTarget}`,
            result.snapshotDecodeMs ?? null,
          ],
          [`local_apply_ms_${result.rowsTarget}`, result.localApplyMs ?? null],
          [
            `server_snapshot_query_ms_${result.rowsTarget}`,
            result.serverSnapshotQueryMs ?? null,
          ],
          [
            `server_row_frame_encode_ms_${result.rowsTarget}`,
            result.serverRowFrameEncodeMs ?? null,
          ],
          [
            `server_chunk_cache_lookup_ms_${result.rowsTarget}`,
            result.serverChunkCacheLookupMs ?? null,
          ],
          [
            `server_chunk_gzip_ms_${result.rowsTarget}`,
            result.serverChunkGzipMs ?? null,
          ],
          [
            `server_chunk_hash_ms_${result.rowsTarget}`,
            result.serverChunkHashMs ?? null,
          ],
          [
            `server_chunk_persist_ms_${result.rowsTarget}`,
            result.serverChunkPersistMs ?? null,
          ],
        ])
      ),
      notes: [
        'Syncular bootstrap uses the low-level /api/sync pull protocol with a local Bun SQLite target.',
        `The harness requests larger snapshot pages (${SYNCULAR_BENCH_BOOTSTRAP_LIMIT_SNAPSHOT_ROWS} rows/page) directly so the benchmark measures full bootstrap completion instead of background client timer cadence.`,
      ],
      metadata: {
        implementation: 'direct-sync-protocol-bootstrap',
        scales: scaleResults.map((result) => ({
          rowsTarget: result.rowsTarget,
          timeToFirstQueryMs: result.timeToFirstQueryMs,
          rowsLoaded: result.rowsLoaded,
          requestCount: result.requestCount,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          bytesTransferred: result.bytesTransferred,
          avgMemoryMb: result.avgMemoryMb,
          peakMemoryMb: result.peakMemoryMb,
          avgCpuPct: result.avgCpuPct,
          peakCpuPct: result.peakCpuPct,
          pullRequestMs: result.pullRequestMs ?? null,
          snapshotFetchMs: result.snapshotFetchMs ?? null,
          snapshotDecodeMs: result.snapshotDecodeMs ?? null,
          localApplyMs: result.localApplyMs ?? null,
          serverSnapshotQueryMs: result.serverSnapshotQueryMs ?? null,
          serverRowFrameEncodeMs: result.serverRowFrameEncodeMs ?? null,
          serverChunkCacheLookupMs: result.serverChunkCacheLookupMs ?? null,
          serverChunkGzipMs: result.serverChunkGzipMs ?? null,
          serverChunkHashMs: result.serverChunkHashMs ?? null,
          serverChunkPersistMs: result.serverChunkPersistMs ?? null,
        })),
      },
    };
  }

  async runOnlinePropagation(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    await ensureStackUp('syncular');
    await seedSyncularStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 200,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures('syncular');
    const writerActorId = fixtures.sampleUserIds[0];
    const readerActorId = fixtures.sampleUserIds[0];
    const projectId = fixtures.sampleProjectId;
    const taskId = fixtures.sampleTaskId;
    if (!writerActorId || !readerActorId || !projectId || !taskId) {
      throw new Error('Syncular fixtures are missing actor, project, or task data');
    }

    const writer = await createSyncularClientSession({
      actorId: writerActorId,
      clientId: 'syncular-writer',
      projectIds: [projectId],
      realtime: true,
      pollIntervalMs: 60_000,
    });
    const reader = await createSyncularClientSession({
      actorId: readerActorId,
      clientId: 'syncular-reader',
      projectIds: [projectId],
      realtime: true,
      pollIntervalMs: 60_000,
    });

    await writer.client.start();
    await reader.client.start();
    await writer.client.awaitBootstrapComplete({ timeoutMs: 60_000 });
    await reader.client.awaitBootstrapComplete({ timeoutMs: 60_000 });

    const warmupIterations = 1;
    for (let warmupIteration = 0; warmupIteration < warmupIterations; warmupIteration += 1) {
      const expectedTitle = `syncular-online-warmup-${warmupIteration}-${Date.now()}`;
      const pushResultPromise = waitForNextPushResult(writer.client);
      const receipt: MutationReceipt = await writer.client.mutations.tasks.update(
        taskId,
        { title: expectedTitle }
      );
      const pushResult = await pushResultPromise;
      if (pushResult.clientCommitId !== receipt.clientCommitId) {
        throw new Error(
          'Syncular warmup push:result did not match the mutation receipt'
        );
      }
      if (pushResult.status !== 'applied' && pushResult.status !== 'cached') {
        throw new Error(`Syncular warmup push failed with status ${pushResult.status}`);
      }

      await waitForLocalTitle({
        db: reader.db,
        taskId,
        expectedTitle,
        timeoutMs: 30_000,
      });
    }

    const writerMeterStart = writer.meterSnapshot();
    const readerMeterStart = reader.meterSnapshot();
    const iterations = 15;
    const samples: OnlinePropagationSample[] = [];
    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const expectedTitle = `syncular-online-${iteration}-${Date.now()}`;
      const pushResultPromise = waitForNextPushResult(writer.client);
      const startedAt = performance.now();
      const receipt: MutationReceipt = await writer.client.mutations.tasks.update(
        taskId,
        { title: expectedTitle }
      );
      const pushResult = await pushResultPromise;
      if (pushResult.clientCommitId !== receipt.clientCommitId) {
        throw new Error('Syncular push:result did not match the mutation receipt');
      }
      if (pushResult.status !== 'applied' && pushResult.status !== 'cached') {
        throw new Error(`Syncular push failed with status ${pushResult.status}`);
      }
      const writeAckMs = performance.now() - startedAt;

      await waitForLocalTitle({
        db: reader.db,
        taskId,
        expectedTitle,
        timeoutMs: 30_000,
      });

      samples.push({
        iteration,
        writeAckMs: round(writeAckMs),
        mirrorVisibleMs: round(performance.now() - startedAt),
      });
    }

    const writerMeter = diffMeterTotals(writer.meterSnapshot(), writerMeterStart);
    const readerMeter = diffMeterTotals(reader.meterSnapshot(), readerMeterStart);
    const requestCount = writerMeter.requestCount + readerMeter.requestCount;
    const requestBytes = writerMeter.requestBytes + readerMeter.requestBytes;
    const responseBytes = writerMeter.responseBytes + readerMeter.responseBytes;
    const meterTotals = requestBytes + responseBytes;
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();
    const visibility = samples.map((sample) => sample.mirrorVisibleMs);
    const writeAcks = samples.map((sample) => sample.writeAckMs);

    await writer.destroy();
    await reader.destroy();
    await rm(writer.dbPath.replace(/\/client\.sqlite$/, ''), {
      recursive: true,
      force: true,
    });
    await rm(reader.dbPath.replace(/\/client\.sqlite$/, ''), {
      recursive: true,
      force: true,
    });

    return {
      status: 'completed',
      metrics: {
        write_ack_ms: average(writeAcks),
        mirror_visible_p50_ms: percentile(visibility, 50),
        mirror_visible_p95_ms: percentile(visibility, 95),
        mirror_visible_p99_ms: percentile(visibility, 99),
        iterations,
        request_count: requestCount,
        request_bytes: requestBytes,
        response_bytes: responseBytes,
        bytes_transferred: meterTotals,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'Writes use the real Syncular client mutations API with realtime transport enabled.',
        'Visibility is measured on a second real Syncular client via realtime wake-up and inline WS delivery, with HTTP catch-up left to the engine fallback path.',
        `One unmeasured warmup write runs after bootstrap so the reported samples reflect steady-state propagation rather than first-write startup effects.`,
      ],
      metadata: {
        implementation: 'local-syncular-client-with-bun-sqlite-realtime',
        warmupIterations,
        samples: samples.map((sample) => ({
          iteration: sample.iteration,
          writeAckMs: sample.writeAckMs,
          mirrorVisibleMs: sample.mirrorVisibleMs,
        })),
      },
    };
  }

  async runOfflineReplay(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    const result = await runSyncularOfflineReplayCase({
      queueSize: 10,
      titlePrefix: 'syncular-offline',
    });

    return {
      status: 'completed',
      metrics: {
        queued_write_count: result.queuedWriteCount,
        reconnect_convergence_ms: result.reconnectConvergenceMs,
        conflict_count: result.conflictCount,
        replayed_write_success_rate: result.replayedWriteSuccessRate,
        request_count: result.requestCount,
        request_bytes: result.requestBytes,
        response_bytes: result.responseBytes,
        bytes_transferred: result.bytesTransferred,
        avg_memory_mb: result.avgMemoryMb,
        peak_memory_mb: result.peakMemoryMb,
        avg_cpu_pct: result.avgCpuPct,
        peak_cpu_pct: result.peakCpuPct,
      },
      notes: [
        'Offline replay uses the real Syncular durable outbox persisted in a Bun SQLite database.',
        'The benchmark stops the Syncular service, queues local writes, recreates the client on the same file, then measures convergence after the service returns.',
      ],
      metadata: {
        implementation: 'local-syncular-client-native-outbox',
        queuedTaskIds: result.queuedTaskIds,
      },
    };
  }

  async runReconnectStorm(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    const clientCounts = [25, 100, 250, 500];
    const results = [];

    for (const clientCount of clientCounts) {
      results.push(
        await runSyncularReconnectStormCase({
          clientCount,
        })
      );
    }

    const baseline = results[0];
    if (!baseline) {
      throw new Error('Syncular reconnect storm produced no results');
    }

    return {
      status: 'completed',
      metrics: Object.fromEntries(
        results.flatMap((result) => [
          [`clients_${result.clientCount}_convergence_ms`, result.reconnectConvergenceMs],
          [`clients_${result.clientCount}_request_count`, result.requestCount],
          [`clients_${result.clientCount}_request_bytes`, result.requestBytes],
          [`clients_${result.clientCount}_response_bytes`, result.responseBytes],
          [`clients_${result.clientCount}_bytes_transferred`, result.bytesTransferred],
          [`clients_${result.clientCount}_sync_avg_cpu_pct`, result.syncAvgCpuPct],
          [`clients_${result.clientCount}_sync_peak_cpu_pct`, result.syncPeakCpuPct],
          [`clients_${result.clientCount}_sync_avg_memory_mb`, result.syncAvgMemoryMb],
          [`clients_${result.clientCount}_sync_peak_memory_mb`, result.syncPeakMemoryMb],
          [`clients_${result.clientCount}_sync_rx_network_mb`, result.syncRxNetworkMb],
          [`clients_${result.clientCount}_sync_tx_network_mb`, result.syncTxNetworkMb],
          [`clients_${result.clientCount}_postgres_avg_cpu_pct`, result.postgresAvgCpuPct],
          [`clients_${result.clientCount}_postgres_peak_cpu_pct`, result.postgresPeakCpuPct],
          [`clients_${result.clientCount}_postgres_avg_memory_mb`, result.postgresAvgMemoryMb],
          [`clients_${result.clientCount}_postgres_peak_memory_mb`, result.postgresPeakMemoryMb],
          [`clients_${result.clientCount}_postgres_rx_network_mb`, result.postgresRxNetworkMb],
          [`clients_${result.clientCount}_postgres_tx_network_mb`, result.postgresTxNetworkMb],
        ])
      ),
      notes: [
        'Reconnect storm uses already-bootstrapped Syncular HTTP clients at 25 / 100 / 250 / 500 clients catching up after the sync service restarts.',
        'Server resource metrics sample the sync service and Postgres containers during each reconnect window.',
      ],
      metadata: {
        implementation: 'syncular-http-reconnect-storm-v2',
        clientCounts,
        scales: results.map((result) => ({
          clientCount: result.clientCount,
          reconnectConvergenceMs: result.reconnectConvergenceMs,
          requestCount: result.requestCount,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          bytesTransferred: result.bytesTransferred,
          syncAvgCpuPct: result.syncAvgCpuPct,
          syncPeakCpuPct: result.syncPeakCpuPct,
          syncAvgMemoryMb: result.syncAvgMemoryMb,
          syncPeakMemoryMb: result.syncPeakMemoryMb,
          postgresAvgCpuPct: result.postgresAvgCpuPct,
          postgresPeakCpuPct: result.postgresPeakCpuPct,
          postgresAvgMemoryMb: result.postgresAvgMemoryMb,
          postgresPeakMemoryMb: result.postgresPeakMemoryMb,
        })),
        clientCount: baseline.clientCount,
      },
    };
  }

  async runLargeOfflineQueue(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    const queueSizes = [100, 500, 1000];
    const queueResults = [];

    for (const queueSize of queueSizes) {
      queueResults.push(
        await runSyncularOfflineReplayCase({
          queueSize,
          titlePrefix: `syncular-large-offline-${queueSize}`,
        })
      );
    }

    return {
      status: 'completed',
      metrics: Object.fromEntries(
        queueResults.flatMap((result, index) => {
          const queueSize = queueSizes[index]!;
          return [
            [`queue_${queueSize}_queued_writes`, result.queuedWriteCount],
            [`queue_${queueSize}_convergence_ms`, result.reconnectConvergenceMs],
            [`queue_${queueSize}_request_count`, result.requestCount],
            [`queue_${queueSize}_bytes_transferred`, result.bytesTransferred],
            [`queue_${queueSize}_avg_memory_mb`, result.avgMemoryMb],
            [`queue_${queueSize}_peak_memory_mb`, result.peakMemoryMb],
            [`queue_${queueSize}_avg_cpu_pct`, result.avgCpuPct],
            [`queue_${queueSize}_peak_cpu_pct`, result.peakCpuPct],
          ];
        })
      ),
      notes: [
        'Large offline queue replay reuses the real Syncular durable outbox path with much larger queued write sets.',
        'The benchmark measures 100 / 500 / 1000 queued writes so scaling behavior is visible instead of a single queue-size point.',
      ],
      metadata: {
        implementation: 'local-syncular-client-native-outbox-large-queue',
        scales: queueResults.map((result, index) => ({
          queueSize: queueSizes[index],
          queuedWriteCount: result.queuedWriteCount,
          reconnectConvergenceMs: result.reconnectConvergenceMs,
          requestCount: result.requestCount,
          bytesTransferred: result.bytesTransferred,
          avgMemoryMb: result.avgMemoryMb,
          peakMemoryMb: result.peakMemoryMb,
          avgCpuPct: result.avgCpuPct,
          peakCpuPct: result.peakCpuPct,
        })),
      },
    };
  }

  async runLocalQuery(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    await ensureStackUp('syncular');
    await seedSyncularStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 100_000,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures('syncular');
    const actorId = fixtures.sampleUserIds[0];
    const ownerId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
    const projectId = fixtures.sampleProjectId;
    if (!actorId || !ownerId || !projectId) {
      throw new Error('Syncular fixtures are missing actor/project data');
    }

    const dbPath = await createTempDbPath('syncular-local-query');
    const db = new Kysely<SyncularClientDb>({
      dialect: createBunSqliteDialect({ path: dbPath }),
    });
    await ensureLocalTables(db);

    const transport = createSyncularHttpTransport({ actorId });
    let cursor = -1;
    let bootstrapState: SyncBootstrapState | null = null;
    let iterationsGuard = 0;

    while (iterationsGuard < 200) {
      iterationsGuard += 1;
      const body = await transport.sync({
        clientId: 'syncular-local-query',
        pull: {
          limitCommits: 100,
          limitSnapshotRows: SYNCULAR_BENCH_BOOTSTRAP_LIMIT_SNAPSHOT_ROWS,
          maxSnapshotPages: SYNCULAR_BENCH_BOOTSTRAP_MAX_SNAPSHOT_PAGES,
          subscriptions: [
            {
              id: 'tasks',
              table: 'tasks',
              scopes: {
                project_id: projectId,
              },
              cursor,
              bootstrapState,
            },
          ],
        },
      });
      const subscription = body.pull?.subscriptions?.[0];
      if (!body.ok || !body.pull?.ok || !subscription) {
        throw new Error('Syncular local query bootstrap returned an invalid payload');
      }
      if (subscription.status === 'revoked') {
        throw new Error('Syncular local query bootstrap subscription was revoked');
      }

      await applySyncularSubscriptionPayload({
        db,
        subscription,
        transport,
      });

      cursor =
        typeof subscription.nextCursor === 'number'
          ? subscription.nextCursor
          : cursor;
      bootstrapState = subscription.bootstrapState ?? null;

      if (bootstrapState === null) {
        break;
      }
    }

    const iterations = 25;
    const listSamples: number[] = [];
    const searchSamples: number[] = [];
    const aggregateSamples: number[] = [];
    let listResultCount = 0;
    let searchResultCount = 0;
    let aggregateResultCount = 0;
    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const listResult = await runSyncularLocalListQuery({
        db,
        projectId,
        ownerId,
      });
      const searchResult = await runSyncularLocalSearchQuery({
        db,
        projectId,
      });
      const aggregateResult = await runSyncularLocalAggregateQuery({
        db,
        projectId,
      });

      listSamples.push(listResult.elapsedMs);
      searchSamples.push(searchResult.elapsedMs);
      aggregateSamples.push(aggregateResult.elapsedMs);
      listResultCount = listResult.resultCount;
      searchResultCount = searchResult.resultCount;
      aggregateResultCount = aggregateResult.resultCount;
    }

    const rowCount = await countLocalTasks(db);
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    await db.destroy();
    await rm(dbPath.replace(/\/client\.sqlite$/, ''), {
      recursive: true,
      force: true,
    });

    return {
      status: 'completed',
      metrics: {
        row_count: rowCount,
        iterations,
        list_query_p50_ms: percentile(listSamples, 50),
        list_query_p95_ms: percentile(listSamples, 95),
        search_query_p50_ms: percentile(searchSamples, 50),
        search_query_p95_ms: percentile(searchSamples, 95),
        aggregate_query_p50_ms: percentile(aggregateSamples, 50),
        aggregate_query_p95_ms: percentile(aggregateSamples, 95),
        list_result_count: listResultCount,
        search_result_count: searchResultCount,
        aggregate_result_count: aggregateResultCount,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'Local query benchmarks run against the fully materialized local Bun SQLite cache after bootstrap completes.',
        'The workload covers a filtered list query, an ID-prefix search query, and a grouped aggregation over the same local task corpus.',
      ],
      metadata: {
        implementation: 'direct-sync-protocol-local-query-workload',
        rowCount,
        iterations,
      },
    };
  }

  async runPermissionChange(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    await ensureStackUp('syncular');
    await seedSyncularStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 2,
      usersPerOrg: 4,
      tasksPerProject: 500,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures('syncular');
    const actorId = fixtures.sampleUserIds[0];
    const revokedProjectId = fixtures.sampleProjectIds[0];
    const retainedProjectId = fixtures.sampleProjectIds[1];
    if (!actorId || !revokedProjectId || !retainedProjectId) {
      throw new Error('Syncular fixtures are missing actor or multi-project data');
    }

    const session = await createSyncularClientSession({
      actorId,
      clientId: `syncular-permission-change-${randomUUID()}`,
      projectIds: [revokedProjectId, retainedProjectId],
      realtime: false,
      pollIntervalMs: 10_000,
    });

    try {
      await session.client.start();
      await session.client.sync();
      const initialVisibleRows = await waitForExpectedTaskCount({
        client: session.client,
        db: session.db,
        expectedRows: 1_000,
        timeoutMs: 60_000,
      });

      const meterBaseline = session.meterSnapshot();
      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();
      const startedAt = performance.now();

      await revokeSyncularProjectMembership({
        projectId: revokedProjectId,
        userId: actorId,
      });

      const postRevokeVisibleRows = await waitForLocalTaskCount({
        client: session.client,
        db: session.db,
        expectedRows: 500,
        timeoutMs: 60_000,
      });
      const revokedProjectRows = await countLocalTasksForProject(
        session.db,
        revokedProjectId
      );
      const retainedProjectRows = await countLocalTasksForProject(
        session.db,
        retainedProjectId
      );
      if (revokedProjectRows !== 0 || retainedProjectRows !== 500) {
        throw new Error(
          `Syncular permission change did not converge: revoked=${revokedProjectRows}, retained=${retainedProjectRows}`
        );
      }

      const convergenceMs = performance.now() - startedAt;
      const meterSnapshot = diffMeterTotals(session.meterSnapshot(), meterBaseline);
      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();

      return {
        status: 'completed',
        metrics: {
          initial_visible_rows: initialVisibleRows,
          post_revoke_visible_rows: postRevokeVisibleRows,
          revoked_project_visible_rows_after_revoke: revokedProjectRows,
          retained_project_visible_rows_after_revoke: retainedProjectRows,
          permission_revoke_convergence_ms: round(convergenceMs),
          request_count: meterSnapshot.requestCount,
          request_bytes: meterSnapshot.requestBytes,
          response_bytes: meterSnapshot.responseBytes,
          bytes_transferred: meterSnapshot.requestBytes + meterSnapshot.responseBytes,
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Permission-change convergence uses Syncular’s real auth-scoped replication model across multiple simultaneously authorized projects.',
          'The benchmark revokes one project membership, then measures how quickly rows for the revoked project disappear while rows for the still-authorized project remain in the local cache.',
        ],
        metadata: {
          implementation: 'syncular-native-permission-revoke',
          actorId,
          revokedProjectId,
          retainedProjectId,
        },
      };
    } finally {
      const destroyDir = session.dbPath.replace(/\/client\.sqlite$/, '');
      await session.destroy();
      await rm(destroyDir, { recursive: true, force: true });
    }
  }

  async runBlobFlow(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    await ensureStackUp('syncular');
    await seedSyncularStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 10,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures('syncular');
    const writerActorId = fixtures.sampleUserIds[0];
    const readerActorId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
    const projectId = fixtures.sampleProjectId;
    const taskId = fixtures.sampleTaskId;
    if (!writerActorId || !readerActorId || !projectId || !taskId) {
      throw new Error('Syncular fixtures are missing actor, project, or task data');
    }

    const meter = createHttpMeter();
    const writerBlobStorage = createMemoryBlobStorage();
    const readerBlobStorage = createMemoryBlobStorage();
    const writer = await createSyncularClientSession({
      actorId: writerActorId,
      clientId: `syncular-blob-flow-writer-${randomUUID()}`,
      projectIds: [projectId],
      includeBlobTable: true,
      realtime: false,
      pollIntervalMs: 60_000,
      meter,
      plugins: [createBlobPlugin({ storage: writerBlobStorage })],
    });
    const reader = await createSyncularClientSession({
      actorId: readerActorId,
      clientId: `syncular-blob-flow-reader-${randomUUID()}`,
      projectIds: [projectId],
      includeBlobTable: true,
      realtime: false,
      pollIntervalMs: 60_000,
      meter,
      plugins: [createBlobPlugin({ storage: readerBlobStorage })],
    });

    if (!hasBlobClient(writer.client) || !hasBlobClient(reader.client)) {
      const writerDestroyDir = writer.dbPath.replace(/\/client\.sqlite$/, '');
      const readerDestroyDir = reader.dbPath.replace(/\/client\.sqlite$/, '');
      await writer.destroy();
      await reader.destroy();
      await rm(writerDestroyDir, { recursive: true, force: true });
      await rm(readerDestroyDir, { recursive: true, force: true });
      throw new Error('Syncular blob plugin did not attach client.blobs');
    }

    const blobSizeBytes = 512 * 1024;
    const payload = createBlobPayload(blobSizeBytes);
    const blobMimeType = 'application/octet-stream';

    try {
      return await withMeteredGlobalFetch(meter.fetch, async () => {
        await initializeSyncularTaskBlobs(projectId);
        await writer.client.start();
        await reader.client.start();
        await writer.client.awaitBootstrapComplete({ timeoutMs: 60_000 });
        await reader.client.awaitBootstrapComplete({ timeoutMs: 60_000 });
        await waitForLocalTaskBlobCount({
          client: writer.client,
          db: writer.db,
          expectedRows: 10,
          timeoutMs: 30_000,
        });
        await waitForLocalTaskBlobCount({
          client: reader.client,
          db: reader.db,
          expectedRows: 10,
          timeoutMs: 30_000,
        });

        const meterBaseline = writer.meterSnapshot();
        const memorySampler = new MemorySampler();
        const cpuSampler = new CpuSampler();
        memorySampler.start();
        cpuSampler.start();
        const baselineSqliteBytes = await readSqliteStorageBytes(writer.dbPath);

        const uploadStartedAt = performance.now();
        const blobRef = await writer.client.blobs.store(payload, {
          immediate: true,
          mimeType: blobMimeType,
        });
        const uploadCompleteMs = performance.now() - uploadStartedAt;

        const uploadCacheStats = await writer.client.blobs.getCacheStats();
        const sqliteBytesAfterUpload = await readSqliteStorageBytes(writer.dbPath);
        const isLocalAfterUpload = await writer.client.blobs.isLocal(blobRef.hash);

        const metadataStartedAt = performance.now();
        await writer.client.mutations.task_blob_entries.update(taskId, {
          blob_hash: blobRef.hash,
          blob_size: blobSizeBytes,
          blob_mime_type: blobMimeType,
        });
        await waitForLocalBlobMetadata({
          client: reader.client,
          db: reader.db,
          taskId,
          expectedHash: blobRef.hash,
          expectedSize: blobSizeBytes,
          expectedMimeType: blobMimeType,
          timeoutMs: 30_000,
        });
        const metadataVisibleMs = performance.now() - metadataStartedAt;

        await writer.client.blobs.clearCache();

        const isLocalAfterClear = await writer.client.blobs.isLocal(blobRef.hash);
        const downloadStartedAt = performance.now();
        const downloaded = await writer.client.blobs.retrieve(blobRef);
        const downloadAfterMetadataMs = performance.now() - downloadStartedAt;
        const downloadCacheStats = await writer.client.blobs.getCacheStats();
        const sqliteBytesAfterDownload = await readSqliteStorageBytes(
          writer.dbPath
        );

        const retryBlobSizeBytes = 256 * 1024;
        const retryPayload = createBlobPayload(retryBlobSizeBytes);
        const retryBlobRef = await writer.client.blobs.store(retryPayload, {
          immediate: false,
          mimeType: blobMimeType,
        });
        const retryQueueBefore = await writer.client.blobs.getUploadQueueStats();
        const retryFirstAttemptStartedAt = performance.now();
        const retryFirstAttemptResult = await withMeteredGlobalFetch(
          createOneShotFailingUploadFetch(meter.fetch),
          () => writer.client.blobs.processUploadQueue()
        );
        const retryFirstAttemptMs =
          performance.now() - retryFirstAttemptStartedAt;
        const retryQueueAfterFailure = await writer.client.blobs.getUploadQueueStats();
        const retryRecoveryStartedAt = performance.now();
        const retryRecoveryResult = await writer.client.blobs.processUploadQueue();
        const retryRecoveryMs = performance.now() - retryRecoveryStartedAt;
        const retryQueueAfterRecovery =
          await writer.client.blobs.getUploadQueueStats();
        const isRetryBlobLocal = await writer.client.blobs.isLocal(
          retryBlobRef.hash
        );

        const meterSnapshot = diffMeterTotals(
          writer.meterSnapshot(),
          meterBaseline
        );
        const memoryMetrics = memorySampler.stop();
        const cpuMetrics = cpuSampler.stop();

        if (downloaded.byteLength !== blobSizeBytes) {
          throw new Error(
            `Syncular blob flow downloaded ${downloaded.byteLength} bytes, expected ${blobSizeBytes}`
          );
        }
        if (retryQueueAfterRecovery.pending !== 0 || retryRecoveryResult.uploaded !== 1) {
          throw new Error(
            `Syncular blob retry recovery did not drain the queue: pending=${retryQueueAfterRecovery.pending}, uploaded=${retryRecoveryResult.uploaded}`
          );
        }

        const expectedTransferBytes = blobSizeBytes * 2 + retryBlobSizeBytes;

        return {
          status: 'completed',
          metrics: {
            blob_size_bytes: blobSizeBytes,
            upload_complete_ms: round(uploadCompleteMs),
            metadata_visible_ms: round(metadataVisibleMs),
            download_after_metadata_ms: round(downloadAfterMetadataMs),
            download_after_clear_ms: round(downloadAfterMetadataMs),
            request_count: meterSnapshot.requestCount,
            request_bytes: meterSnapshot.requestBytes,
            response_bytes: meterSnapshot.responseBytes,
            bytes_transferred: meterSnapshot.requestBytes + meterSnapshot.responseBytes,
            transfer_overhead_bytes:
              meterSnapshot.requestBytes +
              meterSnapshot.responseBytes -
              expectedTransferBytes,
            cache_bytes_after_upload: uploadCacheStats.totalBytes,
            cache_bytes_after_download: downloadCacheStats.totalBytes,
            cache_overhead_bytes_after_upload:
              uploadCacheStats.totalBytes - blobSizeBytes,
            cache_overhead_bytes_after_download:
              downloadCacheStats.totalBytes - blobSizeBytes,
            sqlite_storage_bytes_before_upload: baselineSqliteBytes,
            sqlite_storage_bytes_after_upload: sqliteBytesAfterUpload,
            sqlite_storage_bytes_after_download: sqliteBytesAfterDownload,
            sqlite_storage_overhead_bytes_after_upload:
              sqliteBytesAfterUpload - baselineSqliteBytes - blobSizeBytes,
            sqlite_storage_overhead_bytes_after_download:
              sqliteBytesAfterDownload - baselineSqliteBytes - blobSizeBytes,
            is_local_after_upload: isLocalAfterUpload ? 1 : 0,
            is_local_after_clear: isLocalAfterClear ? 1 : 0,
            retry_blob_size_bytes: retryBlobSizeBytes,
            retry_queue_pending_before: retryQueueBefore.pending,
            retry_queue_pending_after_failure: retryQueueAfterFailure.pending,
            retry_queue_pending_after_recovery: retryQueueAfterRecovery.pending,
            retry_first_attempt_ms: round(retryFirstAttemptMs),
            retry_recovery_ms: round(retryRecoveryMs),
            retry_first_attempt_uploaded: retryFirstAttemptResult.uploaded,
            retry_first_attempt_failed: retryFirstAttemptResult.failed,
            retry_recovery_uploaded: retryRecoveryResult.uploaded,
            retry_recovery_failed: retryRecoveryResult.failed,
            retry_blob_is_local: isRetryBlobLocal ? 1 : 0,
            avg_memory_mb: memoryMetrics.avgMemoryMb,
            peak_memory_mb: memoryMetrics.peakMemoryMb,
            avg_cpu_pct: cpuMetrics.avgCpuPct,
            peak_cpu_pct: cpuMetrics.peakCpuPct,
          },
          notes: [
            'Blob flow uses two real Syncular clients for the same authenticated actor with the blob plugin enabled over the standard HTTP sync path: the writer uploads immediately, syncs blob metadata onto a task row, and the reader waits for that metadata before the uploader clears cache and re-downloads through the real server blob routes.',
            'The same run also measures interrupted upload recovery by enqueueing a second blob, forcing the first direct upload PUT to fail once, then verifying that processUploadQueue successfully retries and drains the outbox on the next pass.',
            'Request and byte counts include upload-init, direct upload, completion, metadata sync, cache clear, download-url resolution, authenticated re-download traffic, and the retry upload path.',
          ],
          metadata: {
            implementation: 'syncular-native-cross-client-blob-flow',
            writerActorId,
            readerActorId,
            projectId,
            taskId,
            blobHash: blobRef.hash,
            blobMimeType: blobRef.mimeType,
            retryBlobHash: retryBlobRef.hash,
          },
        };
      });
    } finally {
      const writerDestroyDir = writer.dbPath.replace(/\/client\.sqlite$/, '');
      const readerDestroyDir = reader.dbPath.replace(/\/client\.sqlite$/, '');
      await writer.destroy();
      await reader.destroy();
      await rm(writerDestroyDir, { recursive: true, force: true });
      await rm(readerDestroyDir, { recursive: true, force: true });
    }
  }
}
