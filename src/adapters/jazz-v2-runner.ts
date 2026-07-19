import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  JazzClient,
  definePermissions,
  schema as s,
  toWriteRecord,
  transformRows,
  type QueryInput,
  type QueryExecutionOptions,
} from 'jazz-tools';
import { deploy } from 'jazz-tools/dev';
import { NapiRuntime } from 'jazz-napi';
import { average, CpuSampler, MemorySampler, percentile, round } from '../metrics.ts';
import { tempRoot } from '../paths.ts';
import { getStack } from '../stacks.ts';
import type { BenchmarkStatus, JsonValue, OnlinePropagationSample } from '../types.ts';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

interface TaskRow {
  id: string;
  dataset_id: string;
  external_id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: boolean;
  server_version: number;
  updated_at: Date;
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
  'bootstrap',
  'online-propagation',
  'offline-replay',
  'large-offline-queue',
  'local-query',
]);
const appId = '782ccb53-dcba-56c0-acc8-d056d008eea3';
const adminSecret = 'jazz-admin';
const backendSecret = 'jazz-backend';
const productVersion = '2.0.0-alpha.53';
const scenarioRoot = join(tempRoot, `jazz-v2-${scenario}`);

const schema = {
  tasks: s
    .table({
      dataset_id: s.string(),
      external_id: s.string(),
      org_id: s.string(),
      project_id: s.string(),
      owner_id: s.string(),
      title: s.string(),
      completed: s.boolean(),
      server_version: s.int(),
      updated_at: s.timestamp(),
    })
    .indexOnly([
      'dataset_id',
      'external_id',
      'org_id',
      'project_id',
      'owner_id',
      'completed',
      'updated_at',
    ]),
};
const app = s.defineApp(schema);
const permissions = definePermissions(app, ({ policy }) => {
  policy.tasks.allowRead.always();
  policy.tasks.allowInsert.always();
  policy.tasks.allowUpdate.always();
  policy.tasks.allowDelete.always();
});
const schemaJson = JSON.stringify({
  __jazzRuntimeSchema: 1,
  schema: app.wasmSchema,
  loadedPolicyBundle: false,
});

