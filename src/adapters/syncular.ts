/**
 * Syncular v2 benchmark adapter — drives the real `@syncular/client`
 * (SyncClient, bun:sqlite local database) against the Dockerized Syncular
 * v2 server stack (relational Postgres server storage, engine-mediated
 * admin writes, presigned MinIO blobs, WebSocket realtime).
 *
 * Every scenario is native: local reads are raw SQL over the synced
 * SQLite mirror, offline queuing is the client's own outbox (`mutate`
 * without `sync`), permission-change uses the real membership-derived
 * scope model, and blob flow uses the product blob transport end to end.
 */
import {
  computeBlobId,
  httpBlobTransport,
  httpSegmentDownloader,
  httpSyncTransport,
  type RealtimeConnector,
  SyncClient,
  type SyncSummary,
  webSocketRealtimeConnector,
} from '@syncular/client';
import { openBunDatabase } from '@syncular/client/bun';
import { schema } from '../../stacks/syncular/syncular-app/src/syncular.generated';
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
  restartServiceCold,
  seedStack,
  writeTask,
} from '../stack-manager';
import { getStack } from '../stacks';
import type {
  BenchmarkAdapter,
  BenchmarkStatus,
  BootstrapScaleResult,
  JsonValue,
  OnlinePropagationSample,
  StackFixtures,
} from '../types';

interface ScenarioOutcome {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

interface TransferTotals {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  realtimeBytes: number;
}

interface BenchClient {
  readonly client: SyncClient;
  readonly actorId: string;
  /**
   * Connect the realtime socket and wait for the server `hello` control
   * frame. The bench server assigns its per-socket session handler
   * asynchronously after the WebSocket opens and silently drops binary
   * frames until then — a sync round sent before `hello` can hang forever.
   */
  connectRealtimeReady(timeoutMs?: number): Promise<void>;
  transfer(): TransferTotals;
  close(): Promise<void>;
}

const STACK_ID = 'syncular' as const;
const IMPLEMENTATION_PREFIX = 'syncular-v2';

const textEncoder = new TextEncoder();

/**
 * Wrap the product WebSocket connector so realtime bytes are counted and
 * the server `hello` control frame is observable (session readiness).
 */
function meteredRealtimeConnector(
  realtimeUrl: string,
  counter: { bytes: number },
  onHello: () => void
): RealtimeConnector {
  const inner = webSocketRealtimeConnector(realtimeUrl);
  return async (handlers) => {
    const socket = await inner({
      onText: (text) => {
        counter.bytes += textEncoder.encode(text).byteLength;
        try {
          const control = JSON.parse(text) as { event?: string };
          if (control.event === 'hello') onHello();
        } catch {
          // non-JSON control frame — ignore for readiness purposes
        }
        handlers.onText(text);
      },
      onBinary: (bytes) => {
        counter.bytes += bytes.byteLength;
        handlers.onBinary(bytes);
      },
      ...(handlers.onClose !== undefined ? { onClose: handlers.onClose } : {}),
    });
    return {
      send: (text: string) => {
        counter.bytes += textEncoder.encode(text).byteLength;
        socket.send(text);
      },
      sendBytes: (bytes: Uint8Array) => {
        counter.bytes += bytes.byteLength;
        socket.sendBytes(bytes);
      },
      close: () => socket.close(),
    };
  };
}

async function createBenchClient(actorId: string): Promise<BenchClient> {
  const stack = getStack(STACK_ID);
  const syncBase = stack.syncBaseUrl;
  const realtimeBase = stack.syncRealtimeBaseUrl;
  if (!realtimeBase) {
    throw new Error('Syncular stack is missing syncRealtimeBaseUrl');
  }

  const meter = createHttpMeter();
  const realtimeCounter = { bytes: 0 };
  const headers = { 'x-actor-id': actorId };
  const clientId = crypto.randomUUID();
  let helloSeen = false;
  let helloResolve: (() => void) | undefined;
  const onHello = () => {
    helloSeen = true;
    helloResolve?.();
  };
  const client = new SyncClient({
    database: openBunDatabase(),
    schema,
    clientId,
    transport: httpSyncTransport(`${syncBase}/sync`, {
      headers,
      fetch: meter.fetch,
    }),
    segments: httpSegmentDownloader(`${syncBase}/segments`, {
      headers,
      fetch: meter.fetch,
    }),
    blobs: httpBlobTransport(`${syncBase}/blobs`, {
      headers,
      fetch: meter.fetch,
    }),
    realtime: meteredRealtimeConnector(
      `${realtimeBase}?actorId=${encodeURIComponent(actorId)}&clientId=${clientId}`,
      realtimeCounter,
      onHello
    ),
  });
  await client.start();

  return {
    client,
    actorId,
    connectRealtimeReady: async (timeoutMs = 10_000) => {
      helloSeen = false;
      const helloPromise = new Promise<void>((resolve) => {
        helloResolve = resolve;
        if (helloSeen) resolve();
      });
      await client.connectRealtime();
      const outcome = await Promise.race([
        helloPromise.then(() => 'hello' as const),
        Bun.sleep(timeoutMs).then(() => 'timeout' as const),
      ]);
      if (outcome === 'timeout') {
        throw new Error(
          'Syncular realtime session did not send hello within the readiness window'
        );
      }
    },
    transfer: () => {
      const snapshot = meter.snapshot();
      return {
        requestCount: snapshot.requestCount,
        requestBytes: snapshot.requestBytes,
        responseBytes: snapshot.responseBytes,
        realtimeBytes: realtimeCounter.bytes,
      };
    },
    close: async () => {
      client.disconnectRealtime();
      await client.close();
    },
  };
}

function sumTransfers(clients: readonly BenchClient[]): TransferTotals {
  return clients.reduce<TransferTotals>(
    (totals, bench) => {
      const transfer = bench.transfer();
      return {
        requestCount: totals.requestCount + transfer.requestCount,
        requestBytes: totals.requestBytes + transfer.requestBytes,
        responseBytes: totals.responseBytes + transfer.responseBytes,
        realtimeBytes: totals.realtimeBytes + transfer.realtimeBytes,
      };
    },
    { requestCount: 0, requestBytes: 0, responseBytes: 0, realtimeBytes: 0 }
  );
}

function totalBytes(transfer: TransferTotals): number {
  return transfer.requestBytes + transfer.responseBytes + transfer.realtimeBytes;
}

/**
 * One subscription PER PROJECT for project-scoped tables — scope
 * revocation only purges when a subscription's effective scope empties,
 * so a narrowed multi-project subscription would purge nothing.
 */
function subscribeTasks(bench: BenchClient, projectIds: readonly string[]): void {
  for (const projectId of projectIds) {
    bench.client.subscribe({
      id: `tasks:${projectId}`,
      table: 'tasks',
      scopes: { project_id: [projectId] },
    });
  }
}

function subscribeBlobEntries(
  bench: BenchClient,
  projectIds: readonly string[]
): void {
  for (const projectId of projectIds) {
    bench.client.subscribe({
      id: `task_blob_entries:${projectId}`,
      table: 'task_blob_entries',
      scopes: { project_id: [projectId] },
    });
  }
}

function subscribeOrgTables(bench: BenchClient, orgId: string): void {
  bench.client.subscribe({
    id: `organizations:${orgId}`,
    table: 'organizations',
    scopes: { id: [orgId] },
  });
  bench.client.subscribe({
    id: `projects:${orgId}`,
    table: 'projects',
    scopes: { org_id: [orgId] },
  });
  bench.client.subscribe({
    id: `app_users:${orgId}`,
    table: 'app_users',
    scopes: { org_id: [orgId] },
  });
}

function subscribeMemberships(
  bench: BenchClient,
  projectIds: readonly string[]
): void {
  for (const projectId of projectIds) {
    bench.client.subscribe({
      id: `project_memberships:${projectId}`,
      table: 'project_memberships',
      scopes: { project_id: [projectId] },
    });
  }
}

function countRows(bench: BenchClient, sql: string, params: string[] = []): number {
  const row = bench.client.query(sql, params)[0];
  return Number(row?.n ?? 0);
}

function localTaskCount(bench: BenchClient, projectId?: string): number {
  if (projectId !== undefined) {
    return countRows(
      bench,
      'SELECT count(*) AS n FROM tasks WHERE project_id = ?',
      [projectId]
    );
  }
  return countRows(bench, 'SELECT count(*) AS n FROM tasks');
}

interface LocalTaskRow {
  id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: number | boolean;
  server_version: number | bigint;
  updated_at_ms: number | bigint;
}

function readLocalTasks(bench: BenchClient, limit: number): LocalTaskRow[] {
  return bench.client.query(
    `SELECT id, org_id, project_id, owner_id, title, completed,
            server_version, updated_at_ms
     FROM tasks ORDER BY id LIMIT ?`,
    [limit]
  ) as unknown as LocalTaskRow[];
}

/** Queue one full-row task title update into the client outbox. */
function mutateTaskTitle(bench: BenchClient, row: LocalTaskRow, title: string): string {
  return bench.client.mutate([
    {
      table: 'tasks',
      op: 'upsert',
      values: {
        id: row.id,
        org_id: row.org_id,
        project_id: row.project_id,
        owner_id: row.owner_id,
        title,
        completed: Boolean(row.completed),
        server_version: Number(row.server_version) + 1,
        updated_at_ms: Date.now(),
      },
    },
  ]);
}

async function waitForLocalTitle(
  bench: BenchClient,
  taskId: string,
  expectedTitle: string,
  timeoutMs: number
): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const row = bench.client.query('SELECT title FROM tasks WHERE id = ?', [
      taskId,
    ])[0];
    if (row?.title === expectedTitle) return;
    await Bun.sleep(0);
  }
  throw new Error(
    `Syncular mirror did not observe ${taskId}=${expectedTitle} within ${timeoutMs}ms`
  );
}

