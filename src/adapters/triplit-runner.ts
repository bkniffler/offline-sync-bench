import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SignJWT } from 'jose';
import { TriplitClient } from '@triplit/client';
import { average, CpuSampler, MemorySampler, percentile, round } from '../metrics.ts';
import { getStack } from '../stacks.ts';
import { schema } from '../triplit-schema.ts';
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
  updated_at: string;
}

interface ReplayResult {
  queueSize: number;
  convergenceMs: number;
  visibleRows: number;
  syncErrors: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
}

const scenario = process.argv[2];
const supportedScenarios = new Set([
  'bootstrap',
  'online-propagation',
  'offline-replay',
  'large-offline-queue',
  'local-query',
  'deep-relationship-query',
]);
const stack = getStack('triplit');
const jwtSecret = 'offline-sync-bench-triplit-secret';
const productVersion = '1.0.50';

if (!scenario || !supportedScenarios.has(scenario)) {
  throw new Error(
    'Expected scenario argument: bootstrap | online-propagation | offline-replay | large-offline-queue | local-query | deep-relationship-query'
  );
}

void main().then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0)),
  (error) =>
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`, () =>
      process.exit(1)
    )
);

async function main(): Promise<RunnerResult> {
  const token = await new SignJWT({ 'x-triplit-token-type': 'secret' })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(jwtSecret));
  pushSchema(token);

  if (scenario === 'bootstrap') return runBootstrap(token);
  if (scenario === 'online-propagation') return runOnlinePropagation(token);
  if (scenario === 'offline-replay') return runOfflineReplay(token);
  if (scenario === 'large-offline-queue') return runLargeOfflineQueue(token);
  if (scenario === 'local-query') return runLocalQuery(token);
  return runDeepRelationshipQuery(token);
}

function pushSchema(token: string): void {
  const result = spawnSync(
    'bunx',
    [
      'triplit',
      'schema',
      'push',
      '--schemaPath',
      'src/triplit-schema.ts',
      '--token',
      token,
      '--remote',
      stack.syncBaseUrl,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`Triplit schema push failed\n${result.stdout}\n${result.stderr}`);
  }
}

async function createClient(
  token: string,
  name: string,
  options: { connect?: boolean; storage?: 'memory' | 'indexeddb' } = {}
): Promise<TriplitClient<typeof schema>> {
  const connect = options.connect ?? true;
  const client = new TriplitClient({
    schema,
    serverUrl: stack.syncBaseUrl,
    token,
    storage:
      options.storage === 'memory'
        ? 'memory'
        : { type: 'indexeddb', name: `triplit-${name}-${randomUUID()}` },
    autoConnect: connect,
    logLevel: 'error',
  });
  await client.ready;
  if (connect) await waitForConnection(client);
  return client;
}

async function waitForConnection(
  client: TriplitClient<typeof schema>,
  timeoutMs = 30_000
): Promise<void> {
  if (client.connectionStatus === 'OPEN') return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => {};
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Triplit connection timed out at ${client.connectionStatus}`));
    }, timeoutMs);
    unsubscribe = client.onConnectionStatusChange((status) => {
      if (status !== 'OPEN') return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    }, true);
  });
}

function taskInput(datasetId: string, index: number, id = randomUUID()) {
  return {
    id,
    dataset_id: datasetId,
    external_id: `${datasetId}-task-${String(index).padStart(6, '0')}`,
    org_id: `${datasetId}-org-1`,
    project_id: `${datasetId}-project-${(index % 4) + 1}`,
    owner_id: `${datasetId}-owner-${index % 2}`,
    title: `Task ${index}`,
    completed: index % 3 === 0,
    server_version: 1,
    updated_at: new Date(1_700_000_000_000 + index).toISOString(),
  };
}

async function seedTasks(
  token: string,
  datasetId: string,
  count: number,
  retainIds = 0
): Promise<string[]> {
  const admin = await createClient(token, `admin-${count}`, {
    connect: false,
    storage: 'memory',
  });
  const retained: string[] = [];
  const chunkSize = 1_000;
  for (let start = 0; start < count; start += chunkSize) {
    const tasks = [];
    for (let index = start; index < Math.min(count, start + chunkSize); index += 1) {
      const id = randomUUID();
      if (retained.length < retainIds) retained.push(id);
      tasks.push(taskInput(datasetId, index, id));
    }
    await admin.http.bulkInsert({ tasks });
  }
  return retained;
}

