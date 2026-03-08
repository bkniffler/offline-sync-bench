import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PowerSyncDatabase,
  Schema,
  Table,
  column,
  type AbstractPowerSyncDatabase,
  type PowerSyncBackendConnector,
} from '@powersync/node';
import { createHttpMeter } from '../http-meter.ts';
import { average, CpuSampler, MemorySampler, percentile, round } from '../metrics.ts';
import { benchmarkRoot, tempRoot } from '../paths.ts';
import { getStack } from '../stacks.ts';
import type {
  BenchmarkStatus,
  BootstrapScaleResult,
  JsonValue,
  OnlinePropagationSample,
  TaskRecord,
} from '../types.ts';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

interface StackFixtures {
  sampleProjectId: string | null;
  sampleTaskId: string | null;
}

interface UploadBatchRequest {
  batch: Array<{
    op: 'PUT' | 'PATCH' | 'DELETE';
    table: string;
    id: string;
    data?: Record<string, string | number | boolean | null>;
  }>;
}

interface PowerSyncSession {
  db: PowerSyncDatabase;
  destroy: () => Promise<void>;
}

const stack = getStack('powersync');
const scenario = process.argv[2];

const AppSchema = new Schema({
  tasks: new Table(
    {
      org_id: column.text,
      project_id: column.text,
      owner_id: column.text,
      title: column.text,
      completed: column.integer,
      server_version: column.integer,
      updated_at: column.text,
    },
    {
      indexes: {
        project: ['project_id'],
      },
    }
  ),
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

function createConnector(userId: string): PowerSyncBackendConnector {
  return {
    async fetchCredentials() {
      const response = await fetch(
        `${stack.appBaseUrl}/api/auth/token?user_id=${encodeURIComponent(userId)}`
      );
      if (!response.ok) {
        throw new Error(
          `PowerSync token endpoint failed: ${response.status} ${response.statusText}`
        );
      }

      const body = (await response.json()) as { token: string };
      return {
        endpoint: stack.syncBaseUrl,
        token: body.token,
      };
    },

    async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
      const transaction = await database.getNextCrudTransaction();
      if (!transaction) {
        return;
      }

      const payload: UploadBatchRequest = {
        batch: transaction.crud.map((operation) => ({
          op: operation.op,
          table: operation.table,
          id: operation.id,
          data: operation.opData,
        })),
      };

      const response = await fetch(`${stack.appBaseUrl}/api/data`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(
          `PowerSync upload failed: ${response.status} ${response.statusText}`
        );
      }

      await transaction.complete();
    },
  };
}

async function runBootstrap(): Promise<RunnerResult> {
  await ensureStackUp();

  const scales = [1000, 10_000, 100_000];
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

    const baseFetch = globalThis.fetch;
    const meter = createHttpMeter(baseFetch);
    globalThis.fetch = meter.fetch;

    const sampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    sampler.start();
    cpuSampler.start();
    const startedAt = performance.now();
    const session = await createSession(`powersync-bootstrap-${rowsTarget}`);

    try {
      await session.db.waitForFirstSync();
      const rowsLoaded = await waitForRowCount(session.db, rowsTarget, 120_000);

      const elapsedMs = performance.now() - startedAt;
      const meterSnapshot = meter.snapshot();
      const memoryMetrics = sampler.stop();
      const cpuMetrics = cpuSampler.stop();
      scaleResults.push({
        rowsTarget,
        timeToFirstQueryMs: round(elapsedMs),
        rowsLoaded,
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
      sampler.stop();
      await session.destroy();
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
      'PowerSync bootstrap uses the real Node SDK against a self-hosted PowerSync service with Postgres-backed bucket storage.',
      'HTTP byte counts capture credential and HTTP traffic only and do not meter websocket frame payloads.',
    ],
    metadata: {
      implementation: 'powersync-node-sdk',
      productVersion: '0.18.0',
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
  await ensureStackUp();
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
    throw new Error('PowerSync fixtures did not return a sample task');
  }

  const baseFetch = globalThis.fetch;
  const meter = createHttpMeter(baseFetch);
  globalThis.fetch = meter.fetch;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  const writer = await createSession('powersync-writer');
  const reader = await createSession('powersync-reader');

  try {
    await writer.db.waitForFirstSync();
    await reader.db.waitForFirstSync();
    await waitForRowCount(writer.db, 200);
    await waitForRowCount(reader.db, 200);

    const iterations = 15;
    const samples: OnlinePropagationSample[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const expectedTitle = `powersync-online-${iteration}-${Date.now()}`;
      const startedAt = performance.now();

      await writer.db.execute('update tasks set title = ? where id = ?', [
        expectedTitle,
        fixtures.sampleTaskId,
      ]);
      const writeAckMs = performance.now() - startedAt;

      await waitForTaskTitle({
        db: reader.db,
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
        'Writes are measured through the real PowerSync Node SDK local SQLite write path.',
        'Mirror visibility is measured on a second PowerSync client waiting for the synced title to appear in its local SQLite database.',
      ],
      metadata: {
        implementation: 'powersync-node-sdk',
        productVersion: '0.18.0',
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
    await writer.destroy();
    await reader.destroy();
  }
}

async function runOfflineReplay(): Promise<RunnerResult> {
  await ensureStackUp();
  await seedStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures();
  const projectId = fixtures.sampleProjectId;
  if (!projectId) {
    throw new Error('PowerSync fixtures are missing project data');
  }

  const candidateTasks = await listTasks({ projectId, limit: 20 });
  if (candidateTasks.length < 10) {
    throw new Error('Need at least 10 tasks for PowerSync offline replay');
  }

  const baseFetch = globalThis.fetch;
  const meter = createHttpMeter(baseFetch);
  globalThis.fetch = meter.fetch;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  const writer = await createSession('powersync-offline-writer');
  const reader = await createSession('powersync-offline-reader');

  try {
    await writer.db.waitForFirstSync();
    await reader.db.waitForFirstSync();
    await waitForRowCount(writer.db, 200);
    await waitForRowCount(reader.db, 200);

    const offlineTargets = candidateTasks.slice(0, 10);
    const expectedTitles = new Map<string, string>();
    for (let index = 0; index < offlineTargets.length; index += 1) {
      const task = offlineTargets[index];
      if (!task) continue;
      expectedTitles.set(task.id, `powersync-offline-${index}-${Date.now()}`);
    }

    stopService('app');
    await waitForServiceStop();

    for (const [taskId, title] of expectedTitles) {
      await writer.db.execute('update tasks set title = ? where id = ?', [title, taskId]);
    }

    await waitForUploadQueueCount(writer.db, expectedTitles.size);
    const queuedStats = await writer.db.getUploadQueueStats(true);

    const startedAt = performance.now();
    startService('app');
    await waitForUrl(`${stack.appBaseUrl}/health`);

    await waitForUploadQueueCount(writer.db, 0);
    await waitForTaskTitles({
      db: reader.db,
      expectedTitles,
      timeoutMs: 60_000,
    });

    const convergenceMs = performance.now() - startedAt;
    const meterSnapshot = meter.snapshot();
    const bytes = meterSnapshot.requestBytes + meterSnapshot.responseBytes;
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      status: 'completed',
      metrics: {
        queued_write_count: queuedStats.count,
        reconnect_convergence_ms: round(convergenceMs),
        conflict_count: 0,
        replayed_write_success_rate:
          queuedStats.count === 0
            ? 0
            : round(expectedTitles.size / queuedStats.count, 4),
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
        'Offline replay uses the native PowerSync upload queue by taking the app backend offline while keeping the local SQLite client active.',
        'Convergence completes when the writer queue drains and a second PowerSync client observes all replayed titles.',
      ],
      metadata: {
        implementation: 'powersync-native-upload-queue',
        productVersion: '0.18.0',
        queuedTaskIds: Array.from(expectedTitles.keys()),
      },
    };
  } finally {
    globalThis.fetch = baseFetch;
    memorySampler.stop();
    cpuSampler.stop();
    try {
      startService('app');
    } catch {
      // The app may already be running if the scenario completed normally.
    }
    await writer.destroy();
    await reader.destroy();
  }
}

async function createSession(label: string): Promise<PowerSyncSession> {
  const dbPath = await createTempDbPath(label);
  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: dbPath,
    },
  });

  await db.init();
  await db.connect(createConnector(label));

  return {
    db,
    destroy: async () => {
      try {
        await db.disconnect();
      } catch {
        // Ignore disconnect failures during cleanup.
      }
      await db.close();
      await rm(dbPath.replace(/\/[^/]+$/, ''), {
        recursive: true,
        force: true,
      });
    },
  };
}

async function createTempDbPath(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `${prefix}-`));
  return join(dir, 'powersync.sqlite');
}