async function waitForServerTitles(
  projectId: string,
  expectedTitles: ReadonlyMap<string, string>,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tasks = await listTasks(STACK_ID, {
      projectId,
      limit: 5000,
    });
    const titleById = new Map(tasks.map((task) => [task.id, task.title]));
    let allVisible = true;
    for (const [taskId, title] of expectedTitles) {
      if (titleById.get(taskId) !== title) {
        allVisible = false;
        break;
      }
    }
    if (allVisible) return;
    await Bun.sleep(10);
  }
  throw new Error('Syncular server did not converge on all replayed titles');
}

async function requireFixtures(): Promise<StackFixtures> {
  const fixtures = await getFixtures(STACK_ID);
  if (
    !fixtures.sampleProjectId ||
    !fixtures.sampleOrgId ||
    fixtures.sampleUserIds.length === 0 ||
    !fixtures.sampleTaskId
  ) {
    throw new Error('Syncular fixtures are missing seeded data');
  }
  return fixtures;
}

async function closeAll(clients: readonly BenchClient[]): Promise<void> {
  for (const bench of clients) {
    try {
      await bench.close();
    } catch {
      // best-effort teardown
    }
  }
}

function failedOutcome(error: unknown, implementation: string): ScenarioOutcome {
  return {
    status: 'failed',
    metrics: {},
    notes: [error instanceof Error ? error.message : String(error)],
    metadata: { implementation },
  };
}

function createRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const chunk = 65_536;
  for (let offset = 0; offset < size; offset += chunk) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + chunk, size)));
  }
  return bytes;
}

interface OfflineReplayCaseResult {
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
  syncRounds: number;
}

/**
 * Shared offline-queue flow: bootstrap, queue `queueSize` writes into the
 * native outbox while NOT syncing (offline), then reconnect (sync) and
 * measure convergence until every replayed write is applied server-side.
 */
