import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
import { createUnsupportedScenarioResult } from '../unsupported';
import type {
  BenchmarkAdapter,
  BenchmarkStatus,
  BootstrapScaleResult,
  JsonValue,
  OnlinePropagationSample,
  TaskRecord,
} from '../types';

interface ElectricShapeMessage {
  key?: string;
  value?: {
    completed?: string | boolean;
    id?: string;
    org_id?: string;
    owner_id?: string;
    project_id?: string;
    server_version?: string | number;
    title?: string;
    updated_at?: string;
  };
  headers?: {
    control?: string;
    operation?: 'insert' | 'update' | 'delete';
  };
}

interface ElectricShapeState {
  handle: string;
  offset: string;
  rows: Map<string, TaskRecord>;
  serverVersion: string | null;
}

interface ElectricQueuedWrite {
  sequence: number;
  taskId: string;
  title: string;
}

interface HttpMeterTotals {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
}

class ElectricOutboxStore {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true });
    this.#db.run(`
      create table if not exists queued_writes (
        sequence integer primary key autoincrement,
        task_id text not null,
        title text not null
      )
    `);
  }

  enqueueWrites(writes: Array<{ taskId: string; title: string }>): void {
    const insert = this.#db.query(
      'insert into queued_writes (task_id, title) values (?, ?)'
    );

    const transaction = this.#db.transaction(
      (queuedWrites: Array<{ taskId: string; title: string }>) => {
        for (const queuedWrite of queuedWrites) {
          insert.run(queuedWrite.taskId, queuedWrite.title);
        }
      }
    );

    transaction(writes);
  }

  listWrites(): ElectricQueuedWrite[] {
    return this.#db
      .query<ElectricQueuedWrite, []>(
        `
          select
            sequence,
            task_id as taskId,
            title
          from queued_writes
          order by sequence asc
        `
      )
      .all();
  }

  clear(): void {
    this.#db.run('delete from queued_writes');
  }

  close(): void {
    this.#db.close();
  }
}

async function createTempOutboxPath(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `${prefix}-`));
  return join(dir, 'outbox.sqlite');
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

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function coerceBoolean(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value;
  return value === 'true';
}

function coerceNumber(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  return Number(value ?? '0');
}

function applyShapeMessages(
  rows: Map<string, TaskRecord>,
  messages: ElectricShapeMessage[]
): {
  snapshotComplete: boolean;
  sawUpToDate: boolean;
} {
  let snapshotComplete = false;
  let sawUpToDate = false;

  for (const message of messages) {
    const control = message.headers?.control;
    if (control === 'snapshot-end') {
      snapshotComplete = true;
      continue;
    }
    if (control === 'up-to-date') {
      sawUpToDate = true;
      continue;
    }

    const taskId = message.value?.id;
    if (!taskId) continue;

    if (message.headers?.operation === 'delete') {
      rows.delete(taskId);
      continue;
    }

    rows.set(taskId, {
      id: taskId,
      orgId: message.value?.org_id ?? '',
      projectId: message.value?.project_id ?? '',
      ownerId: message.value?.owner_id ?? '',
      title: message.value?.title ?? '',
      completed: coerceBoolean(message.value?.completed),
      serverVersion: coerceNumber(message.value?.server_version),
      updatedAt: message.value?.updated_at ?? '',
    });
  }

  return {
    snapshotComplete,
    sawUpToDate,
  };
}

async function fetchShapePage(args: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  path?: string;
  headers?: HeadersInit;
  handle?: string;
  offset: string;
  live?: boolean;
}): Promise<{
  handle: string;
  offset: string;
  serverVersion: string | null;
  messages: ElectricShapeMessage[];
}> {
  const url = new URL(args.path ?? '/v1/shape', args.baseUrl);
  if (!args.path) {
    url.searchParams.set('table', 'tasks');
  }
  url.searchParams.set('offset', args.offset);
  if (args.handle) {
    url.searchParams.set('handle', args.handle);
  }
  if (args.live) {
    url.searchParams.set('live', 'true');
  }

  const response = await args.fetchImpl(url.toString(), {
    headers: args.headers,
  });
  if (!response.ok) {
    throw new Error(
      `Electric shape request failed: ${response.status} ${response.statusText}`
    );
  }

  const handle = response.headers.get('electric-handle');
  const offset = response.headers.get('electric-offset');
  if (!handle || !offset) {
    throw new Error('Electric shape response missing handle/offset headers');
  }

  const body = await response.text();
  return {
    handle,
    offset,
    serverVersion: response.headers.get('electric-server'),
    messages: parseJson<ElectricShapeMessage[]>(body),
  };
}

async function bootstrapShape(args: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  path?: string;
  headers?: HeadersInit;
}): Promise<ElectricShapeState> {
  const rows = new Map<string, TaskRecord>();
  let handle: string | undefined;
  let offset = '-1';
  let serverVersion: string | null = null;

  while (true) {
    const page = await fetchShapePage({
      baseUrl: args.baseUrl,
      fetchImpl: args.fetchImpl,
      path: args.path,
      headers: args.headers,
      handle,
      offset,
    });

    const applyResult = applyShapeMessages(rows, page.messages);
    handle = page.handle;
    offset = page.offset;
    serverVersion = page.serverVersion;

    if (applyResult.snapshotComplete || applyResult.sawUpToDate) {
      break;
    }
  }

  if (!handle) {
    throw new Error('Electric bootstrap did not produce a shape handle');
  }

  return {
    handle,
    offset,
    rows,
    serverVersion,
  };
}

function createElectricActorFetch(args: {
  fetchImpl: typeof fetch;
  actorId: string;
}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('x-user-id', args.actorId);

    return args.fetchImpl(input, {
      ...init,
      headers,
    });
  }) as typeof fetch;
}

function countElectricRowsForProject(
  rows: Map<string, TaskRecord>,
  projectId: string
): number {
  let count = 0;
  for (const row of rows.values()) {
    if (row.projectId === projectId) {
      count += 1;
    }
  }
  return count;
}

async function revokeElectricProjectMembership(args: {
  actorId: string;
  projectId: string;
}): Promise<void> {
  const appBaseUrl = getStack('electric').appBaseUrl;
  if (!appBaseUrl) {
    throw new Error('Electric app base URL is not configured');
  }

  const response = await fetch(`${appBaseUrl}/benchmark/revoke-membership`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      projectId: args.projectId,
      userId: args.actorId,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Electric membership revoke failed: ${response.status} ${response.statusText}`
    );
  }
}

