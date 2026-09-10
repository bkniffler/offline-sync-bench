import { recoverySeed } from '../contracts/recovery.ts';
import { measureCollaboration, collaborationSeed, pollUntil } from '../contracts/collaboration.ts';
import { measureScreens, screenProjectId, screenOwnerId, fixtureTasks, validateScreenData, type Row } from '../contracts/screens.ts';
import { validateSeedIsolation } from '../contracts/seeding-isolation.ts';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type JazzClient, toWriteRecord, type QueryInput } from 'jazz-tools';
import { deploy } from 'jazz-tools/dev';
import { app, appId, adminSecret, backendSecret, permissions, productVersion, createJazzNativeClient, queryTasks, jazzSchemaMigration, type TaskRow } from './jazz-native.ts';
import { validateJazzDeployment } from '../contracts/jazz-deployment.ts';
import { startupScaleCatalog, validateStartupSnapshot } from '../contracts/startup.ts';
import { average, CpuSampler, MemorySampler, percentile, round } from '../metrics.ts';
import { tempRoot } from '../paths.ts';
import { getClientStack as getStack, getStack as getAdministrativeStack } from '../stacks.ts';
import type { BenchmarkStatus, JsonValue, OnlinePropagationSample } from '../types.ts';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}


interface SeedResult {
  client: JazzClient;
  taskIds: string[];
}

interface ReplayResult {
  queueSize: number;
  convergenceMs: number;
  visibleRows: number;
  mutationErrors: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
}

const stack = getStack('jazz-v2');
const scenario = process.argv[2];
const supportedScenarios = new Set([
  'seed-local-query',
  'seed-startup',
  'online-propagation',
  'offline-replay',
  'large-offline-queue',
  'local-query',
]);
const scenarioRoot = process.argv[4] ?? join(tempRoot, `jazz-v2-${scenario}`);
const stores = new WeakMap<JazzClient, string>();


if (!scenario || !supportedScenarios.has(scenario)) {
  throw new Error(
    'Expected scenario argument: seed-startup | online-propagation | offline-replay | large-offline-queue | local-query'
  );
}