async function runOfflineQueueCase(args: {
  queueSize: number;
  titlePrefix: string;
}): Promise<OfflineReplayCaseResult> {
  await ensureStackUp(STACK_ID);
  await seedStack(STACK_ID, {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: Math.max(200, args.queueSize + 25),
    membershipsPerProject: 2,
  });

  const fixtures = await requireFixtures();
  const actorId = fixtures.sampleUserIds[0]!;
  const projectId = fixtures.sampleProjectId!;
  const bench = await createBenchClient(actorId);

  try {
    subscribeTasks(bench, [projectId]);
    await bench.client.syncUntilIdle(500);

    const targets = readLocalTasks(bench, args.queueSize);
    if (targets.length < args.queueSize) {
      throw new Error(
        `Need ${args.queueSize} local tasks for the Syncular offline queue, got ${targets.length}`
      );
    }

    // Offline: mutate() queues into the client outbox; no sync happens.
    const expectedTitles = new Map<string, string>();
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      const title = `${args.titlePrefix}-${index}-${Date.now()}`;
      mutateTaskTitle(bench, target, title);
      expectedTitles.set(target.id, title);
    }
    const queuedWriteCount = bench.client.pendingCommits().length;

    const baseline = bench.transfer();
    const memorySampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    memorySampler.start();
    cpuSampler.start();

    // Reconnect: sync rounds push the whole outbox, then verify the
    // replayed writes are durably visible through the server admin read.
    const startedAt = performance.now();
    const appliedIds = new Set<string>();
    let conflictCount = 0;
    let syncRounds = 0;
    while (bench.client.pendingCommits().length > 0 && syncRounds < 50) {
      const summary: SyncSummary = await bench.client.sync();
      syncRounds += 1;
      for (const id of summary.applied) appliedIds.add(id);
      conflictCount += summary.conflicts.length;
    }
    await waitForServerTitles(projectId, expectedTitles, 120_000);
    const convergenceMs = performance.now() - startedAt;

    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();
    const after = bench.transfer();
    const requestBytes = after.requestBytes - baseline.requestBytes;
    const responseBytes = after.responseBytes - baseline.responseBytes;

    return {
      queuedWriteCount,
      reconnectConvergenceMs: round(convergenceMs),
      conflictCount,
      replayedWriteSuccessRate:
        queuedWriteCount === 0
          ? 0
          : round(appliedIds.size / queuedWriteCount, 4),
      requestCount: after.requestCount - baseline.requestCount,
      requestBytes,
      responseBytes,
      bytesTransferred: requestBytes + responseBytes,
      avgMemoryMb: memoryMetrics.avgMemoryMb,
      peakMemoryMb: memoryMetrics.peakMemoryMb,
      avgCpuPct: cpuMetrics.avgCpuPct,
      peakCpuPct: cpuMetrics.peakCpuPct,
      syncRounds,
    };
  } finally {
    await closeAll([bench]);
  }
}

