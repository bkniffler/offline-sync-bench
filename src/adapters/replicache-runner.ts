import { randomUUID } from 'node:crypto';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import {
  Replicache,
  type MutatorDefs,
  type ReadonlyJSONValue,
  type WriteTransaction,
} from 'replicache';
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
  waitForUrl,
  writeTask,
} from '../stack-manager';
import { getStack } from '../stacks';
import type {
  BenchmarkStatus,
  BootstrapScaleResult,
  JsonValue,
  OnlinePropagationSample,
} from '../types';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

interface UpdateTaskArgs {
  taskId: string;
  title?: string;
  completed?: boolean;
}

type TaskValue = Readonly<{
  id: string;
  orgId: string;
  projectId: string;
  ownerId: string;
  title: string;
  completed: boolean;
  serverVersion: number;
  updatedAt: string;
}> &
  Readonly<Record<string, ReadonlyJSONValue>>;

interface ReplicacheMutators extends MutatorDefs {
  updateTask: (
    tx: WriteTransaction,
    args?: UpdateTaskArgs
  ) => Promise<void>;
}

const stack = getStack('replicache');
const scenario = process.argv[2];

Object.assign(globalThis, {
  indexedDB,
  IDBKeyRange,
});

if (
  scenario !== 'bootstrap' &&
  scenario !== 'online-propagation' &&
  scenario !== 'offline-replay' &&
  scenario !== 'reconnect-storm' &&
  scenario !== 'large-offline-queue' &&
  scenario !== 'local-query' &&
  scenario !== 'permission-change'
) {
  throw new Error(
    'Expected scenario argument: bootstrap | online-propagation | offline-replay | reconnect-storm | large-offline-queue | local-query | permission-change'
  );
}

const result =
  scenario === 'bootstrap'
    ? await runBootstrap()
    : scenario === 'online-propagation'
      ? await runOnlinePropagation()
      : scenario === 'offline-replay'
        ? await runOfflineReplay()
        : scenario === 'reconnect-storm'
          ? await runReconnectStorm()
          : scenario === 'large-offline-queue'
          ? await runLargeOfflineQueue()
          : scenario === 'local-query'
            ? await runLocalQuery()
            : await runPermissionChange();

await writeResultAndExit(result);

function createReplicacheClient(
  name: string,
  actorId?: string
): Replicache<ReplicacheMutators> {
  return new Replicache<ReplicacheMutators>({
    name,
    pullURL: actorId
      ? `${stack.syncBaseUrl}/replicache/pull?actorId=${encodeURIComponent(actorId)}`
      : `${stack.syncBaseUrl}/replicache/pull`,
    pushURL: `${stack.syncBaseUrl}/replicache/push`,
    schemaVersion: 'offline-sync-bench-v1',
    pullInterval: null,
    pushDelay: 0,
    logLevel: 'error',
    mutators: {
      updateTask: async (tx: WriteTransaction, args?: UpdateTaskArgs) => {
        if (!args) {
          return;
        }

        const key = taskKey(args.taskId);
        const existing = await tx.get(key);
        if (!isTaskValue(existing)) {
          return;
        }

        await tx.set(key, {
          ...existing,
          title: args.title ?? existing.title,
          completed: args.completed ?? existing.completed,
          serverVersion: existing.serverVersion + 1,
          updatedAt: new Date().toISOString(),
        });
      },
    },
  });
}

function taskKey(taskId: string): string {
  return `task/${taskId}`;
}

function isTaskValue(value: ReadonlyJSONValue | undefined): value is TaskValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return (
    typeof Reflect.get(value, 'id') === 'string' &&
    typeof Reflect.get(value, 'orgId') === 'string' &&
    typeof Reflect.get(value, 'projectId') === 'string' &&
    typeof Reflect.get(value, 'ownerId') === 'string' &&
    typeof Reflect.get(value, 'title') === 'string' &&
    typeof Reflect.get(value, 'completed') === 'boolean' &&
    typeof Reflect.get(value, 'serverVersion') === 'number' &&
    typeof Reflect.get(value, 'updatedAt') === 'string'
  );
}

async function readAllTasks(rep: Replicache<ReplicacheMutators>): Promise<TaskValue[]> {
  const values = await rep.query((tx) => tx.scan({ prefix: 'task/' }).toArray());
  const tasks: TaskValue[] = [];

  for (const value of values) {
    if (isTaskValue(value)) {
      tasks.push(value);
    }
  }

  return tasks.sort((left, right) => left.id.localeCompare(right.id));
}

