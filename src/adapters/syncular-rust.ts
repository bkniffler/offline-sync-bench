/**
 * Syncular v2 NATIVE Rust client benchmark adapter.
 *
 * Drives the `syncular-bench` Rust driver binary (harness-owned, vendored at
 * syncular-rust-driver/ and built against the published syncular-* crates from
 * crates.io) over JSON lines on stdio. The binary hosts the real Rust
 * client core (rusqlite) plus the shipping native HTTP+WS transport
 * (ureq + tungstenite) against the SAME Dockerized syncular bench server the
 * TS adapter uses — no browser, no WASM, real network.
 *
 * One binary process per client instance. Latency-critical waits
 * (`waitForQuery`) and query timing loops (`benchQuery`) run INSIDE the Rust
 * process so stdio round-trips do not pollute sub-millisecond measurements.
 */
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { average, DockerServiceSampler, round } from '../metrics';
import { benchmarkRoot, tempRoot } from '../paths';
import {
  ensureStackUp,
  getFixtures,
  getTask,
  resolveServiceContainerId,
  restartServiceCold,
  seedStack,
} from '../stack-manager';
import { getStack } from '../stacks';
import { schema } from '../../stacks/syncular/syncular-app/src/syncular.generated';
import type {
  BenchmarkAdapter,
  BenchmarkStatus,
  JsonObject,
  JsonValue,
  StackFixtures,
} from '../types';

const STACK_ID = 'syncular-rust' as const;
// The Rust driver is harness-owned and vendored into this repo at
// syncular-rust-driver/ (a standalone crate depending on the published
// syncular-* crates from crates.io). It builds and runs here — no syncular
// checkout required.
const SYNCULAR_RUST_ROOT = join(benchmarkRoot, 'syncular-rust-driver');
const DEFAULT_BIN_PATH = join(
  SYNCULAR_RUST_ROOT,
  'target/release/syncular-bench'
);

/** The generated schema is already the SPEC §2.4 JSON shape the Rust
 *  client's `parse_schema_json` accepts (including the `blob_ref` column
 *  type spelling used by `task_blob_entries.blob`). */
const schemaJson = JSON.parse(JSON.stringify(schema)) as JsonObject;

type BenchProcess = Subprocess<'pipe', 'pipe', 'pipe'>;

interface ScenarioResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: JsonObject;
}

interface DriverError {
  code: string;
  message: string;
}

interface TransportStats {
  requestBytes: number;
  responseBytes: number;
  wsInBytes: number;
  wsOutBytes: number;
  requestCount: number;
}

interface WaitForQueryResult {
  ok: boolean;
  waitedMs: number;
  rows: Array<Record<string, JsonValue>>;
}

let cachedBinaryPath: string | null = null;

async function ensureBenchBinary(): Promise<string> {
  if (cachedBinaryPath) return cachedBinaryPath;
  const configured = process.env.SYNCULAR_RUST_BENCH_BIN ?? DEFAULT_BIN_PATH;
  if (await Bun.file(configured).exists()) {
    const binaryMtime = (await stat(configured)).mtimeMs;
    const sourceStats = await Promise.all(['src/main.rs', 'Cargo.toml', 'Cargo.lock']
      .map(path => stat(join(SYNCULAR_RUST_ROOT, path))));
    if (configured !== DEFAULT_BIN_PATH || sourceStats.every(source => source.mtimeMs <= binaryMtime)) {
      cachedBinaryPath = configured;
      return configured;
    }
  }

  console.log(
    `[syncular-rust] ${configured} missing or outdated — running \`cargo build --release\` in ${SYNCULAR_RUST_ROOT}`
  );
  const build = Bun.spawnSync(['cargo', 'build', '--release'], {
    cwd: SYNCULAR_RUST_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (build.exitCode !== 0) {
    throw new Error(
      `cargo build --release failed:\n${new TextDecoder().decode(build.stderr)}`
    );
  }

  for (const candidate of [configured, DEFAULT_BIN_PATH]) {
    if (await Bun.file(candidate).exists()) {
      cachedBinaryPath = candidate;
      return candidate;
    }
  }
  throw new Error(`syncular-bench binary not found after build: ${configured}`);
}

/**
 * One Rust driver process = one client instance. JSON-lines request/response
 * with incrementing ids; the binary answers commands serially, so callers
 * keep at most one in-flight call per client (the deliberately-blocking
 * `waitForQuery` counts as that one call).
 */
class RustClient {
  readonly actorId: string;
  readonly clientId: string;
  readonly #proc: BenchProcess;
  readonly #pending = new Map<
    number,
    {
      resolve: (value: Record<string, JsonValue>) => void;
      reject: (error: Error) => void;
    }
  >();
  #nextId = 0;
  #closed = false;

  private constructor(proc: BenchProcess, actorId: string, clientId: string) {
    this.#proc = proc;
    this.actorId = actorId;
    this.clientId = clientId;
    void this.#readLoop();
    void this.#proc.exited.then(() => {
      const wasClosed = this.#closed;
      this.#closed = true;
      const error = new Error(
        `syncular-bench process for ${this.clientId} exited${wasClosed ? '' : ' unexpectedly'}`
      );
      for (const entry of this.#pending.values()) {
        entry.reject(error);
      }
      this.#pending.clear();
    });
  }

  static async start(args: {
    binPath: string;
    actorId: string;
    clientId: string;
    dbPath?: string;
  }): Promise<RustClient> {
    const stack = getStack(STACK_ID);
    const wsBase = stack.syncRealtimeBaseUrl;
    if (!wsBase) {
      throw new Error('syncular-rust stack is missing syncRealtimeBaseUrl');
    }
    const proc = Bun.spawn([args.binPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as BenchProcess;
    const client = new RustClient(proc, args.actorId, args.clientId);
    // The WS registration REQUIRES actorId + the SAME clientId the client
    // core uses — sync-over-socket rounds fail with sync.invalid_client_id
    // otherwise. HTTP authenticates via the x-actor-id header.
    try {
      await client.call('create', {
        clientId: args.clientId,
        schema: schemaJson,
        ...(args.dbPath ? { dbPath: args.dbPath } : {}),
        transport: {
          baseUrl: stack.syncBaseUrl,
          wsUrl: `${wsBase}?actorId=${encodeURIComponent(args.actorId)}&clientId=${encodeURIComponent(args.clientId)}`,
          headers: { 'x-actor-id': args.actorId },
        },
      });
    } catch (error) {
      proc.kill();
      await proc.exited;
      throw error;
    }
    return client;
  }

  get pid(): number {
    return this.#proc.pid;
  }

  async #readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of this.#proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (!line) continue;
          let message: { id?: number; result?: JsonValue; error?: DriverError };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            continue;
          }
          if (typeof message.id !== 'number') continue;
          const entry = this.#pending.get(message.id);
          if (!entry) continue;
          this.#pending.delete(message.id);
          if (message.error) {
            entry.reject(
              new Error(
                `${this.clientId} driver error ${message.error.code}: ${message.error.message}`
              )
            );
          } else {
            entry.resolve((message.result ?? {}) as Record<string, JsonValue>);
          }
        }
      }
    } catch {
      // Stream closed — the exited handler rejects the stragglers.
    }
  }

  call(
    method: string,
    params: JsonObject = {}
  ): Promise<Record<string, JsonValue>> {
    if (this.#closed) {
      return Promise.reject(
        new Error(`syncular-bench process for ${this.clientId} is closed`)
      );
    }
    this.#nextId += 1;
    const id = this.#nextId;
    const promise = new Promise<Record<string, JsonValue>>(
      (resolve, reject) => {
        const timeoutMs = Math.max(180_000, Number(params.timeoutMs ?? 0) + 30_000);
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`${this.clientId} driver command ${method} timed out after ${timeoutMs}ms`));
          this.#proc.kill();
        }, timeoutMs);
        this.#pending.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
      }
    );
    this.#proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    this.#proc.stdin.flush();
    return promise;
  }

  async subscribe(
    id: string,
    table: string,
    scopes: Record<string, string[]>
  ): Promise<void> {
    await this.call('subscribe', { id, table, scopes });
  }

  /** Run sync rounds until the client reports nothing left to do. */
  async syncToIdle(maxAttempts = 20): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const outcome = await this.call('syncUntilIdle', { maxRounds: 50 });
      if (outcome.ok === false) {
        throw new Error(
          `${this.clientId} sync failed: ${String(outcome.errorCode)} ${String(outcome.message)}`
        );
      }
      const status = await this.call('statusSnapshot', {});
      if (status.syncNeeded !== true) return;
    }
    throw new Error(`${this.clientId} did not reach sync idle`);
  }

  async queryRows(
    sql: string,
    params: JsonValue[] = []
  ): Promise<Array<Record<string, JsonValue>>> {
    const result = await this.call('query', { sql, params });
    return (result.rows ?? []) as Array<Record<string, JsonValue>>;
  }

  async count(sql: string, params: JsonValue[] = []): Promise<number> {
    const rows = await this.queryRows(sql, params);
    const first = rows[0] ?? {};
    const value = first[Object.keys(first)[0] ?? 'n'];
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  async waitForQuery(args: {
    sql: string;
    params?: JsonValue[];
    matchCount?: { op: 'eq' | 'gte'; value: number };
    timeoutMs?: number;
    forceSyncIntervalMs?: number;
  }): Promise<WaitForQueryResult> {
    const result = await this.call('waitForQuery', {
      sql: args.sql,
      params: args.params ?? [],
      ...(args.matchCount ? { matchCount: args.matchCount } : {}),
      timeoutMs: args.timeoutMs ?? 30_000,
      ...(args.forceSyncIntervalMs !== undefined
        ? { forceSyncIntervalMs: args.forceSyncIntervalMs }
        : {}),
    });
    return result as unknown as WaitForQueryResult;
  }

  /** Per-iteration query timings measured inside the Rust process (ns → ms). */
  async benchQueryMs(
    sql: string,
    params: JsonValue[],
    iterations: number
  ): Promise<{ samplesMs: number[]; rowCount: number }> {
    const result = await this.call('benchQuery', { sql, params, iterations });
    const ns = (result.nsPerIteration ?? []) as number[];
    return {
      samplesMs: ns.map((value) => value / 1_000_000),
      rowCount: Number(result.rowCount ?? 0),
    };
  }

  async stats(): Promise<TransportStats> {
    const result = await this.call('stats', {});
    return {
      requestBytes: Number(result.requestBytes ?? 0),
      responseBytes: Number(result.responseBytes ?? 0),
      wsInBytes: Number(result.wsInBytes ?? 0),
      wsOutBytes: Number(result.wsOutBytes ?? 0),
      requestCount: Number(result.requestCount ?? 0),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.call('destroy', {});
      this.#closed = true;
      // `close` makes the binary exit its loop; no response ordering games —
      // the kill below is authoritative anyway.
      this.#proc.stdin.write(`${JSON.stringify({ id: 0, method: 'close', params: {} })}\n`);
      this.#proc.stdin.flush();
    } catch {
      // Best-effort shutdown.
    }
    this.#closed = true;
    this.#proc.kill();
    await this.#proc.exited;
  }
}