void main().then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`, () =>
      process.exit(1)
    );
  }
);

async function main(): Promise<RunnerResult> {
  await mkdir(scenarioRoot, { recursive: true });
  if (scenario === 'local-query') return runLocalQuery();
  const deployment = await deploy({
    appId,
    serverUrl: getAdministrativeStack('jazz-v2').syncBaseUrl,
    adminSecret,
    schema: app.wasmSchema,
    permissions,
    migration: jazzSchemaMigration,
  });
  validateJazzDeployment(deployment);

  if (scenario === 'seed-startup') {
    const datasetId = process.argv[3], count = Number(process.argv[5]);
    if (!datasetId?.startsWith('startup-') || ![...startupScaleCatalog, recoverySeed.tasksPerProject].includes(count)) throw new Error('Invalid Jazz startup fixture');
    const { client } = await seedTasks(datasetId, count, { screenFixture: true });
    const rows = await queryTasks(client, app.tasks.where({ dataset_id: { eq: datasetId } }), { tier: 'local', propagation: 'local-only' });
    const tasksDigest = validateStartupSnapshot(rows.map(row => ({ ...row, id: row.external_id })), count);
    const receipt = { pid: process.pid, parentPid: process.ppid, store: stores.get(client)!, datasetId, taskCount: count,
      tasksDigest, edgeDurable: true, productVersion, completedAt: new Date().toISOString() };
    await client.shutdown();
    return { status: 'completed', metrics: { seeded_tasks: count }, notes: ['Native edge-durable canonical startup fixture; seeder closes and exits before reader launch.'], metadata: { seedReceipt: receipt } };
  }

  if (scenario === 'seed-local-query') {
    const datasetId = process.argv[3];
    if (!datasetId?.startsWith('local-')) throw new Error('Jazz screen seeder requires its dataset identity');
    const { client } = await seedTasks(datasetId, 100_000, { screenFixture: true });
    const rows = await queryTasks(client, app.tasks.where({ dataset_id: { eq: datasetId } }), { tier: 'local', propagation: 'local-only' });
    const validation = validateScreenData('local-query', { tasks: rows.map(row => ({ ...row, id: row.external_id })) });
    return { status: 'completed', metrics: { seeded_tasks: 100_000 }, notes: ['Every seed batch received edge durability before this process exits.'],
      metadata: { seedReceipt: { pid: process.pid, parentPid: process.ppid, store: stores.get(client)!, datasetId, taskCount: 100_000, tasksDigest: validation.tasksDigest,
        edgeDurable: true, productVersion, completedAt: new Date().toISOString() } } };
  }

  if (scenario === 'online-propagation') return runOnlinePropagation();
  if (scenario === 'offline-replay') return runOfflineReplay();
  if (scenario === 'large-offline-queue') return runLargeOfflineQueue();
  throw new Error('Unhandled Jazz scenario');
}

function createClient(name: string): JazzClient {
  const store = join(scenarioRoot, `${name}-${randomUUID()}.db`);
  const client = createJazzNativeClient(store, stack.syncBaseUrl);
  stores.set(client, store);
  return client;
}

async function seedTasks(
  datasetId: string,
  count: number,
  options: { client?: JazzClient; retainIds?: number; screenFixture?: boolean } = {}
): Promise<SeedResult> {
  const client = options.client ?? createClient(`seed-${count}`);
  const taskIds: string[] = [];
  const retainIds = options.retainIds ?? 0;
  const chunkSize = 1_000;
  const screenRows = options.screenFixture ? fixtureTasks({ resetFirst: true, orgCount: 1, projectsPerOrg: 1, usersPerOrg: 2, tasksPerProject: count, membershipsPerProject: 2 }) : null;

  for (let chunkStart = 0; chunkStart < count; chunkStart += chunkSize) {
    const batchId = client.beginBatch('direct');
    const chunkEnd = Math.min(count, chunkStart + chunkSize);
    for (let index = chunkStart; index < chunkEnd; index += 1) {
      const taskId = randomUUID();
      if (taskIds.length < retainIds) taskIds.push(taskId);
      client.insertInternal(
        'tasks',
        toWriteRecord(
          {
            dataset_id: datasetId,
            external_id: `${datasetId}-task-${String(index).padStart(6, '0')}`,
            org_id: `${datasetId}-org-1`,
            project_id: `${datasetId}-project-${(index % 4) + 1}`,
            owner_id: `${datasetId}-owner-${index % 2}`,
            title: `Task ${index}`,
            completed: index % 3 === 0,
            server_version: 1,
            updated_at: new Date(1_700_000_000_000 + index),
            ...(screenRows ? { ...screenRows[index], id: undefined, external_id: String(screenRows[index].id), completed: Boolean(screenRows[index].completed) } : {}),
          },
          app.wasmSchema,
          'tasks'
        ),
        { id: taskId },
        undefined,
        undefined,
        batchId
      );
    }
    await client.commitBatch(batchId).wait({ tier: 'edge' });
  }
  return { client, taskIds };
}


async function waitForRows(
  client: JazzClient,
  query: QueryInput,
  expected: number,
  timeoutMs = 180_000
): Promise<TaskRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: TaskRow[] = [];
  while (Date.now() < deadline) {
    rows = await queryTasks(client, query, {
      tier: 'edge',
      propagation: 'full',
    });
    if (rows.length === expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Jazz v2 reached ${rows.length}/${expected} expected rows`);
}

function parseNumberList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  return value.split(',').map((part) => Number(part.trim())).filter(Number.isFinite);
}