async function countRows(db: PowerSyncDatabase): Promise<number> {
  const row = await db.get<{ count: number | string }>(
    'select count(*) as count from tasks'
  );
  return Number(row.count);
}

async function waitForRowCount(
  db: PowerSyncDatabase,
  expectedRows: number,
  timeoutMs = 60_000
): Promise<number> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const rowsLoaded = await countRows(db);
    if (rowsLoaded === expectedRows) {
      return rowsLoaded;
    }
    await sleep(50);
  }

  const actualRows = await countRows(db);
  throw new Error(
    `PowerSync expected ${expectedRows} rows in local SQLite, got ${actualRows}`
  );
}

async function getTaskTitle(
  db: PowerSyncDatabase,
  taskId: string
): Promise<string | null> {
  const row = await db.getOptional<{ title: string }>(
    'select title from tasks where id = ?',
    [taskId]
  );
  return row?.title ?? null;
}

async function waitForTaskTitle(args: {
  db: PowerSyncDatabase;
  taskId: string;
  expectedTitle: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if ((await getTaskTitle(args.db, args.taskId)) === args.expectedTitle) {
      return;
    }
    await sleep(25);
  }

  throw new Error(
    `PowerSync reader did not observe ${args.taskId}=${args.expectedTitle}`
  );
}