/** RSS/CPU sampler over the spawned Rust client processes (`ps`). */
class RustProcessSampler {
  readonly #getPids: () => number[];
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #memorySamplesMb: number[] = [];
  readonly #cpuSamplesPct: number[] = [];

  constructor(getPids: () => number[], intervalMs = 50) {
    this.#getPids = getPids;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#timer) return;
    this.#sampleOnce();
    this.#timer = setInterval(() => this.#sampleOnce(), this.#intervalMs);
  }

  stop(): {
    avgMemoryMb: number;
    peakMemoryMb: number;
    avgCpuPct: number;
    peakCpuPct: number;
  } {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#sampleOnce();
    return {
      avgMemoryMb: average(this.#memorySamplesMb),
      peakMemoryMb: round(Math.max(0, ...this.#memorySamplesMb)),
      avgCpuPct: average(this.#cpuSamplesPct),
      peakCpuPct: round(Math.max(0, ...this.#cpuSamplesPct)),
    };
  }

  #sampleOnce(): void {
    const pids = this.#getPids();
    if (pids.length === 0) return;
    const result = Bun.spawnSync(
      ['ps', '-o', 'rss=,pcpu=', '-p', pids.join(',')],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    if (result.exitCode !== 0) return;
    const text = new TextDecoder().decode(result.stdout).trim();
    if (!text) return;
    let totalRssKb = 0;
    let totalCpuPct = 0;
    for (const line of text.split('\n')) {
      const [rss, cpu] = line.trim().split(/\s+/);
      totalRssKb += Number.parseFloat(rss ?? '0') || 0;
      totalCpuPct += Number.parseFloat(cpu ?? '0') || 0;
    }
    this.#memorySamplesMb.push(totalRssKb / 1024);
    this.#cpuSamplesPct.push(totalCpuPct);
  }
}

function percentileOf(values: number[], p: number, digits = 3): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return round(sorted[index] ?? 0, digits);
}

function sumStats(stats: TransportStats[]): TransportStats {
  return stats.reduce(
    (totals, item) => ({
      requestBytes: totals.requestBytes + item.requestBytes,
      responseBytes: totals.responseBytes + item.responseBytes,
      wsInBytes: totals.wsInBytes + item.wsInBytes,
      wsOutBytes: totals.wsOutBytes + item.wsOutBytes,
      requestCount: totals.requestCount + item.requestCount,
    }),
    {
      requestBytes: 0,
      responseBytes: 0,
      wsInBytes: 0,
      wsOutBytes: 0,
      requestCount: 0,
    }
  );
}

function diffStats(
  after: TransportStats,
  before: TransportStats
): TransportStats {
  return {
    requestBytes: Math.max(0, after.requestBytes - before.requestBytes),
    responseBytes: Math.max(0, after.responseBytes - before.responseBytes),
    wsInBytes: Math.max(0, after.wsInBytes - before.wsInBytes),
    wsOutBytes: Math.max(0, after.wsOutBytes - before.wsOutBytes),
    requestCount: Math.max(0, after.requestCount - before.requestCount),
  };
}

function bytesTransferred(stats: TransportStats): number {
  return (
    stats.requestBytes +
    stats.responseBytes +
    stats.wsInBytes +
    stats.wsOutBytes
  );
}

/** Per-project subscriptions across every synced table (the real app shape). */
async function subscribeAll(
  client: RustClient,
  orgId: string,
  projectIds: string[]
): Promise<void> {
  await client.subscribe('organizations', 'organizations', { id: [orgId] });
  await client.subscribe('projects', 'projects', { org_id: [orgId] });
  await client.subscribe('app_users', 'app_users', { org_id: [orgId] });
  for (const projectId of projectIds) {
    await client.subscribe(`tasks:${projectId}`, 'tasks', {
      project_id: [projectId],
    });
    await client.subscribe(`memberships:${projectId}`, 'project_memberships', {
      project_id: [projectId],
    });
    await client.subscribe(`blobs:${projectId}`, 'task_blob_entries', {
      project_id: [projectId],
    });
  }
}

/** Seed through the shared async readiness check, including fixture-index cleanup. */
async function seedStackPatient(options: {
  orgCount: number;
  projectsPerOrg: number;
  usersPerOrg: number;
  tasksPerProject: number;
  membershipsPerProject: number;
}): Promise<void> {
  await seedStack(STACK_ID, { resetFirst: true, ...options });
}

function requireFixtures(fixtures: StackFixtures): {
  orgId: string;
  projectId: string;
  projectIds: string[];
  userIds: string[];
  taskId: string;
} {
  const orgId = fixtures.sampleOrgId;
  const projectId = fixtures.sampleProjectId;
  const taskId = fixtures.sampleTaskId;
  if (!orgId || !projectId || !taskId || fixtures.sampleUserIds.length === 0) {
    throw new Error('syncular-rust fixtures are missing seeded data');
  }
  return {
    orgId,
    projectId,
    projectIds: fixtures.sampleProjectIds,
    userIds: fixtures.sampleUserIds,
    taskId,
  };
}

/** Full-row upsert values from the client's local task row. */
function taskUpsertValues(
  row: Record<string, JsonValue>,
  overrides: Partial<Record<string, JsonValue>>
): JsonObject {
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    project_id: String(row.project_id),
    owner_id: String(row.owner_id),
    title: String(row.title),
    completed: row.completed === 1 || row.completed === true,
    server_version: Number(row.server_version),
    updated_at_ms: Number(row.updated_at_ms),
    ...overrides,
  };
}

async function readLocalTask(
  client: RustClient,
  taskId: string
): Promise<Record<string, JsonValue>> {
  const rows = await client.queryRows(
    'SELECT id, org_id, project_id, owner_id, title, completed, server_version, updated_at_ms, _syncular_version FROM tasks WHERE id = ?',
    [taskId]
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`local task ${taskId} is not materialized on the client`);
  }
  return row;
}

async function mutateTaskTitle(
  client: RustClient,
  taskId: string,
  title: string
): Promise<void> {
  const row = await readLocalTask(client, taskId);
  await client.call('mutate', {
    mutations: [
      {
        op: 'upsert',
        table: 'tasks',
        values: taskUpsertValues(row, { title, updated_at_ms: Date.now() }),
        baseVersion: Number(row._syncular_version),
      },
    ],
  });
}

async function createTempDbDir(prefix: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(join(tempRoot, `${prefix}-`));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index] as T;
        results[index] = await fn(item, index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

const BASE_METADATA: JsonObject = {
  implementation: 'syncular-rust-native',
  transport: 'http+ws (ureq/tungstenite)',
  clientCore: 'rusqlite',
  driver: 'syncular-bench (JSON lines over stdio, one process per client)',
};

function failedResult(error: unknown): ScenarioResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'failed',
    metrics: {},
    notes: [`syncular-rust scenario failed: ${message}`],
    metadata: { ...BASE_METADATA },
  };
}

export class SyncularRustBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack(STACK_ID);

  async runBootstrap(): Promise<ScenarioResult> {
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      const scales = [1_000, 10_000, 100_000, 250_000, 500_000];
      const metrics: Record<string, number | null> = {};
      const scaleMetadata: JsonValue[] = [];

      for (const rowsTarget of scales) {
        console.log(`[syncular-bootstrap] ${this.stack.id} rows=${rowsTarget}`);
        await seedStackPatient({
          orgCount: 1,
          projectsPerOrg: 1,
          usersPerOrg: 2,
          tasksPerProject: rowsTarget,
          membershipsPerProject: 2,
        });
        const fixtures = requireFixtures(await getFixtures(STACK_ID));
        const actorId = fixtures.userIds[0] as string;

        // Cold-server definition: restart the sync service so in-memory
        // segment/sqlite-image caches from earlier scales (or runs) never
        // serve this measurement. Identical in the syncular (JS) adapter.
        await restartServiceCold(
          STACK_ID,
          'sync',
          `${getStack(STACK_ID).syncBaseUrl.replace(/\/api$/, '')}/health`
        );

        let client: RustClient | null = null;
        const sampler = new RustProcessSampler(() =>
          client ? [client.pid] : []
        );
        sampler.start();
        const startedAt = performance.now();
        client = await RustClient.start({
          binPath,
          actorId,
          clientId: `rust-bootstrap-${rowsTarget}`,
        });
        await subscribeAll(client, fixtures.orgId, fixtures.projectIds);
        await client.syncToIdle();
        const rowsLoaded = await client.count(
          'SELECT count(*) AS n FROM tasks'
        );
        const elapsedMs = performance.now() - startedAt;
        const usage = sampler.stop();
        const stats = await client.stats();
        await client.close();

        if (rowsLoaded !== rowsTarget) {
          throw new Error(
            `bootstrap expected ${rowsTarget} rows, got ${rowsLoaded}`
          );
        }

        // Warm second-client bootstrap: same server, no restart — the "new
        // device joins an existing dataset" path where the server's segment
        // caches legitimately serve. Reported alongside cold, never instead.
        const warmStartedAt = performance.now();
        const warmClient = await RustClient.start({
          binPath,
          actorId,
          clientId: `rust-bootstrap-warm-${rowsTarget}`,
        });
        await subscribeAll(warmClient, fixtures.orgId, fixtures.projectIds);
        await warmClient.syncToIdle();
        const warmRows = await warmClient.count(
          'SELECT count(*) AS n FROM tasks'
        );
        const warmMs = performance.now() - warmStartedAt;
        await warmClient.close();
        if (warmRows !== rowsTarget) {
          throw new Error(
            `warm bootstrap expected ${rowsTarget} rows, got ${warmRows}`
          );
        }

        metrics[`bootstrap_${rowsTarget}_ms`] = round(elapsedMs);
        metrics[`bootstrap_warm_${rowsTarget}_ms`] = round(warmMs);
        metrics[`rows_loaded_${rowsTarget}`] = rowsLoaded;
        metrics[`request_count_${rowsTarget}`] = stats.requestCount;
        metrics[`request_bytes_${rowsTarget}`] = stats.requestBytes;
        metrics[`response_bytes_${rowsTarget}`] = stats.responseBytes;
        metrics[`bytes_transferred_${rowsTarget}`] = bytesTransferred(stats);
        metrics[`avg_memory_mb_${rowsTarget}`] = usage.avgMemoryMb;
        metrics[`peak_memory_mb_${rowsTarget}`] = usage.peakMemoryMb;
        metrics[`avg_cpu_pct_${rowsTarget}`] = usage.avgCpuPct;
        metrics[`peak_cpu_pct_${rowsTarget}`] = usage.peakCpuPct;
        scaleMetadata.push({
          rowsTarget,
          timeToFirstQueryMs: round(elapsedMs),
          rowsLoaded,
          requestCount: stats.requestCount,
          bytesTransferred: bytesTransferred(stats),
        });
      }

      return {
        status: 'completed',
        metrics,
        notes: [
          'Bootstrap runs the native Rust client core (rusqlite, in-memory) against the real server over HTTP; rows arrive via the segment lane.',
          'Memory/CPU are sampled from the spawned Rust client process via ps, not the Bun harness process.',
        ],
        metadata: { ...BASE_METADATA, scales: scaleMetadata },
      };
    } catch (error) {
      return failedResult(error);
    }
  }