if (!scenario || !supportedScenarios.has(scenario)) {
  throw new Error(
    'Expected scenario argument: bootstrap | online-propagation | offline-replay | large-offline-queue | local-query'
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
  await deploy({
    appId,
    serverUrl: stack.syncBaseUrl,
    adminSecret,
    schema: app.wasmSchema,
    permissions,
  });

  if (scenario === 'bootstrap') return runBootstrap();
  if (scenario === 'online-propagation') return runOnlinePropagation();
  if (scenario === 'offline-replay') return runOfflineReplay();
  if (scenario === 'large-offline-queue') return runLargeOfflineQueue();
  return runLocalQuery();
}

function createClient(name: string): JazzClient {
  const runtime = new NapiRuntime(
    schemaJson,
    appId,
    'bench',
    'main',
    join(scenarioRoot, `${name}-${randomUUID()}.db`),
    'local'
  );
  const client = JazzClient.connectWithRuntime(runtime, {
    appId,
    schema: app.wasmSchema,
    serverUrl: stack.syncBaseUrl,
    backendSecret,
    env: 'bench',
    userBranch: 'main',
    tier: 'local',
    defaultDurabilityTier: 'local',
  }).asBackend();
  client.connectTransport(stack.syncBaseUrl, { backend_secret: backendSecret });
  return client;
}

async function seedTasks(
  datasetId: string,
  count: number,
  options: { client?: JazzClient; retainIds?: number } = {}
): Promise<SeedResult> {
  const client = options.client ?? createClient(`seed-${count}`);
  const taskIds: string[] = [];
  const retainIds = options.retainIds ?? 0;
  const chunkSize = 1_000;

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

async function queryTasks(
  client: JazzClient,
  query: QueryInput,
  options: QueryExecutionOptions
): Promise<TaskRow[]> {
  const rows = await client.query(query, options);
  return transformRows<TaskRow>(rows, app.wasmSchema, 'tasks');
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

async function runBootstrap(): Promise<RunnerResult> {
  const scales = parseNumberList(
    process.env.JAZZ_BENCH_BOOTSTRAP_SCALES,
    [1_000, 10_000, 100_000, 250_000, 500_000]
  );
  const scaleResults: Array<Record<string, number | null>> = [];

  for (const rowsTarget of scales) {
    const datasetId = `bootstrap-${rowsTarget}-${randomUUID()}`;
    await seedTasks(datasetId, rowsTarget);
    const memory = new MemorySampler();
    const cpu = new CpuSampler();
    memory.start();
    cpu.start();
    const startedAt = performance.now();
    const reader = createClient(`bootstrap-reader-${rowsTarget}`);
    const rows = await waitForRows(
      reader,
      app.tasks.where({ dataset_id: { eq: datasetId } }),
      rowsTarget,
      600_000
    );
    const memoryMetrics = memory.stop();
    const cpuMetrics = cpu.stop();
    scaleResults.push({
      rowsTarget,
      timeToFirstQueryMs: round(performance.now() - startedAt),
      rowsLoaded: rows.length,
      requestCount: null,
      requestBytes: null,
      responseBytes: null,
      bytesTransferred: null,
      ...memoryMetrics,
      ...cpuMetrics,
    });
  }

  return {
    status: 'completed',
    metrics: Object.fromEntries(
      scaleResults.flatMap((entry) => {
        const scale = entry.rowsTarget;
        return [
          [`bootstrap_${scale}_ms`, entry.timeToFirstQueryMs],
          [`rows_loaded_${scale}`, entry.rowsLoaded],
          [`request_count_${scale}`, null],
          [`request_bytes_${scale}`, null],
          [`response_bytes_${scale}`, null],
          [`bytes_transferred_${scale}`, null],
          [`avg_memory_mb_${scale}`, entry.avgMemoryMb],
          [`peak_memory_mb_${scale}`, entry.peakMemoryMb],
          [`avg_cpu_pct_${scale}`, entry.avgCpuPct],
          [`peak_cpu_pct_${scale}`, entry.peakCpuPct],
        ];
      })
    ),
    notes: [
      'A fresh persistent jazz-napi client performs a full edge-propagated query for each scale.',
      'Jazz v2 does not expose transport byte counters, so request and byte metrics are null.',
      'Jazz v2 is an alpha and these measurements belong to the experimental lane.',
    ],
    metadata: {
      implementation: 'jazz-v2-alpha-native-bootstrap',
      productVersion,
      experimental: true,
      scales: scaleResults as unknown as JsonValue,
    },
  };
}

async function runOnlinePropagation(): Promise<RunnerResult> {
  const datasetId = `online-${randomUUID()}`;
  const { client: writer, taskIds } = await seedTasks(datasetId, 200, { retainIds: 1 });
  const taskId = taskIds[0];
  if (!taskId) throw new Error('Jazz v2 online fixture is missing');
  const reader = createClient('online-reader');
  await waitForRows(reader, app.tasks.where({ dataset_id: { eq: datasetId } }), 200);
  const samples: OnlinePropagationSample[] = [];
  const memory = new MemorySampler();
  const cpu = new CpuSampler();
  memory.start();
  cpu.start();

  for (let iteration = 0; iteration < 15; iteration += 1) {
    const title = `jazz-online-${iteration}-${Date.now()}`;
    const startedAt = performance.now();
    const write = writer.update(
      taskId,
      toWriteRecord(
        { title, server_version: iteration + 2, updated_at: new Date() },
        app.wasmSchema,
        'tasks'
      )
    );
    await write.wait({ tier: 'local' });
    const writeAckMs = performance.now() - startedAt;
    await write.wait({ tier: 'edge' });
    await waitForRows(reader, app.tasks.where({ id: { eq: taskId }, title: { eq: title } }), 1);
    samples.push({
      iteration,
      writeAckMs: round(writeAckMs),
      mirrorVisibleMs: round(performance.now() - startedAt),
    });
  }

  const memoryMetrics = memory.stop();
  const cpuMetrics = cpu.stop();
  const visibility = samples.map((sample) => sample.mirrorVisibleMs);
  return {
    status: 'completed',
    metrics: {
      write_ack_ms: average(samples.map((sample) => sample.writeAckMs)),
      mirror_visible_p50_ms: percentile(visibility, 50),
      mirror_visible_p95_ms: percentile(visibility, 95),
      mirror_visible_p99_ms: percentile(visibility, 99),
      iterations: samples.length,
      request_count: null,
      request_bytes: null,
      response_bytes: null,
      bytes_transferred: null,
      avg_memory_mb: memoryMetrics.avgMemoryMb,
      peak_memory_mb: memoryMetrics.peakMemoryMb,
      avg_cpu_pct: cpuMetrics.avgCpuPct,
      peak_cpu_pct: cpuMetrics.peakCpuPct,
    },
    notes: [
      'write_ack_ms is Jazz local durability; mirror visibility includes edge durability and an independent client query.',
      'Jazz v2 is an alpha and these measurements belong to the experimental lane.',
    ],
    metadata: {
      implementation: 'jazz-v2-alpha-native-propagation',
      productVersion,
      experimental: true,
      samples: samples as unknown as JsonValue,
    },
  };
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
  const rowCount = Number(process.env.JAZZ_BENCH_LOCAL_ROWS ?? 100_000);
  const datasetId = `local-${randomUUID()}`;
  await seedTasks(datasetId, rowCount);
  const client = createClient('local-reader');
  await waitForRows(client, app.tasks.where({ dataset_id: { eq: datasetId } }), rowCount, 600_000);
  const listSamples: number[] = [];
  const searchSamples: number[] = [];
  const aggregateSamples: number[] = [];
  let listResultCount = 0;
  let searchResultCount = 0;
  let aggregateResultCount = 0;
  const memory = new MemorySampler();
  const cpu = new CpuSampler();
  memory.start();
  cpu.start();

  for (let iteration = 0; iteration < 25; iteration += 1) {
    let startedAt = performance.now();
    const list = await queryTasks(
      client,
      app.tasks
        .where({
          dataset_id: { eq: datasetId },
          project_id: { eq: `${datasetId}-project-1` },
          owner_id: { eq: `${datasetId}-owner-0` },
          completed: { eq: false },
        })
        .orderBy('updated_at', 'desc')
        .limit(50),
      { tier: 'local', propagation: 'local-only' }
    );
    listSamples.push(round(performance.now() - startedAt));
    listResultCount = list.length;

    startedAt = performance.now();
    const search = await queryTasks(
      client,
      app.tasks
        .where({
          dataset_id: { eq: datasetId },
          external_id: { contains: '-task-00' },
        })
        .orderBy('external_id')
        .limit(100),
      { tier: 'local', propagation: 'local-only' }
    );
    searchSamples.push(round(performance.now() - startedAt));
    searchResultCount = search.length;

    startedAt = performance.now();
    const aggregateRows = await queryTasks(
      client,
      app.tasks.where({ dataset_id: { eq: datasetId } }),
      { tier: 'local', propagation: 'local-only' }
    );
    aggregateResultCount = new Set(
      aggregateRows.map((row) => `${row.owner_id}:${row.completed}`)
    ).size;
    aggregateSamples.push(round(performance.now() - startedAt));
  }

  const memoryMetrics = memory.stop();
  const cpuMetrics = cpu.stop();
  return {
    status: 'completed',
    metrics: {
      row_count: rowCount,
      iterations: 25,
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
      'List and search use native Jazz local queries over the persistent local runtime.',
      'The aggregate scenario is emulated by materializing the native local result and grouping in JavaScript because Jazz v2 alpha exposes no local aggregate operator.',
      'Jazz v2 is an alpha and these measurements belong to the experimental lane.',
    ],
    metadata: {
      implementation: 'jazz-v2-alpha-local-query-partial-emulation',
      productVersion,
      experimental: true,
    },
  };
}

function pickResourceMetrics(result: ReplayResult): Record<string, number> {
  return {
    avg_memory_mb: result.avgMemoryMb,
    peak_memory_mb: result.peakMemoryMb,
    avg_cpu_pct: result.avgCpuPct,
    peak_cpu_pct: result.peakCpuPct,
  };
}
