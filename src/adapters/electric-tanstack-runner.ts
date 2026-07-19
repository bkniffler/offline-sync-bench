import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import 'fake-indexeddb/auto';
import {
  BasicIndex,
  caseWhen,
  count,
  createCollection,
  eq,
  like,
  queryOnce,
  sum,
  type Collection,
} from '@tanstack/db';
import {
  electricCollectionOptions,
  type ElectricCollectionConfig,
  type ElectricCollectionUtils,
} from '@tanstack/electric-db-collection';
import {
  createNodeSQLitePersistence,
  persistedCollectionOptions,
} from '@tanstack/node-db-sqlite-persistence';
import {
  IndexedDBAdapter,
  startOfflineExecutor,
  type LeaderElection,
  type OfflineTransactionAPI,
  type OnlineDetector,
} from '@tanstack/offline-transactions';
import { createHttpMeter } from '../http-meter.ts';
import {
  average,
  CpuSampler,
  MemorySampler,
  percentile,
  round,
} from '../metrics.ts';
import { benchmarkRoot, tempRoot } from '../paths.ts';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface RunnerResult {
  status: 'completed';
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: boolean;
  server_version: number;
  updated_at: string;
}

interface OrganizationRow extends Record<string, unknown> {
  id: string;
  name: string;
}

interface ProjectRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  name: string;
}

interface StackFixtures {
  sampleProjectId: string | null;
  sampleProjectIds: string[];
  sampleOrgId: string | null;
  sampleUserIds: string[];
  sampleTaskId: string | null;
}

interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
}

interface BootstrapScaleResult {
  rowsTarget: number;
  timeToFirstQueryMs: number;
  rowsLoaded: number;
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  bytesTransferred: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
}

interface OnlineSample {
  iteration: number;
  writeAckMs: number;
  mirrorVisibleMs: number;
}

interface OfflineReplayResult {
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
  restoredQueuedWriteCount: number;
}

type TableCollection<T extends Record<string, unknown>> = Collection<
  T,
  string | number,
  ElectricCollectionUtils<T>,
  never,
  T
>;

type SQLiteDatabase = InstanceType<typeof Database>;
type SQLitePersistence = ReturnType<typeof createNodeSQLitePersistence>;

interface TaskSession {
  database: SQLiteDatabase;
  dir: string;
  tasks: TableCollection<TaskRow>;
  close(): Promise<void>;
}

interface RelationshipSession extends TaskSession {
  organizations: TableCollection<OrganizationRow>;
  projects: TableCollection<ProjectRow>;
}

const ADMIN_BASE_URL = 'http://localhost:3212';
const SYNC_BASE_URL = 'http://localhost:3213';
const APP_BASE_URL = 'http://localhost:3224';
const ELECTRIC_SHAPE_URL = `${SYNC_BASE_URL}/v1/shape`;
const ELECTRIC_COMPOSE_FILE = join(
  benchmarkRoot,
  'stacks/electric/docker-compose.yml'
);
const PRODUCT_VERSIONS = {
  electricClient: '1.5.18',
  tanstackDb: '0.6.16',
  electricCollection: '0.3.14',
  offlineTransactions: '1.0.41',
  sqlitePersistence: '0.2.8',
} as const;

const scenario = process.argv[2];
const supportedScenarios = new Set([
  'bootstrap',
  'online-propagation',
  'offline-replay',
  'large-offline-queue',
  'local-query',
  'deep-relationship-query',
  'permission-change',
]);

if (!scenario || !supportedScenarios.has(scenario)) {
  throw new Error(
    'Expected scenario argument: bootstrap | online-propagation | offline-replay | large-offline-queue | local-query | deep-relationship-query | permission-change'
  );
}

class ControlledOnlineDetector implements OnlineDetector {
  #online: boolean;
  #listeners = new Set<() => void>();

  constructor(online: boolean) {
    this.#online = online;
  }