async function getTaskTitle(
  rep: Replicache<ReplicacheMutators>,
  taskId: string
): Promise<string | null> {
  const value = await rep.query((tx) => tx.get(taskKey(taskId)));
  return typeof value === 'object' && isTaskValue(value) ? value.title : null;
}

function countRowsForProject(rows: TaskValue[], projectId: string): number {
  return rows.filter((row) => row.projectId === projectId).length;
}

async function revokeReplicacheProjectMembership(args: {
  actorId: string;
  projectId: string;
}): Promise<void> {
  const response = await fetch(`${stack.adminBaseUrl}/admin/revoke-membership`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      actorId: args.actorId,
      projectId: args.projectId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Replicache membership revoke failed: ${response.status} ${response.statusText} ${body}`
    );
  }

  const body = (await response.json()) as { ok?: boolean; deletedCount?: number };
  if (!body.ok || body.deletedCount !== 1) {
    throw new Error(
      `Replicache membership revoke deleted ${body.deletedCount ?? 0} rows`
    );
  }
}

async function waitForTaskCount(args: {
  rep: Replicache<ReplicacheMutators>;
  expectedRows: number;
  timeoutMs?: number;
}): Promise<TaskValue[]> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await args.rep.pull();
    const rows = await readAllTasks(args.rep);
    if (rows.length === args.expectedRows) {
      return rows;
    }
    await Bun.sleep(50);
  }

  throw new Error(`Replicache did not reach ${args.expectedRows} rows before timeout`);
}

async function waitForTaskTitle(args: {
  rep: Replicache<ReplicacheMutators>;
  taskId: string;
  expectedTitle: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await args.rep.pull();
    if ((await getTaskTitle(args.rep, args.taskId)) === args.expectedTitle) {
      return;
    }
    await Bun.sleep(25);
  }

  throw new Error(
    `Replicache reader did not observe ${args.taskId}=${args.expectedTitle}`
  );
}

async function waitForAppDown(timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${stack.appBaseUrl}/health`);
      if (!response.ok) {
        return;
      }
    } catch {
      return;
    }
    await Bun.sleep(100);
  }

  throw new Error('Replicache app did not stop in time');
}

async function waitForReplayConvergence(args: {
  writer: Replicache<ReplicacheMutators>;
  reader: Replicache<ReplicacheMutators>;
  expectedTitles: Map<string, string>;
  timeoutMs?: number;
}): Promise<number> {
  const timeoutMs = args.timeoutMs ?? 60_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await args.writer.push();
    await args.writer.pull();
    await args.reader.pull();

    const pendingMutations = await args.writer.experimentalPendingMutations();
    let allVisible = true;
    for (const [taskId, title] of args.expectedTitles) {
      if ((await getTaskTitle(args.reader, taskId)) !== title) {
        allVisible = false;
        break;
      }
    }

    if (pendingMutations.length === 0 && allVisible) {
      return pendingMutations.length;
    }

    await Bun.sleep(50);
  }

  throw new Error('Replicache offline replay did not converge before timeout');
}

async function waitForStormConvergence(args: {
  clients: Array<{
    rep: Replicache<ReplicacheMutators>;
    taskId: string;
    expectedTitle: string;
  }>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await Promise.all(args.clients.map(async ({ rep }) => rep.pull()));

    const visibility = await Promise.all(
      args.clients.map(async ({ rep, taskId, expectedTitle }) => {
        return (await getTaskTitle(rep, taskId)) === expectedTitle;
      })
    );

    if (visibility.every(Boolean)) {
      return;
    }

    await Bun.sleep(50);
  }

  throw new Error('Replicache reconnect storm did not converge before timeout');
}

interface LocalQuerySample {
  elapsedMs: number;
  resultCount: number;
}

interface ReplicacheOfflineReplayCaseResult {
  queuedWriteCount: number;
  replayVisibleMs: number;
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  bytesTransferred: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
  pendingBeforeReconnect: number;
  pendingAfterReplay: number;
  expectedTitles: Map<string, string>;
}