async function runOnlinePropagation(): Promise<RunnerResult> {
  const datasetId = `online-${randomUUID()}`;
  const { client: writer, taskIds } = await seedTasks(datasetId, 200, { retainIds: 1, screenFixture: true });
  const taskId = taskIds[0];
  if (!taskId) throw new Error('Jazz task fixture missing');
  const reader = createClient('online-reader');
  await waitForRows(reader, app.tasks.where({ dataset_id: { eq: datasetId } }), 200);
  const result = await measureCollaboration({
      readData: async () => (await queryTasks(reader, app.tasks.where({ dataset_id: { eq: datasetId } }), { tier: 'local', propagation: 'local-only' })).map(row => ({ ...row, id: row.external_id })),
    localCommit: true,
    write: async (title, milestones) => {
      const write = writer.update(taskId, toWriteRecord({ title }, app.wasmSchema, 'tasks'));
      await Promise.all([write.wait({ tier: 'local' }).then(() => milestones.localCommitted()), write.wait({ tier: 'edge' }).then(() => milestones.serverAccepted())]);
    },
    observe: (title, signal) => pollUntil(async () => (await queryTasks(reader, app.tasks.where({ id: { eq: taskId } }), { tier: 'local', propagation: 'local-only' }))[0]?.title === title, signal),
    diagnostics: { localCommit: 'local durability receipt', serverAccepted: 'edge durability receipt', reader: 'native transport with 1ms local-only query polling', localStorage: 'jazz-napi-sqlite-file' },
  });
  return { status: 'completed', ...result, metadata: { ...result.metadata, implementation: 'jazz-v2-collaboration-v2', productVersion, experimental: true } };
}

async function runOfflineReplay(): Promise<RunnerResult> {
  const replay = await runReplayCase(10, 'offline');
  return {
    status: 'completed',
    metrics: {
      queued_mutations: replay.queueSize,
      replay_visible_ms: replay.convergenceMs,
      mutation_errors: replay.mutationErrors,
      ...pickResourceMetrics(replay),
    },
    notes: [
      'Writes persist in the native local jazz-napi runtime while its public sync transport is disconnected, then replay after reconnect.',
      'Jazz v2 is an alpha and these measurements belong to the experimental lane.',
    ],
    metadata: {
      implementation: 'jazz-v2-alpha-native-offline-replay',
      productVersion,
      experimental: true,
      visibleRows: replay.visibleRows,
    },
  };
}

async function runLargeOfflineQueue(): Promise<RunnerResult> {
  const queueSizes = [100, 500, 1_000];
  const results: ReplayResult[] = [];
  for (const queueSize of queueSizes) {
    results.push(await runReplayCase(queueSize, `large-${queueSize}`));
  }
  return {
    status: 'completed',
    metrics: Object.fromEntries(
      results.flatMap((entry) => [
        [`queue_${entry.queueSize}_queued_writes`, entry.queueSize],
        [`queue_${entry.queueSize}_convergence_ms`, entry.convergenceMs],
        [`queue_${entry.queueSize}_mutation_errors`, entry.mutationErrors],
        [`queue_${entry.queueSize}_avg_memory_mb`, entry.avgMemoryMb],
        [`queue_${entry.queueSize}_peak_memory_mb`, entry.peakMemoryMb],
        [`queue_${entry.queueSize}_avg_cpu_pct`, entry.avgCpuPct],
        [`queue_${entry.queueSize}_peak_cpu_pct`, entry.peakCpuPct],
      ])
    ),
    notes: [
      'Every queued update is a native Jazz local mutation; the harness does not add an outbox.',
      'Jazz v2 is an alpha and these measurements belong to the experimental lane.',
    ],
    metadata: {
      implementation: 'jazz-v2-alpha-native-large-queue',
      productVersion,
      experimental: true,
      queueSizes,
      visibleRows: results.map((entry) => entry.visibleRows),
    },
  };
}

async function runReplayCase(queueSize: number, label: string): Promise<ReplayResult> {
  const datasetId = `${label}-${randomUUID()}`;
  const { client: writer, taskIds } = await seedTasks(datasetId, Math.max(200, queueSize), {
    retainIds: queueSize,
  });
  const reader = createClient(`${label}-reader`);
  await waitForRows(
    reader,
    app.tasks.where({ dataset_id: { eq: datasetId } }),
    Math.max(200, queueSize)
  );
  let mutationErrors = 0;
  writer.onMutationError(() => {
    mutationErrors += 1;
  });
  writer.disconnectTransport();
  const writes = taskIds.map((taskId, index) =>
    writer.update(
      taskId,
      toWriteRecord(
        {
          title: `${datasetId}-queued-${index}`,
          server_version: 2,
          updated_at: new Date(),
        },
        app.wasmSchema,
        'tasks'
      )
    )
  );
  await Promise.all(writes.map((write) => write.wait({ tier: 'local' })));
  const memory = new MemorySampler();
  const cpu = new CpuSampler();
  memory.start();
  cpu.start();
  const startedAt = performance.now();
  writer.connectTransport(stack.syncBaseUrl, { backend_secret: backendSecret });
  await Promise.all(writes.map((write) => write.wait({ tier: 'edge' })));
  const visible = await waitForRows(
    reader,
    app.tasks.where({
      dataset_id: { eq: datasetId },
      title: { contains: '-queued-' },
    }),
    queueSize,
    Math.max(180_000, queueSize * 500)
  );
  const memoryMetrics = memory.stop();
  const cpuMetrics = cpu.stop();
  return {
    queueSize,
    convergenceMs: round(performance.now() - startedAt),
    visibleRows: visible.length,
    mutationErrors,
    ...memoryMetrics,
    ...cpuMetrics,
  };
}

