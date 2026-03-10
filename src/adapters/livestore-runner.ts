import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeAdapter } from '@livestore/adapter-node';
import {
  createStorePromise,
  makeSchema,
  materializers,
  Schema,
  State,
  synced,
  type Store,
} from '@livestore/livestore';
import { makeSyncBackend } from '@livestore/sync-electric';
import { createHttpMeter } from '../http-meter';
import { average, CpuSampler, MemorySampler, percentile, round } from '../metrics';
import { tempRoot } from '../paths';
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

interface LiveStoreSession {
  store: Store<typeof schema>;
  storageDirectory: string;
  destroy: (options?: { preserveStorage?: boolean }) => Promise<void>;
}

const stack = getStack('livestore');
const scenario = process.argv[2];

const tasks = State.SQLite.table({
  name: 'tasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    org_id: State.SQLite.text({ nullable: false }),
    project_id: State.SQLite.text({ nullable: false }),
    owner_id: State.SQLite.text({ nullable: false }),
    title: State.SQLite.text({ default: '', nullable: false }),
    completed: State.SQLite.boolean({ default: false, nullable: false }),
    server_version: State.SQLite.integer({ default: 0, nullable: false }),
    updated_at: State.SQLite.text({ nullable: false }),
  },
});

const events = {
  taskUpserted: synced({
    name: 'taskUpserted',
    schema: Schema.Struct({
      id: Schema.String,
      org_id: Schema.String,
      project_id: Schema.String,
      owner_id: Schema.String,
      title: Schema.String,
      completed: Schema.Boolean,
      server_version: Schema.Number,
      updated_at: Schema.String,
    }),
  }),
};

const state = State.SQLite.makeState({
  tables: { tasks },
  materializers: materializers(events, {
    taskUpserted: (task) => ({
      sql: `
        INSERT INTO 'tasks' (
          id,
          org_id,
          project_id,
          owner_id,
          title,
          completed,
          server_version,
          updated_at
        )
        VALUES (
          $id,
          $org_id,
          $project_id,
          $owner_id,
          $title,
          $completed,
          $server_version,
          $updated_at
        )
        ON CONFLICT (id) DO UPDATE SET
          org_id = $org_id,
          project_id = $project_id,
          owner_id = $owner_id,
          title = $title,
          completed = $completed,
          server_version = $server_version,
          updated_at = $updated_at
      `,
      bindValues: {
        id: task.id,
        org_id: task.org_id,
        project_id: task.project_id,
        owner_id: task.owner_id,
        title: task.title,
        completed: task.completed ? 1 : 0,
        server_version: task.server_version,
        updated_at: task.updated_at,
      },
      writeTables: new Set(['tasks']),
    }),
  }),
});

const schema = makeSchema({
  state,
  events,
});

if (
  scenario !== 'bootstrap' &&
  scenario !== 'online-propagation' &&
  scenario !== 'offline-replay'
) {
  throw new Error(
    'Expected scenario argument: bootstrap | online-propagation | offline-replay'
  );
}

const result =
  scenario === 'bootstrap'
    ? await runBootstrap()
    : scenario === 'online-propagation'
      ? await runOnlinePropagation()
      : await runOfflineReplay();

await writeResultAndExit(result);

async function createStorageDirectory(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(join(tempRoot, `${prefix}-`));
}

async function createSession(args: {
  prefix: string;
  baseDirectory?: string;
}): Promise<LiveStoreSession> {
  const baseDirectory =
    args.baseDirectory ?? (await createStorageDirectory(args.prefix));
  const adapter = makeAdapter({
    storage: {
      type: 'fs',
      baseDirectory,
    },
    clientId: `${args.prefix}-${randomUUID()}`,
    sessionId: randomUUID(),
    sync: {
      backend: makeSyncBackend({
        endpoint: `${stack.appBaseUrl}/livestore/events`,
      }),
    },
  });

  const store = await createStorePromise({
    schema,
    adapter,
    storeId: 'benchmark',
    disableDevtools: true,
  });

  return {
    store,
    storageDirectory: baseDirectory,
    destroy: async (options) => {
      await store.shutdown();
      if (!options?.preserveStorage) {
        await rm(baseDirectory, { recursive: true, force: true });
      }
    },
  };
}

function readAllTasks(store: Store<typeof schema>): ReadonlyArray<LocalTaskRow> {
  return store.query(tasks.orderBy('id', 'asc'));
}

function getTask(store: Store<typeof schema>, taskId: string): LocalTaskRow | null {
  const row = store.query(
    tasks.where('id', taskId).first({ fallback: () => undefined })
  );

  return row ?? null;
}

function getTaskTitle(store: Store<typeof schema>, taskId: string): string | null {
  const row = getTask(store, taskId);
  return row?.title ?? null;
}