async function waitForTaskTitles(args: {
  db: PowerSyncDatabase;
  expectedTitles: Map<string, string>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let allVisible = true;
    for (const [taskId, expectedTitle] of args.expectedTitles) {
      if ((await getTaskTitle(args.db, taskId)) !== expectedTitle) {
        allVisible = false;
        break;
      }
    }

    if (allVisible) {
      return;
    }

    await sleep(50);
  }

  throw new Error('PowerSync reader did not observe all replayed titles');
}

async function waitForUploadQueueCount(
  db: PowerSyncDatabase,
  expectedCount: number,
  timeoutMs = 30_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const stats = await db.getUploadQueueStats(true);
    if (stats.count === expectedCount) {
      return;
    }
    await sleep(50);
  }

  throw new Error(`PowerSync upload queue did not reach count ${expectedCount}`);
}

function runDockerCompose(args: string[]): void {
  const result = spawnSync('docker', ['compose', '-f', stack.composeFile, ...args], {
    cwd: benchmarkRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`
    );
  }
}

async function ensureStackUp(): Promise<void> {
  runDockerCompose(['up', '--build', '-d']);
  await waitForUrl(`${stack.adminBaseUrl}/health`);
  await waitForUrl(`${stack.appBaseUrl}/health`);
  await waitForUrl(`${stack.syncBaseUrl}/probes/liveness`);
}

function stopService(service: 'app' | 'sync'): void {
  const serviceName = stack.services[service];
  if (!serviceName) {
    throw new Error(`PowerSync stack is missing service ${service}`);
  }
  runDockerCompose(['stop', serviceName]);
}

function startService(service: 'app' | 'sync'): void {
  const serviceName = stack.services[service];
  if (!serviceName) {
    throw new Error(`PowerSync stack is missing service ${service}`);
  }
  runDockerCompose(['start', serviceName]);
}

function restartService(service: 'app' | 'sync'): void {
  const serviceName = stack.services[service];
  if (!serviceName) {
    throw new Error(`PowerSync stack is missing service ${service}`);
  }
  runDockerCompose(['restart', serviceName]);
}

async function rebuildStack(): Promise<void> {
  runDockerCompose(['down', '-v', '--remove-orphans']);
  runDockerCompose(['up', '--build', '-d']);
  await waitForUrl(`${stack.adminBaseUrl}/health`);
  await waitForUrl(`${stack.appBaseUrl}/health`);
  await waitForUrl(`${stack.syncBaseUrl}/probes/liveness`);
}

async function waitForServiceStop(timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(`${stack.appBaseUrl}/health`);
    } catch {
      return;
    }
    await sleep(100);
  }
}

async function seedStack(options: {
  resetFirst: boolean;
  orgCount: number;
  projectsPerOrg: number;
  usersPerOrg: number;
  tasksPerProject: number;
  membershipsPerProject: number;
}): Promise<void> {
  if (options.resetFirst) {
    await rebuildStack();
  }

  const response = await fetch(`${stack.adminBaseUrl}/admin/seed`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    throw new Error(`PowerSync seed failed: ${response.status} ${response.statusText}`);
  }
}

async function getFixtures(): Promise<StackFixtures> {
  const response = await fetch(`${stack.adminBaseUrl}/admin/fixtures`);
  if (!response.ok) {
    throw new Error(
      `PowerSync fixtures failed: ${response.status} ${response.statusText}`
    );
  }
  return (await response.json()) as StackFixtures;
}

async function listTasks(args: {
  projectId: string;
  limit: number;
}): Promise<TaskRecord[]> {
  const url = new URL('/admin/tasks', stack.adminBaseUrl);
  url.searchParams.set('projectId', args.projectId);
  url.searchParams.set('limit', String(args.limit));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`PowerSync listTasks failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { tasks: TaskRecord[] };
  return body.tasks;
}

async function waitForUrl(url: string, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = 'unreachable';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
