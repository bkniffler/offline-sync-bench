import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build as esbuild } from 'esbuild';
import * as fakeIndexedDb from 'fake-indexeddb';
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
  resolveServiceContainerId,
  seedStack,
  startService,
  stopService,
  waitForUrlDown,
} from '../stack-manager';
import { getStack } from '../stacks';
import { createUnsupportedScenarioResult } from '../unsupported';
import { tempRoot } from '../paths';
import type {
  BenchmarkAdapter,
  BenchmarkStatus,
  JsonObject,
  JsonValue,
} from '../types';
import { createHttpMeter, type HttpMeterSnapshot } from '../http-meter';

type RustSqlResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
  numAffectedRows?: number;
  insertId?: number;
};

type RustClientStorage = 'memory' | 'indexedDb' | 'opfsSahPool';

type RustSubscriptionSpec = {
  id: string;
  table: string;
  scopes: Record<string, string | string[]>;
  params?: Record<string, unknown>;
};

type RustClient = {
  setAuthHeaders(headers: Record<string, string>): void;
  setSubscriptions(subscriptions: RustSubscriptionSpec[]): void;
  applyMutation(
    operation: Record<string, unknown>,
    localRow?: Record<string, unknown> | null
  ): Promise<string>;
  syncPush(): Promise<RustSyncResult>;
  syncOnce(): Promise<RustSyncResult>;
  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): RustSqlResult<Row>;
  executeUnsafeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): RustSqlResult<Row>;
  transportStats(): RustTransportStats;
  resetTransportStats(): void;
  runtimeInfo(): Promise<Record<string, JsonValue>>;
  conflictSummaries(): Promise<JsonObject[]>;
  storeBlob(
    data: Uint8Array,
    options?: { mimeType?: string; immediate?: boolean }
  ): Promise<RustBlobRef>;
  retrieveBlob(ref: RustBlobRef): Promise<Uint8Array>;
  isBlobLocal(hash: string): boolean;
  processBlobUploadQueue(options?: {
    retryNow?: boolean;
  }): Promise<{ uploaded: number; failed: number }>;
  blobUploadQueueStats(): RustBlobUploadQueueStats;
  blobCacheStats(): RustBlobCacheStats;
  clearBlobCache(): void;
  close(): void;
};

type RustClientModule = {
  openSyncularRustClient(options: {
    config: Record<string, unknown>;
  }): Promise<RustClient>;
};

type RustWorkerClient = {
  setAuthHeaders(headers: Record<string, string>): Promise<void>;
  startRealtime(options?: Record<string, unknown> | boolean): Promise<void>;
  setSubscriptions(subscriptions: RustSubscriptionSpec[]): Promise<void>;
  applyMutation(
    operation: Record<string, unknown>,
    localRow?: Record<string, unknown> | null
  ): Promise<string>;
  syncPush(): Promise<unknown>;
  syncOnce(): Promise<unknown>;
  transportStats(): Promise<RustTransportStats>;
  resetTransportStats(): Promise<void>;
  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<RustSqlResult<Row>>;
  executeUnsafeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<RustSqlResult<Row>>;
  runtimeInfo(): Promise<Record<string, JsonValue>>;
  connectionState(): {
    closed: boolean;
    pendingRequests: number;
    realtime: string;
    lastDiagnostic?: JsonObject;
    lastError?: JsonObject;
  };
  addRowsChangedListener(listener: (event: JsonObject) => void): () => void;
  close(): Promise<void>;
};

type RustWorkerClientModule = {
  createSyncularWorkerClient(options: {
    config: Record<string, unknown>;
    realtime?: Record<string, unknown>;
    diagnostics?: (event: JsonObject) => void;
  }): Promise<RustWorkerClient>;
};

type LocalQuerySample = {
  elapsedMs: number;
  resultCount: number;
};

type OnlinePropagationSample = {
  iteration: number;
  writeAckMs: number;
  mirrorVisibleMs: number;
  writerCleanupMs: number;
};

type RustTransportStats = {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  snapshotChunkCount?: number;
  snapshotChunkFetchMs?: number;
  snapshotChunkDecompressMs?: number;
  snapshotChunkHashMs?: number;
  snapshotChunkDecodeMs?: number;
  serverBootstrapSnapshotQueryMs?: number;
  serverBootstrapRowFrameEncodeMs?: number;
  serverBootstrapSnapshotBinaryEncodeMs?: number;
  serverBootstrapChunkCacheLookupMs?: number;
  serverBootstrapChunkGzipMs?: number;
  serverBootstrapChunkHashMs?: number;
  serverBootstrapChunkPersistMs?: number;
};

type RustSyncTimings = {
  totalMs?: number;
  pushMs?: number;
  pullMs?: number;
  pullRequestMs?: number;
  pullTransformMs?: number;
  snapshotFetchMs?: number;
  pullApplyMs?: number;
  notifyMs?: number;
};

type RustSyncResult = {
  pushedCommits?: number;
  timings?: RustSyncTimings;
};

type RustSchemaContract = {
  localBaseSchema: {
    tableSetupSql: string[];
  };
  localDerivedSchema: {
    indexes: Array<{ table: string; name: string; sql: string }>;
    readModelSetupSql: string[];
    readModelRebuildSql: string[];
  };
};

type RustBootstrapTimingTotals = {
  syncCalls: number;
  totalMs: number;
  pushMs: number;
  pullMs: number;
  pullRequestMs: number;
  pullTransformMs: number;
  snapshotFetchMs: number;
  pullApplyMs: number;
  localApplyMs: number;
  notifyMs: number;
};

type RustBootstrapScaleResult = {
  rowsTarget: number;
  timeToFirstQueryMs: number;
  derivedSchemaMs: number;
  rowsLoaded: number;
  syncCalls: number;
  totalSyncMs: number;
  pushMs: number;
  pullMs: number;
  pullRequestMs: number;
  pullTransformMs: number;
  snapshotFetchMs: number;
  pullApplyMs: number;
  localApplyMs: number;
  notifyMs: number;
  requestCount: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  bytesTransferred: number | null;
  snapshotChunkCount: number;
  snapshotChunkFetchMs: number;
  snapshotChunkDecompressMs: number;
  snapshotChunkHashMs: number;
  snapshotChunkDecodeMs: number;
  serverBootstrapSnapshotQueryMs: number;
  serverBootstrapRowFrameEncodeMs: number;
  serverBootstrapSnapshotBinaryEncodeMs: number;
  serverBootstrapChunkCacheLookupMs: number;
  serverBootstrapChunkGzipMs: number;
  serverBootstrapChunkHashMs: number;
  serverBootstrapChunkPersistMs: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  avgCpuPct: number;
  peakCpuPct: number;
};

type RustReconnectStormCaseResult = {
  mode: RustReconnectMode;
  clientCount: number;
  reconnectConvergenceMs: number;
  clientSyncOnceP50Ms: number | null;
  clientSyncOnceP95Ms: number | null;
  clientSyncOnceP99Ms: number | null;
  clientVisibleP50Ms: number | null;
  clientVisibleP95Ms: number | null;
  clientVisibleP99Ms: number | null;
  extraSyncCalls: number;
  maxExtraSyncCalls: number;
  clientSamples: Array<RustReconnectClientSample | RustWorkerReconnectClientSample>;
  realtimeBinaryAppliedCount?: number;
  realtimePullRequiredCount?: number;
  realtimeReconnectScheduledCount?: number;
  realtimeReconnectPullCount?: number;
  realtimeSyncWakeupP50Ms?: number | null;
  realtimeSyncWakeupP95Ms?: number | null;
  realtimeSyncWakeupP99Ms?: number | null;
  realtimeFirstBinaryAppliedP50Ms?: number | null;
  realtimeFirstBinaryAppliedP95Ms?: number | null;
  realtimeFirstBinaryAppliedP99Ms?: number | null;
  realtimeBinaryApplyTotalP50Ms?: number | null;
  realtimeBinaryApplyTotalP95Ms?: number | null;
  realtimeBinaryApplyTotalP99Ms?: number | null;
  clientVisibleAfterBinaryAppliedP50Ms?: number | null;
  clientVisibleAfterBinaryAppliedP95Ms?: number | null;
  clientVisibleAfterBinaryAppliedP99Ms?: number | null;
  externalWrite?: SyncularRustExternalWriteResult;
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  bytesTransferred: number;
  syncAvgCpuPct: number;
  syncPeakCpuPct: number;
  syncAvgMemoryMb: number;
  syncPeakMemoryMb: number;
  syncRxNetworkMb: number;
  syncTxNetworkMb: number;
  postgresAvgCpuPct: number;
  postgresPeakCpuPct: number;
  postgresAvgMemoryMb: number;
  postgresPeakMemoryMb: number;
  postgresRxNetworkMb: number;
  postgresTxNetworkMb: number;
};

type RustReconnectClientSample = {
  clientIndex: number;
  syncOnceMs: number;
  visibleMs: number;
  waitAfterFirstSyncMs: number;
  extraSyncCalls: number;
  firstSyncTimings: JsonObject;
};

type RustWorkerReconnectClientSample = {
  clientIndex: number;
  visibleMs: number;
  rowsChangedMs?: number;
  diagnosticOffsetsMs?: JsonObject;
  diagnostics: JsonObject;
};

type RustReconnectMode = 'http' | 'worker-realtime';

type SyncularRustExternalWriteResult = {
  timings?: JsonObject;
  realtimeNotify?: JsonObject | null;
};

function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asJsonObjectOrNull(value: unknown): JsonObject | null {
  return asJsonObject(value) ?? null;
}

type RustOfflineReplayCaseResult = {
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
  queuedTaskIds: string[];
  syncAttempts: number;
  matchedTitleCount: number;
  queuedOutbox: RustOutboxStatusCounts;
  reopenedOutbox: RustOutboxStatusCounts | null;
  finalOutbox: RustOutboxStatusCounts;
  reopenedMatchedTitleCount: number | null;
  syncSamples: RustOfflineReplaySyncSample[];
  storage: RustClientStorage;
  durableReopen: boolean;
  browserProcessRestart?: boolean;
  browserStorageFallback?: JsonObject | null;
  browserBootstrapMs?: number;
  browserQueueMs?: number;
  runtimeInfo: Record<string, JsonValue>;
};

type RustOutboxStatusCounts = {
  pending: number;
  sending: number;
  acked: number;
  failed: number;
  total: number;
  unresolved: number;
  statuses: JsonObject;
};

type RustOfflineReplaySyncSample = {
  attempt: number;
  syncMs: number | null;
  matchedTitleCount: number;
  conflictCount: number;
  outboxUnresolved: number;
  outboxPending: number;
  outboxSending: number;
  outboxAcked: number;
  outboxFailed: number;
  pushedCommits: number;
  timings: JsonObject;
  error?: string;
};

type RustPermissionSyncSample = {
  attempt: number;
  syncMs: number;
  countQueryMs: number;
  visibleRows: number;
  timings: JsonObject;
};

type RustBlobRef = {
  hash: string;
  size: number;
  mimeType: string;
  encrypted?: boolean;
  keyId?: string | null;
};

type RustBlobUploadQueueStats = {
  pending: number;
  uploading: number;
  failed: number;
};

type RustBlobCacheStats = {
  count: number;
  totalBytes: number;
};

const SYNCULAR_SERVER_STACK = 'syncular';
const DEFAULT_SYNCULAR_RUST_CLIENT_DIST =
  '/Users/bkniffler/conductor/workspaces/syncular/indianapolis/rust/bindings/browser/dist';
const BOOTSTRAP_TIMEOUT_MS = 180_000;
const PERMISSION_TIMEOUT_MS = 60_000;
const RUST_PULL_LIMIT_COMMITS = 100;
const RUST_PULL_LIMIT_SNAPSHOT_ROWS = 20_000;
const RUST_PULL_MAX_SNAPSHOT_PAGES = 100;
const DEFAULT_RUST_RECONNECT_CLIENT_COUNTS = [25, 100, 250];
const RUST_RECONNECT_MODE = parseRustReconnectMode();
const DEFAULT_RUST_LARGE_OFFLINE_QUEUE_SIZES = [100, 500, 1000];
const RUST_DURABLE_REOPEN = process.env.SYNCULAR_RUST_DURABLE_REOPEN === '1';
const RUST_BROWSER_DURABLE_REOPEN =
  process.env.SYNCULAR_RUST_BROWSER_DURABLE_REOPEN === '1';
const RUST_DURABLE_REOPEN_STORAGE = parseRustClientStorage(
  process.env.SYNCULAR_RUST_DURABLE_REOPEN_STORAGE ?? 'indexedDb',
  'SYNCULAR_RUST_DURABLE_REOPEN_STORAGE'
);
const RUST_DEFAULT_OUTBOX_PUSH_BATCH_LIMIT = 20;
const RUST_DEFAULT_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT = 1000;
const RUST_DEFAULT_ADAPTIVE_OUTBOX_PUSH_THRESHOLD = 100;
const RUST_OUTBOX_PUSH_BATCH_LIMIT = parseOptionalPositiveInteger(
  process.env.SYNCULAR_RUST_OUTBOX_PUSH_BATCH_LIMIT,
  'SYNCULAR_RUST_OUTBOX_PUSH_BATCH_LIMIT'
);
const RUST_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT =
  parseOptionalPositiveInteger(
    process.env.SYNCULAR_RUST_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT,
    'SYNCULAR_RUST_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT'
  ) ?? RUST_DEFAULT_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT;
const RUST_ADAPTIVE_OUTBOX_PUSH_THRESHOLD =
  parseOptionalPositiveInteger(
    process.env.SYNCULAR_RUST_ADAPTIVE_OUTBOX_PUSH_THRESHOLD,
    'SYNCULAR_RUST_ADAPTIVE_OUTBOX_PUSH_THRESHOLD'
  ) ?? RUST_DEFAULT_ADAPTIVE_OUTBOX_PUSH_THRESHOLD;
const RUST_OUTBOX_PUSH_BATCH_MODE = RUST_OUTBOX_PUSH_BATCH_LIMIT
  ? 'fixed'
  : process.env.SYNCULAR_RUST_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT ||
      process.env.SYNCULAR_RUST_ADAPTIVE_OUTBOX_PUSH_THRESHOLD
    ? 'adaptive-configured'
    : 'adaptive-default';
const DEBUG_RUST_WS = process.env.SYNCULAR_RUST_DEBUG_WS === '1';
const RUST_SYNCULAR_SCHEMA_CONTRACT = JSON.parse(
  readFileSync(
    new URL(
      '../../stacks/syncular/syncular-app/syncular.schema.json',
      import.meta.url
    ),
    'utf8'
  )
) as RustSchemaContract;
const RUST_WORKER_DIAGNOSTICS = new WeakMap<RustWorkerClient, JsonObject[]>();

async function loadRustClientModule(): Promise<RustClientModule> {
  const dist =
    process.env.SYNCULAR_RUST_CLIENT_DIST ?? DEFAULT_SYNCULAR_RUST_CLIENT_DIST;
  const modulePath = join(dist, 'rust-client.js');
  await access(modulePath);
  return (await import(pathToFileURL(modulePath).href)) as RustClientModule;
}

async function loadRustWorkerClientModule(): Promise<RustWorkerClientModule> {
  const dist =
    process.env.SYNCULAR_RUST_CLIENT_DIST ?? DEFAULT_SYNCULAR_RUST_CLIENT_DIST;
  const modulePath = join(dist, 'worker-client.js');
  await access(modulePath);
  return (await import(pathToFileURL(modulePath).href)) as RustWorkerClientModule;
}

function syncularRustAppSchema(): JsonObject {
  return {
    schemaVersion: 1,
    tables: [
      {
        name: 'organizations',
        primaryKeyColumn: 'id',
        serverVersionColumn: 'server_version',
        softDeleteColumn: null,
        subscriptionId: 'organizations',
        columns: [
          { name: 'id', typeFamily: 'text', notnullRequired: true, primaryKey: true },
          { name: 'name', typeFamily: 'text', notnullRequired: true, primaryKey: false },
          { name: 'server_version', typeFamily: 'integer', notnullRequired: true, primaryKey: false },
        ],
        blobColumns: [],
        crdtYjsFields: [],
        encryptedFields: [],
        scopes: [{ name: 'id', column: 'id', source: 'projectId', required: false }],
      },
      {
        name: 'projects',
        primaryKeyColumn: 'id',
        serverVersionColumn: 'server_version',
        softDeleteColumn: null,
        subscriptionId: 'projects',
        columns: [
          { name: 'id', typeFamily: 'text', notnullRequired: true, primaryKey: true },
          { name: 'org_id', typeFamily: 'text', notnullRequired: true, primaryKey: false },
          { name: 'name', typeFamily: 'text', notnullRequired: true, primaryKey: false },
          { name: 'server_version', typeFamily: 'integer', notnullRequired: true, primaryKey: false },
        ],
        blobColumns: [],
        crdtYjsFields: [],
        encryptedFields: [],
        scopes: [{ name: 'id', column: 'id', source: 'projectId', required: false }],
      },
      {
        name: 'tasks',
        primaryKeyColumn: 'id',
        serverVersionColumn: 'server_version',
        softDeleteColumn: null,
        subscriptionId: 'tasks',
        columns: [
          { name: 'id', typeFamily: 'text', notnullRequired: true, primaryKey: true },
          { name: 'org_id', typeFamily: 'text', notnullRequired: true, primaryKey: false },
          { name: 'project_id', typeFamily: 'text', notnullRequired: true, primaryKey: false },
          { name: 'owner_id', typeFamily: 'text', notnullRequired: true, primaryKey: false },
          { name: 'title', typeFamily: 'text', notnullRequired: true, primaryKey: false },
          { name: 'completed', typeFamily: 'integer', notnullRequired: true, primaryKey: false },
          { name: 'server_version', typeFamily: 'integer', notnullRequired: true, primaryKey: false },
          { name: 'updated_at', typeFamily: 'text', notnullRequired: true, primaryKey: false },
        ],
        blobColumns: [],
        crdtYjsFields: [],
        encryptedFields: [],
        scopes: [
          {
            name: 'project_id',
            column: 'project_id',
            source: 'projectId',
            required: true,
          },
        ],
      },
      {
        name: 'task_blob_entries',
        primaryKeyColumn: 'id',
        serverVersionColumn: 'server_version',
        softDeleteColumn: null,
        subscriptionId: 'task_blob_entries',
        columns: [
          { name: 'id', typeFamily: 'text', notnullRequired: true, primaryKey: true },
          { name: 'project_id', typeFamily: 'text', notnullRequired: true, primaryKey: false },
          { name: 'blob_hash', typeFamily: 'text', notnullRequired: false, primaryKey: false },
          { name: 'blob_size', typeFamily: 'integer', notnullRequired: false, primaryKey: false },
          { name: 'blob_mime_type', typeFamily: 'text', notnullRequired: false, primaryKey: false },
          { name: 'server_version', typeFamily: 'integer', notnullRequired: true, primaryKey: false },
          { name: 'updated_at', typeFamily: 'text', notnullRequired: true, primaryKey: false },
        ],
        blobColumns: [],
        crdtYjsFields: [],
        encryptedFields: [],
        scopes: [
          {
            name: 'project_id',
            column: 'project_id',
            source: 'projectId',
            required: true,
          },
        ],
      },
    ],
  };
}

async function openBenchRustClient(args: {
  actorId: string;
  clientId: string;
  projectId?: string | null;
  storage?: RustClientStorage;
  fileName?: string;
  clearOnInit?: boolean;
}): Promise<RustClient> {
  installIndexedDbGlobalsIfNeeded(args.storage);
  const mod = await loadRustClientModule();
  const client = await mod.openSyncularRustClient({
    config: {
      baseUrl: `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl}/sync`,
      clientId: args.clientId,
      actorId: args.actorId,
      storage: args.storage ?? 'memory',
      fileName: args.fileName ?? `${args.clientId}.sqlite`,
      clearOnInit: args.clearOnInit ?? true,
      appSchema: syncularRustAppSchema(),
      pull: {
        limitCommits: RUST_PULL_LIMIT_COMMITS,
        limitSnapshotRows: RUST_PULL_LIMIT_SNAPSHOT_ROWS,
        maxSnapshotPages: RUST_PULL_MAX_SNAPSHOT_PAGES,
        includeSnapshotRows: false,
        collectChangedRows: false,
        collectServerTimings: true,
      },
      push: rustOutboxPushOptions(),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    },
  });
  client.setAuthHeaders({ 'x-user-id': args.actorId });
  ensureRustLocalBaseTables(client);
  return client;
}

async function openBenchRustWorkerClient(args: {
  actorId: string;
  clientId: string;
  projectId?: string | null;
}): Promise<RustWorkerClient> {
  const mod = await loadRustWorkerClientModule();
  const diagnostics: JsonObject[] = [];
  const client = await mod.createSyncularWorkerClient({
    config: {
      baseUrl: `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl}/sync`,
      clientId: args.clientId,
      actorId: args.actorId,
      storage: 'memory',
      fileName: `${args.clientId}.sqlite`,
      clearOnInit: true,
      appSchema: syncularRustAppSchema(),
      pull: {
        limitCommits: RUST_PULL_LIMIT_COMMITS,
        limitSnapshotRows: RUST_PULL_LIMIT_SNAPSHOT_ROWS,
        maxSnapshotPages: RUST_PULL_MAX_SNAPSHOT_PAGES,
        includeSnapshotRows: false,
        collectChangedRows: false,
        collectServerTimings: true,
      },
      push: rustOutboxPushOptions(),
      ...(args.projectId ? { projectId: args.projectId } : {}),
    },
    diagnostics: (event) => {
      diagnostics.push(event);
      if (diagnostics.length > 1000) diagnostics.shift();
    },
  });
  RUST_WORKER_DIAGNOSTICS.set(client, diagnostics);
  await client.setAuthHeaders({ 'x-user-id': args.actorId });
  await ensureRustWorkerBaseTables(client);
  return client;
}