function requireTask(store: Store<typeof schema>, taskId: string): LocalTaskRow {
  const row = getTask(store, taskId);
  if (!row) {
    throw new Error(`LiveStore task ${taskId} not found in local state`);
  }
  return row;
}

async function waitForTaskCount(args: {
  store: Store<typeof schema>;
  expectedRows: number;
  timeoutMs?: number;
}): Promise<ReadonlyArray<LocalTaskRow>> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const rows = readAllTasks(args.store);
    if (rows.length === args.expectedRows) {
      return rows;
    }
    await Bun.sleep(50);
  }

  throw new Error(`LiveStore did not reach ${args.expectedRows} rows before timeout`);
}

async function waitForTaskTitle(args: {
  store: Store<typeof schema>;
  taskId: string;
  expectedTitle: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (getTaskTitle(args.store, args.taskId) === args.expectedTitle) {
      return;
    }
    await Bun.sleep(25);
  }

  throw new Error(
    `LiveStore reader did not observe ${args.taskId}=${args.expectedTitle}`
  );
}

function makeUpdatedTask(task: LocalTaskRow, title: string): typeof events.taskUpserted.Event['args'] {
  return {
    id: task.id,
    org_id: task.org_id,
    project_id: task.project_id,
    owner_id: task.owner_id,
    title,
    completed: task.completed,
    server_version: task.server_version + 1,
    updated_at: new Date().toISOString(),
  };
}

async function runBootstrap(): Promise<RunnerResult> {
  await ensureStackUp('livestore');

  const scales = [1000, 10_000];
  const scaleResults: BootstrapScaleResult[] = [];

  for (const rowsTarget of scales) {
    await seedStack('livestore', {
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
    const session = await createSession({
      prefix: `livestore-bootstrap-${rowsTarget}`,
    });

    try {
      const rows = await waitForTaskCount({
        store: session.store,
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
      'LiveStore bootstrap uses the Bun node adapter with fs-backed local persistence and the official sync-electric backend.',
      'The benchmark server mirrors seeded rows into both a canonical tasks table and the LiveStore eventlog table.',
      'The 100000-row bootstrap scale is currently omitted because the wa-sqlite runtime in this configuration aborts with a wasm heap OOM before completion.',
    ],
    metadata: {
      implementation: 'livestore-node-adapter-sync-electric',
      productVersion: '0.3.1',
      unsupportedScales: [100_000],
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
  await ensureStackUp('livestore');
  await seedStack('livestore', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('livestore');
  if (!fixtures.sampleTaskId) {
    throw new Error('LiveStore fixtures did not return a sample task');
  }

  const baseFetch = globalThis.fetch;
  const meter = createHttpMeter(baseFetch);
  globalThis.fetch = meter.fetch;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  const writer = await createSession({ prefix: 'livestore-writer' });
  const reader = await createSession({ prefix: 'livestore-reader' });

  try {
    await waitForTaskCount({ store: writer.store, expectedRows: 200 });
    await waitForTaskCount({ store: reader.store, expectedRows: 200 });

    const iterations = 15;
    const samples: OnlinePropagationSample[] = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const expectedTitle = `livestore-online-${iteration}-${Date.now()}`;
      const existing = requireTask(writer.store, fixtures.sampleTaskId);
      const startedAt = performance.now();

      writer.store.commit(events.taskUpserted(makeUpdatedTask(existing, expectedTitle)));
      const writeAckMs = performance.now() - startedAt;

      await waitForTaskTitle({
        store: reader.store,
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
        'LiveStore write_ack_ms measures local event commit completion; propagation includes sync-electric push and the reader pull cycle.',
        'Mirror visibility completes when a second LiveStore session has materialized the updated task title.',
      ],
      metadata: {
        implementation: 'livestore-node-adapter-sync-electric',
        productVersion: '0.3.1',
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
  return {
    status: 'unsupported',
    metrics: {
      queued_mutations: null,
      request_count: null,
      request_bytes: null,
      response_bytes: null,
      replay_visible_ms: null,
      bytes_transferred: null,
      avg_memory_mb: null,
      peak_memory_mb: null,
      avg_cpu_pct: null,
      peak_cpu_pct: null,
    },
    notes: [
      'Offline replay is marked unsupported for the official LiveStore node adapter plus sync-electric path in this harness.',
      'In this setup, backend outages produce transport failures that terminate sync sessions before queued local writes can be measured fairly.',
      'The benchmark deliberately does not add a benchmark-owned outbox or retry layer on top of LiveStore, because that would stop measuring the framework as shipped.',
    ],
    metadata: {
      implementation: 'unsupported-in-harness',
      productVersion: '0.3.1',
    },
  };
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