async function waitForElectricTitle(args: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  state: ElectricShapeState;
  taskId: string;
  expectedTitle: string;
  timeoutMs?: number;
}): Promise<ElectricShapeState> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let currentState = args.state;

  while (Date.now() - startedAt < timeoutMs) {
    const page = await fetchShapePage({
      baseUrl: args.baseUrl,
      fetchImpl: args.fetchImpl,
      handle: currentState.handle,
      offset: currentState.offset,
      live: true,
    });

    const nextRows = new Map(currentState.rows);
    applyShapeMessages(nextRows, page.messages);

    currentState = {
      handle: page.handle,
      offset: page.offset,
      rows: nextRows,
      serverVersion: page.serverVersion,
    };

    if (nextRows.get(args.taskId)?.title === args.expectedTitle) {
      return currentState;
    }
  }

  throw new Error(
    `Electric live shape did not observe ${args.taskId}=${args.expectedTitle}`
  );
}

function allExpectedTitlesVisible(
  rows: Map<string, TaskRecord>,
  expectedTitles: Map<string, string>
): boolean {
  for (const [taskId, expectedTitle] of expectedTitles) {
    if (rows.get(taskId)?.title !== expectedTitle) {
      return false;
    }
  }

  return true;
}

async function waitForElectricTitles(args: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  state: ElectricShapeState;
  expectedTitles: Map<string, string>;
  timeoutMs?: number;
}): Promise<ElectricShapeState> {
  if (allExpectedTitlesVisible(args.state.rows, args.expectedTitles)) {
    return args.state;
  }

  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let currentState = args.state;

  while (Date.now() - startedAt < timeoutMs) {
    const page = await fetchShapePage({
      baseUrl: args.baseUrl,
      fetchImpl: args.fetchImpl,
      handle: currentState.handle,
      offset: currentState.offset,
      live: true,
    });

    const nextRows = new Map(currentState.rows);
    applyShapeMessages(nextRows, page.messages);

    currentState = {
      handle: page.handle,
      offset: page.offset,
      rows: nextRows,
      serverVersion: page.serverVersion,
    };

    if (allExpectedTitlesVisible(nextRows, args.expectedTitles)) {
      return currentState;
    }
  }

  throw new Error('Electric live shape did not observe all replayed task titles');
}