  async runOnlinePropagation(): Promise<ScenarioResult> {
    let writer: RustClient | null = null;
    let mirror: RustClient | null = null;
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      await seedStackPatient({
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 200,
        membershipsPerProject: 2,
      });
      const fixtures = requireFixtures(await getFixtures(STACK_ID));
      const writerActor = fixtures.userIds[0] as string;
      const mirrorActor = fixtures.userIds[1] ?? writerActor;

      const sampler = new RustProcessSampler(() =>
        [writer, mirror].flatMap((c) => (c ? [c.pid] : []))
      );
      sampler.start();

      writer = await RustClient.start({
        binPath,
        actorId: writerActor,
        clientId: 'rust-online-writer',
      });
      await subscribeAll(writer, fixtures.orgId, [fixtures.projectId]);
      await writer.syncToIdle();

      mirror = await RustClient.start({
        binPath,
        actorId: mirrorActor,
        clientId: 'rust-online-mirror',
      });
      await subscribeAll(mirror, fixtures.orgId, [fixtures.projectId]);
      await mirror.syncToIdle();
      await mirror.call('connectRealtime', {});

      // 5 unmeasured warmup rounds (JIT/plan/socket warm on a freshly
      // restarted server), then 15 measured — identical in the JS adapter.
      const warmup = 5;
      const iterations = 15;
      const samples: Array<{
        iteration: number;
        writeAckMs: number;
        mirrorVisibleMs: number;
        rustWaitedMs: number;
      }> = [];

      for (
        let iteration = -warmup;
        iteration < iterations;
        iteration += 1
      ) {
        const title = `rust-online-${iteration}-${Date.now()}`;
        // Arm the mirror's in-process wait loop BEFORE the write so the
        // visibility latency is measured without stdio round-trip gaps.
        const waitPromise = mirror.waitForQuery({
          sql: 'SELECT id FROM tasks WHERE id = ? AND title = ?',
          params: [fixtures.taskId, title],
          matchCount: { op: 'gte', value: 1 },
          timeoutMs: 30_000,
        });
        await Bun.sleep(10);

        const writeStartedAt = performance.now();
        await mutateTaskTitle(writer, fixtures.taskId, title);
        await writer.call('sync', {});
        const writeAckMs = performance.now() - writeStartedAt;

        const wait = await waitPromise;
        const mirrorVisibleMs = performance.now() - writeStartedAt;
        if (!wait.ok) {
          throw new Error(`mirror did not observe title ${title}`);
        }
        if (iteration < 0) continue; // warmup round — never measured
        samples.push({
          iteration,
          writeAckMs: round(writeAckMs, 3),
          mirrorVisibleMs: round(mirrorVisibleMs, 3),
          rustWaitedMs: round(wait.waitedMs, 3),
        });
      }

      const usage = sampler.stop();
      const stats = sumStats([await writer.stats(), await mirror.stats()]);
      const visibility = samples.map((sample) => sample.mirrorVisibleMs);
      const writeAcks = samples.map((sample) => sample.writeAckMs);

      return {
        status: 'completed',
        metrics: {
          write_ack_ms: round(average(writeAcks), 3),
          mirror_visible_p50_ms: percentileOf(visibility, 50),
          mirror_visible_p95_ms: percentileOf(visibility, 95),
          mirror_visible_p99_ms: percentileOf(visibility, 99),
          iterations,
          request_count: stats.requestCount,
          request_bytes: stats.requestBytes,
          response_bytes: stats.responseBytes,
          bytes_transferred: bytesTransferred(stats),
          avg_memory_mb: usage.avgMemoryMb,
          peak_memory_mb: usage.peakMemoryMb,
          avg_cpu_pct: usage.avgCpuPct,
          peak_cpu_pct: usage.peakCpuPct,
        },
        notes: [
          'Client A mutates + syncs through the Rust core over HTTP; client B holds a live WebSocket and its in-Rust waitForQuery loop applies realtime deltas/wakes until the row is locally visible.',
          'Visibility latency is measured wall-to-wall from the write start in the harness; the in-Rust waitedMs per sample is in metadata.',
        ],
        metadata: {
          ...BASE_METADATA,
          samples: samples as unknown as JsonValue,
        },
      };
    } catch (error) {
      return failedResult(error);
    } finally {
      await writer?.close();
      await mirror?.close();
    }
  }

  async runOfflineReplay(): Promise<ScenarioResult> {
    let client: RustClient | null = null;
    let dbDir: string | null = null;
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      await seedStackPatient({
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 200,
        membershipsPerProject: 2,
      });
      const fixtures = requireFixtures(await getFixtures(STACK_ID));
      const actorId = fixtures.userIds[0] as string;
      dbDir = await createTempDbDir('syncular-rust-offline');

      const sampler = new RustProcessSampler(() =>
        client ? [client.pid] : []
      );
      sampler.start();
      client = await RustClient.start({
        binPath,
        actorId,
        clientId: 'rust-offline-replay',
        dbPath: join(dbDir, 'client.sqlite'),
      });
      await subscribeAll(client, fixtures.orgId, [fixtures.projectId]);
      await client.syncToIdle();

      const queueSize = 10;
      const targets = await client.queryRows(
        'SELECT id FROM tasks ORDER BY id LIMIT ?',
        [queueSize]
      );
      if (targets.length < queueSize) {
        throw new Error(`need ${queueSize} local tasks for offline replay`);
      }

      // "Offline": queue local commits in the native outbox (durable, on-disk
      // sqlite) without syncing.
      const expectedTitles = new Map<string, string>();
      for (let index = 0; index < targets.length; index += 1) {
        const taskId = String(targets[index]?.id);
        const title = `rust-offline-${index}-${Date.now()}`;
        expectedTitles.set(taskId, title);
        await mutateTaskTitle(client, taskId, title);
      }
      const pendingBefore = (
        (await client.call('pendingCommitIds', {})).ids as JsonValue[]
      ).length;
      const statsBefore = await client.stats();

      // Reconnect: replay the outbox and converge.
      const startedAt = performance.now();
      await client.syncToIdle();
      const convergenceMs = performance.now() - startedAt;

      const pendingAfter = (
        (await client.call('pendingCommitIds', {})).ids as JsonValue[]
      ).length;
      const conflicts = (
        (await client.call('conflicts', {})).conflicts as JsonValue[]
      ).length;
      const rejections = (
        (await client.call('rejections', {})).rejections as JsonValue[]
      ).length;
      const statsAfter = await client.stats();
      const usage = sampler.stop();

      // Verify server-side convergence for one replayed write.
      const lastEntry = [...expectedTitles.entries()].at(-1);
      if (lastEntry) {
        const serverTask = await getTask(STACK_ID, lastEntry[0]);
        if (serverTask.title !== lastEntry[1]) {
          throw new Error(
            `server did not converge: ${serverTask.title} != ${lastEntry[1]}`
          );
        }
      }

      const replayStats = diffStats(statsAfter, statsBefore);
      const succeeded = queueSize - rejections - pendingAfter;

      return {
        status: 'completed',
        metrics: {
          queued_write_count: pendingBefore,
          reconnect_convergence_ms: round(convergenceMs),
          conflict_count: conflicts,
          replayed_write_success_rate: round(succeeded / queueSize, 4),
          request_count: replayStats.requestCount,
          request_bytes: replayStats.requestBytes,
          response_bytes: replayStats.responseBytes,
          bytes_transferred: bytesTransferred(replayStats),
          avg_memory_mb: usage.avgMemoryMb,
          peak_memory_mb: usage.peakMemoryMb,
          avg_cpu_pct: usage.avgCpuPct,
          peak_cpu_pct: usage.peakCpuPct,
        },
        notes: [
          'Offline replay uses the native Rust client outbox on an on-disk sqlite database: mutations are queued without syncing, then replayed by real sync rounds on reconnect.',
          'Convergence is verified locally (pending commits drained) and server-side (admin task read).',
        ],
        metadata: {
          ...BASE_METADATA,
          clientStorage: 'sqlite-file',
          queuedTaskIds: [...expectedTitles.keys()],
        },
      };
    } catch (error) {
      return failedResult(error);
    } finally {
      await client?.close();
      if (dbDir) await rm(dbDir, { recursive: true, force: true });
    }
  }

  async runReconnectStorm(): Promise<ScenarioResult> {
    const counts = (process.env.SYNCULAR_RUST_STORM_CLIENTS ?? '25,100,250,500,1000')
      .split(',').map(value => Number(value.trim()));
    if (counts.some(count => !Number.isSafeInteger(count) || count < 1)) {
      throw new Error('SYNCULAR_RUST_STORM_CLIENTS must contain positive integer client counts');
    }
    const metrics: Record<string, number | null> = {};
    const scales: JsonValue[] = [];
    let failed = false;
    for (const clientCount of counts) {
      console.log(`[syncular-storm] ${this.stack.id} clients=${clientCount}`);
      const result = await this.runReconnectStormCase(clientCount);
      Object.assign(metrics, result.metrics);
      scales.push({ clientCount, status: result.status, notes: result.notes });
      if (result.status !== 'completed') {
        failed = true;
        metrics[`clients_${clientCount}_failed`] = 1;
        console.log(`[syncular-storm] ${this.stack.id} clients=${clientCount} failed: ${result.notes.join('; ')}`);
        continue;
      }
      console.log(`[syncular-storm] ${this.stack.id} clients=${clientCount} convergence=${result.metrics.reconnect_convergence_ms}ms`);
    }
    return {
      status: failed ? 'failed' : 'completed', metrics,
      notes: ['Each client-count case starts with fresh, pre-bootstrapped clients and verifies that every client receives the same server-side change. Resource fields are scoped to the measured client count.'],
      metadata: { ...BASE_METADATA, implementation: 'syncular-rust-reconnect-storm-sweep-v2', clientCounts: counts, scales },
    };
  }

  private async runReconnectStormCase(clientCount: number): Promise<ScenarioResult> {
    const clients: RustClient[] = [];
    let dockerSampler: DockerServiceSampler | undefined;
    let procSampler: RustProcessSampler | undefined;
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      await seedStackPatient({
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 200,
        membershipsPerProject: 2,
      });
      // Fixture reset truncates engine state. Recreate server caches before
      // bootstrapping the clients, outside the measured catch-up window.
      await restartServiceCold(
        STACK_ID, 'sync', `${this.stack.syncBaseUrl.replace(/\/api$/, '')}/health`
      );
      const fixtures = requireFixtures(await getFixtures(STACK_ID));

      await mapWithConcurrency(
        Array.from({ length: clientCount }, (_, index) => index),
        8,
        async (index) => {
          const actorId = fixtures.userIds[
            index % fixtures.userIds.length
          ] as string;
          const client = await RustClient.start({
            binPath,
            actorId,
            clientId: `rust-storm-${index}`,
          });
          clients.push(client);
          await client.subscribe(`tasks:${fixtures.projectId}`, 'tasks', {
            project_id: [fixtures.projectId],
          });
          await client.syncToIdle();
        }
      );

      console.log(`[syncular-storm] ${this.stack.id} clients=${clientCount} bootstrapped`);
      const baselines = await Promise.all(clients.map((c) => c.stats()));
      dockerSampler = new DockerServiceSampler([
        { label: 'sync', id: resolveServiceContainerId(STACK_ID, 'sync') },
        {
          label: 'postgres',
          id: resolveServiceContainerId(STACK_ID, 'postgres'),
        },
      ]);
      procSampler = new RustProcessSampler(
        () => clients.map((c) => c.pid),
        100
      );

      const title = `rust-storm-${Date.now()}`;
      const serverTask = await getTask(STACK_ID, fixtures.taskId);
      await dockerSampler.start();
      procSampler.start();
      const startedAt = performance.now();
      const response = await fetch(`${this.stack.adminBaseUrl}/admin/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: serverTask.id, title }),
      });
      if (!response.ok) {
        throw new Error(`admin write failed: ${response.status}`);
      }

      // The storm: every already-bootstrapped client issues catch-up sync
      // rounds at once until the stale change is locally visible.
      await Promise.all(
        clients.map(async (client) => {
          const deadline = Date.now() + 120_000;
          while (true) {
            await client.call('syncUntilIdle', { maxRounds: 10 });
            const rows = await client.queryRows(
              'SELECT id FROM tasks WHERE id = ? AND title = ?',
              [fixtures.taskId, title]
            );
            if (rows.length > 0) return;
            if (Date.now() > deadline) {
              throw new Error(
                `${client.clientId} did not converge within 120s`
              );
            }
            await Bun.sleep(10);
          }
        })
      );
      const convergenceMs = performance.now() - startedAt;
      const containerMetrics = await dockerSampler.stop();
      dockerSampler = undefined;
      const usage = procSampler.stop();
      procSampler = undefined;
      const totals = diffStats(
        sumStats(await Promise.all(clients.map((c) => c.stats()))),
        sumStats(baselines)
      );
      const syncMetrics = containerMetrics.sync;
      const postgresMetrics = containerMetrics.postgres;

      return {
        status: 'completed',
        metrics: {
          client_count: clientCount,
          reconnect_convergence_ms: round(convergenceMs),
          request_count: totals.requestCount,
          request_bytes: totals.requestBytes,
          response_bytes: totals.responseBytes,
          bytes_transferred: bytesTransferred(totals),
          [`clients_${clientCount}_convergence_ms`]: round(convergenceMs),
          [`clients_${clientCount}_request_count`]: totals.requestCount,
          [`clients_${clientCount}_request_bytes`]: totals.requestBytes,
          [`clients_${clientCount}_response_bytes`]: totals.responseBytes,
          [`clients_${clientCount}_bytes_transferred`]: bytesTransferred(totals),
          sync_avg_cpu_pct: syncMetrics?.avgCpuPct ?? 0,
          sync_peak_cpu_pct: syncMetrics?.peakCpuPct ?? 0,
          sync_avg_memory_mb: syncMetrics?.avgMemoryMb ?? 0,
          sync_peak_memory_mb: syncMetrics?.peakMemoryMb ?? 0,
          sync_rx_network_mb: syncMetrics?.rxNetworkMb ?? 0,
          sync_tx_network_mb: syncMetrics?.txNetworkMb ?? 0,
          postgres_avg_cpu_pct: postgresMetrics?.avgCpuPct ?? 0,
          postgres_peak_cpu_pct: postgresMetrics?.peakCpuPct ?? 0,
          postgres_avg_memory_mb: postgresMetrics?.avgMemoryMb ?? 0,
          postgres_peak_memory_mb: postgresMetrics?.peakMemoryMb ?? 0,
          postgres_rx_network_mb: postgresMetrics?.rxNetworkMb ?? 0,
          postgres_tx_network_mb: postgresMetrics?.txNetworkMb ?? 0,
          [`clients_${clientCount}_sync_avg_cpu_pct`]: syncMetrics?.avgCpuPct ?? null,
          [`clients_${clientCount}_sync_peak_cpu_pct`]: syncMetrics?.peakCpuPct ?? null,
          [`clients_${clientCount}_sync_avg_memory_mb`]: syncMetrics?.avgMemoryMb ?? null,
          [`clients_${clientCount}_sync_peak_memory_mb`]: syncMetrics?.peakMemoryMb ?? null,
          [`clients_${clientCount}_sync_rx_network_mb`]: syncMetrics?.rxNetworkMb ?? null,
          [`clients_${clientCount}_sync_tx_network_mb`]: syncMetrics?.txNetworkMb ?? null,
          [`clients_${clientCount}_postgres_avg_cpu_pct`]: postgresMetrics?.avgCpuPct ?? null,
          [`clients_${clientCount}_postgres_peak_cpu_pct`]: postgresMetrics?.peakCpuPct ?? null,
          [`clients_${clientCount}_postgres_avg_memory_mb`]: postgresMetrics?.avgMemoryMb ?? null,
          [`clients_${clientCount}_postgres_peak_memory_mb`]: postgresMetrics?.peakMemoryMb ?? null,
          [`clients_${clientCount}_postgres_rx_network_mb`]: postgresMetrics?.rxNetworkMb ?? null,
          [`clients_${clientCount}_postgres_tx_network_mb`]: postgresMetrics?.txNetworkMb ?? null,
          clients_avg_memory_mb: usage.avgMemoryMb,
          clients_peak_memory_mb: usage.peakMemoryMb,
        },
        notes: [
          `${clientCount} pre-bootstrapped native Rust client processes catch up on one server-side change at once (set SYNCULAR_RUST_STORM_CLIENTS to change the count).`,
          'Server resource metrics sample the syncular sync service and Postgres containers during the reconnect fan-in.',
        ],
        metadata: { ...BASE_METADATA, clientCount },
      };
    } catch (error) {
      return failedResult(error);
    } finally {
      await dockerSampler?.stop().catch(() => {});
      procSampler?.stop();
      await Promise.all(clients.map((client) => client.close()));
    }
  }

  async runLargeOfflineQueue(): Promise<ScenarioResult> {
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      const queueSizes = [100, 500, 1000];
      const metrics: Record<string, number | null> = {};
      const scaleMetadata: JsonValue[] = [];

      for (const queueSize of queueSizes) {
        let client: RustClient | null = null;
        let dbDir: string | null = null;
        try {
          await seedStackPatient({
            orgCount: 1,
            projectsPerOrg: 1,
            usersPerOrg: 2,
            tasksPerProject: Math.max(200, queueSize + 25),
            membershipsPerProject: 2,
          });
          const fixtures = requireFixtures(await getFixtures(STACK_ID));
          const actorId = fixtures.userIds[0] as string;
          dbDir = await createTempDbDir(`syncular-rust-queue-${queueSize}`);

          const sampler = new RustProcessSampler(() =>
            client ? [client.pid] : []
          );
          client = await RustClient.start({
            binPath,
            actorId,
            clientId: `rust-queue-${queueSize}`,
            dbPath: join(dbDir, 'client.sqlite'),
          });
          await subscribeAll(client, fixtures.orgId, [fixtures.projectId]);
          await client.syncToIdle();

          const targets = await client.queryRows(
            'SELECT id FROM tasks ORDER BY id LIMIT ?',
            [queueSize]
          );
          if (targets.length < queueSize) {
            throw new Error(`need ${queueSize} local tasks for the queue`);
          }
          for (let index = 0; index < targets.length; index += 1) {
            await mutateTaskTitle(
              client,
              String(targets[index]?.id),
              `rust-queue-${queueSize}-${index}`
            );
          }
          const queued = (
            (await client.call('pendingCommitIds', {})).ids as JsonValue[]
          ).length;
          const statsBefore = await client.stats();

          sampler.start();
          const startedAt = performance.now();
          await client.syncToIdle();
          const convergenceMs = performance.now() - startedAt;
          const usage = sampler.stop();

          const pendingAfter = (
            (await client.call('pendingCommitIds', {})).ids as JsonValue[]
          ).length;
          if (pendingAfter !== 0) {
            throw new Error(
              `${pendingAfter} commits still pending after replay`
            );
          }
          const replayStats = diffStats(await client.stats(), statsBefore);

          metrics[`queue_${queueSize}_queued_writes`] = queued;
          metrics[`queue_${queueSize}_convergence_ms`] = round(convergenceMs);
          metrics[`queue_${queueSize}_request_count`] =
            replayStats.requestCount;
          metrics[`queue_${queueSize}_bytes_transferred`] =
            bytesTransferred(replayStats);
          metrics[`queue_${queueSize}_avg_memory_mb`] = usage.avgMemoryMb;
          metrics[`queue_${queueSize}_peak_memory_mb`] = usage.peakMemoryMb;
          metrics[`queue_${queueSize}_avg_cpu_pct`] = usage.avgCpuPct;
          metrics[`queue_${queueSize}_peak_cpu_pct`] = usage.peakCpuPct;
          scaleMetadata.push({
            queueSize,
            queuedWriteCount: queued,
            reconnectConvergenceMs: round(convergenceMs),
            requestCount: replayStats.requestCount,
            bytesTransferred: bytesTransferred(replayStats),
          });
        } finally {
          await client?.close();
          if (dbDir) await rm(dbDir, { recursive: true, force: true });
        }
      }

      return {
        status: 'completed',
        metrics,
        notes: [
          'Large offline queue replays 100 / 500 / 1000 durable native-outbox commits (on-disk sqlite) through real sync rounds after reconnect.',
        ],
        metadata: {
          ...BASE_METADATA,
          clientStorage: 'sqlite-file',
          scales: scaleMetadata,
        },
      };
    } catch (error) {
      return failedResult(error);
    }
  }

  async runLocalQuery(): Promise<ScenarioResult> {
    let client: RustClient | null = null;
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      await seedStackPatient({
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 10_000,
        membershipsPerProject: 2,
      });
      const fixtures = requireFixtures(await getFixtures(STACK_ID));
      const actorId = fixtures.userIds[0] as string;
      const ownerId = fixtures.userIds[1] ?? actorId;

      client = await RustClient.start({
        binPath,
        actorId,
        clientId: 'rust-local-query',
      });
      await subscribeAll(client, fixtures.orgId, fixtures.projectIds);
      await client.syncToIdle();
      const rowCount = await client.count('SELECT count(*) AS n FROM tasks');

      const iterations = 200;
      const sampler = new RustProcessSampler(() =>
        client ? [client.pid] : []
      );
      sampler.start();
      const list = await client.benchQueryMs(
        'SELECT id, title, updated_at_ms FROM tasks WHERE project_id = ? AND owner_id = ? AND completed = 0 ORDER BY updated_at_ms DESC, id DESC LIMIT 100',
        [fixtures.projectId, ownerId],
        iterations
      );
      const search = await client.benchQueryMs(
        'SELECT id FROM tasks WHERE project_id = ? AND id LIKE ? ORDER BY id LIMIT 100',
        [fixtures.projectId, `${fixtures.projectId}-task-00%`],
        iterations
      );
      const aggregate = await client.benchQueryMs(
        'SELECT owner_id, completed, count(*) AS n FROM tasks WHERE project_id = ? GROUP BY owner_id, completed',
        [fixtures.projectId],
        iterations
      );
      const usage = sampler.stop();

      return {
        status: 'completed',
        metrics: {
          row_count: rowCount,
          iterations,
          list_query_p50_ms: percentileOf(list.samplesMs, 50),
          list_query_p95_ms: percentileOf(list.samplesMs, 95),
          search_query_p50_ms: percentileOf(search.samplesMs, 50),
          search_query_p95_ms: percentileOf(search.samplesMs, 95),
          aggregate_query_p50_ms: percentileOf(aggregate.samplesMs, 50),
          aggregate_query_p95_ms: percentileOf(aggregate.samplesMs, 95),
          list_result_count: list.rowCount,
          search_result_count: search.rowCount,
          aggregate_result_count: aggregate.rowCount,
          avg_memory_mb: usage.avgMemoryMb,
          peak_memory_mb: usage.peakMemoryMb,
          avg_cpu_pct: usage.avgCpuPct,
          peak_cpu_pct: usage.peakCpuPct,
        },
        notes: [
          'Local queries run as SQL over the materialized rusqlite tables; per-iteration timings are measured inside the Rust process (benchQuery), so stdio round-trips do not inflate sub-millisecond samples.',
        ],
        metadata: { ...BASE_METADATA, rowCount, iterations },
      };
    } catch (error) {
      return failedResult(error);
    } finally {
      await client?.close();
    }
  }

  async runDeepRelationshipQuery(): Promise<ScenarioResult> {
    let client: RustClient | null = null;
    let sampler: RustProcessSampler | undefined;
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      // Same topology as the syncular (JS) adapter: the actor sees 5
      // projects / 10k tasks / 12 users in one org — identical local join
      // datasets across the two client-core rows.
      await seedStackPatient({
        orgCount: 2,
        projectsPerOrg: 5,
        usersPerOrg: 12,
        tasksPerProject: 2_000,
        membershipsPerProject: 12,
      });
      const fixtures = requireFixtures(await getFixtures(STACK_ID));
      const actorId = fixtures.userIds[0] as string;

      client = await RustClient.start({
        binPath,
        actorId,
        clientId: 'rust-deep-query',
      });
      // The actor is a member of every seeded project, so ALL related tables
      // (organizations/projects/app_users/memberships/tasks) are local.
      await subscribeAll(client, fixtures.orgId, fixtures.projectIds);
      await client.syncToIdle();
      const rowCount = await client.count('SELECT count(*) AS n FROM tasks');
      const projectCount = await client.count(
        'SELECT count(*) AS n FROM projects'
      );

      const iterations = 150;
      sampler = new RustProcessSampler(() => client ? [client.pid] : [], 100);
      sampler.start();
      const dashboard = await client.benchQueryMs(
        'SELECT o.id AS org_id, p.id AS project_id, p.name AS project_name, count(t.id) AS task_count, sum(t.completed) AS completed_count FROM organizations o JOIN projects p ON p.org_id = o.id LEFT JOIN tasks t ON t.project_id = p.id GROUP BY o.id, p.id ORDER BY o.id, p.id',
        [],
        iterations
      );
      const detail = await client.benchQueryMs(
        'SELECT t.id, t.title, t.completed, p.name AS project_name, o.name AS org_name, u.email AS owner_email FROM tasks t JOIN projects p ON p.id = t.project_id JOIN organizations o ON o.id = p.org_id JOIN app_users u ON u.id = t.owner_id WHERE t.project_id = ? ORDER BY t.updated_at_ms DESC, t.id LIMIT 50',
        [fixtures.projectId],
        iterations
      );

      const usage = sampler.stop();
      return {
        status: 'completed',
        metrics: {
          avg_memory_mb: usage.avgMemoryMb,
          peak_memory_mb: usage.peakMemoryMb,
          row_count: rowCount,
          project_count: projectCount,
          iterations,
          dashboard_query_p50_ms: percentileOf(dashboard.samplesMs, 50),
          dashboard_query_p95_ms: percentileOf(dashboard.samplesMs, 95),
          detail_join_query_p50_ms: percentileOf(detail.samplesMs, 50),
          detail_join_query_p95_ms: percentileOf(detail.samplesMs, 95),
          dashboard_result_count: dashboard.rowCount,
          detail_join_result_count: detail.rowCount,
        },
        notes: [
          'Deep relationship queries join organizations -> projects -> tasks (dashboard rollup) and tasks -> projects -> organizations -> app_users (detail join) over locally synced rusqlite tables.',
          'Per-iteration timings are measured inside the Rust process (benchQuery).',
        ],
        metadata: { ...BASE_METADATA, rowCount, projectCount, iterations },
      };
    } catch (error) {
      return failedResult(error);
    } finally {
      sampler?.stop();
      await client?.close();
    }
  }

  async runPermissionChange(): Promise<ScenarioResult> {
    let client: RustClient | null = null;
    let rebootstrapClient: RustClient | null = null;
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      const tasksPerProject = 500;
      await seedStackPatient({
        orgCount: 1,
        projectsPerOrg: 2,
        usersPerOrg: 4,
        tasksPerProject,
        membershipsPerProject: 2,
      });
      const fixtures = requireFixtures(await getFixtures(STACK_ID));
      const actorId = fixtures.userIds[0] as string;
      const revokedProjectId = fixtures.projectIds[0];
      const retainedProjectId = fixtures.projectIds[1];
      if (!revokedProjectId || !retainedProjectId) {
        throw new Error('permission change needs two seeded projects');
      }

      // Per-project subscriptions are MANDATORY here: revoking the membership
      // empties the revoked subscription's effective scope, which purges that
      // project's rows; a single multi-project subscription would only narrow.
      client = await RustClient.start({
        binPath,
        actorId,
        clientId: 'rust-permission-change',
      });
      await client.subscribe(`tasks:${revokedProjectId}`, 'tasks', {
        project_id: [revokedProjectId],
      });
      await client.subscribe(`tasks:${retainedProjectId}`, 'tasks', {
        project_id: [retainedProjectId],
      });
      await client.syncToIdle();
      await client.call('connectRealtime', {});
      const initialVisibleRows = await client.count(
        'SELECT count(*) AS n FROM tasks'
      );
      const statsBefore = await client.stats();

      // Arm the same-client wait BEFORE the revoke; the in-Rust loop syncs on
      // realtime wakes and on a 25ms forced cadence (the revoked membership
      // may take the wake path away with it).
      const waitPromise = client.waitForQuery({
        sql: 'SELECT id FROM tasks WHERE project_id = ? LIMIT 1',
        params: [revokedProjectId],
        matchCount: { op: 'eq', value: 0 },
        timeoutMs: 60_000,
        forceSyncIntervalMs: 25,
      });
      await Bun.sleep(10);

      const revokeStartedAt = performance.now();
      const response = await fetch(
        `${this.stack.adminBaseUrl}/admin/revoke-membership`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actorId, projectId: revokedProjectId }),
        }
      );
      if (!response.ok) {
        throw new Error(`revoke-membership failed: ${response.status}`);
      }
      const revokeRequestMs = performance.now() - revokeStartedAt;

      const wait = await waitPromise;
      const convergenceMs = performance.now() - revokeStartedAt;
      if (!wait.ok) {
        throw new Error('revoked project rows did not purge within 60s');
      }

      const revokedRows = await client.count(
        'SELECT count(*) AS n FROM tasks WHERE project_id = ?',
        [revokedProjectId]
      );
      const retainedRows = await client.count(
        'SELECT count(*) AS n FROM tasks WHERE project_id = ?',
        [retainedProjectId]
      );
      const postRevokeRows = await client.count(
        'SELECT count(*) AS n FROM tasks'
      );
      if (revokedRows !== 0 || retainedRows !== tasksPerProject) {
        throw new Error(
          `permission change did not converge: revoked=${revokedRows}, retained=${retainedRows}`
        );
      }
      const statsAfter = await client.stats();

      // Rebootstrap path: a fresh client for the same actor requests both
      // projects; only the retained one materializes.
      const rebootstrapStartedAt = performance.now();
      rebootstrapClient = await RustClient.start({
        binPath,
        actorId,
        clientId: 'rust-permission-rebootstrap',
      });
      await rebootstrapClient.subscribe(`tasks:${revokedProjectId}`, 'tasks', {
        project_id: [revokedProjectId],
      });
      await rebootstrapClient.subscribe(
        `tasks:${retainedProjectId}`,
        'tasks',
        { project_id: [retainedProjectId] }
      );
      await rebootstrapClient.syncToIdle();
      const rebootstrapMs = performance.now() - rebootstrapStartedAt;
      const rebootstrapRevoked = await rebootstrapClient.count(
        'SELECT count(*) AS n FROM tasks WHERE project_id = ?',
        [revokedProjectId]
      );
      const rebootstrapRetained = await rebootstrapClient.count(
        'SELECT count(*) AS n FROM tasks WHERE project_id = ?',
        [retainedProjectId]
      );
      const rebootstrapTotal = await rebootstrapClient.count(
        'SELECT count(*) AS n FROM tasks'
      );
      if (rebootstrapRevoked !== 0 || rebootstrapRetained !== tasksPerProject) {
        throw new Error(
          `rebootstrap after revoke did not converge: revoked=${rebootstrapRevoked}, retained=${rebootstrapRetained}`
        );
      }

      const revokeStats = diffStats(statsAfter, statsBefore);
      return {
        status: 'completed',
        metrics: {
          initial_visible_rows: initialVisibleRows,
          post_revoke_visible_rows: postRevokeRows,
          revoked_project_visible_rows_after_revoke: revokedRows,
          retained_project_visible_rows_after_revoke: retainedRows,
          permission_revoke_convergence_ms: round(convergenceMs),
          same_client_permission_revoke_convergence_ms: round(convergenceMs),
          revoke_request_ms: round(revokeRequestMs),
          rebootstrap_permission_visible_ms: round(rebootstrapMs),
          rebootstrap_visible_rows: rebootstrapTotal,
          rebootstrap_revoked_project_visible_rows: rebootstrapRevoked,
          rebootstrap_retained_project_visible_rows: rebootstrapRetained,
          request_count: revokeStats.requestCount,
          request_bytes: revokeStats.requestBytes,
          response_bytes: revokeStats.responseBytes,
          bytes_transferred: bytesTransferred(revokeStats),
        },
        notes: [
          'Same-client convergence uses the native auth-scoped path: the membership delete empties the per-project subscription effective scope on the next sync round and the Rust client purges the revoked project rows locally.',
          'The rebootstrap path measures a fresh Rust client requesting both projects after the revoke; the revoked subscription yields no rows.',
        ],
        metadata: {
          ...BASE_METADATA,
          actorId,
          revokedProjectId,
          retainedProjectId,
        },
      };
    } catch (error) {
      return failedResult(error);
    } finally {
      await client?.close();
      await rebootstrapClient?.close();
    }
  }

  async runBlobFlow(): Promise<ScenarioResult> {
    let uploader: RustClient | null = null;
    let downloader: RustClient | null = null;
    try {
      await ensureStackUp(STACK_ID);
      const binPath = await ensureBenchBinary();
      await seedStackPatient({
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: 50,
        membershipsPerProject: 2,
      });
      const fixtures = requireFixtures(await getFixtures(STACK_ID));
      const uploaderActor = fixtures.userIds[0] as string;
      const downloaderActor = fixtures.userIds[1] ?? uploaderActor;

      uploader = await RustClient.start({
        binPath,
        actorId: uploaderActor,
        clientId: 'rust-blob-uploader',
      });
      await uploader.subscribe(`tasks:${fixtures.projectId}`, 'tasks', {project_id: [fixtures.projectId]});
      await uploader.subscribe(`blobs:${fixtures.projectId}`, 'task_blob_entries', {project_id: [fixtures.projectId]});
      await uploader.syncToIdle();

      downloader = await RustClient.start({
        binPath,
        actorId: downloaderActor,
        clientId: 'rust-blob-downloader',
      });
      await downloader.subscribe(`tasks:${fixtures.projectId}`, 'tasks', {project_id: [fixtures.projectId]});
      await downloader.subscribe(`blobs:${fixtures.projectId}`, 'task_blob_entries', {project_id: [fixtures.projectId]});
      await downloader.syncToIdle();
      await downloader.call('connectRealtime', {});

      const initialStats = sumStats([await uploader.stats(), await downloader.stats()]);
      const storageSql = 'SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()';
      const uploaderStorageBefore = await uploader.count(storageSql);
      const downloaderStorageBefore = await downloader.count(storageSql);
      const blobSizeBytes = 2 * 1024 * 1024; // 2 MiB — matches the syncular (JS) row
      const blobBytes = new Uint8Array(blobSizeBytes);
      for (let offset = 0; offset < blobBytes.length; offset += 65_536) {
        crypto.getRandomValues(blobBytes.subarray(offset, Math.min(offset + 65_536, blobBytes.length)));
      }
      const blobHex = Buffer.from(blobBytes).toString('hex');

      // Upload: stage the blob, reference it from a synced row, and sync —
      // the sync round takes the presigned upload-grant + PUT path (§5.9.3).
      const uploadStartedAt = performance.now();
      const uploadResult = await uploader.call('uploadBlob', {
        bytes: { $bytes: blobHex },
        mediaType: 'application/octet-stream',
        name: 'bench.bin',
      });
      const ref = uploadResult.ref as Record<string, JsonValue>;
      if (!ref?.blobId || ref.byteLength === undefined) {
        throw new Error('uploadBlob returned no ref');
      }
      // Canonical BlobRef string (§5.9.1 key order).
      const refString = JSON.stringify({
        blobId: ref.blobId,
        byteLength: ref.byteLength,
        ...(ref.mediaType !== undefined ? { mediaType: ref.mediaType } : {}),
        ...(ref.name !== undefined ? { name: ref.name } : {}),
      });
      const entryId = `blob-entry-${Date.now()}`;
      await uploader.call('mutate', {
        mutations: [
          {
            op: 'upsert',
            table: 'task_blob_entries',
            values: {
              id: entryId,
              project_id: fixtures.projectId,
              task_id: fixtures.taskId,
              blob: refString,
              created_at_ms: Date.now(),
            },
          },
        ],
      });

      // Arm the metadata wait on the second client before the push lands.
      const waitPromise = downloader.waitForQuery({
        sql: 'SELECT blob FROM task_blob_entries WHERE id = ?',
        params: [entryId],
        matchCount: { op: 'gte', value: 1 },
        timeoutMs: 30_000,
      });
      await Bun.sleep(10);
      await uploader.syncToIdle();
      const uploadCompleteMs = performance.now() - uploadStartedAt;

      const uploaderStorageAfter = await uploader.count(storageSql);
      const wait = await waitPromise;
      const metadataVisibleMs = performance.now() - uploadStartedAt;
      if (!wait.ok) {
        throw new Error('blob metadata row did not reach the second client');
      }

      // Authenticated re-download on the second client: the blob endpoint
      // issues a presigned GET (§5.9.5) which the Rust transport fetches
      // directly (no host auth on the presigned URL).
      const downloadStartedAt = performance.now();
      const fetchResult = await downloader.call('fetchBlob', {
        blob: refString,
      });
      const downloadMs = performance.now() - downloadStartedAt;
      const blob = fetchResult.blob as Record<string, JsonValue>;
      const bytes = blob?.bytes as { $bytes?: string } | undefined;
      const downloadedLength = (bytes?.$bytes?.length ?? 0) / 2;
      if (
        Number(blob?.byteLength) !== blobSizeBytes ||
        downloadedLength !== blobSizeBytes
      ) {
        throw new Error(
          `blob byteLength mismatch: expected ${blobSizeBytes}, got ${String(blob?.byteLength)} (${downloadedLength} bytes)`
        );
      }

      if (bytes?.$bytes !== blobHex) throw new Error('Downloaded Rust blob bytes differ from the upload');
      const downloaderStorageAfter = await downloader.count(storageSql);
      const stats = diffStats(sumStats([await uploader.stats(), await downloader.stats()]), initialStats);

      // Simulate one unavailable upload pass, including the direct route the
      // product tries when the presigned PUT fails. The native queue owns retry.
      const retryBytes = blobBytes.slice();
      retryBytes[0] = retryBytes[0]! ^ 0xff;
      const retryHex = Buffer.from(retryBytes).toString('hex');
      const retryUpload = await uploader.call('uploadBlob', {
        bytes: { $bytes: retryHex }, options: { mediaType: 'application/octet-stream' },
      });
      const retryRef = retryUpload.ref as Record<string, JsonValue>;
      if (typeof retryRef.blobId !== 'string') throw new Error('Retry upload returned no blob ID');
      const retryRefString = JSON.stringify({blobId: retryRef.blobId, byteLength: retryRef.byteLength, mediaType: retryRef.mediaType});
      const retryEntryId = `rust-blob-retry-${Date.now()}`;
      await uploader.call('mutate', {mutations: [{op: 'upsert', table: 'task_blob_entries', values: {
        id: retryEntryId, project_id: fixtures.projectId, task_id: fixtures.taskId,
        blob: retryRefString, created_at_ms: Date.now(),
      }}]});
      await uploader.call('blockBlobUploads', {blocked: true});
      const firstAttemptStarted = performance.now();
      const firstAttempt = await uploader.call('sync', {});
      const firstAttemptMs = performance.now() - firstAttemptStarted;
      const outage = await uploader.call('blockBlobUploads', {blocked: false});
      const queuedAfterFailure = await uploader.count('SELECT count(*) AS n FROM _syncular_blob_uploads WHERE blob_id = ?', [retryRef.blobId]);
      if (firstAttempt.ok !== false || outage.rejectedPuts !== 2 || queuedAfterFailure !== 1) {
        throw new Error(`Rust upload outage did not preserve the pending blob: ${JSON.stringify({firstAttempt,outage,queuedAfterFailure})}`);
      }
      const recoveryStarted = performance.now();
      await uploader.syncToIdle();
      const retryRecoveryMs = performance.now() - recoveryStarted;
      const queuedAfterRecovery = await uploader.count('SELECT count(*) AS n FROM _syncular_blob_uploads');
      if (queuedAfterRecovery !== 0 || await uploader.count('SELECT count(*) AS n FROM _syncular_outbox') !== 0) {
        throw new Error('Rust retry left pending uploads or metadata commits');
      }
      await downloader.syncToIdle();
      if (await downloader.count('SELECT count(*) AS n FROM task_blob_entries WHERE id = ?', [retryEntryId]) !== 1) {
        throw new Error('Retried Rust blob metadata did not reach the reader');
      }
      const recovered = await downloader.call('fetchBlob', {blob: retryRefString});
      const recoveredBlob = recovered.blob as Record<string, JsonValue>;
      const recoveredBytes = recoveredBlob.bytes as {$bytes?: string};
      if (recoveredBytes.$bytes !== retryHex) throw new Error('Retried Rust blob bytes differ from the upload');

      return {
        status: 'completed',
        metrics: {
          blob_size_bytes: blobSizeBytes,
          hash_verified: 1,
          retry_first_attempt_ms: round(firstAttemptMs),
          retry_recovery_ms: round(retryRecoveryMs),
          retry_failed_puts: Number(outage.rejectedPuts),
          retry_pending_after_failure: queuedAfterFailure,
          retry_pending_after_recovery: queuedAfterRecovery,
          retry_hash_verified: 1,
          transfer_overhead_bytes: bytesTransferred(stats) - 2 * blobSizeBytes,
          sqlite_storage_bytes_after_upload: uploaderStorageAfter,
          sqlite_storage_bytes_after_download: downloaderStorageAfter,
          sqlite_storage_overhead_bytes_after_upload: uploaderStorageAfter - uploaderStorageBefore - blobSizeBytes,
          sqlite_storage_overhead_bytes_after_download: downloaderStorageAfter - downloaderStorageBefore - blobSizeBytes,
          upload_complete_ms: round(uploadCompleteMs),
          metadata_visible_ms: round(metadataVisibleMs, 3),
          download_after_metadata_ms: round(downloadMs, 3),
          request_count: stats.requestCount,
          request_bytes: stats.requestBytes,
          response_bytes: stats.responseBytes,
          bytes_transferred: bytesTransferred(stats),
        },
        notes: [
          'Transfer overhead covers the initial upload, metadata sync and first reader download minus two payloads, excluding setup and the separate retry case. Native transport counters omit JSON grant/redirect response bodies; this is a lower bound on protocol overhead.',
          'SQLite overhead is page-count × page-size growth minus one payload. The retry case rejects signed and authenticated PUTs for one sync pass, verifies native queue retention, restores transport and verifies recovery bytes on the reader.',
          'Blob flow uses the native Rust blob APIs end to end: staged upload + presigned PUT during sync on client A, metadata row sync to client B over realtime, then an authenticated presigned GET re-download on B with byte-length verification.',
        ],
        metadata: {
          ...BASE_METADATA,
          implementation: 'syncular-rust-presigned-cross-client-blob-flow-v2',
          transferOverheadLowerBound: true,
          blobDelivery: 'presigned (MinIO)',
          entryId,
          blobId: (ref.blobId as JsonValue) ?? null,
        },
      };
    } catch (error) {
      return failedResult(error);
    } finally {
      await uploader?.close();
      await downloader?.close();
    }
  }
}