  subscribe(callback: () => void): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  notifyOnline(): void {
    for (const listener of this.#listeners) listener();
  }

  isOnline(): boolean {
    return this.#online;
  }

  setOnline(online: boolean): void {
    this.#online = online;
    if (online) this.notifyOnline();
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

const alwaysLeader: LeaderElection = {
  requestLeadership: async () => true,
  releaseLeadership() {},
  isLeader: () => true,
  onLeadershipChange: () => () => {},
};

function createElectricTableCollection<T extends Record<string, unknown>>(args: {
  id: string;
  table: string;
  persistence: SQLitePersistence;
  fetchImpl: typeof fetch;
  shapeUrl?: string;
  params?: Record<string, string>;
  onUpdate?: ElectricCollectionConfig<T>['onUpdate'];
}): TableCollection<T> {
  return createCollection<
    T,
    string | number,
    ElectricCollectionUtils<T>
  >(
    persistedCollectionOptions<
      T,
      string | number,
      never,
      ElectricCollectionUtils<T>
    >({
      ...electricCollectionOptions<T>({
        id: args.id,
        shapeOptions: {
          url: args.shapeUrl ?? ELECTRIC_SHAPE_URL,
          params: {
            table: args.table,
            ...args.params,
          },
          fetchClient: args.fetchImpl,
          parser: {
            int8: (value) => Number(value),
          },
        },
        getKey: (row) => String(row.id),
        ...(args.onUpdate ? { onUpdate: args.onUpdate } : {}),
      }),
      persistence: args.persistence,
      schemaVersion: 1,
    })
  );
}

async function createTaskSession(args: {
  name: string;
  fetchImpl: typeof fetch;
  actorId?: string;
}): Promise<TaskSession> {
  const context = await createDatabaseContext(args.name);
  const tasks = createElectricTableCollection<TaskRow>({
    id: `${args.name}-tasks`,
    table: 'tasks',
    persistence: context.persistence,
    fetchImpl: args.fetchImpl,
    ...(args.actorId
      ? {
          shapeUrl: `${APP_BASE_URL}/benchmark/shape/tasks`,
          params: { userId: args.actorId },
        }
      : {}),
    onUpdate: async ({ transaction }) => {
      const txid = await postTaskUpdates(
        transaction.mutations.map((mutation) => {
          const modified = mutation.modified as TaskRow;
          return {
            taskId: String(mutation.key),
            title: modified.title,
            completed: modified.completed,
          };
        }),
        randomUUID(),
        args.fetchImpl
      );
      return { txid, timeout: 60_000 };
    },
  });

  return {
    ...context,
    tasks,
    close: () => closeDatabaseContext(context, [tasks]),
  };
}

async function createRelationshipSession(args: {
  name: string;
  fetchImpl: typeof fetch;
}): Promise<RelationshipSession> {
  const context = await createDatabaseContext(args.name);
  const tasks = createElectricTableCollection<TaskRow>({
    id: `${args.name}-tasks`,
    table: 'tasks',
    persistence: context.persistence,
    fetchImpl: args.fetchImpl,
  });
  const projects = createElectricTableCollection<ProjectRow>({
    id: `${args.name}-projects`,
    table: 'projects',
    persistence: context.persistence,
    fetchImpl: args.fetchImpl,
  });
  const organizations = createElectricTableCollection<OrganizationRow>({
    id: `${args.name}-organizations`,
    table: 'organizations',
    persistence: context.persistence,
    fetchImpl: args.fetchImpl,
  });

  return {
    ...context,
    tasks,
    projects,
    organizations,
    close: () =>
      closeDatabaseContext(context, [tasks, projects, organizations]),
  };
}

async function createDatabaseContext(name: string): Promise<{
  database: SQLiteDatabase;
  persistence: SQLitePersistence;
  dir: string;
}> {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `electric-tanstack-${name}-`));
  const database = new Database(join(dir, 'tanstack.sqlite'));
  const persistence = createNodeSQLitePersistence({ database });
  return { database, persistence, dir };
}

async function closeDatabaseContext(
  context: { database: SQLiteDatabase; dir: string },
  collections: Array<{ cleanup(): Promise<void> }>
): Promise<void> {
  await Promise.all(
    collections.map((collection) => collection.cleanup().catch(() => undefined))
  );
  await sleep(100);
  if (context.database.open) context.database.close();
  await rm(context.dir, { recursive: true, force: true });
}

async function postTaskUpdates(
  updates: Array<{
    taskId: string;
    title?: string;
    completed?: boolean;
  }>,
  idempotencyKey: string,
  fetchImpl: typeof fetch
): Promise<number> {
  const response = await fetchImpl(`${APP_BASE_URL}/benchmark/tasks/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ updates }),
  });
  if (!response.ok) {
    throw new Error(
      `TanStack mutation backend failed: ${response.status} ${await response.text()}`
    );
  }
  const body = (await response.json()) as { txid?: number };
  if (!Number.isFinite(body.txid)) {
    throw new Error('TanStack mutation backend did not return a txid');
  }
  return Number(body.txid);
}

async function seedStack(options: {
  resetFirst: boolean;
  orgCount: number;
  projectsPerOrg: number;
  usersPerOrg: number;
  tasksPerProject: number;
  membershipsPerProject: number;
}): Promise<void> {
  await fetchJson(`${ADMIN_BASE_URL}/admin/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options),
  });
}

async function getFixtures(): Promise<StackFixtures> {
  return fetchJson<StackFixtures>(`${ADMIN_BASE_URL}/admin/fixtures`);
}

async function listTasks(args: {
  projectId: string;
  limit: number;
}): Promise<TaskRecord[]> {
  const url = new URL('/admin/tasks', ADMIN_BASE_URL);
  url.searchParams.set('projectId', args.projectId);
  url.searchParams.set('limit', String(args.limit));
  const result = await fetchJson<{
    tasks: Array<{ id: string; projectId: string; title: string }>;
  }>(url.toString());
  return result.tasks;
}

async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function runCompose(args: string[]): void {
  const result = spawnSync(
    'docker',
    ['compose', '-f', ELECTRIC_COMPOSE_FILE, ...args],
    { cwd: benchmarkRoot, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`
    );
  }
}

async function stopApp(): Promise<void> {
  runCompose(['stop', 'app']);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${APP_BASE_URL}/health`);
      if (!response.ok) return;
    } catch {
      return;
    }
    await sleep(50);
  }
  throw new Error('Electric benchmark app did not stop');
}

async function startApp(): Promise<void> {
  runCompose(['start', 'app']);
  await waitForUrl(`${APP_BASE_URL}/health`, 60_000);
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The service is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForTaskTitle(
  collection: TableCollection<TaskRow>,
  taskId: string,
  expectedTitle: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collection.get(taskId)?.title === expectedTitle) return;
    await sleep(5);
  }
  throw new Error(`Task ${taskId} did not converge to ${expectedTitle}`);
}