const RUST_TASK_BLOB_TABLE_SETUP_SQL = `CREATE TABLE IF NOT EXISTS "task_blob_entries" (
  "id" TEXT PRIMARY KEY,
  "project_id" TEXT NOT NULL,
  "blob_hash" TEXT,
  "blob_size" INTEGER,
  "blob_mime_type" TEXT,
  "server_version" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TEXT NOT NULL
)`;

const RUST_TASK_BLOB_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_task_blob_entries_project_id_id
  on task_blob_entries (project_id, id)`;

const RUST_LOCAL_BASE_TABLE_STATEMENTS = [
  ...RUST_SYNCULAR_SCHEMA_CONTRACT.localBaseSchema.tableSetupSql,
  RUST_TASK_BLOB_TABLE_SETUP_SQL,
];

const RUST_LOCAL_DERIVED_SCHEMA_STATEMENTS = [
  ...RUST_SYNCULAR_SCHEMA_CONTRACT.localDerivedSchema.indexes.map(
    (index) => index.sql
  ),
  RUST_TASK_BLOB_INDEX_SQL,
  ...RUST_SYNCULAR_SCHEMA_CONTRACT.localDerivedSchema.readModelSetupSql,
  ...RUST_SYNCULAR_SCHEMA_CONTRACT.localDerivedSchema.readModelRebuildSql,
];

function ensureRustLocalBaseTables(client: RustClient): void {
  for (const statement of RUST_LOCAL_BASE_TABLE_STATEMENTS) {
    client.executeUnsafeSql(statement);
  }
}

function ensureRustLocalDerivedSchema(client: RustClient): void {
  for (const statement of RUST_LOCAL_DERIVED_SCHEMA_STATEMENTS) {
    client.executeUnsafeSql(statement);
  }
}

async function ensureRustWorkerBaseTables(client: RustWorkerClient): Promise<void> {
  for (const statement of RUST_LOCAL_BASE_TABLE_STATEMENTS) {
    await client.executeUnsafeSql(statement);
  }
}

async function ensureRustWorkerDerivedSchema(
  client: RustWorkerClient
): Promise<void> {
  for (const statement of RUST_LOCAL_DERIVED_SCHEMA_STATEMENTS) {
    await client.executeUnsafeSql(statement);
  }
}

function taskSubscription(projectIds: string | string[]): RustSubscriptionSpec {
  return {
    id: 'tasks',
    table: 'tasks',
    scopes: { project_id: projectIds },
    params: {},
  };
}

function taskBlobSubscription(projectIds: string | string[]): RustSubscriptionSpec {
  return {
    id: 'task_blob_entries',
    table: 'task_blob_entries',
    scopes: { project_id: projectIds },
    params: {},
  };
}

function relationshipSubscriptions(args: {
  orgId: string;
  projectIds: string[];
}): RustSubscriptionSpec[] {
  return [
    {
      id: 'organizations',
      table: 'organizations',
      scopes: { id: args.orgId },
      params: {},
    },
    {
      id: 'projects',
      table: 'projects',
      scopes: { id: args.projectIds },
      params: {},
    },
    taskSubscription(args.projectIds),
  ];
}

function countRows(client: RustClient, table: string): number {
  const result = client.executeSql<{ count: number }>(
    `select count(*) as count from ${table}`
  );
  return Number(result.rows[0]?.count ?? 0);
}

function countTasksForProject(client: RustClient, projectId: string): number {
  const result = client.executeSql<{ count: number }>(
    'select count(*) as count from tasks where project_id = ?',
    [projectId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

function rustOutboxStatusCounts(client: RustClient): RustOutboxStatusCounts {
  const rows = client.executeSql<{ status: string; count: number }>(
    'select status, count(*) as count from sync_outbox_commits group by status'
  ).rows;
  const statuses: JsonObject = {};
  let total = 0;
  for (const row of rows) {
    const status = typeof row.status === 'string' ? row.status : 'unknown';
    const count = Number(row.count ?? 0);
    statuses[status] = count;
    total += count;
  }

  const pending = Number(statuses.pending ?? 0);
  const sending = Number(statuses.sending ?? 0);
  const acked = Number(statuses.acked ?? 0);
  const failed = Number(statuses.failed ?? 0);

  return {
    pending,
    sending,
    acked,
    failed,
    total,
    unresolved: total - acked,
    statuses,
  };
}

function selectRustOfflineQueueRows(args: {
  client: RustClient;
  projectId: string;
  queueSize: number;
}): Record<string, unknown>[] {
  const rows = args.client.executeSql(
    `select *
     from tasks
     where project_id = ?
     order by id asc
     limit ?`,
    [args.projectId, args.queueSize]
  ).rows;
  if (rows.length < args.queueSize) {
    throw new Error(
      `Need at least ${args.queueSize} Rust tasks for offline replay; got ${rows.length}`
    );
  }
  return rows;
}

function countRustMatchingTaskTitles(
  client: RustClient,
  expectedTitles: Map<string, string>
): number {
  const entries = Array.from(expectedTitles.entries());
  let matched = 0;
  for (let offset = 0; offset < entries.length; offset += 500) {
    const chunk = entries.slice(offset, offset + 500);
    const ids = chunk.map(([taskId]) => taskId);
    const expectedById = new Map(chunk);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = client.executeSql<{ id: string; title: string }>(
      `select id, title from tasks where id in (${placeholders})`,
      ids
    ).rows;
    for (const row of rows) {
      if (expectedById.get(row.id) === row.title) {
        matched += 1;
      }
    }
  }
  return matched;
}

function countRustTaskBlobEntries(client: RustClient): number {
  const result = client.executeSql<{ count: number }>(
    'select count(*) as count from task_blob_entries'
  );
  return Number(result.rows[0]?.count ?? 0);
}

function getRustTaskBlobMetadata(
  client: RustClient,
  taskId: string
): {
  blobHash: string | null;
  blobSize: number | null;
  blobMimeType: string | null;
} | null {
  const row = client.executeSql<{
    blob_hash: string | null;
    blob_size: number | null;
    blob_mime_type: string | null;
  }>(
    `select blob_hash, blob_size, blob_mime_type
     from task_blob_entries
     where id = ?
     limit 1`,
    [taskId]
  ).rows[0];

  if (!row) return null;
  return {
    blobHash: row.blob_hash ?? null,
    blobSize: row.blob_size == null ? null : Number(row.blob_size),
    blobMimeType: row.blob_mime_type ?? null,
  };
}

async function waitForRustTaskBlobCount(args: {
  client: RustClient;
  expectedRows: number;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const count = countRustTaskBlobEntries(args.client);
    if (count === args.expectedRows) return;
    if (count > args.expectedRows) {
      throw new Error(
        `Expected ${args.expectedRows} Rust task_blob_entries rows, got ${count}`
      );
    }
    await args.client.syncOnce();
  }

  throw new Error(
    `Timed out waiting for ${args.expectedRows} Rust task_blob_entries rows; got ${countRustTaskBlobEntries(
      args.client
    )}`
  );
}

async function waitForRustBlobMetadata(args: {
  client: RustClient;
  taskId: string;
  expectedHash: string;
  expectedSize: number;
  expectedMimeType: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const metadata = getRustTaskBlobMetadata(args.client, args.taskId);
    if (
      metadata?.blobHash === args.expectedHash &&
      metadata.blobSize === args.expectedSize &&
      metadata.blobMimeType === args.expectedMimeType
    ) {
      return;
    }
    await args.client.syncOnce();
  }

  throw new Error(
    `Timed out waiting for Rust blob metadata on task ${args.taskId}`
  );
}

async function initializeSyncularRustTaskBlobs(projectId: string): Promise<void> {
  const response = await fetch(
    `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(/\/api$/, '')}/benchmark/init-task-blobs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Syncular Rust task-blob init failed: ${response.status} ${response.statusText} ${body}`
    );
  }
}

async function withMeteredGlobalFetch<T>(
  meteredFetch: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = meteredFetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function diffMeterTotals(
  current: HttpMeterSnapshot,
  baseline: HttpMeterSnapshot
): HttpMeterSnapshot {
  return {
    requestCount: current.requestCount - baseline.requestCount,
    requestBytes: current.requestBytes - baseline.requestBytes,
    responseBytes: current.responseBytes - baseline.responseBytes,
  };
}

function createBlobPayload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function createOneShotFailingUploadFetch(baseFetch: typeof fetch): typeof fetch {
  let failedOnce = false;

  const flakyFetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!failedOnce && request.method.toUpperCase() === 'PUT') {
        failedOnce = true;
        throw new Error('offline-sync-bench induced upload failure');
      }
      return baseFetch(request);
    },
    typeof baseFetch.preconnect === 'function'
      ? {
          preconnect: baseFetch.preconnect.bind(baseFetch),
        }
      : {}
  ) as typeof fetch;

  return flakyFetch;
}

async function processRustBlobUploadQueueUntilDrained(args: {
  client: RustClient;
  retryNow?: boolean;
  timeoutMs?: number;
}): Promise<{
  uploaded: number;
  failed: number;
  attempts: number;
}> {
  const timeoutMs = args.timeoutMs ?? 15_000;
  const startedAt = performance.now();
  let uploaded = 0;
  let failed = 0;
  let attempts = 0;

  while (performance.now() - startedAt < timeoutMs) {
    attempts += 1;
    const result = await args.client.processBlobUploadQueue({
      retryNow: args.retryNow === true,
    });
    uploaded += result.uploaded;
    failed += result.failed;
    const stats = args.client.blobUploadQueueStats();
    if (stats.pending === 0 && stats.uploading === 0) {
      return { uploaded, failed, attempts };
    }
    await Bun.sleep(100);
  }

  const stats = args.client.blobUploadQueueStats();
  throw new Error(
    `Timed out waiting for Rust blob upload queue to drain: ${JSON.stringify(stats)}`
  );
}

function percentileOrNull(values: number[], percentileRank: number): number | null {
  return values.length > 0 ? percentile(values, percentileRank) : null;
}

function parseOptionalPositiveInteger(
  raw: string | undefined,
  envName: string
): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${envName} must be a positive integer`);
  }
  return value;
}

function parseRustClientStorage(
  raw: string,
  envName: string
): RustClientStorage {
  if (raw === 'memory' || raw === 'indexedDb' || raw === 'opfsSahPool') {
    return raw;
  }
  throw new Error(`${envName} must be one of memory, indexedDb, opfsSahPool`);
}

function rustOutboxPushOptions(): Record<string, number> {
  if (RUST_OUTBOX_PUSH_BATCH_LIMIT) {
    return { outboxBatchLimit: RUST_OUTBOX_PUSH_BATCH_LIMIT };
  }

  return {
    adaptiveOutboxBatchLimit: RUST_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT,
    adaptiveOutboxBatchThreshold: RUST_ADAPTIVE_OUTBOX_PUSH_THRESHOLD,
  };
}

function installIndexedDbGlobalsIfNeeded(storage: RustClientStorage | undefined) {
  if (storage !== 'indexedDb') return;
  Object.assign(globalThis as Record<string, unknown>, {
    indexedDB: fakeIndexedDb.indexedDB,
    IDBKeyRange: fakeIndexedDb.IDBKeyRange,
    IDBCursor: fakeIndexedDb.IDBCursor,
    IDBCursorWithValue: fakeIndexedDb.IDBCursorWithValue,
    IDBDatabase: fakeIndexedDb.IDBDatabase,
    IDBFactory: fakeIndexedDb.IDBFactory,
    IDBIndex: fakeIndexedDb.IDBIndex,
    IDBObjectStore: fakeIndexedDb.IDBObjectStore,
    IDBOpenDBRequest: fakeIndexedDb.IDBOpenDBRequest,
    IDBRequest: fakeIndexedDb.IDBRequest,
    IDBTransaction: fakeIndexedDb.IDBTransaction,
    IDBVersionChangeEvent: fakeIndexedDb.IDBVersionChangeEvent,
  });
}

type SyncularRustBrowserDurabilityHarness = {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  root: string;
  userDataDir: string;
};

type SyncularRustBrowserPhaseResult = JsonObject & {
  runtimeInfo?: Record<string, JsonValue>;
  storageFallback?: JsonObject | null;
  rowsLoaded?: number;
  expectedTitleEntries?: Array<[string, string]>;
  queuedOutbox?: RustOutboxStatusCounts;
  queuedWriteCount?: number;
  matchedTitleCount?: number;
  reopenedOutbox?: RustOutboxStatusCounts;
  reopenedMatchedTitleCount?: number;
  finalOutbox?: RustOutboxStatusCounts;
  conflictCount?: number;
  syncAttempts?: number;
  syncSamples?: RustOfflineReplaySyncSample[];
  transportStats?: {
    requestCount: number;
    requestBytes: number;
    responseBytes: number;
  };
};

type CdpPendingCommand = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

type CdpEventWaiter = {
  method: string;
  predicate?: (params: unknown) => boolean;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

class ChromeCdpPage {
  #nextId = 1;
  #pending = new Map<number, CdpPendingCommand>();
  #eventWaiters: CdpEventWaiter[] = [];
  #debugEvents: string[] = [];

  constructor(private readonly ws: WebSocket) {
    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      if (
        message.method?.startsWith('Network.') ||
        message.method === 'Log.entryAdded' ||
        message.method === 'Runtime.consoleAPICalled' ||
        message.method === 'Runtime.exceptionThrown'
      ) {
        this.#debugEvents.push(
          `${message.method} ${JSON.stringify(message.params ?? {}).slice(0, 1200)}`
        );
        if (this.#debugEvents.length > 80) {
          this.#debugEvents.shift();
        }
      }
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(message.error.message ?? `CDP command ${message.id} failed`)
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (!message.method) return;
      for (const waiter of [...this.#eventWaiters]) {
        if (waiter.method !== message.method) continue;
        if (waiter.predicate && !waiter.predicate(message.params)) continue;
        clearTimeout(waiter.timer);
        this.#eventWaiters = this.#eventWaiters.filter(
          (candidate) => candidate !== waiter
        );
        waiter.resolve(message.params);
      }
    };
    this.ws.onclose = () => {
      const error = new Error('Chrome DevTools connection closed');
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      for (const waiter of this.#eventWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.#eventWaiters = [];
    };
  }

  send(method: string, params: JsonObject = {}): Promise<unknown> {
    const id = this.#nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  waitForEvent(
    method: string,
    predicate?: (params: unknown) => boolean,
    timeoutMs = 30_000
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const waiter: CdpEventWaiter = {
        method,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#eventWaiters = this.#eventWaiters.filter(
            (candidate) => candidate !== waiter
          );
          reject(new Error(`Timed out waiting for Chrome event ${method}`));
        }, timeoutMs),
      };
      this.#eventWaiters.push(waiter);
    });
  }

  close(): void {
    this.ws.close();
  }

  recentDebugEvents(): string[] {
    return [...this.#debugEvents];
  }
}

function syncularBranchRoot(): string {
  return (
    process.env.SYNCULAR_BRANCH_ROOT ??
    '/Users/bkniffler/conductor/workspaces/syncular/indianapolis'
  );
}

function chromeExecutablePath(): string {
  const configured = process.env.SYNCULAR_RUST_BROWSER_CHROME_PATH;
  if (configured) return configured;
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate local port');
  }
  return address.port;
}

async function waitForChromeVersion(port: number): Promise<void> {
  const startedAt = performance.now();
  let lastError = 'unreachable';
  while (performance.now() - startedAt < 20_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for Chrome DevTools: ${lastError}`);
}

async function startChrome(userDataDir: string): Promise<{
  process: ChildProcessWithoutNullStreams;
  port: number;
}> {
  const executable = chromeExecutablePath();
  await access(executable);
  const port = await allocatePort();
  const child = spawn(executable, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
  ]);
  child.stdout.resume();
  child.stderr.resume();
  await waitForChromeVersion(port);
  return { process: child, port };
}

async function stopChrome(
  child: ChildProcessWithoutNullStreams | undefined
): Promise<void> {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!exited && !child.killed) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

async function openChromePage(port: number, url: string): Promise<ChromeCdpPage> {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to create Chrome target: ${response.status} ${response.statusText}`
    );
  }
  const target = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!target.webSocketDebuggerUrl) {
    throw new Error('Chrome target did not expose a DevTools websocket URL');
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Failed to connect to Chrome target'));
  });
  const page = new ChromeCdpPage(ws);
  await page.send('Page.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');
  await page.send('Runtime.enable');
  const loaded = page.waitForEvent('Page.loadEventFired', undefined, 30_000);
  await page.send('Page.navigate', { url });
  await loaded;
  return page;
}