interface ElectricOfflineReplayCaseResult {
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
  productVersion: string | null;
}

async function runElectricOfflineReplayCase(args: {
  queueSize: number;
  titlePrefix: string;
}): Promise<ElectricOfflineReplayCaseResult> {
  await ensureStackUp('electric');
  await seedStack('electric', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: Math.max(200, args.queueSize + 25),
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('electric');
  const projectId = fixtures.sampleProjectId;
  if (!projectId) {
    throw new Error('Electric fixtures are missing project data');
  }

  const candidateTasks = await listTasks('electric', {
    projectId,
    limit: args.queueSize + 10,
  });
  if (candidateTasks.length < args.queueSize) {
    throw new Error(
      `Need at least ${args.queueSize} tasks for Electric offline replay`
    );
  }

  const outboxPath = await createTempOutboxPath(args.titlePrefix);
  const initialOutbox = new ElectricOutboxStore(outboxPath);
  const offlineTargets = candidateTasks.slice(0, args.queueSize);
  const expectedTitles = new Map<string, string>();

  stopService('electric', 'sync');

  for (let index = 0; index < offlineTargets.length; index += 1) {
    const task = offlineTargets[index];
    if (!task) continue;
    const expectedTitle = `${args.titlePrefix}-${index}-${Date.now()}`;
    expectedTitles.set(task.id, expectedTitle);
  }

  initialOutbox.enqueueWrites(
    Array.from(expectedTitles.entries()).map(([taskId, title]) => ({
      taskId,
      title,
    }))
  );
  const queuedWriteCount = initialOutbox.listWrites().length;
  initialOutbox.close();

  startService('electric', 'sync');
  await ensureStackUp('electric');

  const meter = createHttpMeter();
  let state = await bootstrapShape({
    baseUrl: getStack('electric').syncBaseUrl,
    fetchImpl: meter.fetch,
  });
  const meterBaseline = meter.snapshot();
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  const replayOutbox = new ElectricOutboxStore(outboxPath);
  try {
    const queuedWrites = replayOutbox.listWrites();
    const startedAt = performance.now();

    for (const queuedWrite of queuedWrites) {
      await writeTask('electric', {
        taskId: queuedWrite.taskId,
        title: queuedWrite.title,
      });
    }

    state = await waitForElectricTitles({
      baseUrl: getStack('electric').syncBaseUrl,
      fetchImpl: meter.fetch,
      state,
      expectedTitles,
      timeoutMs: 120_000,
    });

    const convergenceMs = performance.now() - startedAt;
    const meterSnapshot = diffMeterTotals(meter.snapshot(), meterBaseline);
    const bytes = meterSnapshot.requestBytes + meterSnapshot.responseBytes;
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    replayOutbox.clear();

    return {
      queuedWriteCount,
      reconnectConvergenceMs: round(convergenceMs),
      conflictCount: 0,
      replayedWriteSuccessRate:
        queuedWriteCount === 0 ? 0 : round(expectedTitles.size / queuedWriteCount, 4),
      requestCount: meterSnapshot.requestCount,
      requestBytes: meterSnapshot.requestBytes,
      responseBytes: meterSnapshot.responseBytes,
      bytesTransferred: bytes,
      avgMemoryMb: memoryMetrics.avgMemoryMb,
      peakMemoryMb: memoryMetrics.peakMemoryMb,
      avgCpuPct: cpuMetrics.avgCpuPct,
      peakCpuPct: cpuMetrics.peakCpuPct,
      queuedTaskIds: Array.from(expectedTitles.keys()),
      productVersion: state.serverVersion,
    };
  } finally {
    replayOutbox.close();
    await rm(outboxPath.replace(/\/outbox\.sqlite$/, ''), {
      recursive: true,
      force: true,
    });
  }
}

interface ElectricReconnectStormCaseResult {
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
  productVersion: string | null;
}

async function runElectricReconnectStormCase(args: {
  clientCount: number;
}): Promise<ElectricReconnectStormCaseResult> {
  await ensureStackUp('electric');
  await seedStack('electric', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('electric');
  const taskId = fixtures.sampleTaskId;
  if (!taskId) {
    throw new Error('Electric fixtures are missing task data');
  }

  const clients = await Promise.all(
    Array.from({ length: args.clientCount }, async (_, index) => {
      const meter = createHttpMeter();
      const state = await bootstrapShape({
        baseUrl: getStack('electric').syncBaseUrl,
        fetchImpl: meter.fetch,
      });

      return {
        index,
        meter,
        state,
        baseline: meter.snapshot(),
      };
    })
  );

  const syncContainerId = resolveServiceContainerId('electric', 'sync');
  const postgresContainerId = resolveServiceContainerId('electric', 'postgres');

  stopService('electric', 'sync');
  await waitForUrlDown(`${getStack('electric').syncBaseUrl}/v1/shape?table=tasks&offset=-1`);
  startService('electric', 'sync');
  await ensureStackUp('electric');

  const sampler = new DockerServiceSampler([
    { label: 'sync', id: syncContainerId },
    { label: 'postgres', id: postgresContainerId },
  ]);
  sampler.start();
  const startedAt = performance.now();
  const expectedTitle = `electric-storm-${Date.now()}`;
  await writeTask('electric', {
    taskId,
    title: expectedTitle,
  });

  const updatedClients = await Promise.all(
    clients.map(async (client) => ({
      ...client,
      state: await waitForElectricTitle({
        baseUrl: getStack('electric').syncBaseUrl,
        fetchImpl: client.meter.fetch,
        state: client.state,
        taskId,
        expectedTitle,
        timeoutMs: 120_000,
      }),
    }))
  );

  const convergenceMs = performance.now() - startedAt;
  const containerMetrics = sampler.stop();
  const totalMeter = updatedClients.reduce(
    (totals, client) => {
      const snapshot = diffMeterTotals(client.meter.snapshot(), client.baseline);
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
    productVersion: updatedClients[0]?.state.serverVersion ?? null,
  };
}

interface LocalQuerySample {
  elapsedMs: number;
  resultCount: number;
}

function runElectricLocalListQuery(args: {
  rows: TaskRecord[];
  projectId: string;
  ownerId: string;
}): LocalQuerySample {
  const startedAt = performance.now();
  const rows = args.rows
    .filter(
      (row) =>
        row.projectId === args.projectId &&
        row.ownerId === args.ownerId &&
        !row.completed
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 50);

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

function runElectricLocalSearchQuery(args: {
  rows: TaskRecord[];
  projectId: string;
}): LocalQuerySample {
  const startedAt = performance.now();
  const rows = args.rows
    .filter(
      (row) =>
        row.projectId === args.projectId &&
        row.id.startsWith('org-1-project-1-task-00')
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 100);

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

function runElectricLocalAggregateQuery(args: {
  rows: TaskRecord[];
  projectId: string;
}): LocalQuerySample {
  const startedAt = performance.now();
  const grouped = new Map<string, number>();

  for (const row of args.rows) {
    if (row.projectId !== args.projectId) continue;
    const key = `${row.ownerId}:${row.completed ? '1' : '0'}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: grouped.size,
  };
}

export class ElectricBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('electric');

  async runBootstrap(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: { [key: string]: JsonValue };
  }> {
    await ensureStackUp('electric');

    const scales = [1000, 10_000, 100_000, 250_000, 500_000];
    const scaleResults: BootstrapScaleResult[] = [];
    let productVersion: string | null = null;

    for (const rowsTarget of scales) {
      await seedStack('electric', {
        resetFirst: true,
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: rowsTarget,
        membershipsPerProject: 2,
      });

      const meter = createHttpMeter();
      const sampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      sampler.start();
      cpuSampler.start();
      const startedAt = performance.now();
      const snapshot = await bootstrapShape({
        baseUrl: this.stack.syncBaseUrl,
        fetchImpl: meter.fetch,
      });
      const elapsedMs = performance.now() - startedAt;
      const memoryMetrics = sampler.stop();
      const cpuMetrics = cpuSampler.stop();
      const meterSnapshot = meter.snapshot();
      const bytes = meterSnapshot.requestBytes + meterSnapshot.responseBytes;
      productVersion = snapshot.serverVersion ?? productVersion;
      if (snapshot.rows.size !== rowsTarget) {
        throw new Error(
          `Electric bootstrap expected ${rowsTarget} rows, got ${snapshot.rows.size}`
        );
      }

      scaleResults.push({
        rowsTarget,
        timeToFirstQueryMs: round(elapsedMs),
        rowsLoaded: snapshot.rows.size,
        requestCount: meterSnapshot.requestCount,
        requestBytes: meterSnapshot.requestBytes,
        responseBytes: meterSnapshot.responseBytes,
        bytesTransferred: bytes,
        avgMemoryMb: memoryMetrics.avgMemoryMb,
        peakMemoryMb: memoryMetrics.peakMemoryMb,
        avgCpuPct: cpuMetrics.avgCpuPct,
        peakCpuPct: cpuMetrics.peakCpuPct,
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
        'Electric bootstrap uses the raw shape feed and a local in-memory materialized view.',
        'This does not add a separate SQLite/PGlite cache layer on top of Electric.',
      ],
      metadata: {
        implementation: 'raw-shape-bootstrap',
        productVersion: productVersion ?? 'unknown',
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
    await ensureStackUp('electric');
    await seedStack('electric', {
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 200,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures('electric');
    if (!fixtures.sampleTaskId) {
      throw new Error('Electric fixtures did not return a sample task');
    }

    const iterations = 15;
    const meter = createHttpMeter();
    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();
    let state = await bootstrapShape({
      baseUrl: this.stack.syncBaseUrl,
      fetchImpl: meter.fetch,
    });
    const samples: OnlinePropagationSample[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const expectedTitle = `electric-online-${iteration}-${Date.now()}`;
      const writeStartedAt = performance.now();
      const writtenTask = await writeTask('electric', {
        taskId: fixtures.sampleTaskId,
        title: expectedTitle,
      });
      const writeAckMs = performance.now() - writeStartedAt;

      state = await waitForElectricTitle({
        baseUrl: this.stack.syncBaseUrl,
        fetchImpl: meter.fetch,
        state,
        taskId: writtenTask.id,
        expectedTitle,
      });

      samples.push({
        iteration,
        writeAckMs: round(writeAckMs),
        mirrorVisibleMs: round(performance.now() - writeStartedAt),
      });
    }

    const visibility = samples.map((sample) => sample.mirrorVisibleMs);
    const writeAcks = samples.map((sample) => sample.writeAckMs);
    const meterSnapshot = meter.snapshot();
    const bytes = meterSnapshot.requestBytes + meterSnapshot.responseBytes;
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      status: 'completed',
      metrics: {
        write_ack_ms: average(writeAcks),
        mirror_visible_p50_ms: percentile(visibility, 50),
        mirror_visible_p95_ms: percentile(visibility, 95),
        mirror_visible_p99_ms: percentile(visibility, 99),
        iterations,
        request_count: meterSnapshot.requestCount,
        request_bytes: meterSnapshot.requestBytes,
        response_bytes: meterSnapshot.responseBytes,
        bytes_transferred: bytes,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'Writes are measured through the benchmark app/admin DB path that Electric observes.',
        'Visibility timing uses live shape requests with the same shape handle/offset chain as a real client.',
      ],
      metadata: {
        implementation: 'raw-shape-live',
        productVersion: state.serverVersion ?? 'unknown',
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
    await ensureStackUp('electric');
    await seedStack('electric', {
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 200,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures('electric');
    const projectId = fixtures.sampleProjectId;
    if (!projectId) {
      throw new Error('Electric fixtures are missing project data');
    }

    const candidateTasks = await listTasks('electric', {
      projectId,
      limit: 20,
    });
    if (candidateTasks.length < 10) {
      throw new Error('Need at least 10 tasks for Electric offline replay');
    }

    const outboxPath = await createTempOutboxPath('electric-offline-replay');
    const initialOutbox = new ElectricOutboxStore(outboxPath);
    const offlineTargets = candidateTasks.slice(0, 10);
    const expectedTitles = new Map<string, string>();

    stopService('electric', 'sync');

    for (let index = 0; index < offlineTargets.length; index += 1) {
      const task = offlineTargets[index];
      if (!task) continue;
      const expectedTitle = `electric-offline-${index}-${Date.now()}`;
      expectedTitles.set(task.id, expectedTitle);
    }

    initialOutbox.enqueueWrites(
      Array.from(expectedTitles.entries()).map(([taskId, title]) => ({
        taskId,
        title,
      }))
    );
    const queuedWriteCount = initialOutbox.listWrites().length;
    initialOutbox.close();

    startService('electric', 'sync');
    await ensureStackUp('electric');

    const meter = createHttpMeter();
    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();
    let state = await bootstrapShape({
      baseUrl: this.stack.syncBaseUrl,
      fetchImpl: meter.fetch,
    });

    const replayOutbox = new ElectricOutboxStore(outboxPath);
    const queuedWrites = replayOutbox.listWrites();
    const startedAt = performance.now();

    for (const queuedWrite of queuedWrites) {
      await writeTask('electric', {
        taskId: queuedWrite.taskId,
        title: queuedWrite.title,
      });
    }

    state = await waitForElectricTitles({
      baseUrl: this.stack.syncBaseUrl,
      fetchImpl: meter.fetch,
      state,
      expectedTitles,
      timeoutMs: 60_000,
    });

    const convergenceMs = performance.now() - startedAt;
    const meterSnapshot = meter.snapshot();
    const bytes = meterSnapshot.requestBytes + meterSnapshot.responseBytes;
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    replayOutbox.clear();
    replayOutbox.close();
    await rm(outboxPath.replace(/\/outbox\.sqlite$/, ''), {
      recursive: true,
      force: true,
    });

    return {
      status: 'completed',
      metrics: {
        queued_write_count: queuedWriteCount,
        reconnect_convergence_ms: round(convergenceMs),
        conflict_count: 0,
        replayed_write_success_rate:
          queuedWriteCount === 0
            ? 0
            : round(expectedTitles.size / queuedWriteCount, 4),
        request_count: meterSnapshot.requestCount,
        request_bytes: meterSnapshot.requestBytes,
        response_bytes: meterSnapshot.responseBytes,
        bytes_transferred: bytes,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'Offline replay is emulated with a benchmark-owned durable Bun SQLite outbox because Electric does not ship a native local write queue in this setup.',
        'The benchmark stops the Electric service, persists queued writes locally, recreates the outbox on disk, then replays writes through Postgres while a live shape reader measures convergence.',
      ],
      metadata: {
        implementation: 'emulated-bun-sqlite-outbox',
        productVersion: state.serverVersion ?? 'unknown',
        queuedTaskIds: Array.from(expectedTitles.keys()),
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
        await runElectricReconnectStormCase({
          clientCount,
        })
      );
    }

    const baseline = results[0];
    if (!baseline) {
      throw new Error('Electric reconnect storm produced no results');
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
        'Reconnect storm uses already-bootstrapped Electric live-shape clients at 25 / 100 / 250 / 500 clients reconnecting to the same changed row.',
        'Server resource metrics sample the Electric sync service and Postgres containers during each reconnect window.',
      ],
      metadata: {
        implementation: 'electric-live-shape-reconnect-storm-v2',
        clientCounts,
        productVersion: baseline.productVersion ?? 'unknown',
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
    const queueSizes = [20];
    const queueResults = [];

    for (const queueSize of queueSizes) {
      queueResults.push(
        await runElectricOfflineReplayCase({
          queueSize,
          titlePrefix: `electric-large-offline-${queueSize}`,
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
        'Large offline queue replay uses the benchmark-owned durable Bun SQLite outbox that replays writes through Electric after reconnect.',
        'The current default scale is 20 queued writes so the benchmark stays materially above the baseline replay case while staying comparable to the Syncular large-queue workload.',
      ],
      metadata: {
        implementation: 'emulated-bun-sqlite-outbox-large-queue',
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
    await ensureStackUp('electric');
    await seedStack('electric', {
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 100_000,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures('electric');
    const projectId = fixtures.sampleProjectId;
    const ownerId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
    if (!projectId || !ownerId) {
      throw new Error('Electric fixtures are missing project or owner data');
    }

    const meter = createHttpMeter();
    const state = await bootstrapShape({
      baseUrl: this.stack.syncBaseUrl,
      fetchImpl: meter.fetch,
    });
    const rows = Array.from(state.rows.values());
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
      const listResult = runElectricLocalListQuery({
        rows,
        projectId,
        ownerId,
      });
      const searchResult = runElectricLocalSearchQuery({
        rows,
        projectId,
      });
      const aggregateResult = runElectricLocalAggregateQuery({
        rows,
        projectId,
      });

      listSamples.push(listResult.elapsedMs);
      searchSamples.push(searchResult.elapsedMs);
      aggregateSamples.push(aggregateResult.elapsedMs);
      listResultCount = listResult.resultCount;
      searchResultCount = searchResult.resultCount;
      aggregateResultCount = aggregateResult.resultCount;
    }

    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      status: 'completed',
      metrics: {
        row_count: rows.length,
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
        'Local query benchmarks run against the fully materialized Electric in-memory shape state after bootstrap completes.',
        'The workload covers a filtered list query, an ID-prefix search query, and a grouped aggregation over the same local task corpus.',
      ],
      metadata: {
        implementation: 'local-electric-shape-query-workload',
        productVersion: state.serverVersion ?? 'unknown',
        rowCount: rows.length,
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
    await ensureStackUp('electric');
    await seedStack('electric', {
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 2,
      usersPerOrg: 4,
      tasksPerProject: 500,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures('electric');
    const actorId = fixtures.sampleUserIds[0];
    const revokedProjectId = fixtures.sampleProjectIds[0];
    const retainedProjectId = fixtures.sampleProjectIds[1];
    const appBaseUrl = this.stack.appBaseUrl;
    if (!actorId || !revokedProjectId || !retainedProjectId || !appBaseUrl) {
      throw new Error('Electric fixtures are missing actor or multi-project data');
    }

    const meter = createHttpMeter();
    const actorFetch = createElectricActorFetch({
      fetchImpl: meter.fetch,
      actorId,
    });
    const initialState = await bootstrapShape({
      baseUrl: appBaseUrl,
      path: '/benchmark/shape/tasks',
      fetchImpl: actorFetch,
    });

    const initialVisibleRows = initialState.rows.size;
    const meterBaseline = meter.snapshot();
    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();
    const startedAt = performance.now();

    await revokeElectricProjectMembership({
      actorId,
      projectId: revokedProjectId,
    });

    let finalState = initialState;
    let revokedProjectRows = countElectricRowsForProject(
      finalState.rows,
      revokedProjectId
    );
    let retainedProjectRows = countElectricRowsForProject(
      finalState.rows,
      retainedProjectId
    );
    const timeoutMs = 60_000;
    const loopStartedAt = Date.now();

    while (Date.now() - loopStartedAt < timeoutMs) {
      finalState = await bootstrapShape({
        baseUrl: appBaseUrl,
        path: '/benchmark/shape/tasks',
        fetchImpl: actorFetch,
      });
      revokedProjectRows = countElectricRowsForProject(
        finalState.rows,
        revokedProjectId
      );
      retainedProjectRows = countElectricRowsForProject(
        finalState.rows,
        retainedProjectId
      );

      if (revokedProjectRows === 0 && retainedProjectRows === 500) {
        break;
      }

      await Bun.sleep(25);
    }

    if (revokedProjectRows !== 0 || retainedProjectRows !== 500) {
      throw new Error(
        `Electric permission change did not converge: revoked=${revokedProjectRows}, retained=${retainedProjectRows}`
      );
    }

    const convergenceMs = performance.now() - startedAt;
    const meterSnapshot = diffMeterTotals(meter.snapshot(), meterBaseline);
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      status: 'completed',
      metrics: {
        initial_visible_rows: initialVisibleRows,
        post_revoke_visible_rows: finalState.rows.size,
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
        'Permission-change convergence uses a benchmark-owned auth-scoped Electric shape proxy that derives the shape WHERE clause from project_memberships for the current actor.',
        'After revocation, the benchmark re-bootstraps the actor-scoped shape and measures how quickly rows for the revoked project disappear while rows for still-authorized projects remain.',
      ],
      metadata: {
        implementation: 'electric-auth-scoped-shape-rebootstrap',
        actorId,
        revokedProjectId,
        retainedProjectId,
        productVersion: initialState.serverVersion ?? 'unknown',
      },
    };
  }

  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Blob flow benchmarking is not implemented for Electric in this harness yet.'],
    });
  }
}