async function runLocalQuery(): Promise<RunnerResult> {
  const datasetId = process.argv[3], seeding = JSON.parse(process.argv[5] ?? 'null') as Record<string, JsonValue> | null;
  if (!datasetId?.startsWith('local-') || !seeding || seeding.datasetId !== datasetId || seeding.exitCode !== 0 || seeding.exitSignal !== null || seeding.pid === process.pid || seeding.exitObservedBeforeReaderSpawn !== true) throw new Error('Jazz screens require a completed separate seed process');
  const readerStartedAt = new Date().toISOString();
  const client = createClient('local-reader');
  await waitForRows(client, app.tasks.where({ dataset_id: { eq: datasetId } }), 100_000, 600_000);
  const localOnly = { tier: 'local', propagation: 'local-only' } as const;
  const result = await measureScreens('local-query', {
    execution: 'mixed-native-and-application',
    readData: async () => ({ tasks: (await queryTasks(client, app.tasks.where({ dataset_id: { eq: datasetId } }), localOnly))
      .map(row => ({ ...row, id: row.external_id })) as unknown as Row[] }),
    query: async name => {
      if (name === 'list') return (await queryTasks(client, app.tasks.where({ dataset_id: { eq: datasetId }, project_id: { eq: screenProjectId }, owner_id: { eq: screenOwnerId }, completed: { eq: false } })
        .orderBy('external_id', 'desc').limit(50), localOnly))
        .map(row => ({ id: row.external_id, title: row.title, completed: Number(row.completed) }));
      if (name === 'search') return (await queryTasks(client, app.tasks.where({ dataset_id: { eq: datasetId }, project_id: { eq: screenProjectId }, external_id: { contains: `${screenProjectId}-task-00` } })
        .orderBy('external_id').limit(100), localOnly))
        .map(row => ({ id: row.external_id, title: row.title }));
      const rows = await queryTasks(client, app.tasks.where({ dataset_id: { eq: datasetId }, project_id: { eq: screenProjectId } }), localOnly);
      const groups = new Map<string, { owner_id: string; completed: number; task_count: number }>();
      for (const row of rows) {
        const key = `${row.owner_id}:${Number(row.completed)}`;
        const group = groups.get(key) ?? { owner_id: row.owner_id, completed: Number(row.completed), task_count: 0 };
        group.task_count++; groups.set(key, group);
      }
      return [...groups.values()].sort((a, b) => a.owner_id < b.owner_id ? -1 : a.owner_id > b.owner_id ? 1 : a.completed - b.completed);
    },
    diagnostics: { localStorage: 'jazz-napi-sqlite-file', listAndSearch: 'native-local-query', aggregate: 'native-materialization-plus-javascript-grouping', idMapping: 'canonical task ID stored in external_id; product ID remains random', seeding: 'separate process; observed exit before reader creation' },
  });
  const metadata = { ...result.metadata, implementation: 'jazz-v2-screens-v2', productVersion, experimental: true,
    seedingIsolation: { method: 'separate-seed-process-v1', seeding, reader: { pid: process.pid, parentPid: process.ppid, store: stores.get(client)!, datasetId, startedAt: readerStartedAt } } };
  validateSeedIsolation(metadata);
  return { status: 'completed', ...result, metadata };
}

function pickResourceMetrics(result: ReplayResult): Record<string, number> {
  return {
    avg_memory_mb: result.avgMemoryMb,
    peak_memory_mb: result.peakMemoryMb,
    avg_cpu_pct: result.avgCpuPct,
    peak_cpu_pct: result.peakCpuPct,
  };
}
