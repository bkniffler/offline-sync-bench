import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createClient,
  createClientHandler,
  type MutationReceipt,
  type SyncClientDb,
} from '../../../syncular/packages/client/src/index.ts';
import {
  decodeSnapshotRows,
  type ScopeValues,
  type SyncBootstrapState,
  type SyncPullSubscriptionResponse,
} from '../../../syncular/packages/core/src/index.ts';
import { createBunSqliteDialect } from '../../../syncular/packages/dialect-bun-sqlite/src/index.ts';
import { createHttpTransport } from '../../../syncular/packages/transport-http/src/index.ts';
import { createWebSocketTransport } from '../../../syncular/packages/transport-ws/src/index.ts';
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
import {
  ensureStackUp,
  getFixtures,
  listTasks,
  resolveServiceContainerId,
  seedStack,
  startService,
  stopService,
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

interface SyncularClientDb extends SyncClientDb {
  tasks: LocalTaskRow;
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

interface SyncClientWithSync {
  sync(): Promise<unknown>;
  awaitBootstrapComplete(args?: { timeoutMs?: number }): Promise<unknown>;
}

const tempRoot = '/Users/bkniffler/GitHub/sync/offline-sync-bench/.tmp';
const SYNCULAR_BENCH_BOOTSTRAP_LIMIT_SNAPSHOT_ROWS = 20_000;
const SYNCULAR_BENCH_BOOTSTRAP_MAX_SNAPSHOT_PAGES = 100;

async function createTempDbPath(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `${prefix}-`));
  return join(dir, 'client.sqlite');
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

async function createSyncularClientSession(args: {
  actorId: string;
  clientId: string;
  projectIds: string[];
  realtime: boolean;
  dbPath?: string;
  pollIntervalMs?: number;
}): Promise<SyncularClientSession> {
  const dbPath = args.dbPath ?? (await createTempDbPath(`syncular-${args.clientId}`));
  const db = new Kysely<SyncularClientDb>({
    dialect: createBunSqliteDialect({ path: dbPath }),
  });
  await ensureLocalTables(db);

  const meter = createHttpMeter();
  const transport = args.realtime
    ? createWebSocketTransport({
        baseUrl: getStack('syncular').syncBaseUrl,
        getHeaders: () => ({
          'x-user-id': args.actorId,
        }),
        getRealtimeParams: () => ({
          userId: args.actorId,
        }),
        fetch: meter.fetch,
        WebSocketImpl: WebSocket,
      })
    : createSyncularHttpTransport({
        actorId: args.actorId,
        fetchImpl: meter.fetch,
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

  const session = await createClient({
    db,
    actorId: args.actorId,
    clientId: args.clientId,
    transport,
    handlers: [handler],
    autoStart: false,
    sync: {
      realtime: args.realtime,
      pollIntervalMs: args.pollIntervalMs ?? 10_000,
    },
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

async function waitForOutboxClear(
  db: Kysely<SyncularClientDb>,
  timeoutMs = 30_000
): Promise<void> {
  const startedAt = Date.now();
  const pollIntervalMs = 10;
  while (Date.now() - startedAt < timeoutMs) {
    if ((await countOutbox(db)) === 0) {
      return;
    }
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
}): Promise<LocalTaskRow[]> {
  const rows: LocalTaskRow[] = [];

  for (const row of args.snapshot.rows ?? []) {
    if (!isJsonRecord(row)) {
      throw new Error('Syncular snapshot contained a non-object row');
    }
    rows.push(normalizeTaskRow(row));
  }

  for (const chunk of args.snapshot.chunks ?? []) {
    const bytes = await args.transport.fetchSnapshotChunk({
      chunkId: chunk.id,
      scopeValues: args.scopeValues,
    });

    for (const decodedRow of decodeSnapshotRows(bytes)) {
      if (!isJsonRecord(decodedRow)) {
        throw new Error('Syncular snapshot chunk contained a non-object row');
      }
      rows.push(normalizeTaskRow(decodedRow));
    }
  }

  return rows;
}

async function insertLocalTaskRows(
  db: Kysely<SyncularClientDb>,
  rows: LocalTaskRow[]
): Promise<void> {
  const batchSize = 500;
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    if (batch.length === 0) continue;
    await db.insertInto('tasks').values(batch).execute();
  }
}

async function upsertLocalTaskRow(
  db: Kysely<SyncularClientDb>,
  row: LocalTaskRow
): Promise<void> {
  const existing = await db
    .selectFrom('tasks')
    .select('id')
    .where('id', '=', row.id)
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable('tasks')
      .set({
        org_id: row.org_id,
        project_id: row.project_id,
        owner_id: row.owner_id,
        title: row.title,
        completed: row.completed,
        server_version: row.server_version,
        updated_at: row.updated_at,
      })
      .where('id', '=', row.id)
      .execute();
    return;
  }

  await db.insertInto('tasks').values(row).execute();
}

async function applySyncularSubscriptionPayload(args: {
  db: Kysely<SyncularClientDb>;
  subscription: SyncPullSubscriptionResponse;
  transport: ReturnType<typeof createHttpTransport>;
}): Promise<void> {
  for (const snapshot of args.subscription.snapshots ?? []) {
    const rows = await materializeSyncularSnapshotRows({
      snapshot,
      transport: args.transport,
      scopeValues: args.subscription.scopes,
    });
    await insertLocalTaskRows(args.db, rows);
  }

  for (const commit of args.subscription.commits ?? []) {
    for (const change of commit.changes ?? []) {
      const rowId = change.row_id;
      if (!rowId) continue;

      if (change.op === 'delete') {
        await args.db.deleteFrom('tasks').where('id', '=', rowId).execute();
        continue;
      }

      const rowJson = change.row_json;
      if (!isJsonRecord(rowJson)) continue;
      await upsertLocalTaskRow(args.db, normalizeTaskRow(rowJson));
    }
  }
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

  try {
    while (iterations < 200) {
      iterations += 1;

      const body = await transport.sync({
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
      });
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
  await seedStack('syncular', {
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
    await waitForOutboxClear(replaySession.db, 120_000);

    for (const [taskId, expectedTitle] of expectedTitles) {
      await waitForLocalTitle({
        db: replaySession.db,
        taskId,
        expectedTitle,
        timeoutMs: 120_000,
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
  await seedStack('syncular', {
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
    startService('syncular', 'sync');
    await ensureStackUp('syncular');

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
    const scales = [1000, 10_000, 100_000];
    const scaleResults: BootstrapScaleResult[] = [];

    for (const rowsTarget of scales) {
      await seedStack('syncular', {
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
    await seedStack('syncular', {
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 200,
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
    const result = await runSyncularReconnectStormCase({
      clientCount: 25,
    });

    return {
      status: 'completed',
      metrics: {
        client_count: result.clientCount,
        reconnect_convergence_ms: result.reconnectConvergenceMs,
        request_count: result.requestCount,
        request_bytes: result.requestBytes,
        response_bytes: result.responseBytes,
        bytes_transferred: result.bytesTransferred,
        sync_avg_cpu_pct: result.syncAvgCpuPct,
        sync_peak_cpu_pct: result.syncPeakCpuPct,
        sync_avg_memory_mb: result.syncAvgMemoryMb,
        sync_peak_memory_mb: result.syncPeakMemoryMb,
        sync_rx_network_mb: result.syncRxNetworkMb,
        sync_tx_network_mb: result.syncTxNetworkMb,
        postgres_avg_cpu_pct: result.postgresAvgCpuPct,
        postgres_peak_cpu_pct: result.postgresPeakCpuPct,
        postgres_avg_memory_mb: result.postgresAvgMemoryMb,
        postgres_peak_memory_mb: result.postgresPeakMemoryMb,
        postgres_rx_network_mb: result.postgresRxNetworkMb,
        postgres_tx_network_mb: result.postgresTxNetworkMb,
      },
      notes: [
        'Reconnect storm uses 25 already-bootstrapped Syncular HTTP clients catching up after the sync service restarts.',
        'Server resource metrics sample the sync service and Postgres containers during the reconnect window.',
      ],
      metadata: {
        implementation: 'syncular-http-reconnect-storm',
        clientCount: result.clientCount,
      },
    };
  }

  async runLargeOfflineQueue(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    const queueSizes = [20];
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
        'The current default scale is 20 queued writes so the benchmark stays materially above the baseline replay case without making run-all impractically slow.',
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
    await seedStack('syncular', {
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
    await seedStack('syncular', {
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
}