async function waitForTaskTitles(
  collection: TableCollection<TaskRow>,
  expectedTitles: Map<string, string>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let visible = 0;
    for (const [taskId, title] of expectedTitles) {
      if (collection.get(taskId)?.title === title) visible += 1;
    }
    if (visible === expectedTitles.size) return;
    await sleep(10);
  }
  throw new Error(
    `Only ${countVisibleTitles(collection, expectedTitles)}/${expectedTitles.size} queued titles converged`
  );
}

function countVisibleTitles(
  collection: TableCollection<TaskRow>,
  expectedTitles: Map<string, string>
): number {
  let visible = 0;
  for (const [taskId, title] of expectedTitles) {
    if (collection.get(taskId)?.title === title) visible += 1;
  }
  return visible;
}

async function waitForOutboxCount(
  executor: ReturnType<typeof startOfflineExecutor>,
  expected: number,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await executor.peekOutbox()).length === expected) return;
    await sleep(5);
  }
  throw new Error(
    `TanStack outbox expected ${expected}, got ${(await executor.peekOutbox()).length}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function productMetadata(): { [key: string]: JsonValue } {
  return { ...PRODUCT_VERSIONS };
}

async function runBootstrap(): Promise<RunnerResult> {
  const scales = [1_000, 10_000, 100_000, 250_000, 500_000];
  const scaleResults: BootstrapScaleResult[] = [];

  for (const rowsTarget of scales) {
    await seedStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: rowsTarget,
      membershipsPerProject: 2,
    });

    const meter = createHttpMeter();
    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();
    const startedAt = performance.now();
    const session = await createTaskSession({
      name: `bootstrap-${rowsTarget}-${randomUUID()}`,
      fetchImpl: meter.fetch,
    });

    try {
      await session.tasks.preload();
      const elapsedMs = performance.now() - startedAt;
      if (session.tasks.size !== rowsTarget) {
        throw new Error(
          `Electric + TanStack bootstrap expected ${rowsTarget}, got ${session.tasks.size}`
        );
      }
      const transfer = meter.snapshot();
      const memory = memorySampler.stop();
      const cpu = cpuSampler.stop();
      scaleResults.push({
        rowsTarget,
        timeToFirstQueryMs: round(elapsedMs),
        rowsLoaded: session.tasks.size,
        requestCount: transfer.requestCount,
        requestBytes: transfer.requestBytes,
        responseBytes: transfer.responseBytes,
        bytesTransferred: transfer.requestBytes + transfer.responseBytes,
        avgMemoryMb: memory.avgMemoryMb,
        peakMemoryMb: memory.peakMemoryMb,
        avgCpuPct: cpu.avgCpuPct,
        peakCpuPct: cpu.peakCpuPct,
      });
    } finally {
      memorySampler.stop();
      cpuSampler.stop();
      await session.close();
    }
  }

  return {
    status: 'completed',
    metrics: Object.fromEntries(
      scaleResults.flatMap((entry) => [
        [`bootstrap_${entry.rowsTarget}_ms`, entry.timeToFirstQueryMs],
        [`rows_loaded_${entry.rowsTarget}`, entry.rowsLoaded],
        [`request_count_${entry.rowsTarget}`, entry.requestCount],
        [`request_bytes_${entry.rowsTarget}`, entry.requestBytes],
        [`response_bytes_${entry.rowsTarget}`, entry.responseBytes],
        [`bytes_transferred_${entry.rowsTarget}`, entry.bytesTransferred],
        [`avg_memory_mb_${entry.rowsTarget}`, entry.avgMemoryMb],
        [`peak_memory_mb_${entry.rowsTarget}`, entry.peakMemoryMb],
        [`avg_cpu_pct_${entry.rowsTarget}`, entry.avgCpuPct],
        [`peak_cpu_pct_${entry.rowsTarget}`, entry.peakCpuPct],
      ])
    ),
    notes: [
      'Bootstrap starts with a fresh Node SQLite file, materializes the official Electric collection, and waits for TanStack DB eager preload to become queryable.',
      'The SQLite persistence wrapper is part of the measured client path rather than a benchmark-owned cache.',
    ],
    metadata: {
      implementation: 'electric-tanstack-sqlite-persisted-bootstrap',
      ...productMetadata(),
      scales: scaleResults as unknown as JsonValue,
    },
  };
}

async function runOnlinePropagation(): Promise<RunnerResult> {
  await seedStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });
  const fixtures = await getFixtures();
  if (!fixtures.sampleTaskId) {
    throw new Error('Electric + TanStack fixtures are missing a task');
  }

  const meter = createHttpMeter();
  const writer = await createTaskSession({
    name: `online-writer-${randomUUID()}`,
    fetchImpl: meter.fetch,
  });
  const reader = await createTaskSession({
    name: `online-reader-${randomUUID()}`,
    fetchImpl: meter.fetch,
  });
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    await Promise.all([writer.tasks.preload(), reader.tasks.preload()]);
    const warmup = 5;
    const iterations = 15;
    const samples: OnlineSample[] = [];

    for (let iteration = -warmup; iteration < iterations; iteration += 1) {
      const expectedTitle = `electric-tanstack-online-${iteration}-${Date.now()}`;
      const startedAt = performance.now();
      const transaction = writer.tasks.update(
        fixtures.sampleTaskId,
        (draft) => {
          draft.title = expectedTitle;
        }
      );
      await transaction.isPersisted.promise;
      const writeAckMs = performance.now() - startedAt;
      await waitForTaskTitle(
        reader.tasks,
        fixtures.sampleTaskId,
        expectedTitle
      );
      if (iteration < 0) continue;
      samples.push({
        iteration,
        writeAckMs: round(writeAckMs),
        mirrorVisibleMs: round(performance.now() - startedAt),
      });
    }

    const transfer = meter.snapshot();
    const memory = memorySampler.stop();
    const cpu = cpuSampler.stop();
    const writeAcks = samples.map((sample) => sample.writeAckMs);
    const visibility = samples.map((sample) => sample.mirrorVisibleMs);

    return {
      status: 'completed',
      metrics: {
        write_ack_ms: average(writeAcks),
        mirror_visible_p50_ms: percentile(visibility, 50),
        mirror_visible_p95_ms: percentile(visibility, 95),
        mirror_visible_p99_ms: percentile(visibility, 99),
        iterations,
        request_count: transfer.requestCount,
        request_bytes: transfer.requestBytes,
        response_bytes: transfer.responseBytes,
        bytes_transferred: transfer.requestBytes + transfer.responseBytes,
        avg_memory_mb: memory.avgMemoryMb,
        peak_memory_mb: memory.peakMemoryMb,
        avg_cpu_pct: cpu.avgCpuPct,
        peak_cpu_pct: cpu.peakCpuPct,
      },
      notes: [
        'Client A updates the TanStack collection; the backend commits the row and txid atomically, and the write ack waits for that txid in A\'s Electric stream.',
        'Mirror visibility is measured when a second independently persisted TanStack collection exposes the new title.',
      ],
      metadata: {
        implementation: 'electric-tanstack-txid-online-propagation',
        ...productMetadata(),
        samples: samples as unknown as JsonValue,
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await Promise.all([writer.close(), reader.close()]);
  }
}

async function runOfflineReplay(): Promise<RunnerResult> {
  const replay = await runOfflineReplayCase(10, 'electric-tanstack-offline');
  return {
    status: 'completed',
    metrics: {
      queued_write_count: replay.queuedWriteCount,
      reconnect_convergence_ms: replay.reconnectConvergenceMs,
      conflict_count: replay.conflictCount,
      replayed_write_success_rate: replay.replayedWriteSuccessRate,
      request_count: replay.requestCount,
      request_bytes: replay.requestBytes,
      response_bytes: replay.responseBytes,
      bytes_transferred: replay.bytesTransferred,
      avg_memory_mb: replay.avgMemoryMb,
      peak_memory_mb: replay.peakMemoryMb,
      avg_cpu_pct: replay.avgCpuPct,
      peak_cpu_pct: replay.peakCpuPct,
    },
    notes: [
      'Writes are optimistic TanStack DB mutations persisted in the official offline-transactions IndexedDB outbox while the mutation backend is unavailable.',
      'The executor is disposed and recreated from the serialized outbox before reconnect, then every txid and second-client title must converge.',
    ],
    metadata: {
      implementation: 'electric-tanstack-native-offline-transactions',
      ...productMetadata(),
      restoredQueuedWriteCount: replay.restoredQueuedWriteCount,
    },
  };
}

async function runLargeOfflineQueue(): Promise<RunnerResult> {
  const queueSizes = (process.env.ELECTRIC_TANSTACK_QUEUE_SIZES ?? '100,500,1000')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (queueSizes.length === 0) {
    throw new Error('Electric + TanStack queue sizes must contain a positive integer');
  }
  const results: OfflineReplayResult[] = [];
  for (const queueSize of queueSizes) {
    results.push(
      await runOfflineReplayCase(
        queueSize,
        `electric-tanstack-large-offline-${queueSize}`
      )
    );
  }

  return {
    status: 'completed',
    metrics: Object.fromEntries(
      results.flatMap((entry, index) => {
        const queueSize = queueSizes[index]!;
        return [
          [`queue_${queueSize}_queued_writes`, entry.queuedWriteCount],
          [`queue_${queueSize}_convergence_ms`, entry.reconnectConvergenceMs],
          [`queue_${queueSize}_request_count`, entry.requestCount],
          [`queue_${queueSize}_bytes_transferred`, entry.bytesTransferred],
          [`queue_${queueSize}_avg_memory_mb`, entry.avgMemoryMb],
          [`queue_${queueSize}_peak_memory_mb`, entry.peakMemoryMb],
          [`queue_${queueSize}_avg_cpu_pct`, entry.avgCpuPct],
          [`queue_${queueSize}_peak_cpu_pct`, entry.peakCpuPct],
        ];
      })
    ),
    notes: [
      'The 100 / 500 / 1000 scales enqueue one official offline transaction per application write and replay them through the idempotent txid backend.',
      'Each scale recreates the executor from its durable serialized outbox before reconnect and verifies both server and second-client convergence.',
    ],
    metadata: {
      implementation: 'electric-tanstack-native-large-offline-queue',
      ...productMetadata(),
      queueSizes,
      restoredQueuedWriteCounts: results.map(
        (entry) => entry.restoredQueuedWriteCount
      ),
    },
  };
}

async function runOfflineReplayCase(
  queueSize: number,
  titlePrefix: string
): Promise<OfflineReplayResult> {
  const debug = (message: string) => {
    if (process.env.ELECTRIC_TANSTACK_DEBUG === '1') {
      process.stderr.write(`[electric-tanstack:${queueSize}] ${message}\n`);
    }
  };
  debug('starting');
  const expectedRows = Math.max(200, queueSize + 25);
  await seedStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: expectedRows,
    membershipsPerProject: 2,
  });
  const fixtures = await getFixtures();
  if (!fixtures.sampleProjectId) {
    throw new Error('Electric + TanStack fixtures are missing a project');
  }
  const candidates = await listTasks({
    projectId: fixtures.sampleProjectId,
    limit: queueSize + 10,
  });
  if (candidates.length < queueSize) {
    throw new Error(
      `Electric + TanStack needs ${queueSize} tasks, got ${candidates.length}`
    );
  }

  const meter = createHttpMeter();
  const writer = await createTaskSession({
    name: `offline-writer-${queueSize}-${randomUUID()}`,
    fetchImpl: meter.fetch,
  });
  const reader = await createTaskSession({
    name: `offline-reader-${queueSize}-${randomUUID()}`,
    fetchImpl: meter.fetch,
  });
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();
  let appStopped = false;
  let executor: ReturnType<typeof startOfflineExecutor> | null = null;

  try {
    await Promise.all([writer.tasks.preload(), reader.tasks.preload()]);
    debug('clients preloaded');
    if (writer.tasks.size !== expectedRows || reader.tasks.size !== expectedRows) {
      throw new Error('Electric + TanStack offline clients did not preload');
    }

    const expectedTitles = new Map<string, string>();
    for (let index = 0; index < queueSize; index += 1) {
      const task = candidates[index]!;
      expectedTitles.set(task.id, `${titlePrefix}-${index}-${Date.now()}`);
    }

    await stopApp();
    appStopped = true;
    const storage = new IndexedDBAdapter(
      `electric-tanstack-outbox-${randomUUID()}`,
      'transactions'
    );
    const offlineDetector = new ControlledOnlineDetector(false);
    const createMutationFns = () => ({
      syncTasks: async (args: {
        transaction: {
          mutations: Array<{
            key: string | number;
            modified: unknown;
          }>;
        };
        idempotencyKey: string;
      }) => {
        const txid = await postTaskUpdates(
          args.transaction.mutations.map((mutation) => {
            const modified = mutation.modified as TaskRow;
            return {
              taskId: String(mutation.key),
              title: modified.title,
              completed: modified.completed,
            };
          }),
          args.idempotencyKey,
          meter.fetch
        );
        await writer.tasks.utils.awaitTxId(txid, 60_000);
      },
    });

    executor = startOfflineExecutor({
      collections: { tasks: writer.tasks },
      mutationFns: createMutationFns(),
      storage,
      onlineDetector: offlineDetector,
      leaderElection: alwaysLeader,
      jitter: false,
    });
    await executor.waitForInit();
    if (!executor.isOfflineEnabled) {
      throw new Error('TanStack offline executor did not acquire leadership');
    }

    const pendingCommits: Promise<unknown>[] = [];
    for (const [taskId, title] of expectedTitles) {
      const offlineTransaction = executor.createOfflineTransaction({
        mutationFnName: 'syncTasks',
        autoCommit: false,
      }) as OfflineTransactionAPI;
      offlineTransaction.mutate(() => {
        writer.tasks.update(taskId, (draft) => {
          draft.title = title;
        });
      });
      const commit = offlineTransaction.commit();
      commit.catch(() => undefined);
      pendingCommits.push(commit);
    }
    await waitForOutboxCount(
      executor,
      queueSize,
      Math.max(60_000, queueSize * 250)
    );
    debug(`queued ${queueSize}`);

    const queuedWriteCount = (await executor.peekOutbox()).length;
    if (countVisibleTitles(writer.tasks, expectedTitles) !== queueSize) {
      throw new Error('TanStack optimistic offline state is incomplete');
    }

    executor.dispose();
    const replayDetector = new ControlledOnlineDetector(false);
    executor = startOfflineExecutor({
      collections: { tasks: writer.tasks },
      mutationFns: createMutationFns(),
      storage,
      onlineDetector: replayDetector,
      leaderElection: alwaysLeader,
      jitter: false,
    });
    await executor.waitForInit();
    const restoredQueuedWriteCount = (await executor.peekOutbox()).length;
    if (restoredQueuedWriteCount !== queueSize) {
      throw new Error(
        `TanStack restored ${restoredQueuedWriteCount}/${queueSize} queued writes`
      );
    }
    debug(`restored ${restoredQueuedWriteCount}`);

    const startedAt = performance.now();
    await startApp();
    appStopped = false;
    replayDetector.setOnline(true);
    const replayTimeoutMs = Math.max(120_000, queueSize * 500);
    await waitForOutboxCount(executor, 0, replayTimeoutMs);
    await waitForTaskTitles(reader.tasks, expectedTitles, replayTimeoutMs);
    debug('replay visible');

    const serverRows = await listTasks({
      projectId: fixtures.sampleProjectId,
      limit: queueSize + 10,
    });
    const serverTitles = new Map(serverRows.map((task) => [task.id, task.title]));
    const serverVisible = Array.from(expectedTitles).filter(
      ([taskId, title]) => serverTitles.get(taskId) === title
    ).length;
    if (serverVisible !== queueSize) {
      throw new Error(
        `TanStack replay reached ${serverVisible}/${queueSize} server rows`
      );
    }

    const convergenceMs = performance.now() - startedAt;
    const transfer = meter.snapshot();
    const memory = memorySampler.stop();
    const cpu = cpuSampler.stop();
    void Promise.allSettled(pendingCommits);

    return {
      queuedWriteCount,
      reconnectConvergenceMs: round(convergenceMs),
      conflictCount: 0,
      replayedWriteSuccessRate: round(serverVisible / queueSize, 4),
      requestCount: transfer.requestCount,
      requestBytes: transfer.requestBytes,
      responseBytes: transfer.responseBytes,
      bytesTransferred: transfer.requestBytes + transfer.responseBytes,
      avgMemoryMb: memory.avgMemoryMb,
      peakMemoryMb: memory.peakMemoryMb,
      avgCpuPct: cpu.avgCpuPct,
      peakCpuPct: cpu.peakCpuPct,
      restoredQueuedWriteCount,
    };
  } finally {
    executor?.dispose();
    memorySampler.stop();
    cpuSampler.stop();
    if (appStopped) await startApp().catch(() => undefined);
    await Promise.all([writer.close(), reader.close()]);
  }
}

async function runLocalQuery(): Promise<RunnerResult> {
  await seedStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 100_000,
    membershipsPerProject: 2,
  });
  const fixtures = await getFixtures();
  const projectId = fixtures.sampleProjectId;
  const ownerId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
  if (!projectId || !ownerId) {
    throw new Error('Electric + TanStack local query fixtures are incomplete');
  }

  const meter = createHttpMeter();
  const session = await createTaskSession({
    name: `local-query-${randomUUID()}`,
    fetchImpl: meter.fetch,
  });
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    await session.tasks.preload();
    session.tasks.createIndex((task) => task.project_id, {
      indexType: BasicIndex,
    });
    session.tasks.createIndex((task) => task.owner_id, {
      indexType: BasicIndex,
    });
    session.tasks.createIndex((task) => task.completed, {
      indexType: BasicIndex,
    });
    session.tasks.createIndex((task) => task.updated_at, {
      indexType: BasicIndex,
    });
    session.tasks.createIndex((task) => task.id, { indexType: BasicIndex });

    const iterations = 25;
    const listSamples: number[] = [];
    const searchSamples: number[] = [];
    const aggregateSamples: number[] = [];
    let listResultCount = 0;
    let searchResultCount = 0;
    let aggregateResultCount = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let startedAt = performance.now();
      const listRows = await queryOnce((q) =>
        q
          .from({ task: session.tasks })
          .where(({ task }) => eq(task.project_id, projectId))
          .where(({ task }) => eq(task.owner_id, ownerId))
          .where(({ task }) => eq(task.completed, false))
          .select(({ task }) => ({
            id: task.id,
            title: task.title,
            updatedAt: task.updated_at,
          }))
          .orderBy(({ task }) => task.updated_at, 'desc')
          .limit(50)
      );
      listSamples.push(round(performance.now() - startedAt));
      listResultCount = listRows.length;

      startedAt = performance.now();
      const searchRows = await queryOnce((q) =>
        q
          .from({ task: session.tasks })
          .where(({ task }) => eq(task.project_id, projectId))
          .where(({ task }) => like(task.id, 'org-1-project-1-task-00%'))
          .select(({ task }) => ({ id: task.id, title: task.title }))
          .orderBy(({ task }) => task.id, 'asc')
          .limit(100)
      );
      searchSamples.push(round(performance.now() - startedAt));
      searchResultCount = searchRows.length;

      startedAt = performance.now();
      const aggregateRows = await queryOnce((q) =>
        q
          .from({ task: session.tasks })
          .where(({ task }) => eq(task.project_id, projectId))
          .groupBy(({ task }) => [task.owner_id, task.completed])
          .select(({ task }) => ({
            ownerId: task.owner_id,
            completed: task.completed,
            taskCount: count(task.id),
          }))
      );
      aggregateSamples.push(round(performance.now() - startedAt));
      aggregateResultCount = aggregateRows.length;
    }

    const memory = memorySampler.stop();
    const cpu = cpuSampler.stop();
    return {
      status: 'completed',
      metrics: {
        row_count: session.tasks.size,
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
        avg_memory_mb: memory.avgMemoryMb,
        peak_memory_mb: memory.peakMemoryMb,
        avg_cpu_pct: cpu.avgCpuPct,
        peak_cpu_pct: cpu.peakCpuPct,
      },
      notes: [
        'Queries use the TanStack DB expression/query engine over the fully materialized, SQLite-persisted Electric task collection.',
        'Explicit TanStack indexes cover the filter/order columns used by the shared list, prefix-search, and grouped-aggregate workload.',
      ],
      metadata: {
        implementation: 'electric-tanstack-local-query-engine',
        ...productMetadata(),
        rowCount: session.tasks.size,
        iterations,
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await session.close();
  }
}

async function runDeepRelationshipQuery(): Promise<RunnerResult> {
  await seedStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 4,
    usersPerOrg: 10,
    tasksPerProject: 25_000,
    membershipsPerProject: 4,
  });
  const fixtures = await getFixtures();
  if (!fixtures.sampleOrgId || !fixtures.sampleProjectId) {
    throw new Error('Electric + TanStack relationship fixtures are incomplete');
  }

  const meter = createHttpMeter();
  const session = await createRelationshipSession({
    name: `relationships-${randomUUID()}`,
    fetchImpl: meter.fetch,
  });
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    await Promise.all([
      session.tasks.preload(),
      session.projects.preload(),
      session.organizations.preload(),
    ]);
    if (
      session.tasks.size !== 100_000 ||
      session.projects.size !== 4 ||
      session.organizations.size !== 1
    ) {
      throw new Error(
        `Relationship preload got tasks=${session.tasks.size}, projects=${session.projects.size}, organizations=${session.organizations.size}`
      );
    }

    session.tasks.createIndex((task) => task.project_id, {
      indexType: BasicIndex,
    });
    session.tasks.createIndex((task) => task.id, { indexType: BasicIndex });
    session.projects.createIndex((project) => project.id, {
      indexType: BasicIndex,
    });
    session.projects.createIndex((project) => project.org_id, {
      indexType: BasicIndex,
    });
    session.organizations.createIndex((organization) => organization.id, {
      indexType: BasicIndex,
    });

    const iterations = 25;
    const dashboardSamples: number[] = [];
    const detailJoinSamples: number[] = [];
    let dashboardResultCount = 0;
    let detailJoinResultCount = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      let startedAt = performance.now();
      const dashboardRows = await queryOnce((q) =>
        q
          .from({ organization: session.organizations })
          .innerJoin(
            { project: session.projects },
            ({ organization, project }) =>
              eq(organization.id, project.org_id)
          )
          .leftJoin(
            { task: session.tasks },
            ({ project, task }) => eq(project.id, task.project_id)
          )
          .where(({ organization }) =>
            eq(organization.id, fixtures.sampleOrgId!)
          )
          .groupBy(({ organization, project }) => [
            organization.name,
            project.id,
            project.name,
          ])
          .select(({ organization, project, task }) => ({
            orgName: organization.name,
            projectId: project.id,
            projectName: project.name,
            taskCount: count(task.id),
            openTaskCount: sum(
              caseWhen(eq(task.completed, false), 1, 0)
            ),
          }))
          .orderBy(({ $selected }) => $selected.openTaskCount, 'desc')
          .orderBy(({ project }) => project.id, 'asc')
          .limit(20)
      );
      dashboardSamples.push(round(performance.now() - startedAt));
      dashboardResultCount = dashboardRows.length;

      startedAt = performance.now();
      const detailRows = await queryOnce((q) =>
        q
          .from({ task: session.tasks })
          .innerJoin(
            { project: session.projects },
            ({ task, project }) => eq(task.project_id, project.id)
          )
          .innerJoin(
            { organization: session.organizations },
            ({ project, organization }) =>
              eq(project.org_id, organization.id)
          )
          .where(({ project }) =>
            eq(project.id, fixtures.sampleProjectId!)
          )
          .where(({ task }) => like(task.id, 'org-1-project-1-task-00%'))
          .select(({ task, project, organization }) => ({
            id: task.id,
            title: task.title,
            projectName: project.name,
            orgName: organization.name,
          }))
          .orderBy(({ task }) => task.id, 'asc')
          .limit(100)
      );
      detailJoinSamples.push(round(performance.now() - startedAt));
      detailJoinResultCount = detailRows.length;
    }

    const memory = memorySampler.stop();
    const cpu = cpuSampler.stop();
    return {
      status: 'completed',
      metrics: {
        org_count: session.organizations.size,
        project_count: session.projects.size,
        row_count: session.tasks.size,
        iterations,
        dashboard_query_p50_ms: percentile(dashboardSamples, 50),
        dashboard_query_p95_ms: percentile(dashboardSamples, 95),
        detail_join_query_p50_ms: percentile(detailJoinSamples, 50),
        detail_join_query_p95_ms: percentile(detailJoinSamples, 95),
        dashboard_result_count: dashboardResultCount,
        detail_join_result_count: detailJoinResultCount,
        avg_memory_mb: memory.avgMemoryMb,
        peak_memory_mb: memory.peakMemoryMb,
        avg_cpu_pct: cpu.avgCpuPct,
        peak_cpu_pct: cpu.peakCpuPct,
      },
      notes: [
        'Organizations, projects, and tasks are independent Electric collections sharing the official TanStack SQLite persistence layer.',
        'The dashboard aggregate and detail relationship query use TanStack DB joins, grouping, ordering, and indexes entirely on the client.',
      ],
      metadata: {
        implementation: 'electric-tanstack-local-relationship-query-engine',
        ...productMetadata(),
        organizationCount: session.organizations.size,
        projectCount: session.projects.size,
        taskCount: session.tasks.size,
        iterations,
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await session.close();
  }
}

async function runPermissionChange(): Promise<RunnerResult> {
  await seedStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 2,
    usersPerOrg: 4,
    tasksPerProject: 500,
    membershipsPerProject: 2,
  });
  const fixtures = await getFixtures();
  const actorId = fixtures.sampleUserIds[0];
  const revokedProjectId = fixtures.sampleProjectIds[0];
  const retainedProjectId = fixtures.sampleProjectIds[1];
  if (!actorId || !revokedProjectId || !retainedProjectId) {
    throw new Error('Electric + TanStack permission fixtures are incomplete');
  }

  const meter = createHttpMeter();
  const initial = await createTaskSession({
    name: `permission-initial-${randomUUID()}`,
    fetchImpl: meter.fetch,
    actorId,
  });
  let rebootstrap: TaskSession | null = null;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    await initial.tasks.preload();
    const initialVisibleRows = initial.tasks.size;
    const baseline = meter.snapshot();
    const startedAt = performance.now();
    const revokeStartedAt = performance.now();
    await fetchJson(`${APP_BASE_URL}/benchmark/revoke-membership`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: actorId, projectId: revokedProjectId }),
    });
    const revokeRequestMs = performance.now() - revokeStartedAt;

    const rebootstrapStartedAt = performance.now();
    rebootstrap = await createTaskSession({
      name: `permission-rebootstrap-${randomUUID()}`,
      fetchImpl: meter.fetch,
      actorId,
    });
    await rebootstrap.tasks.preload();
    const rebootstrapVisibleMs = performance.now() - rebootstrapStartedAt;
    const revokedRows = countRowsForProject(
      rebootstrap.tasks,
      revokedProjectId
    );
    const retainedRows = countRowsForProject(
      rebootstrap.tasks,
      retainedProjectId
    );
    if (revokedRows !== 0 || retainedRows !== 500) {
      throw new Error(
        `Permission rebootstrap got revoked=${revokedRows}, retained=${retainedRows}`
      );
    }

    let sameClientConvergenceMs: number | null = null;
    const sameClientDeadline = Date.now() + 60_000;
    while (Date.now() < sameClientDeadline) {
      if (
        countRowsForProject(initial.tasks, revokedProjectId) === 0 &&
        countRowsForProject(initial.tasks, retainedProjectId) === 500
      ) {
        sameClientConvergenceMs = round(performance.now() - startedAt);
        break;
      }
      await sleep(25);
    }

    const transfer = diffMeter(meter.snapshot(), baseline);
    const memory = memorySampler.stop();
    const cpu = cpuSampler.stop();
    return {
      status: 'completed',
      metrics: {
        initial_visible_rows: initialVisibleRows,
        post_revoke_visible_rows: rebootstrap.tasks.size,
        revoked_project_visible_rows_after_revoke: revokedRows,
        retained_project_visible_rows_after_revoke: retainedRows,
        permission_revoke_convergence_ms: round(
          performance.now() - startedAt
        ),
        same_client_permission_revoke_convergence_ms: sameClientConvergenceMs,
        revoke_request_ms: round(revokeRequestMs),
        rebootstrap_permission_visible_ms: round(rebootstrapVisibleMs),
        rebootstrap_visible_rows: rebootstrap.tasks.size,
        rebootstrap_revoked_project_visible_rows: revokedRows,
        rebootstrap_retained_project_visible_rows: retainedRows,
        request_count: transfer.requestCount,
        request_bytes: transfer.requestBytes,
        response_bytes: transfer.responseBytes,
        bytes_transferred: transfer.requestBytes + transfer.responseBytes,
        avg_memory_mb: memory.avgMemoryMb,
        peak_memory_mb: memory.peakMemoryMb,
        avg_cpu_pct: cpu.avgCpuPct,
        peak_cpu_pct: cpu.peakCpuPct,
      },
      notes: [
        'The collection connects through the actor-scoped Electric shape proxy, so project membership determines the server-side replicated shape.',
        'Rebootstrap after revocation must expose only the retained project; same-client purge is reported when the active Electric stream refetches the changed scope.',
      ],
      metadata: {
        implementation: 'electric-tanstack-auth-scoped-shape',
        ...productMetadata(),
        actorId,
        revokedProjectId,
        retainedProjectId,
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await initial.close();
    if (rebootstrap) await rebootstrap.close();
  }
}

function countRowsForProject(
  collection: TableCollection<TaskRow>,
  projectId: string
): number {
  let count = 0;
  for (const task of collection.values()) {
    if (task.project_id === projectId) count += 1;
  }
  return count;
}

function diffMeter(
  after: { requestCount: number; requestBytes: number; responseBytes: number },
  before: { requestCount: number; requestBytes: number; responseBytes: number }
): { requestCount: number; requestBytes: number; responseBytes: number } {
  return {
    requestCount: Math.max(0, after.requestCount - before.requestCount),
    requestBytes: Math.max(0, after.requestBytes - before.requestBytes),
    responseBytes: Math.max(0, after.responseBytes - before.responseBytes),
  };
}

const result =
  scenario === 'bootstrap'
    ? await runBootstrap()
    : scenario === 'online-propagation'
      ? await runOnlinePropagation()
      : scenario === 'offline-replay'
        ? await runOfflineReplay()
        : scenario === 'large-offline-queue'
          ? await runLargeOfflineQueue()
          : scenario === 'local-query'
            ? await runLocalQuery()
            : scenario === 'deep-relationship-query'
              ? await runDeepRelationshipQuery()
              : await runPermissionChange();

process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