async function evaluateChromeHarnessPhase(
  harness: SyncularRustBrowserDurabilityHarness,
  args: Record<string, unknown>
): Promise<SyncularRustBrowserPhaseResult> {
  let chrome: Awaited<ReturnType<typeof startChrome>> | undefined;
  let page: ChromeCdpPage | undefined;
  try {
    chrome = await startChrome(harness.userDataDir);
    page = await openChromePage(chrome.port, harness.baseUrl);
    const result = (await page.send('Runtime.evaluate', {
      expression: `globalThis.syncularBrowserDurable(${JSON.stringify(args)})`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 180_000,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(
        `${
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Browser harness evaluation failed'
        }\nBrowser events: ${JSON.stringify(page.recentDebugEvents(), null, 2)}`
      );
    }
    return asJsonObject(result.result?.value) ?? {};
  } finally {
    page?.close();
    await stopChrome(chrome?.process);
  }
}

async function createSyncularRustBrowserDurabilityHarness(): Promise<SyncularRustBrowserDurabilityHarness> {
  const root = join(tempRoot, 'syncular-rust-browser-durable', randomUUID());
  const assetRoot = join(root, 'public');
  const userDataDir = join(root, 'chrome-profile');
  await mkdir(assetRoot, { recursive: true });
  await mkdir(userDataDir, { recursive: true });

  const branchRoot = syncularBranchRoot();
  const harnessEntry = join(root, 'browser-durable-entry.ts');
  const harnessJs = join(assetRoot, 'harness.js');
  const workerJs = join(assetRoot, 'worker.js');
  const wasmRoot = join(branchRoot, 'rust/bindings/javascript/dist/wasm');
  const wasmGlue = join(wasmRoot, 'syncular.js');
  const wasmBinary = join(wasmRoot, 'syncular_bg.wasm');
  await access(wasmGlue);
  await access(wasmBinary);
  await writeFile(
    harnessEntry,
    syncularRustBrowserDurabilityHarnessSource(
      join(branchRoot, 'packages/client/src/worker-client.ts')
    )
  );
  await esbuild({
    absWorkingDir: branchRoot,
    bundle: true,
    entryPoints: [harnessEntry],
    format: 'esm',
    legalComments: 'none',
    outfile: harnessJs,
    platform: 'browser',
    sourcemap: false,
    target: 'es2022',
  });
  await esbuild({
    absWorkingDir: branchRoot,
    bundle: true,
    entryPoints: [join(branchRoot, 'packages/client/src/worker-entry.ts')],
    format: 'esm',
    legalComments: 'none',
    outfile: workerJs,
    platform: 'browser',
    sourcemap: false,
    target: 'es2022',
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') {
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Syncular Rust browser durability</title><script type="module" src="/harness.js"></script>',
          { headers: browserAssetHeaders('text/html; charset=utf-8') }
        );
      }
      if (url.pathname === '/harness.js') {
        return new Response(await readFile(harnessJs), {
          headers: browserAssetHeaders('text/javascript; charset=utf-8'),
        });
      }
      if (url.pathname === '/worker.js') {
        return new Response(await readFile(workerJs), {
          headers: browserAssetHeaders('text/javascript; charset=utf-8'),
        });
      }
      if (url.pathname === '/wasm/syncular.js') {
        return new Response(await readFile(wasmGlue), {
          headers: browserAssetHeaders('text/javascript; charset=utf-8'),
        });
      }
      if (url.pathname === '/wasm/syncular_bg.wasm') {
        return new Response(await readFile(wasmBinary), {
          headers: browserAssetHeaders('application/wasm'),
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}/`,
    root,
    userDataDir,
  };
}

function browserAssetHeaders(contentType: string): Headers {
  return new Headers({
    'content-type': contentType,
    'cross-origin-resource-policy': 'same-origin',
  });
}

async function closeSyncularRustBrowserDurabilityHarness(
  harness: SyncularRustBrowserDurabilityHarness
): Promise<void> {
  harness.server.stop(true);
  await rm(harness.root, { recursive: true, force: true });
}

function syncularRustBrowserDurabilityHarnessSource(clientEntry: string): string {
  return `
import { createSyncularWorkerClient } from ${JSON.stringify(clientEntry)};

const runtime = {
  wasmGlueUrl: new URL('/wasm/syncular.js', location.href).href,
  wasmUrl: new URL('/wasm/syncular_bg.wasm', location.href).href,
};

async function openClient(args) {
  const diagnostics = [];
  const client = await createSyncularWorkerClient({
    config: {
      baseUrl: args.baseUrl,
      clientId: args.clientId,
      actorId: args.actorId,
      projectId: args.projectId,
      storage: 'opfsSahPool',
      fileName: args.fileName,
      clearOnInit: args.clearOnInit,
      appSchema: args.appSchema,
      pull: args.pull,
      ...(args.push ? { push: args.push } : {}),
    },
    worker: () => new Worker(new URL('/worker.js', location.href), { type: 'module' }),
    runtime,
    requestTimeoutMs: 120000,
    diagnostics: (event) => {
      diagnostics.push(event);
      if (diagnostics.length > 200) diagnostics.shift();
    },
    sync: { network: false },
  });
  await client.setAuthHeaders({ 'x-user-id': args.actorId });
  for (const statement of args.baseSql) {
    await client.executeUnsafeSql(statement);
  }
  await client.setSubscriptions(args.subscriptions);
  return { client, diagnostics };
}

async function closeClient(client) {
  await client.close();
}

async function countTasks(client) {
  const result = await client.executeSql('select count(*) as count from tasks');
  return Number(result.rows[0]?.count ?? 0);
}

async function outboxCounts(client) {
  const result = await client.executeSql(
    'select status, count(*) as count from sync_outbox_commits group by status'
  );
  const statuses = {};
  let total = 0;
  for (const row of result.rows) {
    const status = typeof row.status === 'string' ? row.status : 'unknown';
    const count = Number(row.count ?? 0);
    statuses[status] = count;
    total += count;
  }
  const pending = Number(statuses.pending ?? 0);
  const sending = Number(statuses.sending ?? 0);
  const acked = Number(statuses.acked ?? 0);
  const failed = Number(statuses.failed ?? 0);
  return {
    pending,
    sending,
    acked,
    failed,
    total,
    unresolved: total - acked,
    statuses,
  };
}

async function countMatchingTitles(client, entries) {
  let matched = 0;
  for (let offset = 0; offset < entries.length; offset += 200) {
    const chunk = entries.slice(offset, offset + 200);
    const ids = chunk.map(([taskId]) => taskId);
    const expected = new Map(chunk);
    const placeholders = ids.map(() => '?').join(', ');
    const result = await client.executeSql(
      'select id, title from tasks where id in (' + placeholders + ')',
      ids
    );
    for (const row of result.rows) {
      if (expected.get(row.id) === row.title) matched += 1;
    }
  }
  return matched;
}

async function selectQueueRows(client, projectId, queueSize) {
  const result = await client.executeSql(
    'select * from tasks where project_id = ? order by id asc limit ?',
    [projectId, queueSize]
  );
  if (result.rows.length < queueSize) {
    throw new Error('Need ' + queueSize + ' browser OPFS rows, got ' + result.rows.length);
  }
  return result.rows;
}

function compactTimings(timings) {
  return {
    totalMs: Number(timings?.totalMs ?? 0),
    pushMs: Number(timings?.pushMs ?? 0),
    pullMs: Number(timings?.pullMs ?? 0),
    pullRequestMs: Number(timings?.pullRequestMs ?? 0),
    pullTransformMs: Number(timings?.pullTransformMs ?? 0),
    snapshotFetchMs: Number(timings?.snapshotFetchMs ?? 0),
    pullApplyMs: Number(timings?.pullApplyMs ?? 0),
    notifyMs: Number(timings?.notifyMs ?? 0),
  };
}

async function bootstrap(args) {
  const { client } = await openClient({ ...args, clearOnInit: true });
  try {
    const startedAt = performance.now();
    let rowsLoaded = 0;
    let syncAttempts = 0;
    while (performance.now() - startedAt < args.timeoutMs) {
      rowsLoaded = await countTasks(client);
      if (rowsLoaded === args.expectedRows) break;
      if (rowsLoaded > args.expectedRows) {
        throw new Error('Expected ' + args.expectedRows + ' rows, got ' + rowsLoaded);
      }
      syncAttempts += 1;
      await client.syncOnce();
    }
    if (rowsLoaded !== args.expectedRows) {
      throw new Error('Timed out waiting for browser OPFS rows; got ' + rowsLoaded);
    }
    for (const statement of args.derivedSql) {
      await client.executeUnsafeSql(statement);
    }
    const runtimeInfo = await client.runtimeInfo();
    return {
      phase: 'bootstrap',
      rowsLoaded,
      syncAttempts,
      elapsedMs: performance.now() - startedAt,
      runtimeInfo,
      storageFallback: runtimeInfo.storageFallback ?? null,
    };
  } finally {
    await closeClient(client);
  }
}

async function queue(args) {
  const { client } = await openClient({ ...args, clearOnInit: false });
  try {
    const startedAt = performance.now();
    const rows = await selectQueueRows(client, args.projectId, args.queueSize);
    const expectedTitleEntries = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const taskId = String(row.id);
      const title = args.titlePrefix + '-' + index + '-' + Date.now();
      expectedTitleEntries.push([taskId, title]);
      await client.applyMutation(
        {
          table: 'tasks',
          row_id: taskId,
          op: 'upsert',
          payload: { title },
          base_version: Number(row.server_version ?? 0),
        },
        { ...row, title }
      );
    }
    const queuedOutbox = await outboxCounts(client);
    const matchedTitleCount = await countMatchingTitles(
      client,
      expectedTitleEntries
    );
    return {
      phase: 'queue',
      elapsedMs: performance.now() - startedAt,
      queuedWriteCount: queuedOutbox.unresolved,
      queuedOutbox,
      expectedTitleEntries,
      matchedTitleCount,
      runtimeInfo: await client.runtimeInfo(),
    };
  } finally {
    await closeClient(client);
  }
}

async function replay(args) {
  const { client } = await openClient({ ...args, clearOnInit: false });
  try {
    const expectedTitleEntries = args.expectedTitleEntries;
    const reopenedOutbox = await outboxCounts(client);
    const reopenedMatchedTitleCount = await countMatchingTitles(
      client,
      expectedTitleEntries
    );
    await client.resetTransportStats();
    const startedAt = performance.now();
    const samples = [];
    let attempt = 0;
    let finalOutbox = reopenedOutbox;
    let finalMatchedTitleCount = reopenedMatchedTitleCount;
    let finalConflictCount = 0;
    while (performance.now() - startedAt < args.timeoutMs) {
      attempt += 1;
      const syncStartedAt = performance.now();
      let syncResult = null;
      let errorMessage;
      try {
        syncResult = await client.syncOnce();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      finalOutbox = await outboxCounts(client);
      const conflicts = await client.conflictSummaries();
      finalConflictCount = conflicts.length;
      finalMatchedTitleCount = await countMatchingTitles(
        client,
        expectedTitleEntries
      );
      samples.push({
        attempt,
        syncMs: performance.now() - syncStartedAt,
        matchedTitleCount: finalMatchedTitleCount,
        conflictCount: finalConflictCount,
        outboxUnresolved: finalOutbox.unresolved,
        outboxPending: finalOutbox.pending,
        outboxSending: finalOutbox.sending,
        outboxAcked: finalOutbox.acked,
        outboxFailed: finalOutbox.failed,
        pushedCommits: Number(syncResult?.pushedCommits ?? 0),
        timings: compactTimings(syncResult?.timings),
        ...(errorMessage ? { error: errorMessage } : {}),
      });
      if (
        finalOutbox.unresolved === 0 &&
        finalConflictCount === 0 &&
        finalMatchedTitleCount === expectedTitleEntries.length
      ) {
        break;
      }
      if (finalOutbox.failed > 0 || finalConflictCount > 0) break;
      if (errorMessage) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const transportStats = await client.transportStats();
    return {
      phase: 'replay',
      elapsedMs: performance.now() - startedAt,
      reopenedOutbox,
      reopenedMatchedTitleCount,
      finalOutbox,
      matchedTitleCount: finalMatchedTitleCount,
      conflictCount: finalConflictCount,
      syncAttempts: attempt,
      syncSamples: samples,
      transportStats,
      runtimeInfo: await client.runtimeInfo(),
    };
  } finally {
    await closeClient(client);
  }
}

globalThis.syncularBrowserDurable = async (args) => {
  if (args.phase === 'bootstrap') return bootstrap(args);
  if (args.phase === 'queue') return queue(args);
  if (args.phase === 'replay') return replay(args);
  throw new Error('Unknown browser durability phase: ' + args.phase);
};
`;
}

function compactRustSyncTimings(timings: RustSyncTimings | undefined): JsonObject {
  return {
    totalMs: round(timings?.totalMs ?? 0),
    pushMs: round(timings?.pushMs ?? 0),
    pullMs: round(timings?.pullMs ?? 0),
    pullRequestMs: round(timings?.pullRequestMs ?? 0),
    pullTransformMs: round(timings?.pullTransformMs ?? 0),
    snapshotFetchMs: round(timings?.snapshotFetchMs ?? 0),
    pullApplyMs: round(timings?.pullApplyMs ?? 0),
    notifyMs: round(timings?.notifyMs ?? 0),
  };
}

function clearRustWorkerDiagnostics(client: RustWorkerClient): void {
  const diagnostics = RUST_WORKER_DIAGNOSTICS.get(client);
  if (diagnostics) diagnostics.length = 0;
}

function rustWorkerDiagnostics(client: RustWorkerClient): JsonObject[] {
  return [...(RUST_WORKER_DIAGNOSTICS.get(client) ?? [])];
}

function diagnosticCode(event: JsonObject): string | null {
  return typeof event.code === 'string' ? event.code : null;
}

function diagnosticDetailNumber(event: JsonObject, key: string): number | null {
  const details = event.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  const value = details[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diagnosticDetailString(event: JsonObject, key: string): string | null {
  const details = event.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  const value = details[key];
  return typeof value === 'string' ? value : null;
}

function diagnosticDetailBoolean(event: JsonObject, key: string): boolean | null {
  const details = event.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  const value = details[key];
  return typeof value === 'boolean' ? value : null;
}

function diagnosticAtMs(event: JsonObject): number | null {
  const value = event.at;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstDiagnosticOffsetMs(
  events: JsonObject[],
  code: string,
  baseEpochMs: number
): number | null {
  const firstAt = events
    .filter((event) => diagnosticCode(event) === code)
    .map(diagnosticAtMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)[0];
  return firstAt === undefined ? null : round(firstAt - baseEpochMs);
}

function lastDiagnosticOffsetMs(
  events: JsonObject[],
  code: string,
  baseEpochMs: number
): number | null {
  const lastAt = events
    .filter((event) => diagnosticCode(event) === code)
    .map(diagnosticAtMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => b - a)[0];
  return lastAt === undefined ? null : round(lastAt - baseEpochMs);
}

function summarizeRustWorkerDiagnosticOffsets(
  client: RustWorkerClient,
  baseEpochMs: number
): JsonObject {
  const events = rustWorkerDiagnostics(client);
  return {
    firstReconnectScheduledMs: firstDiagnosticOffsetMs(
      events,
      'realtime.reconnect_scheduled',
      baseEpochMs
    ),
    lastReconnectScheduledMs: lastDiagnosticOffsetMs(
      events,
      'realtime.reconnect_scheduled',
      baseEpochMs
    ),
    firstHelloMs: firstDiagnosticOffsetMs(events, 'realtime.hello', baseEpochMs),
    firstSyncWakeupMs: firstDiagnosticOffsetMs(
      events,
      'realtime.sync_wakeup',
      baseEpochMs
    ),
    firstBinaryAppliedMs: firstDiagnosticOffsetMs(
      events,
      'realtime.binary_applied',
      baseEpochMs
    ),
    firstAckSentMs: firstDiagnosticOffsetMs(
      events,
      'realtime.ack_sent',
      baseEpochMs
    ),
  };
}

function countDiagnosticReasons(events: JsonObject[], code: string): JsonObject {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (diagnosticCode(event) !== code) continue;
    const reason = diagnosticDetailString(event, 'reason') ?? 'null';
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function countDiagnosticDetailStrings(
  events: JsonObject[],
  code: string,
  key: string
): JsonObject {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (diagnosticCode(event) !== code) continue;
    const value = diagnosticDetailString(event, key) ?? 'null';
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function countDiagnosticCode(client: RustWorkerClient, code: string): number {
  return rustWorkerDiagnostics(client).filter(
    (event) => diagnosticCode(event) === code
  ).length;
}

function summarizeRustWorkerDiagnostics(client: RustWorkerClient): JsonObject {
  const events = rustWorkerDiagnostics(client);
  const binaryApplyTotalMs = events
    .map((event) => diagnosticDetailNumber(event, 'totalMs'))
    .filter((value): value is number => value !== null);
  const binaryApplyDecodeMs = events
    .map((event) => diagnosticDetailNumber(event, 'syncPackDecodeMs'))
    .filter((value): value is number => value !== null);
  const binaryApplyNotifyMs = events
    .map((event) => diagnosticDetailNumber(event, 'notifyMs'))
    .filter((value): value is number => value !== null);
  const syncWakeupPayloadBytes = events
    .filter((event) => diagnosticCode(event) === 'realtime.sync_wakeup')
    .map((event) => diagnosticDetailNumber(event, 'payloadBytes'))
    .filter((value): value is number => value !== null);
  const pullRequiredPayloadBytes = events
    .filter((event) => diagnosticCode(event) === 'realtime.pull_required')
    .map((event) => diagnosticDetailNumber(event, 'payloadBytes'))
    .filter((value): value is number => value !== null);

  return {
    eventCount: events.length,
    realtimeHelloSyncPackEncodings: countDiagnosticDetailStrings(
      events,
      'realtime.hello',
      'syncPackEncoding'
    ),
    realtimeSyncWakeupCount: events.filter(
      (event) => diagnosticCode(event) === 'realtime.sync_wakeup'
    ).length,
    realtimeSyncWakeupRequiresPullCount: events.filter(
      (event) =>
        diagnosticCode(event) === 'realtime.sync_wakeup' &&
        diagnosticDetailBoolean(event, 'requiresPull') === true
    ).length,
    realtimeSyncWakeupReasons: countDiagnosticReasons(
      events,
      'realtime.sync_wakeup'
    ),
    realtimeSyncWakeupPayloadBytesP50: percentileOrNull(
      syncWakeupPayloadBytes,
      50
    ),
    realtimeSyncWakeupPayloadBytesP95: percentileOrNull(
      syncWakeupPayloadBytes,
      95
    ),
    realtimeSyncWakeupPayloadBytesMax:
      syncWakeupPayloadBytes.length > 0
        ? Math.max(...syncWakeupPayloadBytes)
        : null,
    realtimeBinaryAppliedCount: events.filter(
      (event) => diagnosticCode(event) === 'realtime.binary_applied'
    ).length,
    realtimePullRequiredCount: events.filter(
      (event) => diagnosticCode(event) === 'realtime.pull_required'
    ).length,
    realtimePullRequiredReasons: countDiagnosticReasons(
      events,
      'realtime.pull_required'
    ),
    realtimePullRequiredPayloadBytesP50: percentileOrNull(
      pullRequiredPayloadBytes,
      50
    ),
    realtimePullRequiredPayloadBytesP95: percentileOrNull(
      pullRequiredPayloadBytes,
      95
    ),
    realtimeBinaryApplyFailedCount: events.filter(
      (event) => diagnosticCode(event) === 'realtime.binary_apply_failed'
    ).length,
    realtimeBinaryApplyTotalP50Ms: percentileOrNull(binaryApplyTotalMs, 50),
    realtimeBinaryApplyTotalP95Ms: percentileOrNull(binaryApplyTotalMs, 95),
    realtimeBinaryApplyDecodeP50Ms: percentileOrNull(binaryApplyDecodeMs, 50),
    realtimeBinaryApplyDecodeP95Ms: percentileOrNull(binaryApplyDecodeMs, 95),
    realtimeBinaryApplyNotifyP50Ms: percentileOrNull(binaryApplyNotifyMs, 50),
    realtimeBinaryApplyNotifyP95Ms: percentileOrNull(binaryApplyNotifyMs, 95),
  };
}

function metricNumber(summary: JsonObject, key: string): number | null {
  const value = summary[key];
  return typeof value === 'number' ? value : null;
}

function sumMetricNumber(summaries: JsonObject[], key: string): number {
  return summaries.reduce((total, summary) => {
    const value = metricNumber(summary, key);
    return total + (value ?? 0);
  }, 0);
}

function metricNumbers(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function workerDiagnosticOffsetValues(
  samples: RustWorkerReconnectClientSample[],
  key: string
): number[] {
  return metricNumbers(
    samples.map((sample) => metricNumber(sample.diagnosticOffsetsMs ?? {}, key))
  );
}

function workerDiagnosticMetricValues(
  samples: RustWorkerReconnectClientSample[],
  key: string
): number[] {
  return metricNumbers(
    samples.map((sample) => metricNumber(sample.diagnostics, key))
  );
}

function getRustTaskRow(
  client: RustClient,
  taskId: string
): Record<string, unknown> | null {
  return (
    client.executeSql('select * from tasks where id = ? limit 1', [taskId])
      .rows[0] ?? null
  );
}

function getRustTaskTitle(client: RustClient, taskId: string): string | null {
  const row = client.executeSql<{ title: string }>(
    'select title from tasks where id = ? limit 1',
    [taskId]
  ).rows[0];
  return typeof row?.title === 'string' ? row.title : null;
}

async function getRustWorkerTaskRow(
  client: RustWorkerClient,
  taskId: string
): Promise<Record<string, unknown> | null> {
  return (
    (
      await client.executeSql('select * from tasks where id = ? limit 1', [
        taskId,
      ])
    ).rows[0] ?? null
  );
}

async function getRustWorkerTaskTitle(
  client: RustWorkerClient,
  taskId: string
): Promise<string | null> {
  const row = (
    await client.executeSql<{ title: string }>(
      'select title from tasks where id = ? limit 1',
      [taskId]
    )
  ).rows[0];
  return typeof row?.title === 'string' ? row.title : null;
}

async function waitForRustWorkerRealtimeConnected(args: {
  client: RustWorkerClient;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 10_000;
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (args.client.connectionState().realtime === 'connected') {
      return;
    }
    await Bun.sleep(25);
  }

  throw new Error(
    `Timed out waiting for Rust worker realtime connection: ${JSON.stringify(
      args.client.connectionState()
    )}`
  );
}

async function startRustWorkerRealtime(args: {
  client: RustWorkerClient;
  actorId: string;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectJitterRatio?: number;
  pullRecoveryJitterMs?: number;
}): Promise<void> {
  await args.client.startRealtime({
    wsUrl: getStack(SYNCULAR_SERVER_STACK).syncRealtimeBaseUrl,
    params: { userId: args.actorId },
    initialReconnectDelayMs: args.initialReconnectDelayMs ?? 50,
    maxReconnectDelayMs: args.maxReconnectDelayMs ?? 100,
    reconnectJitterRatio: args.reconnectJitterRatio,
    pullRecoveryJitterMs: args.pullRecoveryJitterMs,
    heartbeatTimeoutMs: 0,
  });
  await waitForRustWorkerRealtimeConnected({ client: args.client });
}

async function waitForRustWorkerTaskTitle(args: {
  client: RustWorkerClient;
  taskId: string;
  expectedTitle: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    if (
      (await getRustWorkerTaskTitle(args.client, args.taskId)) ===
      args.expectedTitle
    ) {
      return;
    }
    await Bun.sleep(5);
  }

  throw new Error(
    `Timed out waiting for Rust worker task ${args.taskId} title ${args.expectedTitle}`
  );
}

async function waitForRustWorkerTaskTitleFromRealtime(args: {
  client: RustWorkerClient;
  taskId: string;
  expectedTitle: string;
  timeoutMs?: number;
}): Promise<{
  rowsChangedAtMs: number;
  visibleAtMs: number;
}> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    const remainingMs = Math.max(1, timeoutMs - (performance.now() - startedAt));
    const rowsChangedEvent = await waitForRustWorkerRowsChanged(
      args.client,
      remainingMs
    );
    const rowsChangedAtMs = performance.now();
    if (rustWorkerRowsChangedMatchesTask(rowsChangedEvent, args.taskId)) {
      const visibleAtMs = performance.now();
      await waitForRustWorkerRealtimeDiagnostic(args.client);
      return {
        rowsChangedAtMs,
        visibleAtMs,
      };
    }
    if (
      (await getRustWorkerTaskTitle(args.client, args.taskId)) ===
      args.expectedTitle
    ) {
      const visibleAtMs = performance.now();
      await waitForRustWorkerRealtimeDiagnostic(args.client);
      return {
        rowsChangedAtMs,
        visibleAtMs,
      };
    }
  }

  throw new Error(
    `Timed out waiting for Rust worker realtime task ${args.taskId} title ${args.expectedTitle}`
  );
}

function waitForRustWorkerRowsChanged(
  client: RustWorkerClient,
  timeoutMs: number
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let remove: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (remove) remove();
      reject(new Error('Timed out waiting for Rust worker rowsChanged event'));
    }, timeoutMs);

    remove = client.addRowsChangedListener((event) => {
      if (DEBUG_RUST_WS) console.error('rust worker rowsChanged');
      clearTimeout(timer);
      if (remove) remove();
      resolve(event);
    });
  });
}

async function waitForRustWorkerRealtimeDiagnostic(
  client: RustWorkerClient,
  timeoutMs = 1_000
): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const hasRealtimeApplyDiagnostic = rustWorkerDiagnostics(client).some(
      (event) => {
        const code = diagnosticCode(event);
        return (
          code === 'realtime.binary_applied' ||
          code === 'realtime.pull_required' ||
          code === 'realtime.binary_apply_failed'
        );
      }
    );
    if (hasRealtimeApplyDiagnostic) return;
    await Bun.sleep(1);
  }
}

function rustWorkerRowsChangedMatchesTask(
  event: JsonObject,
  taskId: string
): boolean {
  const changedTables = event.changedTables;
  if (
    Array.isArray(changedTables) &&
    changedTables.some((table) => table === 'tasks')
  ) {
    return true;
  }
  const changedRows = event.changedRows;
  if (!Array.isArray(changedRows)) return false;
  return changedRows.some((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    const record = row as Record<string, unknown>;
    if (record.table !== 'tasks' || record.rowId !== taskId) return false;
    const changedFields = record.changedFields;
    return Array.isArray(changedFields)
      ? changedFields.includes('title')
      : true;
  });
}

async function waitForRustTaskTitle(args: {
  client: RustClient;
  taskId: string;
  expectedTitle: string;
  timeoutMs?: number;
}): Promise<void> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < (args.timeoutMs ?? 30_000)) {
    if (getRustTaskTitle(args.client, args.taskId) === args.expectedTitle) {
      return;
    }
    await args.client.syncOnce();
    await Bun.sleep(5);
  }

  throw new Error(
    `Timed out waiting for Rust task ${args.taskId} title ${args.expectedTitle}`
  );
}

async function syncRustClientUntilTaskTitle(args: {
  client: RustClient;
  clientIndex: number;
  taskId: string;
  expectedTitle: string;
  convergenceStartedAt: number;
  timeoutMs?: number;
}): Promise<RustReconnectClientSample> {
  const timeoutMs = args.timeoutMs ?? 60_000;
  const syncStartedAt = performance.now();
  const firstSyncResult = await args.client.syncOnce();
  const syncOnceMs = performance.now() - syncStartedAt;
  let extraSyncCalls = 0;

  while (performance.now() - args.convergenceStartedAt < timeoutMs) {
    if (getRustTaskTitle(args.client, args.taskId) === args.expectedTitle) {
      const visibleAt = performance.now();
      return {
        clientIndex: args.clientIndex,
        syncOnceMs: round(syncOnceMs),
        visibleMs: round(visibleAt - args.convergenceStartedAt),
        waitAfterFirstSyncMs: round(visibleAt - syncStartedAt - syncOnceMs),
        extraSyncCalls,
        firstSyncTimings: compactRustSyncTimings(firstSyncResult.timings),
      };
    }
    extraSyncCalls += 1;
    await args.client.syncOnce();
    await Bun.sleep(5);
  }

  throw new Error(
    `Timed out waiting for Rust reconnect client ${args.clientIndex} task ${args.taskId} title ${args.expectedTitle}`
  );
}

async function waitForRustTaskCount(args: {
  client: RustClient;
  expectedRows: number;
  timeoutMs?: number;
}): Promise<{
  rowsLoaded: number;
  timings: RustBootstrapTimingTotals;
}> {
  const startedAt = performance.now();
  const timings = emptyRustBootstrapTimingTotals();
  while (performance.now() - startedAt < (args.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS)) {
    const count = countRows(args.client, 'tasks');
    if (count === args.expectedRows) return { rowsLoaded: count, timings };
    if (count > args.expectedRows) {
      throw new Error(`Expected ${args.expectedRows} Rust rows, got ${count}`);
    }
    accumulateRustSyncTimings(timings, (await args.client.syncOnce()).timings);
  }

  const finalCount = countRows(args.client, 'tasks');
  throw new Error(
    `Timed out waiting for ${args.expectedRows} Rust rows; got ${finalCount}`
  );
}

function emptyRustBootstrapTimingTotals(): RustBootstrapTimingTotals {
  return {
    syncCalls: 0,
    totalMs: 0,
    pushMs: 0,
    pullMs: 0,
    pullRequestMs: 0,
    pullTransformMs: 0,
    snapshotFetchMs: 0,
    pullApplyMs: 0,
    localApplyMs: 0,
    notifyMs: 0,
  };
}

function accumulateRustSyncTimings(
  totals: RustBootstrapTimingTotals,
  timings: RustSyncTimings | undefined
): void {
  totals.syncCalls += 1;
  totals.totalMs += timings?.totalMs ?? 0;
  totals.pushMs += timings?.pushMs ?? 0;
  totals.pullMs += timings?.pullMs ?? 0;
  totals.pullRequestMs += timings?.pullRequestMs ?? 0;
  totals.pullTransformMs += timings?.pullTransformMs ?? 0;
  totals.snapshotFetchMs += timings?.snapshotFetchMs ?? 0;
  totals.pullApplyMs += timings?.pullApplyMs ?? 0;
  totals.localApplyMs += Math.max(
    0,
    (timings?.pullApplyMs ?? 0) - (timings?.snapshotFetchMs ?? 0)
  );
  totals.notifyMs += timings?.notifyMs ?? 0;
}

function parseRustReconnectClientCounts(): number[] {
  const raw = process.env.SYNCULAR_RUST_RECONNECT_CLIENT_COUNTS;
  if (!raw) return DEFAULT_RUST_RECONNECT_CLIENT_COUNTS;

  const values = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (values.length === 0) {
    throw new Error(
      'SYNCULAR_RUST_RECONNECT_CLIENT_COUNTS must contain positive integer counts'
    );
  }
  return values;
}

function parseRustReconnectMode(): RustReconnectMode {
  const raw = process.env.SYNCULAR_RUST_RECONNECT_MODE;
  if (!raw) return 'worker-realtime';
  if (raw === 'http' || raw === 'worker-realtime') return raw;
  throw new Error(
    'SYNCULAR_RUST_RECONNECT_MODE must be either "http" or "worker-realtime"'
  );
}

function parseRustLargeOfflineQueueSizes(): number[] {
  const raw = process.env.SYNCULAR_RUST_LARGE_OFFLINE_QUEUE_SIZES;
  if (!raw) return DEFAULT_RUST_LARGE_OFFLINE_QUEUE_SIZES;

  const values = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (values.length === 0) {
    throw new Error(
      'SYNCULAR_RUST_LARGE_OFFLINE_QUEUE_SIZES must contain positive integer queue sizes'
    );
  }
  return values;
}

async function waitForRustOfflineReplayConvergence(args: {
  client: RustClient;
  expectedTitles: Map<string, string>;
  timeoutMs: number;
}): Promise<{
  syncAttempts: number;
  matchedTitleCount: number;
  conflictCount: number;
  finalOutbox: RustOutboxStatusCounts;
  samples: RustOfflineReplaySyncSample[];
}> {
  const startedAt = performance.now();
  const samples: RustOfflineReplaySyncSample[] = [];
  let attempt = 0;
  let finalMatchedTitleCount = countRustMatchingTaskTitles(
    args.client,
    args.expectedTitles
  );
  let finalConflictCount = 0;
  let finalOutbox = rustOutboxStatusCounts(args.client);

  while (performance.now() - startedAt < args.timeoutMs) {
    attempt += 1;
    const syncStartedAt = performance.now();
    let syncMs: number | null = null;
    let syncResult: RustSyncResult | null = null;
    let errorMessage: string | undefined;
    try {
      syncResult = await args.client.syncOnce();
      syncMs = round(performance.now() - syncStartedAt);
    } catch (error) {
      syncMs = round(performance.now() - syncStartedAt);
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    finalOutbox = rustOutboxStatusCounts(args.client);
    const conflicts = await args.client.conflictSummaries();
    finalConflictCount = conflicts.length;
    finalMatchedTitleCount = countRustMatchingTaskTitles(
      args.client,
      args.expectedTitles
    );
    const pushedCommitsValue = syncResult
      ? (syncResult as Record<string, unknown>).pushedCommits
      : 0;

    samples.push({
      attempt,
      syncMs,
      matchedTitleCount: finalMatchedTitleCount,
      conflictCount: finalConflictCount,
      outboxUnresolved: finalOutbox.unresolved,
      outboxPending: finalOutbox.pending,
      outboxSending: finalOutbox.sending,
      outboxAcked: finalOutbox.acked,
      outboxFailed: finalOutbox.failed,
      pushedCommits:
        typeof pushedCommitsValue === 'number' ? pushedCommitsValue : 0,
      timings: compactRustSyncTimings(syncResult?.timings),
      ...(errorMessage ? { error: errorMessage } : {}),
    });

    if (
      finalOutbox.unresolved === 0 &&
      finalConflictCount === 0 &&
      finalMatchedTitleCount === args.expectedTitles.size
    ) {
      return {
        syncAttempts: attempt,
        matchedTitleCount: finalMatchedTitleCount,
        conflictCount: finalConflictCount,
        finalOutbox,
        samples,
      };
    }

    if (finalOutbox.failed > 0 || finalConflictCount > 0) {
      return {
        syncAttempts: attempt,
        matchedTitleCount: finalMatchedTitleCount,
        conflictCount: finalConflictCount,
        finalOutbox,
        samples,
      };
    }

    if (errorMessage) {
      await Bun.sleep(50);
    }
  }

  throw new Error(
    `Timed out waiting for Rust offline replay: outbox=${JSON.stringify(
      finalOutbox.statuses
    )}, matchedTitles=${finalMatchedTitleCount}/${args.expectedTitles.size}, conflicts=${finalConflictCount}`
  );
}

async function runSyncularRustBrowserDurableReplayCase(args: {
  queueSize: number;
  titlePrefix: string;
}): Promise<RustOfflineReplayCaseResult> {
  await ensureStackUp(SYNCULAR_SERVER_STACK);
  await seedSyncularRustStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: Math.max(200, args.queueSize + 25),
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
  const actorId = fixtures.sampleUserIds[0];
  const projectId = fixtures.sampleProjectId;
  if (!actorId || !projectId) {
    throw new Error('Syncular Rust fixtures are missing actor/project data');
  }

  const clientId = `${args.titlePrefix}-browser-${randomUUID()}`;
  const fileName = `${clientId}.sqlite`;
  const subscriptions = [taskSubscription(projectId)];
  const basePhaseArgs: Record<string, unknown> = {
    actorId,
    appSchema: syncularRustAppSchema(),
    baseSql: RUST_LOCAL_BASE_TABLE_STATEMENTS,
    baseUrl: `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(
      'http://localhost:',
      'http://127.0.0.1:'
    )}/sync`,
    clientId,
    derivedSql: RUST_LOCAL_DERIVED_SCHEMA_STATEMENTS,
    fileName,
    projectId,
    pull: {
      limitCommits: RUST_PULL_LIMIT_COMMITS,
      limitSnapshotRows: RUST_PULL_LIMIT_SNAPSHOT_ROWS,
      maxSnapshotPages: RUST_PULL_MAX_SNAPSHOT_PAGES,
      includeSnapshotRows: false,
      collectChangedRows: false,
      collectServerTimings: true,
    },
    push: rustOutboxPushOptions(),
    subscriptions,
    timeoutMs: 120_000,
  };
  const harness = await createSyncularRustBrowserDurabilityHarness();
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  let syncServiceStarted = true;
  let memoryMetrics: ReturnType<MemorySampler['stop']> | null = null;
  let cpuMetrics: ReturnType<CpuSampler['stop']> | null = null;

  try {
    memorySampler.start();
    cpuSampler.start();
    const bootstrap = await evaluateChromeHarnessPhase(harness, {
      ...basePhaseArgs,
      phase: 'bootstrap',
      expectedRows: Math.max(200, args.queueSize + 25),
    });

    stopService(SYNCULAR_SERVER_STACK, 'sync');
    syncServiceStarted = false;
    await waitForUrlDown(
      `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(/\/api$/, '')}/health`
    );

    const queue = await evaluateChromeHarnessPhase(harness, {
      ...basePhaseArgs,
      phase: 'queue',
      queueSize: args.queueSize,
      titlePrefix: args.titlePrefix,
    });
    const expectedTitleEntries = queue.expectedTitleEntries ?? [];
    const queuedOutbox = queue.queuedOutbox;
    if (!queuedOutbox) {
      throw new Error('Browser OPFS queue phase did not return outbox counts');
    }
    const queuedWriteCount = queue.queuedWriteCount ?? queuedOutbox.unresolved;
    if (queuedWriteCount < args.queueSize) {
      throw new Error(
        `Expected at least ${args.queueSize} browser OPFS queued writes, got ${queuedWriteCount}`
      );
    }
    if ((queue.matchedTitleCount ?? 0) !== expectedTitleEntries.length) {
      throw new Error(
        `Expected browser OPFS queue phase to retain ${expectedTitleEntries.length} local titles, got ${queue.matchedTitleCount ?? 0}`
      );
    }

    startService(SYNCULAR_SERVER_STACK, 'sync');
    syncServiceStarted = true;
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await waitForSyncularRustApiReady({ actorId, projectId });

    const replay = await evaluateChromeHarnessPhase(harness, {
      ...basePhaseArgs,
      phase: 'replay',
      expectedTitleEntries,
      timeoutMs: Math.max(120_000, args.queueSize * 500),
    });
    const reopenedOutbox = replay.reopenedOutbox;
    const finalOutbox = replay.finalOutbox;
    if (!reopenedOutbox || !finalOutbox) {
      throw new Error('Browser OPFS replay phase did not return outbox counts');
    }
    if (reopenedOutbox.unresolved < queuedWriteCount) {
      throw new Error(
        `Expected browser OPFS reopened outbox to retain ${queuedWriteCount} unresolved writes, got ${reopenedOutbox.unresolved}`
      );
    }
    if ((replay.reopenedMatchedTitleCount ?? 0) !== expectedTitleEntries.length) {
      throw new Error(
        `Expected browser OPFS reopened store to retain ${expectedTitleEntries.length} local titles, got ${replay.reopenedMatchedTitleCount ?? 0}`
      );
    }
    const transportStats = replay.transportStats ?? {
      requestCount: 0,
      requestBytes: 0,
      responseBytes: 0,
    };
    memoryMetrics = memorySampler.stop();
    cpuMetrics = cpuSampler.stop();

    return {
      queuedWriteCount,
      reconnectConvergenceMs: round(Number(replay.elapsedMs ?? 0)),
      conflictCount: Number(replay.conflictCount ?? 0),
      replayedWriteSuccessRate: round(
        queuedWriteCount === 0 ? 0 : finalOutbox.acked / queuedWriteCount,
        4
      ),
      requestCount: transportStats.requestCount,
      requestBytes: transportStats.requestBytes,
      responseBytes: transportStats.responseBytes,
      bytesTransferred: transportStats.requestBytes + transportStats.responseBytes,
      avgMemoryMb: memoryMetrics.avgMemoryMb,
      peakMemoryMb: memoryMetrics.peakMemoryMb,
      avgCpuPct: cpuMetrics.avgCpuPct,
      peakCpuPct: cpuMetrics.peakCpuPct,
      queuedTaskIds: expectedTitleEntries.map(([taskId]) => taskId),
      syncAttempts: Number(replay.syncAttempts ?? 0),
      matchedTitleCount: Number(replay.matchedTitleCount ?? 0),
      queuedOutbox,
      reopenedOutbox,
      finalOutbox,
      reopenedMatchedTitleCount: Number(replay.reopenedMatchedTitleCount ?? 0),
      syncSamples: (replay.syncSamples ?? []) as RustOfflineReplaySyncSample[],
      storage: 'opfsSahPool',
      durableReopen: true,
      browserProcessRestart: true,
      browserStorageFallback:
        asJsonObject(
          replay.storageFallback ?? bootstrap.storageFallback ?? queue.storageFallback
        ) ?? null,
      browserBootstrapMs: round(Number(bootstrap.elapsedMs ?? 0)),
      browserQueueMs: round(Number(queue.elapsedMs ?? 0)),
      runtimeInfo:
        replay.runtimeInfo ?? bootstrap.runtimeInfo ?? queue.runtimeInfo ?? {},
    };
  } finally {
    if (!memoryMetrics) memorySampler.stop();
    if (!cpuMetrics) cpuSampler.stop();
    if (!syncServiceStarted) {
      startService(SYNCULAR_SERVER_STACK, 'sync');
      await ensureStackUp(SYNCULAR_SERVER_STACK);
    }
    await closeSyncularRustBrowserDurabilityHarness(harness);
  }
}

async function runSyncularRustOfflineReplayCase(args: {
  queueSize: number;
  titlePrefix: string;
}): Promise<RustOfflineReplayCaseResult> {
  await ensureStackUp(SYNCULAR_SERVER_STACK);
  await seedSyncularRustStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: Math.max(200, args.queueSize + 25),
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
  const actorId = fixtures.sampleUserIds[0];
  const projectId = fixtures.sampleProjectId;
  if (!actorId || !projectId) {
    throw new Error('Syncular Rust fixtures are missing actor/project data');
  }

  const clientId = `${args.titlePrefix}-${randomUUID()}`;
  const storage = RUST_DURABLE_REOPEN ? RUST_DURABLE_REOPEN_STORAGE : 'memory';
  const fileName = `${clientId}.sqlite`;
  const subscriptions = [taskSubscription(projectId)];
  const bootstrap = await bootstrapRustClient({
    actorId,
    clientId,
    projectIds: projectId,
    expectedRows: Math.max(200, args.queueSize + 25),
    subscriptions,
    storage,
    fileName,
    clearOnInit: true,
  });
  let client = bootstrap.client;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  const replayTimeoutMs = Math.max(120_000, args.queueSize * 500);
  let syncServiceStarted = true;
  let memoryMetrics: ReturnType<MemorySampler['stop']> | null = null;
  let cpuMetrics: ReturnType<CpuSampler['stop']> | null = null;

  try {
    memorySampler.start();
    cpuSampler.start();
    stopService(SYNCULAR_SERVER_STACK, 'sync');
    syncServiceStarted = false;
    await waitForUrlDown(
      `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(/\/api$/, '')}/health`
    );

    const offlineTargets = selectRustOfflineQueueRows({
      client,
      projectId,
      queueSize: args.queueSize,
    });
    const expectedTitles = new Map<string, string>();
    for (let index = 0; index < offlineTargets.length; index += 1) {
      const row = offlineTargets[index]!;
      const taskId = String(row.id);
      const expectedTitle = `${args.titlePrefix}-${index}-${Date.now()}`;
      expectedTitles.set(taskId, expectedTitle);
      await client.applyMutation(
        {
          table: 'tasks',
          row_id: taskId,
          op: 'upsert',
          payload: { title: expectedTitle },
          base_version: Number(row.server_version ?? 0),
        },
        { ...row, title: expectedTitle }
      );
    }

    const queuedOutbox = rustOutboxStatusCounts(client);
    const queuedWriteCount = queuedOutbox.unresolved;
    if (queuedWriteCount < offlineTargets.length) {
      throw new Error(
        `Expected at least ${offlineTargets.length} queued Rust writes, got ${queuedWriteCount}`
      );
    }
    let reopenedOutbox: RustOutboxStatusCounts | null = null;
    let reopenedMatchedTitleCount: number | null = null;

    if (RUST_DURABLE_REOPEN) {
      client.close();
      client = await openBenchRustClient({
        actorId,
        clientId,
        projectId,
        storage,
        fileName,
        clearOnInit: false,
      });
      client.setSubscriptions(subscriptions);
      ensureRustLocalDerivedSchema(client);
      reopenedOutbox = rustOutboxStatusCounts(client);
      reopenedMatchedTitleCount = countRustMatchingTaskTitles(client, expectedTitles);
      if (reopenedOutbox.unresolved < queuedWriteCount) {
        throw new Error(
          `Expected reopened Rust outbox to retain ${queuedWriteCount} unresolved writes, got ${reopenedOutbox.unresolved}`
        );
      }
      if (reopenedMatchedTitleCount !== expectedTitles.size) {
        throw new Error(
          `Expected reopened Rust store to retain ${expectedTitles.size} local titles, got ${reopenedMatchedTitleCount}`
        );
      }
    }

    client.resetTransportStats();
    startService(SYNCULAR_SERVER_STACK, 'sync');
    syncServiceStarted = true;
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await waitForSyncularRustApiReady({ actorId, projectId });

    const startedAt = performance.now();
    const convergence = await waitForRustOfflineReplayConvergence({
      client,
      expectedTitles,
      timeoutMs: replayTimeoutMs,
    });
    const convergenceMs = performance.now() - startedAt;
    const transportStats = client.transportStats();
    memoryMetrics = memorySampler.stop();
    cpuMetrics = cpuSampler.stop();

    return {
      queuedWriteCount,
      reconnectConvergenceMs: round(convergenceMs),
      conflictCount: convergence.conflictCount,
      replayedWriteSuccessRate: round(
        queuedWriteCount === 0
          ? 0
          : convergence.finalOutbox.acked / queuedWriteCount,
        4
      ),
      requestCount: transportStats.requestCount,
      requestBytes: transportStats.requestBytes,
      responseBytes: transportStats.responseBytes,
      bytesTransferred: transportStats.requestBytes + transportStats.responseBytes,
      avgMemoryMb: memoryMetrics.avgMemoryMb,
      peakMemoryMb: memoryMetrics.peakMemoryMb,
      avgCpuPct: cpuMetrics.avgCpuPct,
      peakCpuPct: cpuMetrics.peakCpuPct,
      queuedTaskIds: Array.from(expectedTitles.keys()),
      syncAttempts: convergence.syncAttempts,
      matchedTitleCount: convergence.matchedTitleCount,
      queuedOutbox,
      reopenedOutbox,
      finalOutbox: convergence.finalOutbox,
      reopenedMatchedTitleCount,
      syncSamples: convergence.samples,
      storage,
      durableReopen: RUST_DURABLE_REOPEN,
      runtimeInfo: bootstrap.runtimeInfo,
    };
  } finally {
    if (!memoryMetrics) memorySampler.stop();
    if (!cpuMetrics) cpuSampler.stop();
    if (!syncServiceStarted) {
      startService(SYNCULAR_SERVER_STACK, 'sync');
      await ensureStackUp(SYNCULAR_SERVER_STACK);
    }
    client.close();
  }
}

async function runSyncularRustReconnectStormCase(args: {
  clientCount: number;
}): Promise<RustReconnectStormCaseResult> {
  await ensureStackUp(SYNCULAR_SERVER_STACK);
  await seedSyncularRustStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
  const actorId = fixtures.sampleUserIds[0];
  const projectId = fixtures.sampleProjectId;
  const taskId = fixtures.sampleTaskId;
  if (!actorId || !projectId || !taskId) {
    throw new Error('Syncular Rust fixtures are missing actor/project/task data');
  }

  const sessions: RustClient[] = [];
  for (let index = 0; index < args.clientCount; index += 1) {
    const bootstrap = await bootstrapRustClient({
      actorId,
      clientId: `syncular-rust-storm-${args.clientCount}-${index}-${randomUUID()}`,
      projectIds: projectId,
      expectedRows: 200,
    });
    bootstrap.client.resetTransportStats();
    sessions.push(bootstrap.client);
  }

  let syncServiceStarted = true;
  try {
    const syncContainerId = resolveServiceContainerId(SYNCULAR_SERVER_STACK, 'sync');
    const postgresContainerId = resolveServiceContainerId(
      SYNCULAR_SERVER_STACK,
      'postgres'
    );

    stopService(SYNCULAR_SERVER_STACK, 'sync');
    syncServiceStarted = false;
    await waitForUrlDown(
      `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(/\/api$/, '')}/health`
    );
    startService(SYNCULAR_SERVER_STACK, 'sync');
    syncServiceStarted = true;
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await waitForSyncularRustApiReady({ actorId, projectId });

    const sampler = new DockerServiceSampler([
      { label: 'sync', id: syncContainerId },
      { label: 'postgres', id: postgresContainerId },
    ]);
    sampler.start();
    const startedAt = performance.now();
    const expectedTitle = `syncular-rust-storm-${Date.now()}`;
    await writeSyncularRustExternalTask({
      taskId,
      title: expectedTitle,
    });
    const clientSamples = await Promise.all(
      sessions.map((client, clientIndex) =>
        syncRustClientUntilTaskTitle({
          client,
          clientIndex,
          taskId,
          expectedTitle,
          convergenceStartedAt: startedAt,
          timeoutMs: 60_000,
        })
      )
    );

    const containerMetrics = sampler.stop();
    const totalTransport = sessions.reduce(
      (totals, client) => {
        const stats = client.transportStats();
        return {
          requestCount: totals.requestCount + stats.requestCount,
          requestBytes: totals.requestBytes + stats.requestBytes,
          responseBytes: totals.responseBytes + stats.responseBytes,
        };
      },
      {
        requestCount: 0,
        requestBytes: 0,
        responseBytes: 0,
      }
    );
    const syncMetrics = containerMetrics.sync;
    const postgresMetrics = containerMetrics.postgres;
    const clientSyncOnceMs = clientSamples.map((sample) => sample.syncOnceMs);
    const clientVisibleMs = clientSamples.map((sample) => sample.visibleMs);
    const convergenceMs =
      clientVisibleMs.length > 0 ? Math.max(...clientVisibleMs) : 0;
    const extraSyncCalls = clientSamples.reduce(
      (total, sample) => total + sample.extraSyncCalls,
      0
    );
    const maxExtraSyncCalls = Math.max(
      0,
      ...clientSamples.map((sample) => sample.extraSyncCalls)
    );

    return {
      mode: 'http' as const,
      clientCount: args.clientCount,
      reconnectConvergenceMs: round(convergenceMs),
      clientSyncOnceP50Ms: percentileOrNull(clientSyncOnceMs, 50),
      clientSyncOnceP95Ms: percentileOrNull(clientSyncOnceMs, 95),
      clientSyncOnceP99Ms: percentileOrNull(clientSyncOnceMs, 99),
      clientVisibleP50Ms: percentileOrNull(clientVisibleMs, 50),
      clientVisibleP95Ms: percentileOrNull(clientVisibleMs, 95),
      clientVisibleP99Ms: percentileOrNull(clientVisibleMs, 99),
      extraSyncCalls,
      maxExtraSyncCalls,
      clientSamples,
      requestCount: totalTransport.requestCount,
      requestBytes: totalTransport.requestBytes,
      responseBytes: totalTransport.responseBytes,
      bytesTransferred: totalTransport.requestBytes + totalTransport.responseBytes,
      syncAvgCpuPct: syncMetrics?.avgCpuPct ?? 0,
      syncPeakCpuPct: syncMetrics?.peakCpuPct ?? 0,
      syncAvgMemoryMb: syncMetrics?.avgMemoryMb ?? 0,
      syncPeakMemoryMb: syncMetrics?.peakMemoryMb ?? 0,
      syncRxNetworkMb: syncMetrics?.rxNetworkMb ?? 0,
      syncTxNetworkMb: syncMetrics?.txNetworkMb ?? 0,
      postgresAvgCpuPct: postgresMetrics?.avgCpuPct ?? 0,
      postgresPeakCpuPct: postgresMetrics?.peakCpuPct ?? 0,
      postgresAvgMemoryMb: postgresMetrics?.avgMemoryMb ?? 0,
      postgresPeakMemoryMb: postgresMetrics?.peakMemoryMb ?? 0,
      postgresRxNetworkMb: postgresMetrics?.rxNetworkMb ?? 0,
      postgresTxNetworkMb: postgresMetrics?.txNetworkMb ?? 0,
    };
  } finally {
    if (!syncServiceStarted) {
      startService(SYNCULAR_SERVER_STACK, 'sync');
      await ensureStackUp(SYNCULAR_SERVER_STACK);
    }
    for (const client of sessions) {
      client.close();
    }
  }
}

async function waitForRustWorkerReconnectTaskTitle(args: {
  client: RustWorkerClient;
  clientIndex: number;
  taskId: string;
  expectedTitle: string;
  convergenceStartedAt: number;
  convergenceStartedAtEpochMs: number;
  timeoutMs?: number;
}): Promise<RustWorkerReconnectClientSample> {
  const waitResult = await waitForRustWorkerTaskTitleFromRealtime({
    client: args.client,
    taskId: args.taskId,
    expectedTitle: args.expectedTitle,
    timeoutMs: args.timeoutMs ?? 60_000,
  });

  return {
    clientIndex: args.clientIndex,
    visibleMs: round(waitResult.visibleAtMs - args.convergenceStartedAt),
    rowsChangedMs: round(
      waitResult.rowsChangedAtMs - args.convergenceStartedAt
    ),
    diagnosticOffsetsMs: summarizeRustWorkerDiagnosticOffsets(
      args.client,
      args.convergenceStartedAtEpochMs
    ),
    diagnostics: summarizeRustWorkerDiagnostics(args.client),
  };
}

async function runSyncularRustWorkerRealtimeReconnectStormCase(args: {
  clientCount: number;
}): Promise<RustReconnectStormCaseResult> {
  await ensureStackUp(SYNCULAR_SERVER_STACK);
  await seedSyncularRustStack({
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
  const actorId = fixtures.sampleUserIds[0];
  const projectId = fixtures.sampleProjectId;
  const taskId = fixtures.sampleTaskId;
  if (!actorId || !projectId || !taskId) {
    throw new Error('Syncular Rust fixtures are missing actor/project/task data');
  }

  const sessions: RustWorkerClient[] = [];
  for (let index = 0; index < args.clientCount; index += 1) {
    const bootstrap = await bootstrapRustWorkerClient({
      actorId,
      clientId: `syncular-rust-worker-storm-${args.clientCount}-${index}-${randomUUID()}`,
      projectIds: projectId,
      expectedRows: 200,
    });
    sessions.push(bootstrap.client);
  }

  for (const client of sessions) {
    await startRustWorkerRealtime({
      client,
      actorId,
      initialReconnectDelayMs: 50,
      maxReconnectDelayMs: 100,
      reconnectJitterRatio: 20,
      pullRecoveryJitterMs: 1000,
    });
    await client.resetTransportStats();
    clearRustWorkerDiagnostics(client);
  }

  let syncServiceStarted = true;
  try {
    const syncContainerId = resolveServiceContainerId(SYNCULAR_SERVER_STACK, 'sync');
    const postgresContainerId = resolveServiceContainerId(
      SYNCULAR_SERVER_STACK,
      'postgres'
    );

    stopService(SYNCULAR_SERVER_STACK, 'sync');
    syncServiceStarted = false;
    await waitForUrlDown(
      `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(/\/api$/, '')}/health`
    );
    startService(SYNCULAR_SERVER_STACK, 'sync');
    syncServiceStarted = true;
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await waitForSyncularRustApiReady({ actorId, projectId });

    const sampler = new DockerServiceSampler([
      { label: 'sync', id: syncContainerId },
      { label: 'postgres', id: postgresContainerId },
    ]);
    sampler.start();
    const startedAt = performance.now();
    const startedAtEpochMs = Date.now();
    const expectedTitle = `syncular-rust-worker-storm-${Date.now()}`;
    const waiters = sessions.map((client, clientIndex) =>
      waitForRustWorkerReconnectTaskTitle({
        client,
        clientIndex,
        taskId,
        expectedTitle,
        convergenceStartedAt: startedAt,
        convergenceStartedAtEpochMs: startedAtEpochMs,
        timeoutMs: 60_000,
      })
    );
    const externalWrite = await writeSyncularRustExternalTask({
      taskId,
      title: expectedTitle,
    });
    const clientSamples = await Promise.all(waiters);

    const containerMetrics = sampler.stop();
    const transportStats = await Promise.all(
      sessions.map((client) => client.transportStats())
    );
    const totalTransport = transportStats.reduce(
      (totals, stats) => ({
        requestCount: totals.requestCount + stats.requestCount,
        requestBytes: totals.requestBytes + stats.requestBytes,
        responseBytes: totals.responseBytes + stats.responseBytes,
      }),
      {
        requestCount: 0,
        requestBytes: 0,
        responseBytes: 0,
      }
    );
    const syncMetrics = containerMetrics.sync;
    const postgresMetrics = containerMetrics.postgres;
    const clientVisibleMs = clientSamples.map((sample) => sample.visibleMs);
    const convergenceMs =
      clientVisibleMs.length > 0 ? Math.max(...clientVisibleMs) : 0;
    const diagnosticSummaries = clientSamples.map((sample) => sample.diagnostics);
    const syncWakeupOffsets = workerDiagnosticOffsetValues(
      clientSamples,
      'firstSyncWakeupMs'
    );
    const firstBinaryAppliedOffsets = workerDiagnosticOffsetValues(
      clientSamples,
      'firstBinaryAppliedMs'
    );
    const binaryApplyTotalMs = workerDiagnosticMetricValues(
      clientSamples,
      'realtimeBinaryApplyTotalP95Ms'
    );
    const visibleAfterBinaryAppliedMs = metricNumbers(
      clientSamples.map((sample) => {
        const firstBinaryAppliedMs = metricNumber(
          sample.diagnosticOffsetsMs ?? {},
          'firstBinaryAppliedMs'
        );
        return firstBinaryAppliedMs === null
          ? null
          : Math.max(0, sample.visibleMs - firstBinaryAppliedMs);
      })
    );
    const realtimeReconnectScheduledCount = sessions.reduce(
      (total, client) =>
        total + countDiagnosticCode(client, 'realtime.reconnect_scheduled'),
      0
    );

    return {
      mode: 'worker-realtime' as const,
      clientCount: args.clientCount,
      reconnectConvergenceMs: round(convergenceMs),
      clientSyncOnceP50Ms: null,
      clientSyncOnceP95Ms: null,
      clientSyncOnceP99Ms: null,
      clientVisibleP50Ms: percentileOrNull(clientVisibleMs, 50),
      clientVisibleP95Ms: percentileOrNull(clientVisibleMs, 95),
      clientVisibleP99Ms: percentileOrNull(clientVisibleMs, 99),
      extraSyncCalls: 0,
      maxExtraSyncCalls: 0,
      clientSamples,
      realtimeBinaryAppliedCount: sumMetricNumber(
        diagnosticSummaries,
        'realtimeBinaryAppliedCount'
      ),
      realtimePullRequiredCount: sumMetricNumber(
        diagnosticSummaries,
        'realtimePullRequiredCount'
      ),
      realtimeReconnectScheduledCount,
      realtimeReconnectPullCount: diagnosticSummaries.reduce((total, summary) => {
        const reasons = summary.realtimePullRequiredReasons;
        if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) {
          return total;
        }
        const value = reasons.reconnect;
        return total + (typeof value === 'number' ? value : 0);
      }, 0),
      realtimeSyncWakeupP50Ms: percentileOrNull(syncWakeupOffsets, 50),
      realtimeSyncWakeupP95Ms: percentileOrNull(syncWakeupOffsets, 95),
      realtimeSyncWakeupP99Ms: percentileOrNull(syncWakeupOffsets, 99),
      realtimeFirstBinaryAppliedP50Ms: percentileOrNull(
        firstBinaryAppliedOffsets,
        50
      ),
      realtimeFirstBinaryAppliedP95Ms: percentileOrNull(
        firstBinaryAppliedOffsets,
        95
      ),
      realtimeFirstBinaryAppliedP99Ms: percentileOrNull(
        firstBinaryAppliedOffsets,
        99
      ),
      realtimeBinaryApplyTotalP50Ms: percentileOrNull(binaryApplyTotalMs, 50),
      realtimeBinaryApplyTotalP95Ms: percentileOrNull(binaryApplyTotalMs, 95),
      realtimeBinaryApplyTotalP99Ms: percentileOrNull(binaryApplyTotalMs, 99),
      clientVisibleAfterBinaryAppliedP50Ms: percentileOrNull(
        visibleAfterBinaryAppliedMs,
        50
      ),
      clientVisibleAfterBinaryAppliedP95Ms: percentileOrNull(
        visibleAfterBinaryAppliedMs,
        95
      ),
      clientVisibleAfterBinaryAppliedP99Ms: percentileOrNull(
        visibleAfterBinaryAppliedMs,
        99
      ),
      externalWrite,
      requestCount: totalTransport.requestCount,
      requestBytes: totalTransport.requestBytes,
      responseBytes: totalTransport.responseBytes,
      bytesTransferred: totalTransport.requestBytes + totalTransport.responseBytes,
      syncAvgCpuPct: syncMetrics?.avgCpuPct ?? 0,
      syncPeakCpuPct: syncMetrics?.peakCpuPct ?? 0,
      syncAvgMemoryMb: syncMetrics?.avgMemoryMb ?? 0,
      syncPeakMemoryMb: syncMetrics?.peakMemoryMb ?? 0,
      syncRxNetworkMb: syncMetrics?.rxNetworkMb ?? 0,
      syncTxNetworkMb: syncMetrics?.txNetworkMb ?? 0,
      postgresAvgCpuPct: postgresMetrics?.avgCpuPct ?? 0,
      postgresPeakCpuPct: postgresMetrics?.peakCpuPct ?? 0,
      postgresAvgMemoryMb: postgresMetrics?.avgMemoryMb ?? 0,
      postgresPeakMemoryMb: postgresMetrics?.peakMemoryMb ?? 0,
      postgresRxNetworkMb: postgresMetrics?.rxNetworkMb ?? 0,
      postgresTxNetworkMb: postgresMetrics?.txNetworkMb ?? 0,
    };
  } finally {
    if (!syncServiceStarted) {
      startService(SYNCULAR_SERVER_STACK, 'sync');
      await ensureStackUp(SYNCULAR_SERVER_STACK);
    }
    await Promise.all(sessions.map((client) => client.close()));
  }
}

async function bootstrapRustClient(args: {
  actorId: string;
  clientId: string;
  projectIds: string | string[];
  expectedRows: number;
  subscriptions?: RustSubscriptionSpec[];
  storage?: RustClientStorage;
  fileName?: string;
  clearOnInit?: boolean;
}): Promise<{
  client: RustClient;
  durationMs: number;
  derivedSchemaMs: number;
  rowsLoaded: number;
  timings: RustBootstrapTimingTotals;
  runtimeInfo: Record<string, JsonValue>;
}> {
  const client = await openBenchRustClient({
    actorId: args.actorId,
    clientId: args.clientId,
    projectId: Array.isArray(args.projectIds) ? args.projectIds[0] : args.projectIds,
    storage: args.storage,
    fileName: args.fileName,
    clearOnInit: args.clearOnInit,
  });
  client.setSubscriptions(args.subscriptions ?? [taskSubscription(args.projectIds)]);

  try {
    const startedAt = performance.now();
    const bootstrap = await waitForRustTaskCount({
      client,
      expectedRows: args.expectedRows,
    });
    const derivedStartedAt = performance.now();
    ensureRustLocalDerivedSchema(client);
    const derivedSchemaMs = performance.now() - derivedStartedAt;
    const durationMs = performance.now() - startedAt;

    return {
      client,
      durationMs,
      derivedSchemaMs,
      rowsLoaded: bootstrap.rowsLoaded,
      timings: bootstrap.timings,
      runtimeInfo: await client.runtimeInfo(),
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function bootstrapRustWorkerClient(args: {
  actorId: string;
  clientId: string;
  projectIds: string | string[];
  expectedRows: number;
}): Promise<{
  client: RustWorkerClient;
  durationMs: number;
  derivedSchemaMs: number;
  rowsLoaded: number;
  runtimeInfo: Record<string, JsonValue>;
}> {
  const client = await openBenchRustWorkerClient({
    actorId: args.actorId,
    clientId: args.clientId,
    projectId: Array.isArray(args.projectIds) ? args.projectIds[0] : args.projectIds,
  });
  await client.setSubscriptions([taskSubscription(args.projectIds)]);

  try {
    const startedAt = performance.now();
    let rowsLoaded = 0;
    while (performance.now() - startedAt < BOOTSTRAP_TIMEOUT_MS) {
      rowsLoaded = Number(
        (
          await client.executeSql<{ count: number }>(
            'select count(*) as count from tasks'
          )
        ).rows[0]?.count ?? 0
      );
      if (rowsLoaded === args.expectedRows) break;
      if (rowsLoaded > args.expectedRows) {
        throw new Error(`Expected ${args.expectedRows} Rust worker rows, got ${rowsLoaded}`);
      }
      await client.syncOnce();
    }
    if (rowsLoaded !== args.expectedRows) {
      throw new Error(
        `Timed out waiting for ${args.expectedRows} Rust worker rows; got ${rowsLoaded}`
      );
    }
    const derivedStartedAt = performance.now();
    await ensureRustWorkerDerivedSchema(client);
    const derivedSchemaMs = performance.now() - derivedStartedAt;

    return {
      client,
      durationMs: performance.now() - startedAt,
      derivedSchemaMs,
      rowsLoaded,
      runtimeInfo: await client.runtimeInfo(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function seedSyncularRustStack(
  options: Parameters<typeof seedStack>[1]
): Promise<void> {
  await seedStack(SYNCULAR_SERVER_STACK, options);
  const response = await fetch(
    `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(/\/api$/, '')}/benchmark/reset-scope-cache`,
    { method: 'POST' }
  );
  if (!response.ok) {
    throw new Error(
      `Syncular Rust scope cache reset failed: ${response.status} ${response.statusText}`
    );
  }
}

async function waitForSyncularRustApiReady(args: {
  actorId: string;
  projectId: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let lastError = 'unreachable';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(
        `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl}/sync`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-user-id': args.actorId,
          },
          body: JSON.stringify({
            clientId: 'syncular-rust-benchmark-readiness',
            pull: {
              schemaVersion: 1,
              limitCommits: RUST_PULL_LIMIT_COMMITS,
              limitSnapshotRows: RUST_PULL_LIMIT_SNAPSHOT_ROWS,
              maxSnapshotPages: RUST_PULL_MAX_SNAPSHOT_PAGES,
              subscriptions: [
                {
                  id: 'benchmark-readiness-sub',
                  table: 'tasks',
                  scopes: {
                    project_id: args.projectId,
                  },
                  cursor: -1,
                },
              ],
            },
          }),
        }
      );

      if (response.ok) {
        return;
      }

      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for Syncular Rust API readiness: ${lastError}`);
}

