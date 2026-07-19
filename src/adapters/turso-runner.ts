import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, type Database } from '@tursodatabase/sync';
import { createHttpMeter } from '../http-meter.ts';
import {
  average,
  CpuSampler,
  MemorySampler,
  percentile,
  round,
} from '../metrics.ts';
import { tempRoot } from '../paths.ts';
import {
  ensureStackUp,
  getFixtures,
  listTasks,
  seedStack,
  startService,
  stopService,
} from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import type {
  BenchmarkStatus,
  BootstrapScaleResult,
  JsonValue,
  OnlinePropagationSample,
} from '../types.ts';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

interface TursoSession {
  db: Database;
  dir: string;
  close(): Promise<void>;
}

interface OfflineReplayResult {
  queuedWriteCount: number;
  cdcOperationsBeforeReplay: number;
  replayVisibleMs: number;
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  bytesTransferred: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
  pendingAfterReplay: number;
}

interface QuerySample {
  elapsedMs: number;
  resultCount: number;
}

const stack = getStack('turso');
const scenario = process.argv[2];
const supportedScenarios = new Set([
  'bootstrap',
  'online-propagation',
  'offline-replay',
  'large-offline-queue',
  'local-query',
  'deep-relationship-query',
]);

if (!scenario || !supportedScenarios.has(scenario)) {
  throw new Error(
    'Expected scenario argument: bootstrap | online-propagation | offline-replay | large-offline-queue | local-query | deep-relationship-query'
  );
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
            : await runDeepRelationshipQuery();

process.stdout.write(`${JSON.stringify(result)}\n`);

async function createSession(
  name: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<TursoSession> {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `turso-${name}-`));
  const db = await connect({
    path: join(dir, 'replica.db'),
    url: stack.syncBaseUrl,
    clientName: `${name}-${randomUUID()}`,
    fetch: fetchImpl,
    pushOperationsThreshold: 2_000,
  });

  return {
    db,
    dir,
    async close() {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function getCount(db: Database, table: string): Promise<number> {
  const statement = await db.prepare(`select count(*) as count from ${table}`);
  const row = (await statement.get()) as
    | { count?: number | bigint }
    | undefined;
  return Number(row?.count ?? 0);
}

async function pullUntilCount(
  db: Database,
  table: string,
  expected: number,
  timeoutMs = 180_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await db.pull();
    if ((await getCount(db, table)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Turso did not reach ${expected} ${table} rows before timeout`);
}

async function getTaskTitle(db: Database, taskId: string): Promise<string | null> {
  const statement = await db.prepare('select title from tasks where id = ?');
  const row = (await statement.get(taskId)) as { title?: string } | undefined;
  return row?.title ?? null;
}

async function pullUntilTitle(
  db: Database,
  taskId: string,
  expectedTitle: string,
  timeoutMs = 60_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await db.pull();
    if ((await getTaskTitle(db, taskId)) === expectedTitle) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Turso reader did not observe ${taskId}=${expectedTitle}`);
}

async function waitForSyncServer(timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(stack.syncBaseUrl);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Turso sync server did not become reachable');
}

async function runBootstrap(): Promise<RunnerResult> {
  await ensureStackUp('turso');
  const scales = [1_000, 10_000, 100_000, 250_000, 500_000];
  const scaleResults: BootstrapScaleResult[] = [];

  for (const rowsTarget of scales) {
    await seedStack('turso', {
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: rowsTarget,
      membershipsPerProject: 2,
    });

    const meter = createHttpMeter(globalThis.fetch);
    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();
    const startedAt = performance.now();
    const session = await createSession(`bootstrap-${rowsTarget}`, meter.fetch);

    try {
      await pullUntilCount(session.db, 'tasks', rowsTarget, 600_000);
      const elapsedMs = performance.now() - startedAt;
      const meterSnapshot = meter.snapshot();
      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();

      scaleResults.push({
        rowsTarget,
        timeToFirstQueryMs: round(elapsedMs),
        rowsLoaded: await getCount(session.db, 'tasks'),
        requestCount: meterSnapshot.requestCount,
        requestBytes: meterSnapshot.requestBytes,
        responseBytes: meterSnapshot.responseBytes,
        bytesTransferred:
          meterSnapshot.requestBytes + meterSnapshot.responseBytes,
        avgMemoryMb: memoryMetrics.avgMemoryMb,
        peakMemoryMb: memoryMetrics.peakMemoryMb,
        avgCpuPct: cpuMetrics.avgCpuPct,
        peakCpuPct: cpuMetrics.peakCpuPct,
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
      'Bootstrap downloads an official Turso Sync replica from a cold local database file and waits until the local SQL count reaches the target.',
      'The local tursodb sync server implements the same protocol as Turso Cloud without adding managed-network latency.',
    ],
    metadata: {
      implementation: 'turso-sync-native-js',
      productVersion: '0.7.0',
      scales: scaleResults as unknown as JsonValue,
    },
  };
}

async function runOnlinePropagation(): Promise<RunnerResult> {
  await ensureStackUp('turso');
  await seedStack('turso', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });
  const fixtures = await getFixtures('turso');
  if (!fixtures.sampleTaskId) throw new Error('Turso fixtures are missing a task');

  const meter = createHttpMeter(globalThis.fetch);
  const writer = await createSession('online-writer', meter.fetch);
  const reader = await createSession('online-reader', meter.fetch);
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    await pullUntilCount(writer.db, 'tasks', 200);
    await pullUntilCount(reader.db, 'tasks', 200);
    const samples: OnlinePropagationSample[] = [];

    for (let iteration = 0; iteration < 15; iteration += 1) {
      const title = `turso-online-${iteration}-${Date.now()}`;
      const startedAt = performance.now();
      const update = await writer.db.prepare(
        `update tasks set title = ?, server_version = server_version + 1,
         updated_at = ? where id = ?`
      );
      await update.run(title, new Date().toISOString(), fixtures.sampleTaskId);
      const writeAckMs = performance.now() - startedAt;
      await writer.db.push();
      await pullUntilTitle(reader.db, fixtures.sampleTaskId, title);
      samples.push({
        iteration,
        writeAckMs: round(writeAckMs),
        mirrorVisibleMs: round(performance.now() - startedAt),
      });
    }

    const meterSnapshot = meter.snapshot();
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();
    const visibility = samples.map((sample) => sample.mirrorVisibleMs);

    return {
      status: 'completed',
      metrics: {
        write_ack_ms: average(samples.map((sample) => sample.writeAckMs)),
        mirror_visible_p50_ms: percentile(visibility, 50),
        mirror_visible_p95_ms: percentile(visibility, 95),
        mirror_visible_p99_ms: percentile(visibility, 99),
        iterations: samples.length,
        request_count: meterSnapshot.requestCount,
        request_bytes: meterSnapshot.requestBytes,
        response_bytes: meterSnapshot.responseBytes,
        bytes_transferred:
          meterSnapshot.requestBytes + meterSnapshot.responseBytes,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'write_ack_ms is the native local Turso SQL commit; mirror visibility includes push and the second replica pull.',
      ],
      metadata: {
        implementation: 'turso-sync-native-js',
        productVersion: '0.7.0',
        samples: samples as unknown as JsonValue,
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await writer.close();
    await reader.close();
  }
}

async function runOfflineReplay(): Promise<RunnerResult> {
  const replay = await runOfflineReplayCase(10, 'turso-offline');
  return {
    status: 'completed',
    metrics: {
      queued_mutations: replay.queuedWriteCount,
      replay_visible_ms: replay.replayVisibleMs,
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
      'Writes commit to the native Turso local database while the sync server is stopped, then push after reconnect.',
      'Convergence requires the second native replica to observe all updated rows; low-level CDC bookkeeping is recorded separately from application writes.',
    ],
    metadata: {
      implementation: 'turso-sync-native-offline-replay',
      productVersion: '0.7.0',
      cdcOperationsBeforeReplay: replay.cdcOperationsBeforeReplay,
      pendingAfterReplay: replay.pendingAfterReplay,
    },
  };
}

async function runLargeOfflineQueue(): Promise<RunnerResult> {
  const queueSizes = [100, 500, 1_000];
  const results: OfflineReplayResult[] = [];
  for (const queueSize of queueSizes) {
    results.push(
      await runOfflineReplayCase(queueSize, `turso-large-offline-${queueSize}`)
    );
  }

  return {
    status: 'completed',
    metrics: Object.fromEntries(
      results.flatMap((entry, index) => {
        const queueSize = queueSizes[index]!;
        return [
          [`queue_${queueSize}_queued_writes`, entry.queuedWriteCount],
          [`queue_${queueSize}_convergence_ms`, entry.replayVisibleMs],
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
      'Large queue replay uses Turso Sync CDC persisted beside the local database; no harness outbox is involved.',
    ],
    metadata: {
      implementation: 'turso-sync-native-large-queue',
      productVersion: '0.7.0',
      queueSizes,
      cdcOperationsBeforeReplay: results.map(
        (entry) => entry.cdcOperationsBeforeReplay
      ),
      pendingAfterReplay: results.map((entry) => entry.pendingAfterReplay),
    },
  };
}

async function runOfflineReplayCase(
  queueSize: number,
  titlePrefix: string
): Promise<OfflineReplayResult> {
  await ensureStackUp('turso');
  const expectedRows = Math.max(200, queueSize + 25);
  await seedStack('turso', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: expectedRows,
    membershipsPerProject: 2,
  });
  const fixtures = await getFixtures('turso');
  if (!fixtures.sampleProjectId) throw new Error('Turso fixtures are missing a project');
  const targets = (
    await listTasks('turso', {
      projectId: fixtures.sampleProjectId,
      limit: queueSize + 10,
    })
  ).slice(0, queueSize);
  if (targets.length !== queueSize) {
    throw new Error(`Turso queue needs ${queueSize} rows, got ${targets.length}`);
  }

  const meter = createHttpMeter(globalThis.fetch);
  const writer = await createSession(`offline-writer-${queueSize}`, meter.fetch);
  const reader = await createSession(`offline-reader-${queueSize}`, meter.fetch);
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();
  let serviceStopped = false;

  try {
    await pullUntilCount(writer.db, 'tasks', expectedRows);
    await pullUntilCount(reader.db, 'tasks', expectedRows);
    stopService('turso', 'sync');
    serviceStopped = true;

    const update = await writer.db.prepare(
      `update tasks set title = ?, server_version = server_version + 1,
       updated_at = ? where id = ?`
    );
    for (let index = 0; index < targets.length; index += 1) {
      const task = targets[index]!;
      await update.run(
        `${titlePrefix}-${index}`,
        new Date().toISOString(),
        task.id
      );
    }

    const pendingBefore = (await writer.db.stats()).cdcOperations;
    const startedAt = performance.now();
    startService('turso', 'sync');
    serviceStopped = false;
    await waitForSyncServer();
    await writer.db.push();

    const deadline = Date.now() + Math.max(120_000, queueSize * 500);
    let visible = 0;
    while (Date.now() < deadline) {
      await reader.db.pull();
      const countMatching = await reader.db.prepare(
        'select count(*) as count from tasks where title like ?'
      );
      const row = (await countMatching.get(`${titlePrefix}-%`)) as {
        count: number | bigint;
      };
      visible = Number(row.count);
      if (visible === queueSize) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (visible !== queueSize) {
      throw new Error(`Turso replay exposed ${visible}/${queueSize} queued writes`);
    }

    const meterSnapshot = meter.snapshot();
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();
    return {
      queuedWriteCount: queueSize,
      cdcOperationsBeforeReplay: pendingBefore,
      replayVisibleMs: round(performance.now() - startedAt),
      requestCount: meterSnapshot.requestCount,
      requestBytes: meterSnapshot.requestBytes,
      responseBytes: meterSnapshot.responseBytes,
      bytesTransferred:
        meterSnapshot.requestBytes + meterSnapshot.responseBytes,
      avgMemoryMb: memoryMetrics.avgMemoryMb,
      peakMemoryMb: memoryMetrics.peakMemoryMb,
      avgCpuPct: cpuMetrics.avgCpuPct,
      peakCpuPct: cpuMetrics.peakCpuPct,
      pendingAfterReplay: (await writer.db.stats()).cdcOperations,
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    if (serviceStopped) {
      startService('turso', 'sync');
      await waitForSyncServer().catch(() => undefined);
    }
    await writer.close();
    await reader.close();
  }
}

async function runLocalQuery(): Promise<RunnerResult> {
  await ensureStackUp('turso');
  await seedStack('turso', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 100_000,
    membershipsPerProject: 2,
  });
  const fixtures = await getFixtures('turso');
  const projectId = fixtures.sampleProjectId;
  const ownerId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
  if (!projectId || !ownerId) throw new Error('Turso fixtures are incomplete');

  const session = await createSession('local-query');
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    await pullUntilCount(session.db, 'tasks', 100_000, 300_000);
    const listSamples: number[] = [];
    const searchSamples: number[] = [];
    const aggregateSamples: number[] = [];
    let listResultCount = 0;
    let searchResultCount = 0;
    let aggregateResultCount = 0;

    for (let iteration = 0; iteration < 25; iteration += 1) {
      const list = await timeQuery(
        session.db,
        `select id from tasks
         where project_id = ? and owner_id = ? and completed = 0
         order by updated_at desc limit 50`,
        [projectId, ownerId]
      );
      const search = await timeQuery(
        session.db,
        `select id from tasks
         where project_id = ? and id like 'org-1-project-1-task-00%'
         order by id limit 100`,
        [projectId]
      );
      const aggregate = await timeQuery(
        session.db,
        `select owner_id, completed, count(*) as count from tasks
         where project_id = ? group by owner_id, completed`,
        [projectId]
      );
      listSamples.push(list.elapsedMs);
      searchSamples.push(search.elapsedMs);
      aggregateSamples.push(aggregate.elapsedMs);
      listResultCount = list.resultCount;
      searchResultCount = search.resultCount;
      aggregateResultCount = aggregate.resultCount;
    }

    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();
    return {
      status: 'completed',
      metrics: {
        row_count: 100_000,
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
        'All queries execute directly against the native local Turso replica after synchronization.',
      ],
      metadata: {
        implementation: 'turso-sync-native-local-sql',
        productVersion: '0.7.0',
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await session.close();
  }
}

async function runDeepRelationshipQuery(): Promise<RunnerResult> {
  await ensureStackUp('turso');
  await seedStack('turso', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 4,
    usersPerOrg: 10,
    tasksPerProject: 25_000,
    membershipsPerProject: 4,
  });
  const fixtures = await getFixtures('turso');
  if (!fixtures.sampleOrgId || !fixtures.sampleProjectId) {
    throw new Error('Turso relationship fixtures are incomplete');
  }

  const session = await createSession('deep-relationship-query');
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    await pullUntilCount(session.db, 'tasks', 100_000, 300_000);
    const dashboardSamples: number[] = [];
    const detailSamples: number[] = [];
    let dashboardResultCount = 0;
    let detailResultCount = 0;

    for (let iteration = 0; iteration < 25; iteration += 1) {
      const dashboard = await timeQuery(
        session.db,
        `select o.name as org_name, p.id as project_id, p.name as project_name,
                count(t.id) as task_count,
                sum(case when t.completed = 0 then 1 else 0 end) as open_task_count
         from organizations o
         join projects p on p.org_id = o.id
         left join tasks t on t.project_id = p.id
         where o.id = ?
         group by o.name, p.id, p.name
         order by open_task_count desc, p.id
         limit 20`,
        [fixtures.sampleOrgId]
      );
      const detail = await timeQuery(
        session.db,
        `select t.id, t.title, p.name as project_name, o.name as org_name
         from tasks t
         join projects p on p.id = t.project_id
         join organizations o on o.id = p.org_id
         where p.id = ? order by t.id limit 100`,
        [fixtures.sampleProjectId]
      );
      dashboardSamples.push(dashboard.elapsedMs);
      detailSamples.push(detail.elapsedMs);
      dashboardResultCount = dashboard.resultCount;
      detailResultCount = detail.resultCount;
    }

    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();
    return {
      status: 'completed',
      metrics: {
        org_count: 1,
        project_count: 4,
        row_count: 100_000,
        iterations: 25,
        dashboard_query_p50_ms: percentile(dashboardSamples, 50),
        dashboard_query_p95_ms: percentile(dashboardSamples, 95),
        detail_join_query_p50_ms: percentile(detailSamples, 50),
        detail_join_query_p95_ms: percentile(detailSamples, 95),
        dashboard_result_count: dashboardResultCount,
        detail_join_result_count: detailResultCount,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'Relationship workloads use native joins and aggregation over the local Turso SQL replica.',
      ],
      metadata: {
        implementation: 'turso-sync-native-relational-sql',
        productVersion: '0.7.0',
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await session.close();
  }
}

async function timeQuery(
  db: Database,
  sql: string,
  params: unknown[]
): Promise<QuerySample> {
  const startedAt = performance.now();
  const statement = await db.prepare(sql);
  const rows = (await statement.all(...params)) as unknown[];
  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}