interface ReplicacheReconnectStormCaseResult {
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

function diffMeterTotals(
  current: {
    requestCount: number;
    requestBytes: number;
    responseBytes: number;
  },
  baseline: {
    requestCount: number;
    requestBytes: number;
    responseBytes: number;
  }
): {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
} {
  return {
    requestCount: Math.max(0, current.requestCount - baseline.requestCount),
    requestBytes: Math.max(0, current.requestBytes - baseline.requestBytes),
    responseBytes: Math.max(0, current.responseBytes - baseline.responseBytes),
  };
}

function runReplicacheLocalListQuery(args: {
  rows: TaskValue[];
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

function runReplicacheLocalSearchQuery(args: {
  rows: TaskValue[];
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

function runReplicacheLocalAggregateQuery(args: {
  rows: TaskValue[];
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

async function runBootstrap(): Promise<RunnerResult> {
  await ensureStackUp('replicache');

  const scales = [1000, 10_000, 100_000];
  const scaleResults: BootstrapScaleResult[] = [];

  for (const rowsTarget of scales) {
    await seedStack('replicache', {
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: rowsTarget,
      membershipsPerProject: 2,
    });

    const baseFetch = globalThis.fetch;
    const meter = createHttpMeter(baseFetch);
    globalThis.fetch = meter.fetch;

    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();
    const startedAt = performance.now();
    const rep = createReplicacheClient(`replicache-bootstrap-${rowsTarget}-${randomUUID()}`);

    try {
      const rows = await waitForTaskCount({
        rep,
        expectedRows: rowsTarget,
      });
      const elapsedMs = performance.now() - startedAt;
      const meterSnapshot = meter.snapshot();
      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();

      scaleResults.push({
        rowsTarget,
        timeToFirstQueryMs: round(elapsedMs),
        rowsLoaded: rows.length,
        requestCount: meterSnapshot.requestCount,
        requestBytes: meterSnapshot.requestBytes,
        responseBytes: meterSnapshot.responseBytes,
        bytesTransferred: meterSnapshot.requestBytes + meterSnapshot.responseBytes,
        avgMemoryMb: memoryMetrics.avgMemoryMb,
        peakMemoryMb: memoryMetrics.peakMemoryMb,
        avgCpuPct: cpuMetrics.avgCpuPct,
        peakCpuPct: cpuMetrics.peakCpuPct,
      });
    } finally {
      globalThis.fetch = baseFetch;
      cpuSampler.stop();
      memorySampler.stop();
      await rep.close();
    }
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
      'Replicache bootstrap uses the real client runtime under Bun with fake-indexeddb and a benchmark-owned BYOB push/pull server.',
      'Pull responses currently use full-dataset patches whenever the derived dataset cookie changes.',
    ],
    metadata: {
      implementation: 'replicache-client-fake-indexeddb',
      productVersion: '15.3.0',
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

async function runOnlinePropagation(): Promise<RunnerResult> {
  await ensureStackUp('replicache');
  await seedStack('replicache', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('replicache');
  if (!fixtures.sampleTaskId) {
    throw new Error('Replicache fixtures did not return a sample task');
  }

  const baseFetch = globalThis.fetch;
  const meter = createHttpMeter(baseFetch);
  globalThis.fetch = meter.fetch;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  const writer = createReplicacheClient(`replicache-writer-${randomUUID()}`);
  const reader = createReplicacheClient(`replicache-reader-${randomUUID()}`);

  try {
    await waitForTaskCount({ rep: writer, expectedRows: 200 });
    await waitForTaskCount({ rep: reader, expectedRows: 200 });

    const iterations = 15;
    const samples: OnlinePropagationSample[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const expectedTitle = `replicache-online-${iteration}-${Date.now()}`;
      const startedAt = performance.now();
      await writer.mutate.updateTask({
        taskId: fixtures.sampleTaskId,
        title: expectedTitle,
      });
      const writeAckMs = performance.now() - startedAt;

      await writer.push();
      await writer.pull();
      await waitForTaskTitle({
        rep: reader,
        taskId: fixtures.sampleTaskId,
        expectedTitle,
      });

      samples.push({
        iteration,
        writeAckMs: round(writeAckMs),
        mirrorVisibleMs: round(performance.now() - startedAt),
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
        'Replicache write_ack_ms measures optimistic local mutator completion; canonical propagation starts with the subsequent manual push.',
        'Mirror visibility is measured after the writer push completes and the reader has pulled the updated patch.',
      ],
      metadata: {
        implementation: 'replicache-client-fake-indexeddb',
        productVersion: '15.3.0',
        samples: samples.map((sample) => ({
          iteration: sample.iteration,
          writeAckMs: sample.writeAckMs,
          mirrorVisibleMs: sample.mirrorVisibleMs,
        })),
      },
    };
  } finally {
    globalThis.fetch = baseFetch;
    memorySampler.stop();
    cpuSampler.stop();
    await writer.close();
    await reader.close();
  }
}

async function runOfflineReplay(): Promise<RunnerResult> {
  await ensureStackUp('replicache');
  const result = await runOfflineReplayCase({
    queueSize: 10,
    titlePrefix: 'replicache-offline',
  });

  return {
    status: 'completed',
    metrics: {
      queued_mutations: result.pendingBeforeReconnect,
      replay_visible_ms: round(result.replayVisibleMs),
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
      'Offline replay uses Replicache pending mutations persisted in IndexedDB-compatible storage and a manual push after the backend comes back.',
      'Convergence completes when pending mutations are gone and a second client has pulled every expected title.',
    ],
    metadata: {
      implementation: 'replicache-client-fake-indexeddb',
      productVersion: '15.3.0',
      pendingBeforeReconnect: result.pendingBeforeReconnect,
      pendingAfterReplay: result.pendingAfterReplay,
      expectedTitles: Object.fromEntries(result.expectedTitles),
    },
  };
}

async function runReconnectStorm(): Promise<RunnerResult> {
  const clientCounts = [25, 100, 250, 500];
  const results: ReplicacheReconnectStormCaseResult[] = [];

  for (const clientCount of clientCounts) {
    results.push(await runReconnectStormCase({ clientCount }));
  }

  const baseline = results[0];
  if (!baseline) {
    throw new Error('Replicache reconnect storm produced no results');
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
      'Reconnect storm keeps native Replicache clients bootstrapped at 25 / 100 / 250 / 500 clients, restarts the sync app, applies one external write, and measures convergence once every client has pulled the updated title.',
      'Request counts and transfer volume are aggregated across all clients after each restart.',
    ],
    metadata: {
      implementation: 'replicache-client-reconnect-storm-v2',
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
      productVersion: '15.3.0',
      clientCount: baseline.clientCount,
    },
  };
}

async function runLargeOfflineQueue(): Promise<RunnerResult> {
  const queueSizes = [100, 500, 1000];
  const queueResults: ReplicacheOfflineReplayCaseResult[] = [];

  for (const queueSize of queueSizes) {
    queueResults.push(
      await runOfflineReplayCase({
        queueSize,
        titlePrefix: `replicache-large-offline-${queueSize}`,
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
          [`queue_${queueSize}_convergence_ms`, round(result.replayVisibleMs)],
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
      'Large offline queue replay uses the native Replicache pending mutation queue persisted in fake-indexeddb under Bun.',
      'The benchmark measures 100 / 500 / 1000 queued writes so scaling behavior is visible instead of a single queue-size point.',
    ],
    metadata: {
      implementation: 'replicache-client-fake-indexeddb-large-queue',
      productVersion: '15.3.0',
      scales: queueResults.map((result, index) => ({
        queueSize: queueSizes[index],
        queuedWriteCount: result.queuedWriteCount,
        replayVisibleMs: round(result.replayVisibleMs),
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

async function runLocalQuery(): Promise<RunnerResult> {
  await ensureStackUp('replicache');
  await seedStack('replicache', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 100_000,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('replicache');
  const projectId = fixtures.sampleProjectId;
  const ownerId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
  if (!projectId || !ownerId) {
    throw new Error('Replicache fixtures are missing project or owner data');
  }

  const rep = createReplicacheClient(`replicache-local-query-${randomUUID()}`);
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    const rows = await waitForTaskCount({ rep, expectedRows: 100_000, timeoutMs: 120_000 });
    const iterations = 25;
    const listSamples: number[] = [];
    const searchSamples: number[] = [];
    const aggregateSamples: number[] = [];
    let listResultCount = 0;
    let searchResultCount = 0;
    let aggregateResultCount = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const listResult = runReplicacheLocalListQuery({
        rows,
        projectId,
        ownerId,
      });
      const searchResult = runReplicacheLocalSearchQuery({
        rows,
        projectId,
      });
      const aggregateResult = runReplicacheLocalAggregateQuery({
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
        'Local query benchmarks run against the native Replicache local store after bootstrap completes.',
        'The workload covers a filtered list query, an ID-prefix search query, and a grouped aggregation over the same task corpus.',
      ],
      metadata: {
        implementation: 'replicache-client-local-query',
        productVersion: '15.3.0',
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await rep.close();
  }
}

async function runPermissionChange(): Promise<RunnerResult> {
  await ensureStackUp('replicache');
  await seedStack('replicache', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 2,
    usersPerOrg: 4,
    tasksPerProject: 500,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('replicache');
  const actorId = fixtures.sampleUserIds[0];
  const revokedProjectId = fixtures.sampleProjectIds[0];
  const retainedProjectId = fixtures.sampleProjectIds[1];
  if (!actorId || !revokedProjectId || !retainedProjectId) {
    throw new Error('Replicache fixtures are missing actor or multi-project data');
  }

  const baseFetch = globalThis.fetch;
  const meter = createHttpMeter(baseFetch);
  globalThis.fetch = meter.fetch;
  const initialRep = createReplicacheClient(
    `replicache-permission-change-${randomUUID()}`,
    actorId
  );
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    const initialRows = await waitForTaskCount({
      rep: initialRep,
      expectedRows: 1000,
      timeoutMs: 120_000,
    });
    const initialVisibleRows = initialRows.length;
    const meterBaseline = meter.snapshot();

    await revokeReplicacheProjectMembership({
      actorId,
      projectId: revokedProjectId,
    });

    const startedAt = performance.now();
    const rebootstrapRep = createReplicacheClient(
      `replicache-permission-change-rebootstrap-${randomUUID()}`,
      actorId
    );
    const finalRows = await waitForTaskCount({
      rep: rebootstrapRep,
      expectedRows: 500,
      timeoutMs: 120_000,
    });
    const revokedProjectRows = countRowsForProject(finalRows, revokedProjectId);
    const retainedProjectRows = countRowsForProject(finalRows, retainedProjectId);

    await rebootstrapRep.close();

    if (revokedProjectRows !== 0 || retainedProjectRows !== 500) {
      throw new Error(
        `Replicache permission change did not converge: revoked=${revokedProjectRows}, retained=${retainedProjectRows}`
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
        post_revoke_visible_rows: finalRows.length,
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
        'Permission-change convergence uses an actor-scoped Replicache pull path derived from project_memberships in the benchmark-owned BYOB server.',
        'After revocation, the benchmark re-bootstraps the actor-scoped client view and measures how quickly rows for the revoked project disappear while rows for the still-authorized project remain.',
      ],
      metadata: {
        implementation: 'replicache-auth-scoped-rebootstrap',
        productVersion: '15.3.0',
        actorId,
        revokedProjectId,
        retainedProjectId,
      },
    };
  } finally {
    globalThis.fetch = baseFetch;
    memorySampler.stop();
    cpuSampler.stop();
    await initialRep.close();
  }
}

async function runOfflineReplayCase(args: {
  queueSize: number;
  titlePrefix: string;
}): Promise<ReplicacheOfflineReplayCaseResult> {
  await ensureStackUp('replicache');
  await seedStack('replicache', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: Math.max(200, args.queueSize + 25),
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('replicache');
  const projectId = fixtures.sampleProjectId;
  if (!projectId) {
    throw new Error('Replicache fixtures are missing project data');
  }

  const candidateTasks = await listTasks('replicache', {
    projectId,
    limit: args.queueSize + 10,
  });
  if (candidateTasks.length < args.queueSize) {
    throw new Error(
      `Need at least ${args.queueSize} tasks for Replicache offline replay`
    );
  }

  const baseFetch = globalThis.fetch;
  const replayTimeoutMs = Math.max(120_000, args.queueSize * 500);
  const meter = createHttpMeter(baseFetch);
  globalThis.fetch = meter.fetch;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  const writer = createReplicacheClient(
    `replicache-offline-writer-${args.queueSize}-${randomUUID()}`
  );
  const reader = createReplicacheClient(
    `replicache-offline-reader-${args.queueSize}-${randomUUID()}`
  );

  try {
    const expectedRows = Math.max(200, args.queueSize + 25);
    await waitForTaskCount({ rep: writer, expectedRows, timeoutMs: 120_000 });
    await waitForTaskCount({ rep: reader, expectedRows, timeoutMs: 120_000 });

    const offlineTargets = candidateTasks.slice(0, args.queueSize);
    const expectedTitles = new Map<string, string>();
    for (let index = 0; index < offlineTargets.length; index += 1) {
      const task = offlineTargets[index];
      if (!task) continue;
      expectedTitles.set(task.id, `${args.titlePrefix}-${index}-${Date.now()}`);
    }

    stopService('replicache', 'app');
    await waitForAppDown();

    for (const [taskId, title] of expectedTitles) {
      await writer.mutate.updateTask({ taskId, title });
    }

    const pendingBeforeReconnect = (
      await writer.experimentalPendingMutations()
    ).length;

    const startedAt = performance.now();
    startService('replicache', 'app');
    await waitForUrl(`${stack.appBaseUrl}/health`);
    const pendingAfterReplay = await waitForReplayConvergence({
      writer,
      reader,
      expectedTitles,
      timeoutMs: replayTimeoutMs,
    });
    const replayVisibleMs = performance.now() - startedAt;
    const meterSnapshot = meter.snapshot();
    const bytesTransferred = meterSnapshot.requestBytes + meterSnapshot.responseBytes;
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      queuedWriteCount: pendingBeforeReconnect,
      replayVisibleMs: round(replayVisibleMs),
      requestCount: meterSnapshot.requestCount,
      requestBytes: meterSnapshot.requestBytes,
      responseBytes: meterSnapshot.responseBytes,
      bytesTransferred,
      avgMemoryMb: memoryMetrics.avgMemoryMb,
      peakMemoryMb: memoryMetrics.peakMemoryMb,
      avgCpuPct: cpuMetrics.avgCpuPct,
      peakCpuPct: cpuMetrics.peakCpuPct,
      pendingBeforeReconnect,
      pendingAfterReplay,
      expectedTitles,
    };
  } finally {
    globalThis.fetch = baseFetch;
    memorySampler.stop();
    cpuSampler.stop();
    try {
      startService('replicache', 'app');
    } catch {
      // The app may already be running if the scenario completed normally.
    }
    await writer.close();
    await reader.close();
  }
}

async function runReconnectStormCase(args: {
  clientCount: number;
}): Promise<ReplicacheReconnectStormCaseResult> {
  await ensureStackUp('replicache');
  await seedStack('replicache', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('replicache');
  const taskId = fixtures.sampleTaskId;
  if (!taskId) {
    throw new Error('Replicache fixtures are missing task data');
  }

  const baseFetch = globalThis.fetch;
  const meter = createHttpMeter(baseFetch);
  globalThis.fetch = meter.fetch;

  const clients = await Promise.all(
    Array.from({ length: args.clientCount }, async (_, index) => {
      const rep = createReplicacheClient(`replicache-storm-${index}-${randomUUID()}`);
      await waitForTaskCount({ rep, expectedRows: 200, timeoutMs: 120_000 });
      return { rep };
    })
  );

  try {
    const baseline = meter.snapshot();
    const syncContainerId = resolveServiceContainerId('replicache', 'sync');
    const postgresContainerId = resolveServiceContainerId('replicache', 'postgres');

    stopService('replicache', 'sync');
    await waitForAppDown();
    startService('replicache', 'sync');
    await waitForUrl(`${stack.appBaseUrl}/health`);

    const sampler = new DockerServiceSampler([
      { label: 'sync', id: syncContainerId },
      { label: 'postgres', id: postgresContainerId },
    ]);
    sampler.start();

    const expectedTitle = `replicache-storm-${Date.now()}`;
    const startedAt = performance.now();
    await writeTask('replicache', {
      taskId,
      title: expectedTitle,
    });

    await waitForStormConvergence({
      clients: clients.map((client) => ({
        rep: client.rep,
        taskId,
        expectedTitle,
      })),
      timeoutMs: 120_000,
    });

    const convergenceMs = performance.now() - startedAt;
    const containerMetrics = sampler.stop();
    const totalMeter = diffMeterTotals(meter.snapshot(), baseline);

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
    globalThis.fetch = baseFetch;
    try {
      startService('replicache', 'sync');
    } catch {
      // The service may already be running after normal completion.
    }
    await Promise.all(clients.map(async (client) => client.rep.close()));
  }
}

async function writeResultAndExit(result: RunnerResult): Promise<never> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  process.exit(0);
}