async function writeSyncularRustExternalTask(args: {
  taskId: string;
  title?: string;
  completed?: boolean;
}): Promise<SyncularRustExternalWriteResult> {
  const response = await fetch(
    `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(/\/api$/, '')}/benchmark/external-write`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Syncular Rust benchmark external write failed: ${response.status} ${response.statusText} ${body}`
    );
  }
  const body = await response.json();
  return {
    timings:
      body && typeof body === 'object' && !Array.isArray(body)
        ? asJsonObject((body as Record<string, unknown>).timings)
        : undefined,
    realtimeNotify:
      body && typeof body === 'object' && !Array.isArray(body)
        ? asJsonObjectOrNull((body as Record<string, unknown>).realtimeNotify)
        : null,
  };
}

async function revokeSyncularRustProjectMembership(args: {
  projectId: string;
  userId: string;
}): Promise<void> {
  const response = await fetch(
    `${getStack(SYNCULAR_SERVER_STACK).syncBaseUrl.replace(/\/api$/, '')}/benchmark/revoke-membership`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Syncular Rust membership revoke failed: ${response.status} ${response.statusText} ${body}`
    );
  }
}

async function runRustLocalListQuery(args: {
  client: RustClient;
  projectId: string;
  ownerId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = args.client.executeSql(
    `select id, title, updated_at
     from tasks
     where project_id = ? and owner_id = ? and completed = 0
     order by updated_at desc
     limit 50`,
    [args.projectId, args.ownerId]
  ).rows;

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

async function runRustLocalSearchQuery(args: {
  client: RustClient;
  projectId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = args.client.executeSql(
    `select id, title
     from tasks
     where project_id = ? and id like ?
     order by id asc
     limit 100`,
    [args.projectId, 'org-1-project-1-task-00%']
  ).rows;

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

async function runRustLocalAggregateQuery(args: {
  client: RustClient;
  projectId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = args.client.executeSql(
    `select owner_id, completed, task_count
     from syncular_rust_task_counts
     where project_id = ?
     order by owner_id, completed`,
    [args.projectId]
  ).rows;

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

async function runRustRawLocalAggregateQuery(args: {
  client: RustClient;
  projectId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = args.client.executeSql(
    `select owner_id, completed, count(*) as task_count
     from tasks
     where project_id = ?
     group by owner_id, completed
     order by owner_id, completed`,
    [args.projectId]
  ).rows;

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

const RUST_RAW_DASHBOARD_QUERY = `select
   organizations.name as org_name,
   projects.id as project_id,
   projects.name as project_name,
   (
     select count(*)
     from tasks
     where tasks.project_id = projects.id
   ) as task_count,
   (
     select count(*)
     from tasks
     where tasks.project_id = projects.id and tasks.completed = 0
   ) as open_task_count
 from organizations
 join projects on projects.org_id = organizations.id
 where organizations.id = ?
 order by open_task_count desc, projects.id asc
 limit 20`;

const RUST_DASHBOARD_QUERY = `select
   organizations.name as org_name,
   projects.id as project_id,
   projects.name as project_name,
   coalesce(open_task_counts.task_count, 0) + coalesce(completed_task_counts.task_count, 0) as task_count,
   coalesce(open_task_counts.task_count, 0) as open_task_count
 from organizations
 join projects on projects.org_id = organizations.id
 left join syncular_rust_task_counts_by_project_completion open_task_counts
   on open_task_counts.project_id = projects.id and open_task_counts.completed = 0
 left join syncular_rust_task_counts_by_project_completion completed_task_counts
   on completed_task_counts.project_id = projects.id and completed_task_counts.completed = 1
 where organizations.id = ?
 order by open_task_count desc, projects.id asc
 limit 20`;

const RUST_DETAIL_JOIN_QUERY = `select
   tasks.id,
   tasks.title,
   projects.name as project_name,
   organizations.name as org_name
 from tasks
 join projects on projects.id = tasks.project_id
 join organizations on organizations.id = projects.org_id
 where projects.id = ? and tasks.id like ?
 order by tasks.id asc
 limit 100`;

function explainRustQueryPlan(
  client: RustClient,
  sql: string,
  params: readonly unknown[]
): JsonObject[] {
  return client
    .executeSql<{ id?: number; parent?: number; notused?: number; detail?: string }>(
      `explain query plan ${sql}`,
      params
    )
    .rows.map((row) => ({
      id: typeof row.id === 'number' ? row.id : null,
      parent: typeof row.parent === 'number' ? row.parent : null,
      notused: typeof row.notused === 'number' ? row.notused : null,
      detail: typeof row.detail === 'string' ? row.detail : JSON.stringify(row),
    }));
}

async function runRustDashboardQuery(args: {
  client: RustClient;
  orgId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = args.client.executeSql(RUST_DASHBOARD_QUERY, [args.orgId]).rows;

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

async function runRustRawDashboardQuery(args: {
  client: RustClient;
  orgId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = args.client.executeSql(RUST_RAW_DASHBOARD_QUERY, [args.orgId]).rows;

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

async function runRustDetailJoinQuery(args: {
  client: RustClient;
  projectId: string;
}): Promise<LocalQuerySample> {
  const startedAt = performance.now();
  const rows = args.client.executeSql(RUST_DETAIL_JOIN_QUERY, [
    args.projectId,
    'org-1-project-1-task-00%',
  ]).rows;

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

export class SyncularRustBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('syncular-rust');

  async runBootstrap(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }> {
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    const scales = [1000, 10_000, 100_000, 250_000, 500_000];
    const scaleResults: RustBootstrapScaleResult[] = [];
    let runtimeInfo: Record<string, JsonValue> | null = null;
    let failedScale: { rowsTarget: number; error: string } | null = null;

    for (const rowsTarget of scales) {
      await seedSyncularRustStack({
        resetFirst: true,
        orgCount: 1,
        projectsPerOrg: 1,
        usersPerOrg: 2,
        tasksPerProject: rowsTarget,
        membershipsPerProject: 2,
      });

      const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
      const actorId = fixtures.sampleUserIds[0];
      const projectId = fixtures.sampleProjectId;
      if (!actorId || !projectId) {
        throw new Error('Syncular Rust fixtures are missing actor/project data');
      }

      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();
      try {
        const result = await bootstrapRustClient({
          actorId,
          clientId: `syncular-rust-bootstrap-${rowsTarget}-${randomUUID()}`,
          projectIds: projectId,
          expectedRows: rowsTarget,
        });
        const memoryMetrics = memorySampler.stop();
        const cpuMetrics = cpuSampler.stop();
        runtimeInfo = result.runtimeInfo;
        const transportStats = result.client.transportStats();
        result.client.close();

        scaleResults.push({
          rowsTarget,
          timeToFirstQueryMs: round(result.durationMs),
          derivedSchemaMs: round(result.derivedSchemaMs),
          rowsLoaded: result.rowsLoaded,
          syncCalls: result.timings.syncCalls,
          totalSyncMs: round(result.timings.totalMs),
          pushMs: round(result.timings.pushMs),
          pullMs: round(result.timings.pullMs),
          pullRequestMs: round(result.timings.pullRequestMs),
          pullTransformMs: round(result.timings.pullTransformMs),
          snapshotFetchMs: round(result.timings.snapshotFetchMs),
          pullApplyMs: round(result.timings.pullApplyMs),
          localApplyMs: round(result.timings.localApplyMs),
          notifyMs: round(result.timings.notifyMs),
          requestCount: transportStats.requestCount,
          requestBytes: transportStats.requestBytes,
          responseBytes: transportStats.responseBytes,
          bytesTransferred:
            transportStats.requestBytes + transportStats.responseBytes,
          snapshotChunkCount: transportStats.snapshotChunkCount ?? 0,
          snapshotChunkFetchMs: round(transportStats.snapshotChunkFetchMs ?? 0),
          snapshotChunkDecompressMs: round(
            transportStats.snapshotChunkDecompressMs ?? 0
          ),
          snapshotChunkHashMs: round(transportStats.snapshotChunkHashMs ?? 0),
          snapshotChunkDecodeMs: round(transportStats.snapshotChunkDecodeMs ?? 0),
          serverBootstrapSnapshotQueryMs: round(
            transportStats.serverBootstrapSnapshotQueryMs ?? 0
          ),
          serverBootstrapRowFrameEncodeMs: round(
            transportStats.serverBootstrapRowFrameEncodeMs ?? 0
          ),
          serverBootstrapSnapshotBinaryEncodeMs: round(
            transportStats.serverBootstrapSnapshotBinaryEncodeMs ?? 0
          ),
          serverBootstrapChunkCacheLookupMs: round(
            transportStats.serverBootstrapChunkCacheLookupMs ?? 0
          ),
          serverBootstrapChunkGzipMs: round(
            transportStats.serverBootstrapChunkGzipMs ?? 0
          ),
          serverBootstrapChunkHashMs: round(
            transportStats.serverBootstrapChunkHashMs ?? 0
          ),
          serverBootstrapChunkPersistMs: round(
            transportStats.serverBootstrapChunkPersistMs ?? 0
          ),
          avgMemoryMb: memoryMetrics.avgMemoryMb,
          peakMemoryMb: memoryMetrics.peakMemoryMb,
          avgCpuPct: cpuMetrics.avgCpuPct,
          peakCpuPct: cpuMetrics.peakCpuPct,
        });
      } catch (error) {
        memorySampler.stop();
        cpuSampler.stop();
        failedScale = {
          rowsTarget,
          error: error instanceof Error ? error.message : String(error),
        };
        break;
      }
    }

    return {
      status: failedScale ? 'failed' : 'completed',
      metrics: Object.fromEntries(
        scaleResults.flatMap((result) => [
          [`bootstrap_${result.rowsTarget}_ms`, result.timeToFirstQueryMs],
          [`derived_schema_ms_${result.rowsTarget}`, result.derivedSchemaMs],
          [`rows_loaded_${result.rowsTarget}`, result.rowsLoaded],
          [`sync_calls_${result.rowsTarget}`, result.syncCalls],
          [`sync_total_ms_${result.rowsTarget}`, result.totalSyncMs],
          [`push_ms_${result.rowsTarget}`, result.pushMs],
          [`pull_ms_${result.rowsTarget}`, result.pullMs],
          [`pull_request_ms_${result.rowsTarget}`, result.pullRequestMs],
          [`pull_transform_ms_${result.rowsTarget}`, result.pullTransformMs],
          [`snapshot_fetch_ms_${result.rowsTarget}`, result.snapshotFetchMs],
          [`pull_apply_ms_${result.rowsTarget}`, result.pullApplyMs],
          [`local_apply_ms_${result.rowsTarget}`, result.localApplyMs],
          [`notify_ms_${result.rowsTarget}`, result.notifyMs],
          [`request_count_${result.rowsTarget}`, result.requestCount],
          [`request_bytes_${result.rowsTarget}`, result.requestBytes],
          [`response_bytes_${result.rowsTarget}`, result.responseBytes],
          [`bytes_transferred_${result.rowsTarget}`, result.bytesTransferred],
          [`snapshot_chunk_count_${result.rowsTarget}`, result.snapshotChunkCount],
          [`snapshot_chunk_fetch_ms_${result.rowsTarget}`, result.snapshotChunkFetchMs],
          [
            `snapshot_chunk_decompress_ms_${result.rowsTarget}`,
            result.snapshotChunkDecompressMs,
          ],
          [`snapshot_chunk_hash_ms_${result.rowsTarget}`, result.snapshotChunkHashMs],
          [`snapshot_chunk_decode_ms_${result.rowsTarget}`, result.snapshotChunkDecodeMs],
          [
            `server_bootstrap_snapshot_query_ms_${result.rowsTarget}`,
            result.serverBootstrapSnapshotQueryMs,
          ],
          [
            `server_bootstrap_row_frame_encode_ms_${result.rowsTarget}`,
            result.serverBootstrapRowFrameEncodeMs,
          ],
          [
            `server_bootstrap_snapshot_binary_encode_ms_${result.rowsTarget}`,
            result.serverBootstrapSnapshotBinaryEncodeMs,
          ],
          [
            `server_bootstrap_chunk_cache_lookup_ms_${result.rowsTarget}`,
            result.serverBootstrapChunkCacheLookupMs,
          ],
          [
            `server_bootstrap_chunk_gzip_ms_${result.rowsTarget}`,
            result.serverBootstrapChunkGzipMs,
          ],
          [
            `server_bootstrap_chunk_hash_ms_${result.rowsTarget}`,
            result.serverBootstrapChunkHashMs,
          ],
          [
            `server_bootstrap_chunk_persist_ms_${result.rowsTarget}`,
            result.serverBootstrapChunkPersistMs,
          ],
          [`avg_memory_mb_${result.rowsTarget}`, result.avgMemoryMb],
          [`peak_memory_mb_${result.rowsTarget}`, result.peakMemoryMb],
          [`avg_cpu_pct_${result.rowsTarget}`, result.avgCpuPct],
          [`peak_cpu_pct_${result.rowsTarget}`, result.peakCpuPct],
        ])
      ),
      notes: [
        'Syncular Rust bootstrap uses the new Rust-owned SQLite WASM client against the shared Syncular benchmark server.',
        'The local store is memory-backed in this Bun harness so the result isolates Rust client materialization/query cost rather than browser persistence cost.',
        `The Rust client requests ${RUST_PULL_LIMIT_SNAPSHOT_ROWS} rows/page and up to ${RUST_PULL_MAX_SNAPSHOT_PAGES} snapshot pages per pull to match the TS Syncular bootstrap profile.`,
        ...(failedScale
          ? [
              `Bootstrap failed at ${failedScale.rowsTarget} rows: ${failedScale.error}`,
            ]
          : []),
      ],
      metadata: {
        implementation: 'syncular-rust-wasm-client-bootstrap',
        runtimeInfo: runtimeInfo ?? {},
        failedScale: failedScale ?? null,
        scales: scaleResults.map((result) => ({
          rowsTarget: result.rowsTarget,
          timeToFirstQueryMs: result.timeToFirstQueryMs,
          derivedSchemaMs: result.derivedSchemaMs,
          rowsLoaded: result.rowsLoaded,
          syncCalls: result.syncCalls,
          totalSyncMs: result.totalSyncMs,
          pushMs: result.pushMs,
          pullMs: result.pullMs,
          pullRequestMs: result.pullRequestMs,
          pullTransformMs: result.pullTransformMs,
          snapshotFetchMs: result.snapshotFetchMs,
          pullApplyMs: result.pullApplyMs,
          localApplyMs: result.localApplyMs,
          notifyMs: result.notifyMs,
          requestCount: result.requestCount,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          bytesTransferred: result.bytesTransferred,
          snapshotChunkCount: result.snapshotChunkCount,
          snapshotChunkFetchMs: result.snapshotChunkFetchMs,
          snapshotChunkDecompressMs: result.snapshotChunkDecompressMs,
          snapshotChunkHashMs: result.snapshotChunkHashMs,
          snapshotChunkDecodeMs: result.snapshotChunkDecodeMs,
          serverBootstrapSnapshotQueryMs: result.serverBootstrapSnapshotQueryMs,
          serverBootstrapRowFrameEncodeMs: result.serverBootstrapRowFrameEncodeMs,
          serverBootstrapSnapshotBinaryEncodeMs:
            result.serverBootstrapSnapshotBinaryEncodeMs,
          serverBootstrapChunkCacheLookupMs:
            result.serverBootstrapChunkCacheLookupMs,
          serverBootstrapChunkGzipMs: result.serverBootstrapChunkGzipMs,
          serverBootstrapChunkHashMs: result.serverBootstrapChunkHashMs,
          serverBootstrapChunkPersistMs: result.serverBootstrapChunkPersistMs,
          avgMemoryMb: result.avgMemoryMb,
          peakMemoryMb: result.peakMemoryMb,
          avgCpuPct: result.avgCpuPct,
          peakCpuPct: result.peakCpuPct,
        })),
      },
    };
  }

  async runOnlinePropagation() {
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await seedSyncularRustStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 200,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
    const actorId = fixtures.sampleUserIds[0];
    const projectId = fixtures.sampleProjectId;
    const taskId = fixtures.sampleTaskId;
    if (!actorId || !projectId || !taskId) {
      throw new Error('Syncular Rust fixtures are missing actor, project, or task data');
    }

    const writerBootstrap = await bootstrapRustWorkerClient({
      actorId,
      clientId: `syncular-rust-writer-${randomUUID()}`,
      projectIds: projectId,
      expectedRows: 200,
    });
    const readerBootstrap = await bootstrapRustWorkerClient({
      actorId,
      clientId: `syncular-rust-reader-${randomUUID()}`,
      projectIds: projectId,
      expectedRows: 200,
    });
    const writer = writerBootstrap.client;
    const reader = readerBootstrap.client;

    try {
      await startRustWorkerRealtime({ client: reader, actorId });

      const warmupIterations = 1;
      for (
        let warmupIteration = 0;
        warmupIteration < warmupIterations;
        warmupIteration += 1
      ) {
        const expectedTitle = `syncular-rust-online-warmup-${warmupIteration}-${Date.now()}`;
        const row = await getRustWorkerTaskRow(writer, taskId);
        if (!row) throw new Error(`Missing Rust writer task ${taskId}`);
        if (DEBUG_RUST_WS) console.error('rust ws warmup wait start');
        const visibleOnReader = waitForRustWorkerTaskTitleFromRealtime({
          client: reader,
          taskId,
          expectedTitle,
          timeoutMs: 30_000,
        });
        await writer.applyMutation(
          {
            table: 'tasks',
            row_id: taskId,
            op: 'upsert',
            payload: { title: expectedTitle },
            base_version: Number(row.server_version ?? 0),
          },
          { ...row, title: expectedTitle }
        );
        await writer.syncPush();
        if (DEBUG_RUST_WS) console.error('rust ws warmup pushed');
        await visibleOnReader;
        await writer.syncOnce();
        if (DEBUG_RUST_WS) console.error('rust ws warmup visible');
      }

      await writer.resetTransportStats();
      await reader.resetTransportStats();
      clearRustWorkerDiagnostics(writer);
      clearRustWorkerDiagnostics(reader);
      const iterations = 15;
      const samples: OnlinePropagationSample[] = [];
      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const expectedTitle = `syncular-rust-online-${iteration}-${Date.now()}`;
        const row = await getRustWorkerTaskRow(writer, taskId);
        if (!row) throw new Error(`Missing Rust writer task ${taskId}`);
        if (DEBUG_RUST_WS) console.error('rust ws iteration wait start', iteration);
        const visibleOnReader = waitForRustWorkerTaskTitleFromRealtime({
          client: reader,
          taskId,
          expectedTitle,
          timeoutMs: 30_000,
        });
        const startedAt = performance.now();
        await writer.applyMutation(
          {
            table: 'tasks',
            row_id: taskId,
            op: 'upsert',
            payload: { title: expectedTitle },
            base_version: Number(row.server_version ?? 0),
          },
          { ...row, title: expectedTitle }
        );
        await writer.syncPush();
        if (DEBUG_RUST_WS) console.error('rust ws iteration pushed', iteration);
        const writeAckMs = performance.now() - startedAt;
        await visibleOnReader;
        const mirrorVisibleMs = performance.now() - startedAt;
        if (DEBUG_RUST_WS) console.error('rust ws iteration visible', iteration);
        const cleanupStartedAt = performance.now();
        await writer.syncOnce();
        const writerCleanupMs = performance.now() - cleanupStartedAt;

        samples.push({
          iteration,
          writeAckMs: round(writeAckMs),
          mirrorVisibleMs: round(mirrorVisibleMs),
          writerCleanupMs: round(writerCleanupMs),
        });
      }

      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();
      const writerStats = await writer.transportStats();
      const readerStats = await reader.transportStats();
      const requestCount = writerStats.requestCount + readerStats.requestCount;
      const requestBytes = writerStats.requestBytes + readerStats.requestBytes;
      const responseBytes = writerStats.responseBytes + readerStats.responseBytes;
      const visibility = samples.map((sample) => sample.mirrorVisibleMs);
      const writeAcks = samples.map((sample) => sample.writeAckMs);
      const writerCleanup = samples.map((sample) => sample.writerCleanupMs);
      const writerDiagnostics = summarizeRustWorkerDiagnostics(writer);
      const readerDiagnostics = summarizeRustWorkerDiagnostics(reader);

      return {
        status: 'completed' as const,
        metrics: {
          write_ack_ms: average(writeAcks),
          mirror_visible_p50_ms: percentile(visibility, 50),
          mirror_visible_p95_ms: percentile(visibility, 95),
          mirror_visible_p99_ms: percentile(visibility, 99),
          writer_cleanup_avg_ms: average(writerCleanup),
          writer_cleanup_p95_ms: percentile(writerCleanup, 95),
          reader_realtime_binary_applied_count: metricNumber(
            readerDiagnostics,
            'realtimeBinaryAppliedCount'
          ),
          reader_realtime_pull_required_count: metricNumber(
            readerDiagnostics,
            'realtimePullRequiredCount'
          ),
          reader_realtime_binary_apply_failed_count: metricNumber(
            readerDiagnostics,
            'realtimeBinaryApplyFailedCount'
          ),
          reader_realtime_sync_wakeup_count: metricNumber(
            readerDiagnostics,
            'realtimeSyncWakeupCount'
          ),
          reader_realtime_sync_wakeup_payload_bytes_p50: metricNumber(
            readerDiagnostics,
            'realtimeSyncWakeupPayloadBytesP50'
          ),
          reader_realtime_sync_wakeup_payload_bytes_p95: metricNumber(
            readerDiagnostics,
            'realtimeSyncWakeupPayloadBytesP95'
          ),
          reader_realtime_sync_wakeup_payload_bytes_max: metricNumber(
            readerDiagnostics,
            'realtimeSyncWakeupPayloadBytesMax'
          ),
          reader_realtime_binary_apply_p50_ms: metricNumber(
            readerDiagnostics,
            'realtimeBinaryApplyTotalP50Ms'
          ),
          reader_realtime_binary_apply_p95_ms: metricNumber(
            readerDiagnostics,
            'realtimeBinaryApplyTotalP95Ms'
          ),
          iterations,
          request_count: requestCount,
          request_bytes: requestBytes,
          response_bytes: responseBytes,
          bytes_transferred: requestBytes + responseBytes,
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Writes use the Rust worker applyMutation path and syncPush for write acknowledgement.',
          'Visibility is measured on a second Rust worker client before post-visibility writer cleanup.',
          'Reader realtime diagnostics record binary sync-pack apply versus HTTP pull-required recovery.',
          'HTTP byte counters come from the Rust worker transport stats and include writer pushes plus reader realtime-triggered pulls.',
        ],
        metadata: {
          implementation: 'syncular-rust-wasm-worker-realtime-propagation',
          runtimeInfo: writerBootstrap.runtimeInfo,
          warmupIterations,
          samples: samples.map((sample) => ({
            iteration: sample.iteration,
            writeAckMs: sample.writeAckMs,
            mirrorVisibleMs: sample.mirrorVisibleMs,
            writerCleanupMs: sample.writerCleanupMs,
          })),
          diagnostics: {
            writer: writerDiagnostics,
            reader: readerDiagnostics,
          },
        },
      };
    } finally {
      await writer.close();
      await reader.close();
    }
  }

  async runOfflineReplay() {
    const result = RUST_BROWSER_DURABLE_REOPEN
      ? await runSyncularRustBrowserDurableReplayCase({
          queueSize: 10,
          titlePrefix: 'syncular-rust-browser-offline',
        })
      : await runSyncularRustOfflineReplayCase({
          queueSize: 10,
          titlePrefix: 'syncular-rust-offline',
        });

    return {
      status: 'completed' as const,
      metrics: {
        queued_write_count: result.queuedWriteCount,
        reconnect_convergence_ms: result.reconnectConvergenceMs,
        conflict_count: result.conflictCount,
        replayed_write_success_rate: result.replayedWriteSuccessRate,
        request_count: result.requestCount,
        request_bytes: result.requestBytes,
        response_bytes: result.responseBytes,
        bytes_transferred: result.bytesTransferred,
        avg_memory_mb: result.avgMemoryMb,
        peak_memory_mb: result.peakMemoryMb,
        avg_cpu_pct: result.avgCpuPct,
        peak_cpu_pct: result.peakCpuPct,
        sync_attempts: result.syncAttempts,
        matched_title_count: result.matchedTitleCount,
        durable_reopen_outbox_unresolved:
          result.reopenedOutbox?.unresolved ?? null,
        durable_reopen_matched_title_count:
          result.reopenedMatchedTitleCount ?? null,
        browser_process_restart: result.browserProcessRestart ? 1 : 0,
        browser_bootstrap_ms: result.browserBootstrapMs ?? null,
        browser_queue_ms: result.browserQueueMs ?? null,
      },
      notes: [
        'Offline replay uses the real Rust WASM applyMutation outbox and replays queued commits after the Syncular service restarts.',
        result.browserProcessRestart
          ? 'Browser durable mode uses a real Chrome worker with opfsSahPool storage and restarts the browser process between bootstrap, offline queueing, and replay.'
          : result.durableReopen
          ? 'Durable reopen mode closes the Rust client after queuing offline writes, reopens the same IndexedDB-compatible store with clearOnInit=false, and verifies the queued outbox before replay.'
          : 'The default Bun harness uses Rust memory storage; set SYNCULAR_RUST_DURABLE_REOPEN=1 for an IndexedDB-compatible close/reopen durability probe.',
      ],
      metadata: {
        implementation: result.browserProcessRestart
          ? 'syncular-rust-browser-worker-opfs-process-restart'
          : result.durableReopen
            ? 'syncular-rust-wasm-indexeddb-outbox-reopen'
            : 'syncular-rust-wasm-native-outbox-active-session',
        runtimeInfo: result.runtimeInfo,
        storage: result.storage,
        durableReopen: result.durableReopen,
        browserProcessRestart: result.browserProcessRestart ?? false,
        browserStorageFallback: result.browserStorageFallback ?? null,
        outboxPushBatchMode: RUST_OUTBOX_PUSH_BATCH_MODE,
        outboxPushBatchLimit:
          RUST_OUTBOX_PUSH_BATCH_LIMIT ?? RUST_DEFAULT_OUTBOX_PUSH_BATCH_LIMIT,
        adaptiveOutboxBatchLimit: RUST_OUTBOX_PUSH_BATCH_LIMIT
          ? null
          : RUST_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT,
        adaptiveOutboxBatchThreshold: RUST_OUTBOX_PUSH_BATCH_LIMIT
          ? null
          : RUST_ADAPTIVE_OUTBOX_PUSH_THRESHOLD,
        queuedTaskIds: result.queuedTaskIds,
        queuedOutbox: result.queuedOutbox,
        reopenedOutbox: result.reopenedOutbox,
        reopenedMatchedTitleCount: result.reopenedMatchedTitleCount,
        finalOutbox: result.finalOutbox,
        syncSamples: result.syncSamples,
      },
    };
  }

  async runReconnectStorm() {
    const clientCounts = parseRustReconnectClientCounts();
    const results = [];
    const runCase =
      RUST_RECONNECT_MODE === 'worker-realtime'
        ? runSyncularRustWorkerRealtimeReconnectStormCase
        : runSyncularRustReconnectStormCase;

    for (const clientCount of clientCounts) {
      results.push(
        await runCase({
          clientCount,
        })
      );
    }

    return {
      status: 'completed' as const,
      metrics: Object.fromEntries(
        results.flatMap((result) => [
          [`clients_${result.clientCount}_convergence_ms`, result.reconnectConvergenceMs],
          [`clients_${result.clientCount}_request_count`, result.requestCount],
          [`clients_${result.clientCount}_request_bytes`, result.requestBytes],
          [`clients_${result.clientCount}_response_bytes`, result.responseBytes],
          [`clients_${result.clientCount}_bytes_transferred`, result.bytesTransferred],
          [`clients_${result.clientCount}_client_sync_once_p50_ms`, result.clientSyncOnceP50Ms],
          [`clients_${result.clientCount}_client_sync_once_p95_ms`, result.clientSyncOnceP95Ms],
          [`clients_${result.clientCount}_client_sync_once_p99_ms`, result.clientSyncOnceP99Ms],
          [`clients_${result.clientCount}_client_visible_p50_ms`, result.clientVisibleP50Ms],
          [`clients_${result.clientCount}_client_visible_p95_ms`, result.clientVisibleP95Ms],
          [`clients_${result.clientCount}_client_visible_p99_ms`, result.clientVisibleP99Ms],
          [`clients_${result.clientCount}_extra_sync_calls`, result.extraSyncCalls],
          [`clients_${result.clientCount}_max_extra_sync_calls`, result.maxExtraSyncCalls],
          [
            `clients_${result.clientCount}_realtime_binary_applied_count`,
            result.realtimeBinaryAppliedCount ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_pull_required_count`,
            result.realtimePullRequiredCount ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_reconnect_scheduled_count`,
            result.realtimeReconnectScheduledCount ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_reconnect_pull_count`,
            result.realtimeReconnectPullCount ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_sync_wakeup_p50_ms`,
            result.realtimeSyncWakeupP50Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_sync_wakeup_p95_ms`,
            result.realtimeSyncWakeupP95Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_sync_wakeup_p99_ms`,
            result.realtimeSyncWakeupP99Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_first_binary_applied_p50_ms`,
            result.realtimeFirstBinaryAppliedP50Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_first_binary_applied_p95_ms`,
            result.realtimeFirstBinaryAppliedP95Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_first_binary_applied_p99_ms`,
            result.realtimeFirstBinaryAppliedP99Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_binary_apply_total_p50_ms`,
            result.realtimeBinaryApplyTotalP50Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_binary_apply_total_p95_ms`,
            result.realtimeBinaryApplyTotalP95Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_realtime_binary_apply_total_p99_ms`,
            result.realtimeBinaryApplyTotalP99Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_client_visible_after_binary_applied_p50_ms`,
            result.clientVisibleAfterBinaryAppliedP50Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_client_visible_after_binary_applied_p95_ms`,
            result.clientVisibleAfterBinaryAppliedP95Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_client_visible_after_binary_applied_p99_ms`,
            result.clientVisibleAfterBinaryAppliedP99Ms ?? null,
          ],
          [
            `clients_${result.clientCount}_external_write_total_ms`,
            metricNumber(result.externalWrite?.timings ?? {}, 'totalMs'),
          ],
          [
            `clients_${result.clientCount}_external_write_realtime_notify_ms`,
            metricNumber(result.externalWrite?.timings ?? {}, 'realtimeNotifyMs'),
          ],
          [
            `clients_${result.clientCount}_external_write_realtime_owner_count`,
            metricNumber(result.externalWrite?.realtimeNotify ?? {}, 'ownerCount'),
          ],
          [
            `clients_${result.clientCount}_external_write_binary_pack_owner_count`,
            metricNumber(
              result.externalWrite?.realtimeNotify ?? {},
              'binaryPackOwnerCount'
            ),
          ],
          [`clients_${result.clientCount}_sync_avg_cpu_pct`, result.syncAvgCpuPct],
          [`clients_${result.clientCount}_sync_peak_cpu_pct`, result.syncPeakCpuPct],
          [`clients_${result.clientCount}_sync_avg_memory_mb`, result.syncAvgMemoryMb],
          [`clients_${result.clientCount}_sync_peak_memory_mb`, result.syncPeakMemoryMb],
          [`clients_${result.clientCount}_sync_rx_network_mb`, result.syncRxNetworkMb],
          [`clients_${result.clientCount}_sync_tx_network_mb`, result.syncTxNetworkMb],
          [`clients_${result.clientCount}_postgres_avg_cpu_pct`, result.postgresAvgCpuPct],
          [`clients_${result.clientCount}_postgres_peak_cpu_pct`, result.postgresPeakCpuPct],
          [`clients_${result.clientCount}_postgres_avg_memory_mb`, result.postgresAvgMemoryMb],
          [`clients_${result.clientCount}_postgres_peak_memory_mb`, result.postgresPeakMemoryMb],
          [`clients_${result.clientCount}_postgres_rx_network_mb`, result.postgresRxNetworkMb],
          [`clients_${result.clientCount}_postgres_tx_network_mb`, result.postgresTxNetworkMb],
        ])
      ),
      notes: [
        RUST_RECONNECT_MODE === 'worker-realtime'
          ? 'Reconnect storm uses already-bootstrapped Rust worker realtime clients catching up after the sync service restarts.'
          : 'Reconnect storm uses already-bootstrapped Rust WASM HTTP clients catching up after the sync service restarts.',
        'Server resource metrics sample the sync service and Postgres containers during each reconnect window.',
        RUST_RECONNECT_MODE === 'worker-realtime'
          ? 'Worker realtime clients run reconnect catch-up pulls and apply direct binary websocket sync-packs when connected in time for the update.'
          : 'This is Rust client stress coverage, not the Rust worker realtime/WS path yet.',
      ],
      metadata: {
        implementation:
          RUST_RECONNECT_MODE === 'worker-realtime'
            ? 'syncular-rust-worker-realtime-reconnect-storm'
            : 'syncular-rust-wasm-client-http-reconnect-storm',
        mode: RUST_RECONNECT_MODE,
        clientCounts,
        scales: results.map((result) => ({
          mode: result.mode,
          clientCount: result.clientCount,
          reconnectConvergenceMs: result.reconnectConvergenceMs,
          requestCount: result.requestCount,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          bytesTransferred: result.bytesTransferred,
          clientSyncOnceP50Ms: result.clientSyncOnceP50Ms,
          clientSyncOnceP95Ms: result.clientSyncOnceP95Ms,
          clientSyncOnceP99Ms: result.clientSyncOnceP99Ms,
          clientVisibleP50Ms: result.clientVisibleP50Ms,
          clientVisibleP95Ms: result.clientVisibleP95Ms,
          clientVisibleP99Ms: result.clientVisibleP99Ms,
          extraSyncCalls: result.extraSyncCalls,
          maxExtraSyncCalls: result.maxExtraSyncCalls,
          realtimeBinaryAppliedCount: result.realtimeBinaryAppliedCount ?? null,
          realtimePullRequiredCount: result.realtimePullRequiredCount ?? null,
          realtimeReconnectScheduledCount:
            result.realtimeReconnectScheduledCount ?? null,
          realtimeReconnectPullCount: result.realtimeReconnectPullCount ?? null,
          realtimeSyncWakeupP50Ms: result.realtimeSyncWakeupP50Ms ?? null,
          realtimeSyncWakeupP95Ms: result.realtimeSyncWakeupP95Ms ?? null,
          realtimeSyncWakeupP99Ms: result.realtimeSyncWakeupP99Ms ?? null,
          realtimeFirstBinaryAppliedP50Ms:
            result.realtimeFirstBinaryAppliedP50Ms ?? null,
          realtimeFirstBinaryAppliedP95Ms:
            result.realtimeFirstBinaryAppliedP95Ms ?? null,
          realtimeFirstBinaryAppliedP99Ms:
            result.realtimeFirstBinaryAppliedP99Ms ?? null,
          realtimeBinaryApplyTotalP50Ms:
            result.realtimeBinaryApplyTotalP50Ms ?? null,
          realtimeBinaryApplyTotalP95Ms:
            result.realtimeBinaryApplyTotalP95Ms ?? null,
          realtimeBinaryApplyTotalP99Ms:
            result.realtimeBinaryApplyTotalP99Ms ?? null,
          clientVisibleAfterBinaryAppliedP50Ms:
            result.clientVisibleAfterBinaryAppliedP50Ms ?? null,
          clientVisibleAfterBinaryAppliedP95Ms:
            result.clientVisibleAfterBinaryAppliedP95Ms ?? null,
          clientVisibleAfterBinaryAppliedP99Ms:
            result.clientVisibleAfterBinaryAppliedP99Ms ?? null,
          externalWrite: result.externalWrite ?? null,
          clientSamples: result.clientSamples,
          syncAvgCpuPct: result.syncAvgCpuPct,
          syncPeakCpuPct: result.syncPeakCpuPct,
          syncAvgMemoryMb: result.syncAvgMemoryMb,
          syncPeakMemoryMb: result.syncPeakMemoryMb,
          postgresAvgCpuPct: result.postgresAvgCpuPct,
          postgresPeakCpuPct: result.postgresPeakCpuPct,
          postgresAvgMemoryMb: result.postgresAvgMemoryMb,
          postgresPeakMemoryMb: result.postgresPeakMemoryMb,
        })),
      },
    };
  }

  async runLargeOfflineQueue() {
    const queueSizes = parseRustLargeOfflineQueueSizes();
    const queueResults = [];

    for (const queueSize of queueSizes) {
      queueResults.push(
        await runSyncularRustOfflineReplayCase({
          queueSize,
          titlePrefix: `syncular-rust-large-offline-${queueSize}`,
        })
      );
    }

    return {
      status: 'completed' as const,
      metrics: Object.fromEntries(
        queueResults.flatMap((result, index) => {
          const queueSize = queueSizes[index]!;
          return [
            [`queue_${queueSize}_queued_writes`, result.queuedWriteCount],
            [`queue_${queueSize}_convergence_ms`, result.reconnectConvergenceMs],
            [`queue_${queueSize}_request_count`, result.requestCount],
            [`queue_${queueSize}_bytes_transferred`, result.bytesTransferred],
            [`queue_${queueSize}_avg_memory_mb`, result.avgMemoryMb],
            [`queue_${queueSize}_peak_memory_mb`, result.peakMemoryMb],
            [`queue_${queueSize}_avg_cpu_pct`, result.avgCpuPct],
            [`queue_${queueSize}_peak_cpu_pct`, result.peakCpuPct],
            [`queue_${queueSize}_sync_attempts`, result.syncAttempts],
            [`queue_${queueSize}_replayed_write_success_rate`, result.replayedWriteSuccessRate],
            [
              `queue_${queueSize}_durable_reopen_outbox_unresolved`,
              result.reopenedOutbox?.unresolved ?? null,
            ],
            [
              `queue_${queueSize}_durable_reopen_matched_title_count`,
              result.reopenedMatchedTitleCount ?? null,
            ],
          ];
        })
      ),
      notes: [
        'Large offline queue replay uses the same Rust WASM native outbox path at multiple queue sizes.',
        'The default queue sizes are 100 / 500 / 1000; set SYNCULAR_RUST_LARGE_OFFLINE_QUEUE_SIZES for targeted self-verification runs.',
        RUST_DURABLE_REOPEN
          ? 'Durable reopen mode closes and reopens the same IndexedDB-compatible Rust store before replay at each scale.'
          : 'The default Bun harness verifies active-session replay with Rust memory storage; set SYNCULAR_RUST_DURABLE_REOPEN=1 for an IndexedDB-compatible close/reopen probe.',
      ],
      metadata: {
        implementation: RUST_DURABLE_REOPEN
          ? 'syncular-rust-wasm-indexeddb-outbox-large-queue-reopen'
          : 'syncular-rust-wasm-native-outbox-large-queue-active-session',
        queueSizes,
        storage: RUST_DURABLE_REOPEN ? RUST_DURABLE_REOPEN_STORAGE : 'memory',
        durableReopen: RUST_DURABLE_REOPEN,
        outboxPushBatchMode: RUST_OUTBOX_PUSH_BATCH_MODE,
        outboxPushBatchLimit:
          RUST_OUTBOX_PUSH_BATCH_LIMIT ?? RUST_DEFAULT_OUTBOX_PUSH_BATCH_LIMIT,
        adaptiveOutboxBatchLimit: RUST_OUTBOX_PUSH_BATCH_LIMIT
          ? null
          : RUST_ADAPTIVE_OUTBOX_PUSH_BATCH_LIMIT,
        adaptiveOutboxBatchThreshold: RUST_OUTBOX_PUSH_BATCH_LIMIT
          ? null
          : RUST_ADAPTIVE_OUTBOX_PUSH_THRESHOLD,
        scales: queueResults.map((result, index) => ({
          queueSize: queueSizes[index],
          queuedWriteCount: result.queuedWriteCount,
          reconnectConvergenceMs: result.reconnectConvergenceMs,
          requestCount: result.requestCount,
          bytesTransferred: result.bytesTransferred,
          avgMemoryMb: result.avgMemoryMb,
          peakMemoryMb: result.peakMemoryMb,
          avgCpuPct: result.avgCpuPct,
          peakCpuPct: result.peakCpuPct,
          syncAttempts: result.syncAttempts,
          replayedWriteSuccessRate: result.replayedWriteSuccessRate,
          matchedTitleCount: result.matchedTitleCount,
          queuedOutbox: result.queuedOutbox,
          reopenedOutbox: result.reopenedOutbox,
          reopenedMatchedTitleCount: result.reopenedMatchedTitleCount,
          finalOutbox: result.finalOutbox,
          syncSamples: result.syncSamples,
        })),
      },
    };
  }

  async runLocalQuery(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }> {
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await seedSyncularRustStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 100_000,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
    const actorId = fixtures.sampleUserIds[0];
    const ownerId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
    const projectId = fixtures.sampleProjectId;
    if (!actorId || !ownerId || !projectId) {
      throw new Error('Syncular Rust fixtures are missing actor/project data');
    }

    const bootstrap = await bootstrapRustClient({
      actorId,
      clientId: `syncular-rust-local-query-${randomUUID()}`,
      projectIds: projectId,
      expectedRows: 100_000,
    });
    const { client } = bootstrap;

    try {
      const iterations = 25;
      const listSamples: number[] = [];
      const searchSamples: number[] = [];
      const aggregateSamples: number[] = [];
      const rawAggregateSamples: number[] = [];
      let listResultCount = 0;
      let searchResultCount = 0;
      let aggregateResultCount = 0;
      let rawAggregateResultCount = 0;
      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const listResult = await runRustLocalListQuery({
          client,
          projectId,
          ownerId,
        });
        const searchResult = await runRustLocalSearchQuery({ client, projectId });
        const aggregateResult = await runRustLocalAggregateQuery({
          client,
          projectId,
        });
        const rawAggregateResult = await runRustRawLocalAggregateQuery({
          client,
          projectId,
        });

        listSamples.push(listResult.elapsedMs);
        searchSamples.push(searchResult.elapsedMs);
        aggregateSamples.push(aggregateResult.elapsedMs);
        rawAggregateSamples.push(rawAggregateResult.elapsedMs);
        listResultCount = listResult.resultCount;
        searchResultCount = searchResult.resultCount;
        aggregateResultCount = aggregateResult.resultCount;
        rawAggregateResultCount = rawAggregateResult.resultCount;
      }

      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();
      const rowCount = countRows(client, 'tasks');

      return {
        status: 'completed',
        metrics: {
          row_count: rowCount,
          bootstrap_ms: round(bootstrap.durationMs),
          iterations,
          list_query_p50_ms: percentile(listSamples, 50),
          list_query_p95_ms: percentile(listSamples, 95),
          search_query_p50_ms: percentile(searchSamples, 50),
          search_query_p95_ms: percentile(searchSamples, 95),
          aggregate_query_p50_ms: percentile(aggregateSamples, 50),
          aggregate_query_p95_ms: percentile(aggregateSamples, 95),
          aggregate_read_model_query_p50_ms: percentile(aggregateSamples, 50),
          aggregate_read_model_query_p95_ms: percentile(aggregateSamples, 95),
          aggregate_raw_sql_query_p50_ms: percentile(rawAggregateSamples, 50),
          aggregate_raw_sql_query_p95_ms: percentile(rawAggregateSamples, 95),
          list_result_count: listResultCount,
          search_result_count: searchResultCount,
          aggregate_result_count: aggregateResultCount,
          aggregate_raw_sql_result_count: rawAggregateResultCount,
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Local query benchmarks run against the fully materialized Rust-owned SQLite cache after bootstrap completes.',
          'aggregate_query_* uses the Rust-native task-count read model; aggregate_raw_sql_query_* reports the equivalent raw SQLite group-by scan for comparison.',
        ],
        metadata: {
          implementation: 'syncular-rust-wasm-client-local-query',
          aggregateQueryMode: 'read-model-with-raw-sql-comparison',
          runtimeInfo: bootstrap.runtimeInfo,
          rowCount,
          iterations,
        },
      };
    } finally {
      client.close();
    }
  }

  async runDeepRelationshipQuery(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }> {
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await seedSyncularRustStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 4,
      usersPerOrg: 10,
      tasksPerProject: 25_000,
      membershipsPerProject: 4,
    });

    const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
    const actorId = fixtures.sampleUserIds[0];
    const orgId = fixtures.sampleOrgId;
    const projectIds = fixtures.sampleProjectIds;
    const detailProjectId = projectIds[0];
    if (!actorId || !orgId || !detailProjectId || projectIds.length === 0) {
      throw new Error('Syncular Rust deep query fixtures are missing org/project data');
    }

    const bootstrap = await bootstrapRustClient({
      actorId,
      clientId: `syncular-rust-deep-query-${randomUUID()}`,
      projectIds,
      expectedRows: 100_000,
      subscriptions: relationshipSubscriptions({ orgId, projectIds }),
    });
    const { client } = bootstrap;

    try {
      const iterations = 25;
      const dashboardQueryPlan = explainRustQueryPlan(client, RUST_DASHBOARD_QUERY, [
        orgId,
      ]);
      const dashboardRawSqlQueryPlan = explainRustQueryPlan(
        client,
        RUST_RAW_DASHBOARD_QUERY,
        [orgId]
      );
      const detailJoinQueryPlan = explainRustQueryPlan(client, RUST_DETAIL_JOIN_QUERY, [
        detailProjectId,
        'org-1-project-1-task-00%',
      ]);
      const dashboardSamples: number[] = [];
      const dashboardRawSqlSamples: number[] = [];
      const detailJoinSamples: number[] = [];
      let dashboardResultCount = 0;
      let dashboardRawSqlResultCount = 0;
      let detailJoinResultCount = 0;
      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();

      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const dashboardResult = await runRustDashboardQuery({ client, orgId });
        const dashboardRawSqlResult = await runRustRawDashboardQuery({
          client,
          orgId,
        });
        const detailJoinResult = await runRustDetailJoinQuery({
          client,
          projectId: detailProjectId,
        });

        dashboardSamples.push(dashboardResult.elapsedMs);
        dashboardRawSqlSamples.push(dashboardRawSqlResult.elapsedMs);
        detailJoinSamples.push(detailJoinResult.elapsedMs);
        dashboardResultCount = dashboardResult.resultCount;
        dashboardRawSqlResultCount = dashboardRawSqlResult.resultCount;
        detailJoinResultCount = detailJoinResult.resultCount;
      }

      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();
      const taskCount = countRows(client, 'tasks');
      const organizationCount = countRows(client, 'organizations');
      const projectCount = countRows(client, 'projects');

      return {
        status: 'completed',
        metrics: {
          org_count: organizationCount,
          project_count: projectCount,
          row_count: taskCount,
          bootstrap_ms: round(bootstrap.durationMs),
          iterations,
          dashboard_query_p50_ms: percentile(dashboardSamples, 50),
          dashboard_query_p95_ms: percentile(dashboardSamples, 95),
          dashboard_read_model_query_p50_ms: percentile(dashboardSamples, 50),
          dashboard_read_model_query_p95_ms: percentile(dashboardSamples, 95),
          dashboard_raw_sql_query_p50_ms: percentile(dashboardRawSqlSamples, 50),
          dashboard_raw_sql_query_p95_ms: percentile(dashboardRawSqlSamples, 95),
          detail_join_query_p50_ms: percentile(detailJoinSamples, 50),
          detail_join_query_p95_ms: percentile(detailJoinSamples, 95),
          dashboard_result_count: dashboardResultCount,
          dashboard_read_model_result_count: dashboardResultCount,
          dashboard_raw_sql_result_count: dashboardRawSqlResultCount,
          detail_join_result_count: detailJoinResultCount,
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Deep relationship query benchmarks run against the local Rust-owned SQLite cache after all related tables are materialized.',
          'dashboard_query_* uses a generated countBy read model keyed by project_id/completed; dashboard_raw_sql_query_* records the equivalent tuned raw SQL count query for comparison.',
        ],
        metadata: {
          implementation: 'syncular-rust-wasm-client-deep-relationship-query',
          dashboardQueryMode: 'generated-count-by-read-model-with-raw-sql-comparison',
          dashboardReadModel: 'taskCountsByProjectCompletion',
          runtimeInfo: bootstrap.runtimeInfo,
          orgCount: organizationCount,
          projectCount,
          rowCount: taskCount,
          queryPlans: {
            dashboard: dashboardQueryPlan,
            dashboardReadModel: dashboardQueryPlan,
            dashboardRawSql: dashboardRawSqlQueryPlan,
            detailJoin: detailJoinQueryPlan,
          },
        },
      };
    } finally {
      client.close();
    }
  }

  async runPermissionChange(): Promise<{
    status: BenchmarkStatus;
    metrics: Record<string, number | null>;
    notes: string[];
    metadata: JsonObject;
  }> {
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await seedSyncularRustStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 2,
      usersPerOrg: 4,
      tasksPerProject: 500,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
    const actorId = fixtures.sampleUserIds[0];
    const revokedProjectId = fixtures.sampleProjectIds[0];
    const retainedProjectId = fixtures.sampleProjectIds[1];
    if (!actorId || !revokedProjectId || !retainedProjectId) {
      throw new Error('Syncular Rust permission fixtures are missing data');
    }

    const bootstrap = await bootstrapRustClient({
      actorId,
      clientId: `syncular-rust-permission-change-${randomUUID()}`,
      projectIds: [revokedProjectId, retainedProjectId],
      expectedRows: 1_000,
    });
    const { client } = bootstrap;

    try {
      client.resetTransportStats();
      const memorySampler = new MemorySampler();
      const cpuSampler = new CpuSampler();
      memorySampler.start();
      cpuSampler.start();
      const startedAt = performance.now();

      const revokeStartedAt = performance.now();
      await revokeSyncularRustProjectMembership({
        projectId: revokedProjectId,
        userId: actorId,
      });
      const revokeRequestMs = performance.now() - revokeStartedAt;

      let postRevokeVisibleRows = countRows(client, 'tasks');
      const syncSamples: RustPermissionSyncSample[] = [];
      const syncTimingTotals = emptyRustBootstrapTimingTotals();
      while (performance.now() - startedAt < PERMISSION_TIMEOUT_MS) {
        const syncStartedAt = performance.now();
        const syncResult = await client.syncOnce();
        const syncMs = performance.now() - syncStartedAt;
        accumulateRustSyncTimings(syncTimingTotals, syncResult.timings);
        const countStartedAt = performance.now();
        postRevokeVisibleRows = countRows(client, 'tasks');
        const countQueryMs = performance.now() - countStartedAt;
        syncSamples.push({
          attempt: syncSamples.length + 1,
          syncMs: round(syncMs),
          countQueryMs: round(countQueryMs),
          visibleRows: postRevokeVisibleRows,
          timings: compactRustSyncTimings(syncResult.timings),
        });
        if (postRevokeVisibleRows === 500) break;
      }

      const verificationStartedAt = performance.now();
      const revokedProjectRows = countTasksForProject(client, revokedProjectId);
      const retainedProjectRows = countTasksForProject(client, retainedProjectId);
      const verificationMs = performance.now() - verificationStartedAt;
      if (revokedProjectRows !== 0 || retainedProjectRows !== 500) {
        throw new Error(
          `Syncular Rust permission change did not converge: revoked=${revokedProjectRows}, retained=${retainedProjectRows}`
        );
      }

      const sameClientConvergenceMs = performance.now() - startedAt;
      const memoryMetrics = memorySampler.stop();
      const cpuMetrics = cpuSampler.stop();
      const transportStats = client.transportStats();
      const requestBytes = transportStats.requestBytes;
      const responseBytes = transportStats.responseBytes;
      const rebootstrapStartedAt = performance.now();
      const rebootstrap = await bootstrapRustClient({
        actorId,
        clientId: `syncular-rust-permission-change-rebootstrap-${randomUUID()}`,
        projectIds: [revokedProjectId, retainedProjectId],
        expectedRows: 500,
      });
      const rebootstrapVisibleMs = performance.now() - rebootstrapStartedAt;
      const rebootstrapClient = rebootstrap.client;
      const rebootstrapVisibleRows = countRows(rebootstrapClient, 'tasks');
      const rebootstrapRevokedProjectRows = countTasksForProject(
        rebootstrapClient,
        revokedProjectId
      );
      const rebootstrapRetainedProjectRows = countTasksForProject(
        rebootstrapClient,
        retainedProjectId
      );
      const rebootstrapTransportStats = rebootstrapClient.transportStats();
      rebootstrapClient.close();

      return {
        status: 'completed',
        metrics: {
          initial_visible_rows: 1_000,
          post_revoke_visible_rows: postRevokeVisibleRows,
          revoked_project_visible_rows_after_revoke: revokedProjectRows,
          retained_project_visible_rows_after_revoke: retainedProjectRows,
          permission_revoke_convergence_ms: round(sameClientConvergenceMs),
          same_client_permission_revoke_convergence_ms: round(sameClientConvergenceMs),
          revoke_request_ms: round(revokeRequestMs),
          sync_attempts: syncSamples.length,
          sync_elapsed_ms: round(syncSamples.reduce((total, sample) => total + sample.syncMs, 0)),
          sync_reported_total_ms: round(syncTimingTotals.totalMs),
          sync_pull_request_ms: round(syncTimingTotals.pullRequestMs),
          sync_pull_apply_ms: round(syncTimingTotals.pullApplyMs),
          sync_local_apply_ms: round(syncTimingTotals.localApplyMs),
          sync_notify_ms: round(syncTimingTotals.notifyMs),
          post_revoke_count_query_ms: round(
            syncSamples.reduce((total, sample) => total + sample.countQueryMs, 0)
          ),
          verification_ms: round(verificationMs),
          request_count: transportStats.requestCount,
          request_bytes: requestBytes,
          response_bytes: responseBytes,
          bytes_transferred: requestBytes + responseBytes,
          rebootstrap_permission_visible_ms: round(rebootstrapVisibleMs),
          rebootstrap_bootstrap_ms: round(rebootstrap.durationMs),
          rebootstrap_visible_rows: rebootstrapVisibleRows,
          rebootstrap_revoked_project_visible_rows: rebootstrapRevokedProjectRows,
          rebootstrap_retained_project_visible_rows: rebootstrapRetainedProjectRows,
          rebootstrap_request_count: rebootstrapTransportStats.requestCount,
          rebootstrap_request_bytes: rebootstrapTransportStats.requestBytes,
          rebootstrap_response_bytes: rebootstrapTransportStats.responseBytes,
          rebootstrap_bytes_transferred:
            rebootstrapTransportStats.requestBytes +
            rebootstrapTransportStats.responseBytes,
          avg_memory_mb: memoryMetrics.avgMemoryMb,
          peak_memory_mb: memoryMetrics.peakMemoryMb,
          avg_cpu_pct: cpuMetrics.avgCpuPct,
          peak_cpu_pct: cpuMetrics.peakCpuPct,
        },
        notes: [
          'Permission-change convergence uses the Rust client pull path with a multi-project subscription and reports same-client revoke as the primary metric.',
          'Rebootstrap-after-revoke is reported separately so it can be compared with stacks whose benchmark path recreates the local view.',
        ],
        metadata: {
          implementation: 'syncular-rust-wasm-client-permission-revoke',
          runtimeInfo: bootstrap.runtimeInfo,
          actorId,
          revokedProjectId,
          retainedProjectId,
          syncSamples,
          rebootstrap: {
            durationMs: round(rebootstrap.durationMs),
            visibleRows: rebootstrapVisibleRows,
            revokedProjectRows: rebootstrapRevokedProjectRows,
            retainedProjectRows: rebootstrapRetainedProjectRows,
            timings: compactRustSyncTimings(rebootstrap.timings),
          },
        },
      };
    } finally {
      client.close();
    }
  }

  async runBlobFlow() {
    await ensureStackUp(SYNCULAR_SERVER_STACK);
    await seedSyncularRustStack({
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: 10,
      membershipsPerProject: 2,
    });

    const fixtures = await getFixtures(SYNCULAR_SERVER_STACK);
    const writerActorId = fixtures.sampleUserIds[0];
    const readerActorId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
    const projectId = fixtures.sampleProjectId;
    const taskId = fixtures.sampleTaskId;
    if (!writerActorId || !readerActorId || !projectId || !taskId) {
      throw new Error('Syncular Rust blob fixtures are missing actor, project, or task data');
    }

    await initializeSyncularRustTaskBlobs(projectId);

    const subscriptions = [
      taskSubscription(projectId),
      taskBlobSubscription(projectId),
    ];
    const writerBootstrap = await bootstrapRustClient({
      actorId: writerActorId,
      clientId: `syncular-rust-blob-writer-${randomUUID()}`,
      projectIds: projectId,
      expectedRows: 10,
      subscriptions,
    });
    const readerBootstrap = await bootstrapRustClient({
      actorId: readerActorId,
      clientId: `syncular-rust-blob-reader-${randomUUID()}`,
      projectIds: projectId,
      expectedRows: 10,
      subscriptions,
    });
    const writer = writerBootstrap.client;
    const reader = readerBootstrap.client;
    const meter = createHttpMeter();
    const blobSizeBytes = 512 * 1024;
    const payload = createBlobPayload(blobSizeBytes);
    const blobMimeType = 'application/octet-stream';

    try {
      await waitForRustTaskBlobCount({
        client: writer,
        expectedRows: 10,
      });
      await waitForRustTaskBlobCount({
        client: reader,
        expectedRows: 10,
      });

      return await withMeteredGlobalFetch(meter.fetch, async () => {
        writer.resetTransportStats();
        reader.resetTransportStats();
        const meterBaseline = meter.snapshot();
        const memorySampler = new MemorySampler();
        const cpuSampler = new CpuSampler();
        memorySampler.start();
        cpuSampler.start();

        const uploadStartedAt = performance.now();
        const blobRef = await writer.storeBlob(payload, {
          immediate: true,
          mimeType: blobMimeType,
        });
        const uploadCompleteMs = performance.now() - uploadStartedAt;

        const uploadCacheStats = writer.blobCacheStats();
        const isLocalAfterUpload = writer.isBlobLocal(blobRef.hash);

        const metadataRow = writer.executeSql<Record<string, unknown>>(
          'select * from task_blob_entries where id = ? limit 1',
          [taskId]
        ).rows[0];
        if (!metadataRow) {
          throw new Error(`Missing Rust task_blob_entries row ${taskId}`);
        }

        const metadataStartedAt = performance.now();
        await writer.applyMutation(
          {
            table: 'task_blob_entries',
            row_id: taskId,
            op: 'upsert',
            payload: {
              blob_hash: blobRef.hash,
              blob_size: blobSizeBytes,
              blob_mime_type: blobMimeType,
            },
            base_version: Number(metadataRow.server_version ?? 0),
          },
          {
            ...metadataRow,
            blob_hash: blobRef.hash,
            blob_size: blobSizeBytes,
            blob_mime_type: blobMimeType,
          }
        );
        await writer.syncPush();
        await waitForRustBlobMetadata({
          client: reader,
          taskId,
          expectedHash: blobRef.hash,
          expectedSize: blobSizeBytes,
          expectedMimeType: blobMimeType,
          timeoutMs: 30_000,
        });
        const metadataVisibleMs = performance.now() - metadataStartedAt;

        writer.clearBlobCache();
        const isLocalAfterClear = writer.isBlobLocal(blobRef.hash);

        const downloadStartedAt = performance.now();
        const downloaded = await writer.retrieveBlob(blobRef);
        const downloadAfterMetadataMs = performance.now() - downloadStartedAt;
        const downloadCacheStats = writer.blobCacheStats();

        const retryBlobSizeBytes = 256 * 1024;
        const retryPayload = createBlobPayload(retryBlobSizeBytes);
        const retryBlobRef = await writer.storeBlob(retryPayload, {
          immediate: false,
          mimeType: blobMimeType,
        });
        const retryQueueBefore = writer.blobUploadQueueStats();
        const retryFirstAttemptStartedAt = performance.now();
        const retryFirstAttemptResult = await withMeteredGlobalFetch(
          createOneShotFailingUploadFetch(meter.fetch),
          () => writer.processBlobUploadQueue()
        );
        const retryFirstAttemptMs =
          performance.now() - retryFirstAttemptStartedAt;
        const retryQueueAfterFailure = writer.blobUploadQueueStats();
        const retryRecoveryStartedAt = performance.now();
        const retryRecoveryResult = await processRustBlobUploadQueueUntilDrained({
          client: writer,
          retryNow: true,
        });
        const retryRecoveryMs = performance.now() - retryRecoveryStartedAt;
        const retryQueueAfterRecovery = writer.blobUploadQueueStats();
        const isRetryBlobLocal = writer.isBlobLocal(retryBlobRef.hash);

        const meterSnapshot = diffMeterTotals(meter.snapshot(), meterBaseline);
        const memoryMetrics = memorySampler.stop();
        const cpuMetrics = cpuSampler.stop();

        if (downloaded.byteLength !== blobSizeBytes) {
          throw new Error(
            `Syncular Rust blob flow downloaded ${downloaded.byteLength} bytes, expected ${blobSizeBytes}`
          );
        }
        if (
          retryQueueAfterRecovery.pending !== 0 ||
          retryQueueAfterRecovery.uploading !== 0 ||
          retryRecoveryResult.uploaded !== 1
        ) {
          throw new Error(
            `Syncular Rust blob retry did not drain the queue: pending=${retryQueueAfterRecovery.pending}, uploading=${retryQueueAfterRecovery.uploading}, uploaded=${retryRecoveryResult.uploaded}`
          );
        }

        const expectedTransferBytes = blobSizeBytes * 2 + retryBlobSizeBytes;

        return {
          status: 'completed' as const,
          metrics: {
            blob_size_bytes: blobSizeBytes,
            upload_complete_ms: round(uploadCompleteMs),
            metadata_visible_ms: round(metadataVisibleMs),
            download_after_metadata_ms: round(downloadAfterMetadataMs),
            download_after_clear_ms: round(downloadAfterMetadataMs),
            request_count: meterSnapshot.requestCount,
            request_bytes: meterSnapshot.requestBytes,
            response_bytes: meterSnapshot.responseBytes,
            bytes_transferred: meterSnapshot.requestBytes + meterSnapshot.responseBytes,
            transfer_overhead_bytes:
              meterSnapshot.requestBytes +
              meterSnapshot.responseBytes -
              expectedTransferBytes,
            cache_bytes_after_upload: uploadCacheStats.totalBytes,
            cache_bytes_after_download: downloadCacheStats.totalBytes,
            cache_overhead_bytes_after_upload:
              uploadCacheStats.totalBytes - blobSizeBytes,
            cache_overhead_bytes_after_download:
              downloadCacheStats.totalBytes - blobSizeBytes,
            sqlite_storage_bytes_before_upload: null,
            sqlite_storage_bytes_after_upload: null,
            sqlite_storage_bytes_after_download: null,
            sqlite_storage_overhead_bytes_after_upload: null,
            sqlite_storage_overhead_bytes_after_download: null,
            is_local_after_upload: isLocalAfterUpload ? 1 : 0,
            is_local_after_clear: isLocalAfterClear ? 1 : 0,
            retry_blob_size_bytes: retryBlobSizeBytes,
            retry_queue_pending_before: retryQueueBefore.pending,
            retry_queue_pending_after_failure: retryQueueAfterFailure.pending,
            retry_queue_pending_after_recovery: retryQueueAfterRecovery.pending,
            retry_first_attempt_ms: round(retryFirstAttemptMs),
            retry_recovery_ms: round(retryRecoveryMs),
            retry_recovery_attempts: retryRecoveryResult.attempts,
            retry_recovery_retry_now: 1,
            retry_first_attempt_uploaded: retryFirstAttemptResult.uploaded,
            retry_first_attempt_failed: retryFirstAttemptResult.failed,
            retry_recovery_uploaded: retryRecoveryResult.uploaded,
            retry_recovery_failed: retryRecoveryResult.failed,
            retry_blob_is_local: isRetryBlobLocal ? 1 : 0,
            writer_sync_request_count: writer.transportStats().requestCount,
            reader_sync_request_count: reader.transportStats().requestCount,
            avg_memory_mb: memoryMetrics.avgMemoryMb,
            peak_memory_mb: memoryMetrics.peakMemoryMb,
            avg_cpu_pct: cpuMetrics.avgCpuPct,
            peak_cpu_pct: cpuMetrics.peakCpuPct,
          },
          notes: [
            'Blob flow uses two real Rust WASM clients against the standard Syncular blob routes: the writer uploads immediately, syncs blob metadata through task_blob_entries, the reader pulls metadata, and the writer re-downloads after clearing its local blob cache.',
            'The retry path stores a second Rust blob without immediate upload, forces the first PUT to fail once, then processes the native Rust blob upload queue with retryNow=true until it drains.',
            'The Bun harness uses Rust memory storage, so SQLite storage-byte overhead is reported as n/a for this Rust lane.',
          ],
          metadata: {
            implementation: 'syncular-rust-wasm-native-blob-flow',
            runtimeInfo: writerBootstrap.runtimeInfo,
            writerActorId,
            readerActorId,
            projectId,
            taskId,
            blobHash: blobRef.hash,
            blobMimeType: blobRef.mimeType,
            retryBlobHash: retryBlobRef.hash,
            retryQueueBefore,
            retryQueueAfterFailure,
            retryQueueAfterRecovery,
            retryRecoveryAttempts: retryRecoveryResult.attempts,
          },
        };
      });
    } finally {
      writer.close();
      reader.close();
    }
  }
}
