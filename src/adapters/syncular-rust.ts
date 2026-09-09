import { runAttachments } from '../attachments/run.ts';
import { runAccess } from '../access/run.ts';
import { assertRustExecutable } from '../executables.ts';
import { runFanout } from '../fanout/run.ts';
import { runStartup } from '../startup/run.ts';
import { runReopen } from '../recovery/reopen.ts';
import { runConflicts } from '../recovery/conflicts.ts';
import { runRecovery } from '../recovery/run.ts';
import { measureCollaboration, collaborationSeed, pollUntil } from '../contracts/collaboration.ts';
import { measureScreens, screenSeed, screenQueries, type ScreenCase, type Row } from '../contracts/screens.ts';
/**
 * Syncular v2 NATIVE Rust client benchmark adapter.
 *
 * Drives the `syncular-bench` Rust driver binary (harness-owned, vendored at
 * drivers/syncular-rust/ and built against the published syncular-* crates from
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
import { getClientStack as getStack } from '../stacks';
import { indexedSyncularSchema as schema, captureScreenPlans } from '../contracts/screen-indexes.ts';
import type {
  BenchmarkAdapter,
  BenchmarkStatus,
  JsonObject,
  JsonValue,
  StackFixtures,
} from '../types';

const STACK_ID = 'syncular-rust' as const;
// The Rust driver is harness-owned and vendored into this repo at
// drivers/syncular-rust/ (a standalone crate depending on the published
// syncular-* crates from crates.io). It builds and runs here — no syncular
// checkout required.
const SYNCULAR_RUST_ROOT = join(benchmarkRoot, 'drivers/syncular-rust');
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

export async function ensureBenchBinary(): Promise<string> {
  if (cachedBinaryPath) { assertRustExecutable(cachedBinaryPath); return cachedBinaryPath; }
  const configured = process.env.SYNCULAR_RUST_BENCH_BIN ?? DEFAULT_BIN_PATH;
  if (process.env.SYNCULAR_RUST_BENCH_BIN) {
    if (!await Bun.file(configured).exists()) throw new Error(`Configured Rust executable does not exist: ${configured}`);
    assertRustExecutable(configured); cachedBinaryPath = configured; return configured;
  }
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
  const build = Bun.spawnSync(['cargo', 'build', '--release', '--locked'], {
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
export class RustClient {
  readonly actorId: string;
  readonly clientId: string;
  readonly #proc: BenchProcess;
  readonly #pending = new Map<
    number,
    {
      resolve: (value: Record<string, JsonValue>) => void;
      reject: (error: Error) => void;
      onEvent?: (event: string, data: JsonObject) => void;
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
    syncBaseUrl?: string;
  }): Promise<RustClient> {
    const stack = getStack(STACK_ID);
    const wsBase = args.syncBaseUrl ? `${args.syncBaseUrl.replace(/^http/, 'ws')}/sync/realtime` : stack.syncRealtimeBaseUrl;
    if (!wsBase) {
      throw new Error('syncular-rust stack is missing syncRealtimeBaseUrl');
    }
    assertRustExecutable(args.binPath);
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
          baseUrl: args.syncBaseUrl ?? stack.syncBaseUrl,
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
          let message: { id?: number; result?: JsonValue; error?: DriverError; event?: string; data?: JsonObject };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            continue;
          }
          if (typeof message.id !== 'number') continue;
          const entry = this.#pending.get(message.id);
          if (!entry) continue;
          if (message.event) { entry.onEvent?.(message.event, message.data ?? {}); continue; }
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
    params: JsonObject = {},
    onEvent?: (event: string, data: JsonObject) => void
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
          onEvent,
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
    pollIntervalMs?: number;
  }): Promise<WaitForQueryResult> {
    const result = await this.call('waitForQuery', {
      sql: args.sql,
      params: args.params ?? [],
      ...(args.matchCount ? { matchCount: args.matchCount } : {}),
      timeoutMs: args.timeoutMs ?? 30_000,
      ...(args.pollIntervalMs !== undefined ? { pollIntervalMs: args.pollIntervalMs } : {}),
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
      // `close` makes the binary exit its loop after native resource teardown.
      this.#proc.stdin.write(`${JSON.stringify({ id: 0, method: 'close', params: {} })}\n`);
      this.#proc.stdin.flush();
    } catch {
      // Best-effort shutdown.
    }
    this.#closed = true;
    // The close command normally exits the driver. Avoid racing that exit with
    // an immediate kill; retain a bounded fallback for a stuck native process.
    const timeout = setTimeout(() => { if (this.#proc.exitCode === null) this.#proc.kill(); }, 2_000);
    try { await this.#proc.exited; } finally { clearTimeout(timeout); }
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
    metadata: { ...BASE_METADATA, ...(error instanceof Error && 'evidence' in error ? { evidence: error.evidence as JsonObject } : {}) },
  };
}

export class SyncularRustBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack(STACK_ID);

  async runBootstrap() { return runStartup('syncular-rust'); }

  async runOnlinePropagation(): Promise<ScenarioResult> {
    await ensureStackUp(STACK_ID);
    const binPath = await ensureBenchBinary();
    await seedStackPatient(collaborationSeed);
    const fixtures = requireFixtures(await getFixtures(STACK_ID));
    const writer = await RustClient.start({ binPath, actorId: fixtures.userIds[0]!, clientId: 'rust-writer' });
    const reader = await RustClient.start({ binPath, actorId: fixtures.userIds[1]!, clientId: 'rust-reader' });
    try {
      for (const client of [writer, reader]) { await subscribeAll(client, fixtures.orgId, [fixtures.projectId]); await client.syncToIdle(); }
      await reader.call('connectRealtime', {});
      const result = await measureCollaboration({
      readData: () => reader.queryRows('SELECT * FROM tasks'),
        localCommit: true,
        write: async (title, milestones) => {
          await mutateTaskTitle(writer, fixtures.taskId, title); milestones.localCommitted();
          const outcome = await writer.call('sync', {});
          if (outcome.ok === false) throw new Error(`Rust sync failed: ${JSON.stringify(outcome)}`);
          milestones.serverAccepted();
        },
        observe: async title => { const observed = await reader.waitForQuery({ sql: 'SELECT id FROM tasks WHERE id = ? AND title = ?', params: [fixtures.taskId, title], matchCount: { op: 'eq', value: 1 }, timeoutMs: 30_000 }); if (!observed.ok) throw new Error('Rust reader visibility timed out'); },
        diagnostics: { localCommit: 'native mutate returned through driver', serverAccepted: 'successful combined sync response through driver', reader: 'native 1ms query loop with realtime traffic processing; driver response receipt is included', localStorage: 'rusqlite-memory' },
      });
      return { status: 'completed', ...result, metadata: { ...BASE_METADATA, ...result.metadata, implementation: 'syncular-rust-collaboration-v2' } };
    } finally { await writer.close(); await reader.close(); }
  }

  async runReplicaReopen() { return runReopen('syncular-rust'); }

  async runConflictUpdateUpdate() { return runConflicts('syncular-rust', 'conflict-update-update'); }
  async runConflictUpdateDelete() { return runConflicts('syncular-rust', 'conflict-update-delete'); }

  async runOfflineRestart(): Promise<ScenarioResult> { return runRecovery(STACK_ID, 'offline-restart'); }

  async runOfflineReplay(): Promise<ScenarioResult> { return runRecovery(STACK_ID, 'offline-replay'); }

  async runConnectedFanout() { return runFanout('syncular-rust', 'connected-fanout'); }

  async runReconnectStorm() { return runFanout('syncular-rust', 'reconnect-storm'); }

  async runLargeOfflineQueue(): Promise<ScenarioResult> { return runRecovery(STACK_ID, 'large-offline-queue'); }

  async runLocalQuery(): Promise<ScenarioResult> { return this.runScreens('local-query'); }

  async runDeepRelationshipQuery(): Promise<ScenarioResult> { return this.runScreens('deep-relationship-query'); }

  private async runScreens(scenario: ScreenCase): Promise<ScenarioResult> {
    await ensureStackUp(STACK_ID);
    const binPath = await ensureBenchBinary();
    await seedStackPatient(screenSeed(scenario));
    const fixtures = requireFixtures(await getFixtures(STACK_ID));
    const client = await RustClient.start({ binPath, actorId: fixtures.userIds[0]!, clientId: `rust-${scenario}` });
    try {
      await subscribeAll(client, fixtures.orgId, []);
      await client.syncToIdle();
      const projects = await client.queryRows('SELECT * FROM projects ORDER BY id');
      await subscribeAll(client, fixtures.orgId, projects.map(row => String(row.id)));
      await client.syncToIdle();
      const result = await measureScreens(scenario, {
        execution: 'native-sql',
        readData: async () => ({ tasks: await client.queryRows('SELECT * FROM tasks'), projects, organizations: await client.queryRows('SELECT * FROM organizations') }),
        query: name => client.queryRows(screenQueries[name]),
        timedQuery: async name => {
          const result = await client.call('benchQuery', { sql: screenQueries[name], iterations: 1 });
          return { elapsedMs: Number((result.nsPerIteration as number[])[0]) / 1_000_000, rows: result.rows as Row[] };
        },
        diagnostics: { queries: screenQueries, timing: 'inside-rust-process', localStorage: 'rusqlite-memory', queryPlans: await captureScreenPlans(scenario, sql => client.queryRows(sql)) },
      });
      return { status: 'completed', ...result, metadata: { ...BASE_METADATA, ...result.metadata, implementation: 'syncular-rust-screens-v2' } };
    } finally { await client.close(); }
  }

  async runPermissionChange() { return runAccess(STACK_ID); }

  async runBlobFlow() { return runAttachments('syncular-rust'); }
}