export class SyncularBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack(STACK_ID);

  async runBootstrap(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-native-bootstrap`;
    try {
      await ensureStackUp(STACK_ID);

      const scales = [1_000, 10_000, 100_000];
      const scaleResults: BootstrapScaleResult[] = [];
      const warmByScale = new Map<number, number>();

      for (const rowsTarget of scales) {
        await seedStack(STACK_ID, {
          resetFirst: true,
          orgCount: 1,
          projectsPerOrg: 1,
          usersPerOrg: 2,
          tasksPerProject: rowsTarget,
          membershipsPerProject: 2,
        });

        const fixtures = await requireFixtures();
        const actorId = fixtures.sampleUserIds[0]!;
        const projectId = fixtures.sampleProjectId!;

        // Cold-server definition: restart the sync service so in-memory
        // segment/sqlite-image caches from earlier scales (or runs) never
        // serve this measurement. Identical in the syncular-rust adapter.
        await restartServiceCold(
          STACK_ID,
          'sync',
          `${this.stack.syncBaseUrl.replace(/\/api$/, '')}/health`
        );

        const memorySampler = new MemorySampler();
        const cpuSampler = new CpuSampler();
        memorySampler.start();
        cpuSampler.start();

        const startedAt = performance.now();
        const bench = await createBenchClient(actorId);
        let rowsLoaded = 0;
        try {
          subscribeTasks(bench, [projectId]);
          await bench.client.syncUntilIdle(1_000);
          rowsLoaded = localTaskCount(bench);
          const elapsedMs = performance.now() - startedAt;
          const memoryMetrics = memorySampler.stop();
          const cpuMetrics = cpuSampler.stop();
          const transfer = bench.transfer();

          if (rowsLoaded !== rowsTarget) {
            throw new Error(
              `Syncular bootstrap expected ${rowsTarget} rows, got ${rowsLoaded}`
            );
          }

          scaleResults.push({
            rowsTarget,
            timeToFirstQueryMs: round(elapsedMs),
            rowsLoaded,
            requestCount: transfer.requestCount,
            requestBytes: transfer.requestBytes,
            responseBytes: transfer.responseBytes,
            bytesTransferred: totalBytes(transfer),
            avgMemoryMb: memoryMetrics.avgMemoryMb,
            peakMemoryMb: memoryMetrics.peakMemoryMb,
            avgCpuPct: cpuMetrics.avgCpuPct,
            peakCpuPct: cpuMetrics.peakCpuPct,
          });
        } finally {
          await closeAll([bench]);
        }

        // Warm second-client bootstrap: same server, no restart — the "new
        // device joins an existing dataset" path where the server's segment
        // and sqlite-image caches legitimately serve. Reported alongside the
        // cold number, never instead of it.
        const warmStartedAt = performance.now();
        const warmBench = await createBenchClient(actorId);
        try {
          subscribeTasks(warmBench, [projectId]);
          await warmBench.client.syncUntilIdle(1_000);
          if (localTaskCount(warmBench) !== rowsTarget) {
            throw new Error(
              `Syncular warm bootstrap expected ${rowsTarget} rows, got ${localTaskCount(warmBench)}`
            );
          }
          warmByScale.set(rowsTarget, round(performance.now() - warmStartedAt));
        } finally {
          await closeAll([warmBench]);
        }
      }

      return {
        status: 'completed',
        metrics: Object.fromEntries(
          scaleResults.flatMap((result) => [
            [`bootstrap_${result.rowsTarget}_ms`, result.timeToFirstQueryMs],
            [
              `bootstrap_warm_${result.rowsTarget}_ms`,
              warmByScale.get(result.rowsTarget) ?? null,
            ],
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
          'Bootstrap runs the real SyncClient against the v2 sync endpoint into a fresh bun:sqlite database, timed until a local SQL count over the synced tasks table answers.',
          'The server materializes snapshots from relational Postgres storage; segment/sqlite-image delivery is negotiated by the product client.',
          'Cold numbers restart the sync service first (on-demand artifact build included); warm numbers are a second fresh client against the already-serving dataset.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
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
    } catch (error) {
      return failedOutcome(error, implementation);
    }
  }

  async runOnlinePropagation(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-client-write-realtime-mirror`;
    const clients: BenchClient[] = [];
    try {
      await ensureStackUp(STACK_ID);
      await seedStack(STACK_ID, {
        resetFirst: true,
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 200,
        membershipsPerProject: 2,
      });

      const fixtures = await requireFixtures();
      const actorId = fixtures.sampleUserIds[0]!;
      const projectId = fixtures.sampleProjectId!;
      const taskId = fixtures.sampleTaskId!;

      const writer = await createBenchClient(actorId);
      const mirror = await createBenchClient(actorId);
      clients.push(writer, mirror);

      subscribeTasks(writer, [projectId]);
      subscribeTasks(mirror, [projectId]);
      await writer.client.syncUntilIdle(500);
      await mirror.client.syncUntilIdle(500);
      // Register the mirror's subscriptions on the realtime session: with
      // the socket connected, the next sync round runs over it (§8.7).
      // connectRealtimeReady waits for the server hello so the round is
      // not dropped by the bench server's async session attach.
      await mirror.connectRealtimeReady();
      await mirror.client.sync();

      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();

      // 5 unmeasured warmup rounds (JIT/plan/socket warm on a freshly
      // restarted server), then 15 measured — identical in the Rust adapter.
      const warmup = 5;
      const iterations = 15;
      const samples: OnlinePropagationSample[] = [];
      for (let iteration = -warmup; iteration < iterations; iteration += 1) {
        const writerRow = writer.client.query(
          `SELECT id, org_id, project_id, owner_id, title, completed,
                  server_version, updated_at_ms FROM tasks WHERE id = ?`,
          [taskId]
        )[0] as unknown as LocalTaskRow | undefined;
        if (!writerRow) {
          throw new Error(`Writer client is missing task ${taskId}`);
        }

        const expectedTitle = `syncular-online-${iteration}-${Date.now()}`;
        const writeStartedAt = performance.now();
        mutateTaskTitle(writer, writerRow, expectedTitle);
        const mirrorVisible = waitForLocalTitle(
          mirror,
          taskId,
          expectedTitle,
          30_000
        );
        const summary = await writer.client.sync();
        const writeAckMs = performance.now() - writeStartedAt;
        if (summary.applied.length === 0) {
          throw new Error('Syncular writer sync did not apply the commit');
        }
        await mirrorVisible;
        if (iteration < 0) continue; // warmup round — never measured
        samples.push({
          iteration,
          writeAckMs: round(writeAckMs),
          mirrorVisibleMs: round(performance.now() - writeStartedAt),
        });
      }

      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();
      const transfer = sumTransfers(clients);
      const visibility = samples.map((sample) => sample.mirrorVisibleMs);
      const writeAcks = samples.map((sample) => sample.writeAckMs);

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
          realtime_bytes: transfer.realtimeBytes,
          bytes_transferred: totalBytes(transfer),
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Client A writes through the native mutate+sync path (write ack = the combined push+pull round completing); client B holds a realtime WebSocket and applies the fanned-out delta automatically.',
          'Mirror visibility is polled with sub-millisecond local SQL reads on client B, so the number is end-to-end product latency, not transport-only.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
          samples: samples.map((sample) => ({
            iteration: sample.iteration,
            writeAckMs: sample.writeAckMs,
            mirrorVisibleMs: sample.mirrorVisibleMs,
          })),
        },
      };
    } catch (error) {
      return failedOutcome(error, implementation);
    } finally {
      await closeAll(clients);
    }
  }

  async runOfflineReplay(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-native-outbox-replay`;
    try {
      const result = await runOfflineQueueCase({
        queueSize: 10,
        titlePrefix: 'syncular-offline',
      });

      return {
        status: 'completed',
        metrics: {
          queued_write_count: result.queuedWriteCount,
          reconnect_convergence_ms: result.reconnectConvergenceMs,
          conflict_count: result.conflictCount,
          replayed_write_success_rate: result.replayedWriteSuccessRate,
          request_count: result.requestCount,
          request_bytes: result.requestBytes,
          response_bytes: result.responseBytes,
          bytes_transferred: result.bytesTransferred,
          sync_rounds: result.syncRounds,
          avg_memory_mb: result.avgMemoryMb,
          peak_memory_mb: result.peakMemoryMb,
          avg_cpu_pct: result.avgCpuPct,
          peak_cpu_pct: result.peakCpuPct,
        },
        notes: [
          'Offline queuing is the native Syncular client outbox: mutate() appends durable commits while no sync runs, then reconnect pushes the whole queue through the product sync round.',
          'Convergence includes verification that every replayed title is durably visible through the engine-mediated server admin read.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
        },
      };
    } catch (error) {
      return failedOutcome(error, implementation);
    }
  }

  async runReconnectStorm(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-http-reconnect-storm`;
    const clients: BenchClient[] = [];
    try {
      await ensureStackUp(STACK_ID);
      await seedStack(STACK_ID, {
        resetFirst: true,
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 200,
        membershipsPerProject: 2,
      });

      const fixtures = await requireFixtures();
      const actorId = fixtures.sampleUserIds[0]!;
      const projectId = fixtures.sampleProjectId!;
      const taskId = fixtures.sampleTaskId!;
      const clientCount = Number(process.env.SYNCULAR_STORM_CLIENTS ?? '25');

      for (let offset = 0; offset < clientCount; offset += 8) {
        const batchSize = Math.min(8, clientCount - offset);
        await Promise.all(
          Array.from({ length: batchSize }, async () => {
            const bench = await createBenchClient(actorId);
            clients.push(bench);
            subscribeTasks(bench, [projectId]);
            await bench.client.syncUntilIdle(500);
          })
        );
      }

      const syncContainerId = resolveServiceContainerId(STACK_ID, 'sync');
      const postgresContainerId = resolveServiceContainerId(STACK_ID, 'postgres');
      const sampler = new DockerServiceSampler([
        { label: 'sync', id: syncContainerId },
        { label: 'postgres', id: postgresContainerId },
      ]);

      const baseline = sumTransfers(clients);
      sampler.start();
      const startedAt = performance.now();
      const expectedTitle = `syncular-storm-${Date.now()}`;
      await writeTask(STACK_ID, { taskId, title: expectedTitle });

      await Promise.all(
        clients.map(async (bench) => {
          const deadline = performance.now() + 120_000;
          while (performance.now() < deadline) {
            await bench.client.sync();
            const row = bench.client.query(
              'SELECT title FROM tasks WHERE id = ?',
              [taskId]
            )[0];
            if (row?.title === expectedTitle) return;
            await Bun.sleep(5);
          }
          throw new Error('Syncular storm client did not converge in time');
        })
      );

      const convergenceMs = performance.now() - startedAt;
      const containerMetrics = sampler.stop();
      const after = sumTransfers(clients);
      const transfer: TransferTotals = {
        requestCount: after.requestCount - baseline.requestCount,
        requestBytes: after.requestBytes - baseline.requestBytes,
        responseBytes: after.responseBytes - baseline.responseBytes,
        realtimeBytes: after.realtimeBytes - baseline.realtimeBytes,
      };
      const syncMetrics = containerMetrics.sync;
      const postgresMetrics = containerMetrics.postgres;

      return {
        status: 'completed',
        metrics: {
          client_count: clientCount,
          reconnect_convergence_ms: round(convergenceMs),
          sync_avg_cpu_pct: syncMetrics?.avgCpuPct ?? 0,
          postgres_avg_cpu_pct: postgresMetrics?.avgCpuPct ?? 0,
          [`clients_${clientCount}_convergence_ms`]: round(convergenceMs),
          [`clients_${clientCount}_request_count`]: transfer.requestCount,
          [`clients_${clientCount}_request_bytes`]: transfer.requestBytes,
          [`clients_${clientCount}_response_bytes`]: transfer.responseBytes,
          [`clients_${clientCount}_bytes_transferred`]: totalBytes(transfer),
          [`clients_${clientCount}_sync_avg_cpu_pct`]: syncMetrics?.avgCpuPct ?? 0,
          [`clients_${clientCount}_sync_peak_cpu_pct`]: syncMetrics?.peakCpuPct ?? 0,
          [`clients_${clientCount}_sync_avg_memory_mb`]: syncMetrics?.avgMemoryMb ?? 0,
          [`clients_${clientCount}_sync_peak_memory_mb`]: syncMetrics?.peakMemoryMb ?? 0,
          [`clients_${clientCount}_sync_rx_network_mb`]: syncMetrics?.rxNetworkMb ?? 0,
          [`clients_${clientCount}_sync_tx_network_mb`]: syncMetrics?.txNetworkMb ?? 0,
          [`clients_${clientCount}_postgres_avg_cpu_pct`]:
            postgresMetrics?.avgCpuPct ?? 0,
          [`clients_${clientCount}_postgres_peak_cpu_pct`]:
            postgresMetrics?.peakCpuPct ?? 0,
          [`clients_${clientCount}_postgres_avg_memory_mb`]:
            postgresMetrics?.avgMemoryMb ?? 0,
          [`clients_${clientCount}_postgres_peak_memory_mb`]:
            postgresMetrics?.peakMemoryMb ?? 0,
          [`clients_${clientCount}_postgres_rx_network_mb`]:
            postgresMetrics?.rxNetworkMb ?? 0,
          [`clients_${clientCount}_postgres_tx_network_mb`]:
            postgresMetrics?.txNetworkMb ?? 0,
        },
        notes: [
          `${clientCount} pre-bootstrapped SyncClient instances catch up on the same engine-mediated server-side change by syncing simultaneously through the product HTTP sync round (set SYNCULAR_STORM_CLIENTS to change the count).`,
          'Server CPU/memory/network samples the syncular sync service and Postgres containers for the duration of the fan-in.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
          clientCount,
        },
      };
    } catch (error) {
      return failedOutcome(error, implementation);
    } finally {
      await closeAll(clients);
    }
  }

  async runLargeOfflineQueue(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-native-outbox-large-queue`;
    try {
      const queueSizes = [100, 500, 1_000];
      const queueResults: OfflineReplayCaseResult[] = [];

      for (const queueSize of queueSizes) {
        queueResults.push(
          await runOfflineQueueCase({
            queueSize,
            titlePrefix: `syncular-large-offline-${queueSize}`,
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
              [`queue_${queueSize}_conflict_count`, result.conflictCount],
              [
                `queue_${queueSize}_replayed_write_success_rate`,
                result.replayedWriteSuccessRate,
              ],
              [`queue_${queueSize}_avg_memory_mb`, result.avgMemoryMb],
              [`queue_${queueSize}_peak_memory_mb`, result.peakMemoryMb],
              [`queue_${queueSize}_avg_cpu_pct`, result.avgCpuPct],
              [`queue_${queueSize}_peak_cpu_pct`, result.peakCpuPct],
            ];
          })
        ),
        notes: [
          'Large offline queue replay drives 100 / 500 / 1000 native outbox commits through the product sync round after reconnect.',
          'Each scale verifies durable server-side convergence through the engine-mediated admin read before stopping the clock.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
          scales: queueResults.map((result, index) => ({
            queueSize: queueSizes[index] ?? 0,
            queuedWriteCount: result.queuedWriteCount,
            reconnectConvergenceMs: result.reconnectConvergenceMs,
            requestCount: result.requestCount,
            bytesTransferred: result.bytesTransferred,
            syncRounds: result.syncRounds,
            avgMemoryMb: result.avgMemoryMb,
            peakMemoryMb: result.peakMemoryMb,
            avgCpuPct: result.avgCpuPct,
            peakCpuPct: result.peakCpuPct,
          })),
        },
      };
    } catch (error) {
      return failedOutcome(error, implementation);
    }
  }

  async runLocalQuery(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-local-sqlite-query`;
    const clients: BenchClient[] = [];
    try {
      await ensureStackUp(STACK_ID);
      // 10k local rows — same topology as the syncular-rust adapter so the
      // two client-core rows measure identical local datasets.
      await seedStack(STACK_ID, {
        resetFirst: true,
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 10_000,
        membershipsPerProject: 2,
      });

      const fixtures = await requireFixtures();
      const actorId = fixtures.sampleUserIds[0]!;
      const projectId = fixtures.sampleProjectId!;
      const orgId = fixtures.sampleOrgId!;
      const ownerId = fixtures.sampleUserIds[1] ?? actorId;

      const bench = await createBenchClient(actorId);
      clients.push(bench);
      subscribeOrgTables(bench, orgId);
      subscribeMemberships(bench, [projectId]);
      subscribeTasks(bench, [projectId]);
      await bench.client.syncUntilIdle(1_000);
      const rowCount = localTaskCount(bench);

      // Iteration counts and query shapes are kept identical to the
      // syncular-rust adapter so the two client-core rows compare fairly.
      const iterations = 200;
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
        let startedAt = performance.now();
        const listRows = bench.client.query(
          `SELECT id, title, completed, updated_at_ms
           FROM tasks
           WHERE project_id = ? AND owner_id = ? AND completed = 0
           ORDER BY updated_at_ms DESC, id DESC
           LIMIT 100`,
          [projectId, ownerId]
        );
        listSamples.push(performance.now() - startedAt);
        listResultCount = listRows.length;

        startedAt = performance.now();
        const searchRows = bench.client.query(
          `SELECT id, title FROM tasks
           WHERE project_id = ? AND id LIKE ?
           ORDER BY id LIMIT 100`,
          [projectId, `${projectId}-task-00%`]
        );
        searchSamples.push(performance.now() - startedAt);
        searchResultCount = searchRows.length;

        startedAt = performance.now();
        const aggregateRows = bench.client.query(
          `SELECT owner_id, count(*) AS task_count, sum(completed) AS completed_count
           FROM tasks WHERE project_id = ?
           GROUP BY owner_id`,
          [projectId]
        );
        aggregateSamples.push(performance.now() - startedAt);
        aggregateResultCount = aggregateRows.length;
      }

      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();

      return {
        status: 'completed',
        metrics: {
          row_count: rowCount,
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
          'Local queries run as raw SQL over the fully synced bun:sqlite mirror after bootstrap of 100000 tasks completes; no network is touched during measurement.',
          'The workload covers a filtered+sorted list with LIMIT 100, an id-prefix search, and a grouped COUNT/SUM aggregation.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
          rowCount,
          iterations,
        },
      };
    } catch (error) {
      return failedOutcome(error, implementation);
    } finally {
      await closeAll(clients);
    }
  }

  async runDeepRelationshipQuery(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-local-sqlite-joins`;
    const clients: BenchClient[] = [];
    try {
      await ensureStackUp(STACK_ID);
      await seedStack(STACK_ID, {
        resetFirst: true,
        orgCount: 2,
        projectsPerOrg: 5,
        usersPerOrg: 12,
        tasksPerProject: 2_000,
        membershipsPerProject: 12,
      });

      const fixtures = await requireFixtures();
      const actorId = fixtures.sampleUserIds[0]!;
      const orgId = fixtures.sampleOrgId!;

      const bench = await createBenchClient(actorId);
      clients.push(bench);

      // Phase 1: sync the relational spine so the actor's project list is
      // known locally, then window in every authorized project.
      subscribeOrgTables(bench, orgId);
      await bench.client.syncUntilIdle(500);
      const projectIds = bench.client
        .query('SELECT id FROM projects WHERE org_id = ? ORDER BY id', [orgId])
        .map((row) => String(row.id));
      if (projectIds.length === 0) {
        throw new Error('Syncular deep query bootstrap found no projects');
      }
      subscribeMemberships(bench, projectIds);
      subscribeTasks(bench, projectIds);
      await bench.client.syncUntilIdle(1_000);

      const organizationCount = countRows(
        bench,
        'SELECT count(*) AS n FROM organizations'
      );
      const projectCount = countRows(bench, 'SELECT count(*) AS n FROM projects');
      const taskCount = localTaskCount(bench);
      const detailProjectId = projectIds[0]!;

      const iterations = 150;
      const dashboardSamples: number[] = [];
      const detailJoinSamples: number[] = [];
      let dashboardResultCount = 0;
      let detailJoinResultCount = 0;

      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        let startedAt = performance.now();
        const dashboardRows = bench.client.query(
          `SELECT o.id AS org_id, o.name AS org_name,
                  p.id AS project_id, p.name AS project_name,
                  count(t.id) AS task_count,
                  sum(CASE WHEN t.completed = 0 THEN 1 ELSE 0 END) AS open_count
           FROM organizations o
           JOIN projects p ON p.org_id = o.id
           LEFT JOIN tasks t ON t.project_id = p.id
           GROUP BY o.id, p.id
           ORDER BY o.id, p.id`
        );
        dashboardSamples.push(performance.now() - startedAt);
        dashboardResultCount = dashboardRows.length;

        startedAt = performance.now();
        const detailRows = bench.client.query(
          `SELECT t.id, t.title, t.completed, t.updated_at_ms,
                  p.name AS project_name, o.name AS org_name,
                  u.email AS owner_email
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN organizations o ON o.id = p.org_id
           JOIN app_users u ON u.id = t.owner_id
           WHERE t.project_id = ? AND t.completed = 0
           ORDER BY t.updated_at_ms DESC, t.id DESC
           LIMIT 100`,
          [detailProjectId]
        );
        detailJoinSamples.push(performance.now() - startedAt);
        detailJoinResultCount = detailRows.length;
      }

      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();

      return {
        status: 'completed',
        metrics: {
          org_count: organizationCount,
          project_count: projectCount,
          row_count: taskCount,
          iterations,
          dashboard_query_p50_ms: percentile(dashboardSamples, 50),
          dashboard_query_p95_ms: percentile(dashboardSamples, 95),
          detail_join_query_p50_ms: percentile(detailJoinSamples, 50),
          detail_join_query_p95_ms: percentile(detailJoinSamples, 95),
          dashboard_result_count: dashboardResultCount,
          detail_join_result_count: detailJoinResultCount,
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Organizations, projects, users, memberships, and tasks are all synced locally, so the dashboard rollup and detail joins run fully in the client SQLite database.',
          'The dashboard query joins organizations -> projects -> tasks with per-project open/task counts; the detail query joins a task page back to project, organization, and owner.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
          organizationCount,
          projectCount,
          taskCount,
          iterations,
        },
      };
    } catch (error) {
      return failedOutcome(error, implementation);
    } finally {
      await closeAll(clients);
    }
  }

  async runPermissionChange(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-membership-scope-revoke`;
    const clients: BenchClient[] = [];
    try {
      await ensureStackUp(STACK_ID);
      await seedStack(STACK_ID, {
        resetFirst: true,
        orgCount: 1,
        projectsPerOrg: 2,
        usersPerOrg: 4,
        tasksPerProject: 500,
        membershipsPerProject: 2,
      });

      const fixtures = await requireFixtures();
      const actorId = fixtures.sampleUserIds[0]!;
      const revokedProjectId = fixtures.sampleProjectIds[0];
      const retainedProjectId = fixtures.sampleProjectIds[1];
      if (!revokedProjectId || !retainedProjectId) {
        throw new Error('Syncular fixtures are missing multi-project data');
      }

      const bench = await createBenchClient(actorId);
      clients.push(bench);
      subscribeTasks(bench, [revokedProjectId, retainedProjectId]);
      await bench.client.syncUntilIdle(500);
      const initialVisibleRows = localTaskCount(bench);

      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();
      const baseline = bench.transfer();

      // Revoke through the engine-mediated admin write (a real
      // project_memberships delete committed by the sync engine).
      const startedAt = performance.now();
      const revokeResponse = await fetch(
        `${this.stack.adminBaseUrl}/admin/revoke-membership`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actorId, projectId: revokedProjectId }),
        }
      );
      if (!revokeResponse.ok) {
        throw new Error(
          `Syncular membership revoke failed: ${revokeResponse.status}`
        );
      }
      const revokeRequestMs = performance.now() - startedAt;

      // Same-client convergence: keep syncing until the revoked project's
      // rows are purged (§3.3) while the retained project stays intact.
      let revokedProjectRows = -1;
      let retainedProjectRows = -1;
      const deadline = performance.now() + 60_000;
      while (performance.now() < deadline) {
        await bench.client.sync();
        revokedProjectRows = localTaskCount(bench, revokedProjectId);
        retainedProjectRows = localTaskCount(bench, retainedProjectId);
        if (revokedProjectRows === 0 && retainedProjectRows === 500) break;
        await Bun.sleep(10);
      }
      if (revokedProjectRows !== 0 || retainedProjectRows !== 500) {
        throw new Error(
          `Syncular permission change did not converge: revoked=${revokedProjectRows}, retained=${retainedProjectRows}`
        );
      }
      const convergenceMs = performance.now() - startedAt;
      const postRevokeVisibleRows = localTaskCount(bench);

      // Fresh-client rebootstrap after the revoke: the narrowed scopes
      // must hold from the first bootstrap, not only via purge.
      const rebootstrapStartedAt = performance.now();
      const rebootstrapBench = await createBenchClient(actorId);
      clients.push(rebootstrapBench);
      subscribeTasks(rebootstrapBench, [revokedProjectId, retainedProjectId]);
      await rebootstrapBench.client.syncUntilIdle(500);
      const rebootstrapVisibleMs = performance.now() - rebootstrapStartedAt;
      const rebootstrapRevokedRows = localTaskCount(
        rebootstrapBench,
        revokedProjectId
      );
      const rebootstrapRetainedRows = localTaskCount(
        rebootstrapBench,
        retainedProjectId
      );
      if (rebootstrapRevokedRows !== 0 || rebootstrapRetainedRows !== 500) {
        throw new Error(
          `Syncular rebootstrap after revoke leaked rows: revoked=${rebootstrapRevokedRows}, retained=${rebootstrapRetainedRows}`
        );
      }

      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();
      const after = bench.transfer();
      const rebootstrapTransfer = rebootstrapBench.transfer();
      const requestBytes =
        after.requestBytes - baseline.requestBytes + rebootstrapTransfer.requestBytes;
      const responseBytes =
        after.responseBytes -
        baseline.responseBytes +
        rebootstrapTransfer.responseBytes;

      return {
        status: 'completed',
        metrics: {
          initial_visible_rows: initialVisibleRows,
          post_revoke_visible_rows: postRevokeVisibleRows,
          revoked_project_visible_rows_after_revoke: revokedProjectRows,
          retained_project_visible_rows_after_revoke: retainedProjectRows,
          permission_revoke_convergence_ms: round(convergenceMs),
          same_client_permission_revoke_convergence_ms: round(convergenceMs),
          revoke_request_ms: round(revokeRequestMs),
          rebootstrap_permission_visible_ms: round(rebootstrapVisibleMs),
          rebootstrap_visible_rows: rebootstrapRevokedRows + rebootstrapRetainedRows,
          rebootstrap_revoked_project_visible_rows: rebootstrapRevokedRows,
          rebootstrap_retained_project_visible_rows: rebootstrapRetainedRows,
          request_count:
            after.requestCount -
            baseline.requestCount +
            rebootstrapTransfer.requestCount,
          request_bytes: requestBytes,
          response_bytes: responseBytes,
          bytes_transferred: requestBytes + responseBytes,
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Permission change is the real Syncular auth model: server scopes derive from project_memberships on every round, so an engine-committed membership delete empties the per-project subscription scope and the client purges the revoked rows.',
          'Same-client convergence keeps the original client syncing until the purge lands; a fresh client then re-bootstraps to prove the narrowed scope holds from first sync.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
          actorId,
          revokedProjectId,
          retainedProjectId,
        },
      };
    } catch (error) {
      return failedOutcome(error, implementation);
    } finally {
      await closeAll(clients);
    }
  }

  async runBlobFlow(): Promise<ScenarioOutcome> {
    const implementation = `${IMPLEMENTATION_PREFIX}-presigned-cross-client-blob-flow`;
    const clients: BenchClient[] = [];
    try {
      await ensureStackUp(STACK_ID);
      await seedStack(STACK_ID, {
        resetFirst: true,
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 50,
        membershipsPerProject: 2,
      });

      const fixtures = await requireFixtures();
      const actorId = fixtures.sampleUserIds[0]!;
      const projectId = fixtures.sampleProjectId!;
      const taskId = fixtures.sampleTaskId!;

      const writer = await createBenchClient(actorId);
      const reader = await createBenchClient(actorId);
      clients.push(writer, reader);

      subscribeTasks(writer, [projectId]);
      subscribeBlobEntries(writer, [projectId]);
      subscribeTasks(reader, [projectId]);
      subscribeBlobEntries(reader, [projectId]);
      await writer.client.syncUntilIdle(500);
      await reader.client.syncUntilIdle(500);
      await reader.connectRealtimeReady();
      await reader.client.sync();

      const blobSizeBytes = 2 * 1024 * 1024;
      const payload = createRandomBytes(blobSizeBytes);
      const entryId = crypto.randomUUID();

      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();
      const baseline = sumTransfers(clients);

      // Writer: stage + reference + sync. The sync flushes the staged
      // upload through the presigned MinIO PUT grant before the push.
      const uploadStartedAt = performance.now();
      const blobRef = await writer.client.uploadBlob(payload, {
        mediaType: 'application/octet-stream',
      });
      writer.client.mutate([
        {
          table: 'task_blob_entries',
          op: 'upsert',
          values: {
            id: entryId,
            project_id: projectId,
            task_id: taskId,
            blob: writer.client.blobRefString(blobRef),
            created_at_ms: Date.now(),
          },
        },
      ]);
      const metadataVisible = (async () => {
        const deadline = performance.now() + 60_000;
        while (performance.now() < deadline) {
          const row = reader.client.query(
            'SELECT id, blob FROM task_blob_entries WHERE id = ?',
            [entryId]
          )[0];
          if (row && typeof row.blob === 'string' && row.blob.length > 0) {
            return String(row.blob);
          }
          await Bun.sleep(0);
        }
        throw new Error('Syncular blob metadata did not reach the reader');
      })();
      const writerSummary = await writer.client.sync();
      const uploadCompleteMs = performance.now() - uploadStartedAt;
      if (writerSummary.applied.length === 0) {
        throw new Error(
          `Syncular blob metadata push was not applied (rejected: ${writerSummary.rejected.length})`
        );
      }

      const readerBlobRef = await metadataVisible;
      const metadataVisibleMs = performance.now() - uploadStartedAt;

      // Reader: authenticated re-download resolves a presigned MinIO GET
      // and the client core verifies the content address.
      const downloadStartedAt = performance.now();
      const downloaded = await reader.client.fetchBlob(readerBlobRef);
      const downloadAfterMetadataMs = performance.now() - downloadStartedAt;

      if (downloaded.bytes.byteLength !== blobSizeBytes) {
        throw new Error(
          `Syncular blob flow downloaded ${downloaded.bytes.byteLength} bytes, expected ${blobSizeBytes}`
        );
      }
      const downloadedHash = await computeBlobId(downloaded.bytes);
      if (downloadedHash !== blobRef.blobId) {
        throw new Error('Syncular blob flow content hash mismatch');
      }

      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();
      const after = sumTransfers(clients);
      const transfer: TransferTotals = {
        requestCount: after.requestCount - baseline.requestCount,
        requestBytes: after.requestBytes - baseline.requestBytes,
        responseBytes: after.responseBytes - baseline.responseBytes,
        realtimeBytes: after.realtimeBytes - baseline.realtimeBytes,
      };

      return {
        status: 'completed',
        metrics: {
          blob_size_bytes: blobSizeBytes,
          upload_complete_ms: round(uploadCompleteMs),
          metadata_visible_ms: round(metadataVisibleMs),
          download_after_metadata_ms: round(downloadAfterMetadataMs),
          hash_verified: 1,
          request_count: transfer.requestCount,
          request_bytes: transfer.requestBytes,
          response_bytes: transfer.responseBytes,
          realtime_bytes: transfer.realtimeBytes,
          bytes_transferred: totalBytes(transfer),
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Blob flow uses the product blob transport end to end: the writer stages 2 MiB, the sync round flushes it through a presigned MinIO PUT grant, and the referencing task_blob_entries row is pushed and fanned out.',
          'The realtime reader observes the metadata row via the WebSocket delta, then re-downloads through the authenticated blob route (presigned MinIO GET) with client-side content-address verification.',
          'The writer pushes over HTTP because the bench realtime hub is wired without a blob store, so blob-referencing commits are only accepted on the HTTP sync round.',
        ],
        metadata: {
          implementation,
          engine: 'syncular-v2',
          blobId: blobRef.blobId,
          entryId,
          projectId,
          taskId,
        },
      };
    } catch (error) {
      return failedOutcome(error, implementation);
    } finally {
      await closeAll(clients);
    }
  }
}
