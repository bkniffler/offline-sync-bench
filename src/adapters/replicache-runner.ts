import { randomUUID } from 'node:crypto';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import {
  Replicache,
  type MutatorDefs,
  type ReadonlyJSONValue,
  type WriteTransaction,
} from 'replicache';
import { createHttpMeter } from '../http-meter';
import { average, CpuSampler, MemorySampler, percentile, round } from '../metrics';
import {
  ensureStackUp,
  getFixtures,
  listTasks,
  seedStack,
  startService,
  stopService,
  waitForUrl,
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
  scenario !== 'offline-replay'
) {
  throw new Error('Expected scenario argument: bootstrap | online-propagation | offline-replay');
}

const result =
  scenario === 'bootstrap'
    ? await runBootstrap()
    : scenario === 'online-propagation'
      ? await runOnlinePropagation()
      : await runOfflineReplay();

await writeResultAndExit(result);

function createReplicacheClient(name: string): Replicache<ReplicacheMutators> {
  return new Replicache<ReplicacheMutators>({
    name,
    pullURL: `${stack.syncBaseUrl}/replicache/pull`,
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
  await seedStack('replicache', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('replicache');
  const projectId = fixtures.sampleProjectId;
  if (!projectId) {
    throw new Error('Replicache fixtures are missing project data');
  }

  const candidateTasks = await listTasks('replicache', { projectId, limit: 20 });
  if (candidateTasks.length < 10) {
    throw new Error('Need at least 10 tasks for Replicache offline replay');
  }

  const baseFetch = globalThis.fetch;
  const meter = createHttpMeter(baseFetch);
  globalThis.fetch = meter.fetch;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  const writer = createReplicacheClient(`replicache-offline-writer-${randomUUID()}`);
  const reader = createReplicacheClient(`replicache-offline-reader-${randomUUID()}`);

  try {
    await waitForTaskCount({ rep: writer, expectedRows: 200 });
    await waitForTaskCount({ rep: reader, expectedRows: 200 });

    const offlineTargets = candidateTasks.slice(0, 10);
    const expectedTitles = new Map<string, string>();
    for (let index = 0; index < offlineTargets.length; index += 1) {
      const task = offlineTargets[index];
      if (!task) continue;
      expectedTitles.set(task.id, `replicache-offline-${index}-${Date.now()}`);
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
    });
    const replayDurationMs = performance.now() - startedAt;
    const meterSnapshot = meter.snapshot();
    const bytes = meterSnapshot.requestBytes + meterSnapshot.responseBytes;
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      status: 'completed',
      metrics: {
        queued_mutations: pendingBeforeReconnect,
        replay_visible_ms: round(replayDurationMs),
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
        'Offline replay uses Replicache pending mutations persisted in IndexedDB-compatible storage and a manual push after the backend comes back.',
        'Convergence completes when pending mutations are gone and a second client has pulled every expected title.',
      ],
      metadata: {
        implementation: 'replicache-client-fake-indexeddb',
        productVersion: '15.3.0',
        pendingBeforeReconnect,
        pendingAfterReplay,
        expectedTitles: Object.fromEntries(expectedTitles),
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