async function fetchRemoteTasks(
  client: TriplitClient<typeof schema>,
  datasetId: string,
  extra?: readonly ['title', '=' | 'like', string]
): Promise<TaskRow[]> {
  let query = client.query('tasks').Where('dataset_id', '=', datasetId);
  if (extra) query = query.Where(extra[0], extra[1], extra[2]);
  const rows = await client.fetch(query, { policy: 'remote-first' });
  return [...rows.values()] as TaskRow[];
}

async function waitForRemoteRows(
  client: TriplitClient<typeof schema>,
  datasetId: string,
  expected: number,
  extra?: readonly ['title', '=' | 'like', string],
  timeoutMs = 180_000
): Promise<TaskRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: TaskRow[] = [];
  while (Date.now() < deadline) {
    rows = await fetchRemoteTasks(client, datasetId, extra);
    if (rows.length === expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Triplit reached ${rows.length}/${expected} expected rows`);
}

function parseNumberList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  return value.split(',').map((part) => Number(part.trim())).filter(Number.isFinite);
}

async function runBootstrap(token: string): Promise<RunnerResult> {
  const scales = parseNumberList(
    process.env.TRIPLIT_BENCH_BOOTSTRAP_SCALES,
    [1_000, 10_000, 100_000, 250_000, 500_000]
  );
  const scaleResults: Array<Record<string, number | null>> = [];
  for (const rowsTarget of scales) {
    const datasetId = `bootstrap-${rowsTarget}-${randomUUID()}`;
    await seedTasks(token, datasetId, rowsTarget);
    const memory = new MemorySampler();
    const cpu = new CpuSampler();
    memory.start();
    cpu.start();
    const startedAt = performance.now();
    const reader = await createClient(token, `bootstrap-reader-${rowsTarget}`);
    const rows = await waitForRemoteRows(reader, datasetId, rowsTarget, undefined, 600_000);
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
    reader.disconnect();
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
      'A fresh Triplit IndexedDB client performs a remote-first full query for every bootstrap scale.',
      'Transport byte counters are not exposed by the Triplit client, so request and byte metrics are null.',
    ],
    metadata: {
      implementation: 'triplit-native-indexeddb-bootstrap',
      productVersion,
      serverVersion: '1.0.61',
      scales: scaleResults as unknown as JsonValue,
    },
  };
}

async function runOnlinePropagation(token: string): Promise<RunnerResult> {
  const datasetId = `online-${randomUUID()}`;
  const [taskId] = await seedTasks(token, datasetId, 200, 1);
  if (!taskId) throw new Error('Triplit online fixture is missing');
  const writer = await createClient(token, 'online-writer');
  const reader = await createClient(token, 'online-reader');
  await Promise.all([
    waitForRemoteRows(writer, datasetId, 200),
    waitForRemoteRows(reader, datasetId, 200),
  ]);
  const memory = new MemorySampler();
  const cpu = new CpuSampler();
  memory.start();
  cpu.start();
  const samples: OnlinePropagationSample[] = [];
  for (let iteration = 0; iteration < 15; iteration += 1) {
    const title = `triplit-online-${iteration}-${Date.now()}`;
    const startedAt = performance.now();
    await writer.update('tasks', taskId, {
      title,
      server_version: iteration + 2,
      updated_at: new Date().toISOString(),
    });
    const writeAckMs = performance.now() - startedAt;
    await writer.syncWrites();
    await waitForRemoteRows(reader, datasetId, 1, ['title', '=', title]);
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
      'write_ack_ms is the optimistic local IndexedDB update; mirror visibility includes native outbox sync and an independent remote-first query.',
    ],
    metadata: {
      implementation: 'triplit-native-propagation',
      productVersion,
      serverVersion: '1.0.61',
      samples: samples as unknown as JsonValue,
    },
  };
}

async function runOfflineReplay(token: string): Promise<RunnerResult> {
  const replay = await runReplayCase(token, 10, 'offline');
  return {
    status: 'completed',
    metrics: {
      queued_mutations: replay.queueSize,
      replay_visible_ms: replay.convergenceMs,
      sync_errors: replay.syncErrors,
      ...resourceMetrics(replay),
    },
    notes: [
      'Writes queue in Triplit\'s native IndexedDB outbox while disconnected and replay after the public connect() call.',
    ],
    metadata: {
      implementation: 'triplit-native-offline-replay',
      productVersion,
      serverVersion: '1.0.61',
      visibleRows: replay.visibleRows,
    },
  };
}

async function runLargeOfflineQueue(token: string): Promise<RunnerResult> {
  const queueSizes = [100, 500, 1_000];
  const results: ReplayResult[] = [];
  for (const queueSize of queueSizes) {
    results.push(await runReplayCase(token, queueSize, `large-${queueSize}`));
  }
  return {
    status: 'completed',
    metrics: Object.fromEntries(
      results.flatMap((entry) => [
        [`queue_${entry.queueSize}_queued_writes`, entry.queueSize],
        [`queue_${entry.queueSize}_convergence_ms`, entry.convergenceMs],
        [`queue_${entry.queueSize}_sync_errors`, entry.syncErrors],
        [`queue_${entry.queueSize}_avg_memory_mb`, entry.avgMemoryMb],
        [`queue_${entry.queueSize}_peak_memory_mb`, entry.peakMemoryMb],
        [`queue_${entry.queueSize}_avg_cpu_pct`, entry.avgCpuPct],
        [`queue_${entry.queueSize}_peak_cpu_pct`, entry.peakCpuPct],
      ])
    ),
    notes: [
      'Every queued update is a native Triplit mutation stored in the official IndexedDB outbox; the harness does not add a queue.',
    ],
    metadata: {
      implementation: 'triplit-native-large-queue',
      productVersion,
      serverVersion: '1.0.61',
      queueSizes,
      visibleRows: results.map((entry) => entry.visibleRows),
    },
  };
}

async function runReplayCase(
  token: string,
  queueSize: number,
  label: string
): Promise<ReplayResult> {
  const datasetId = `${label}-${randomUUID()}`;
  const ids = await seedTasks(token, datasetId, Math.max(200, queueSize), queueSize);
  const writer = await createClient(token, `${label}-writer`);
  const reader = await createClient(token, `${label}-reader`);
  await Promise.all([
    waitForRemoteRows(writer, datasetId, Math.max(200, queueSize)),
    waitForRemoteRows(reader, datasetId, Math.max(200, queueSize)),
  ]);
  let syncErrors = 0;
  writer.onFailureToSyncWrites(() => {
    syncErrors += 1;
  });
  writer.disconnect();
  for (let index = 0; index < ids.length; index += 1) {
    await writer.update('tasks', ids[index]!, {
      title: `${datasetId}-queued-${index}`,
      server_version: 2,
      updated_at: new Date().toISOString(),
    });
  }
  const memory = new MemorySampler();
  const cpu = new CpuSampler();
  memory.start();
  cpu.start();
  const startedAt = performance.now();
  await writer.connect();
  await waitForConnection(writer);
  await writer.syncWrites();
  const visible = await waitForRemoteRows(
    reader,
    datasetId,
    queueSize,
    ['title', 'like', '%-queued-%'],
    Math.max(180_000, queueSize * 500)
  );
  const memoryMetrics = memory.stop();
  const cpuMetrics = cpu.stop();
  return {
    queueSize,
    convergenceMs: round(performance.now() - startedAt),
    visibleRows: visible.length,
    syncErrors,
    ...memoryMetrics,
    ...cpuMetrics,
  };
}

async function runLocalQuery(token: string): Promise<RunnerResult> {
  const rowCount = Number(process.env.TRIPLIT_BENCH_LOCAL_ROWS ?? 100_000);
  const datasetId = `local-${randomUUID()}`;
  await seedTasks(token, datasetId, rowCount);
  const client = await createClient(token, 'local-reader');
  await waitForRemoteRows(client, datasetId, rowCount, undefined, 600_000);
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
    const list = await client.fetch(
      client
        .query('tasks')
        .Where('dataset_id', '=', datasetId)
        .Where('project_id', '=', `${datasetId}-project-1`)
        .Where('owner_id', '=', `${datasetId}-owner-0`)
        .Where('completed', '=', false)
        .Order('updated_at', 'DESC')
        .Limit(50),
      { policy: 'local-only' }
    );
    listSamples.push(round(performance.now() - startedAt));
    listResultCount = list.length;

    startedAt = performance.now();
    const search = await client.fetch(
      client
        .query('tasks')
        .Where('dataset_id', '=', datasetId)
        .Where('external_id', 'like', '%-task-00%')
        .Order('external_id', 'ASC')
        .Limit(100),
      { policy: 'local-only' }
    );
    searchSamples.push(round(performance.now() - startedAt));
    searchResultCount = search.length;

    startedAt = performance.now();
    const aggregateRows = await client.fetch(
      client.query('tasks').Where('dataset_id', '=', datasetId),
      { policy: 'local-only' }
    );
    aggregateResultCount = new Set(
      [...aggregateRows.values()].map((row) => `${row.owner_id}:${row.completed}`)
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
      'List and search execute through the native Triplit local query engine over its IndexedDB cache.',
      'The aggregate subtest materializes the native local query and groups in JavaScript because Triplit does not expose an aggregate operator.',
    ],
    metadata: {
      implementation: 'triplit-local-query-partial-emulation',
      productVersion,
      serverVersion: '1.0.61',
    },
  };
}

async function runDeepRelationshipQuery(token: string): Promise<RunnerResult> {
  const rowCount = Number(process.env.TRIPLIT_BENCH_DEEP_ROWS ?? 100_000);
  const datasetId = `deep-${randomUUID()}`;
  const admin = await createClient(token, 'deep-admin', {
    connect: false,
    storage: 'memory',
  });
  const orgId = `${datasetId}-org-1`;
  const projects = Array.from({ length: 4 }, (_, index) => ({
    id: `${datasetId}-project-${index + 1}`,
    dataset_id: datasetId,
    org_id: orgId,
    name: `Project ${index + 1}`,
  }));
  await admin.http.bulkInsert({
    organizations: [{ id: orgId, dataset_id: datasetId, name: 'Organization 1' }],
    projects,
  });
  await seedTasks(token, datasetId, rowCount);
  const client = await createClient(token, 'deep-reader');
  const dashboardQuery = client
    .query('organizations')
    .Where('dataset_id', '=', datasetId)
    .Include('projects', (rel) => rel('projects').Include('tasks'));
  const detailQuery = client
    .query('projects')
    .Where('id', '=', projects[0]!.id)
    .Include('organization')
    .Include('tasks');
  await client.fetch(dashboardQuery, { policy: 'remote-first' });
  await client.fetch(detailQuery, { policy: 'remote-first' });
  const dashboardSamples: number[] = [];
  const detailSamples: number[] = [];
  let dashboardResultCount = 0;
  let detailResultCount = 0;
  const memory = new MemorySampler();
  const cpu = new CpuSampler();
  memory.start();
  cpu.start();
  for (let iteration = 0; iteration < 25; iteration += 1) {
    let startedAt = performance.now();
    const dashboard = await client.fetch(dashboardQuery, { policy: 'local-only' });
    dashboardSamples.push(round(performance.now() - startedAt));
    dashboardResultCount = [...dashboard.values()].reduce(
      (total, org) =>
        total + org.projects.reduce((sum, project) => sum + project.tasks.length, 0),
      0
    );

    startedAt = performance.now();
    const detail = await client.fetch(detailQuery, { policy: 'local-only' });
    detailSamples.push(round(performance.now() - startedAt));
    detailResultCount = [...detail.values()][0]?.tasks.length ?? 0;
  }
  const memoryMetrics = memory.stop();
  const cpuMetrics = cpu.stop();
  return {
    status: 'completed',
    metrics: {
      row_count: rowCount,
      iterations: 25,
      dashboard_query_p50_ms: percentile(dashboardSamples, 50),
      dashboard_query_p95_ms: percentile(dashboardSamples, 95),
      detail_query_p50_ms: percentile(detailSamples, 50),
      detail_query_p95_ms: percentile(detailSamples, 95),
      dashboard_result_count: dashboardResultCount,
      detail_result_count: detailResultCount,
      avg_memory_mb: memoryMetrics.avgMemoryMb,
      peak_memory_mb: memoryMetrics.peakMemoryMb,
      avg_cpu_pct: cpuMetrics.avgCpuPct,
      peak_cpu_pct: cpuMetrics.peakCpuPct,
    },
    notes: [
      'Both workloads use native Triplit schema relationships and nested Include queries over the local IndexedDB cache.',
      'The dashboard result count is reduced in JavaScript after the native relationship traversal.',
    ],
    metadata: {
      implementation: 'triplit-native-deep-relationships',
      productVersion,
      serverVersion: '1.0.61',
    },
  };
}

function resourceMetrics(result: ReplayResult): Record<string, number> {
  return {
    avg_memory_mb: result.avgMemoryMb,
    peak_memory_mb: result.peakMemoryMb,
    avg_cpu_pct: result.avgCpuPct,
    peak_cpu_pct: result.peakCpuPct,
  };
}
