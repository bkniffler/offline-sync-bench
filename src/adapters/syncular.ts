import { runAttachments } from '../attachments/run.ts';
import { runAccess } from '../access/run.ts';
import { relayBlobUrl, type BlobDownloadProxy } from '../attachments/transfer-gate.ts';
import { runFanout } from '../fanout/run.ts';
import { runStartup } from '../startup/run.ts';
import { runReopen } from '../recovery/reopen.ts';
import { runConflicts } from '../recovery/conflicts.ts';
import { runRecovery } from '../recovery/run.ts';
import { measureCollaboration, collaborationSeed, pollUntil } from '../contracts/collaboration.ts';
import { measureScreens, screenSeed, screenQueries, type ScreenCase, type Row } from '../contracts/screens.ts';
/**
 * Syncular v2 benchmark adapter — drives the real `@syncular/client`
 * (SyncClient, bun:sqlite local database) against the Dockerized Syncular
 * v2 server stack (relational Postgres server storage, engine-mediated
 * admin writes, presigned MinIO blobs, WebSocket realtime).
 *
 * Every scenario is native: local reads are raw SQL over the synced
 * SQLite mirror, offline queuing uses the client's own persisted outbox behind a client-only
 * network gate, permission-change uses the real membership-derived
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
import { indexedSyncularSchema as schema, captureScreenPlans } from '../contracts/screen-indexes.ts';
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
  resolveServiceContainerId,
  restartServiceCold,
  seedStack,
  writeTask,
} from '../stack-manager';
import { getClientStack as getStack } from '../stacks';
import type {
  BenchmarkAdapter,
  BenchmarkStatus,
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

export async function createBenchClient(
  actorId: string,
  uploadFault?: { blocked: boolean; rejectedPuts: number },
  options: { dbPath?: string; clientId?: string; syncBaseUrl?: string; blobDownloadProxy?: BlobDownloadProxy; onBlobUploaded?: (receipt: { route: string; byteLength: number }) => void } = {}
): Promise<BenchClient> {
  const stack = getStack(STACK_ID);
  const syncBase = options.syncBaseUrl ?? stack.syncBaseUrl;
  const realtimeBase = options.syncBaseUrl ? `${syncBase.replace(/^http/, 'ws')}/sync/realtime` : stack.syncRealtimeBaseUrl;
  if (!realtimeBase) {
    throw new Error('Syncular stack is missing syncRealtimeBaseUrl');
  }

  // Metering must preserve the framing of the product's finite SSP2 bodies.
  // Bound failed network requests so a tier can report failure and clean up.
  const timedFetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeout = AbortSignal.timeout(120_000);
    return fetch(input, { ...init, signal: inherited ? AbortSignal.any([inherited, timeout]) : timeout });
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  const meter = createHttpMeter(timedFetch, { fixedLengthRequests: true });
  // Preserve Content-Length for presigned S3 PUTs when counting their bodies.
  const blobMeter = createHttpMeter(fetch, { fixedLengthRequests: true });
  const realtimeCounter = { bytes: 0 };
  const headers = { 'x-actor-id': actorId };
  const clientId = options.clientId ?? crypto.randomUUID();
  let helloSeen = false;
  let helloResolve: (() => void) | undefined;
  const onHello = () => {
    helloSeen = true;
    helloResolve?.();
  };
  const client = new SyncClient({
    database: openBunDatabase(options.dbPath),
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
      fetch: uploadFault || options.blobDownloadProxy || options.onBlobUploaded
        ? Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
            if (uploadFault?.blocked && method === 'PUT') {
              uploadFault.rejectedPuts += 1;
              throw new Error('Benchmark injected blob-upload outage');
            }
            const url = input instanceof Request ? input.url : String(input);
            if (options.blobDownloadProxy && method === 'GET' && new URL(url).origin !== new URL(syncBase).origin) {
              const relayed = relayBlobUrl(url, options.blobDownloadProxy);
              return blobMeter.fetch(input instanceof Request ? new Request(relayed, input) : relayed, init);
            }
            const response = await blobMeter.fetch(input, init);
            if (method === 'PUT' && response.ok && options.onBlobUploaded) {
              const body = init?.body ?? (input instanceof Request ? input.body : undefined);
              const length = body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body.byteLength : Number(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('content-length'));
              options.onBlobUploaded({ route: new URL(url).origin === new URL(syncBase).origin ? 'authenticated-direct' : 'presigned', byteLength: length });
            }
            return response;
          }, { preconnect: fetch.preconnect })
        : blobMeter.fetch,
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
      const blobSnapshot = blobMeter.snapshot();
      return {
        requestCount: snapshot.requestCount + blobSnapshot.requestCount,
        requestBytes: snapshot.requestBytes + blobSnapshot.requestBytes,
        responseBytes: snapshot.responseBytes + blobSnapshot.responseBytes,
        realtimeBytes: realtimeCounter.bytes,
      };
    },
    close: async () => {
      const database = client.database;
      client.disconnectRealtime();
      await client.close();
      database.close();
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
export function subscribeTasks(bench: BenchClient, projectIds: readonly string[]): void {
  for (const projectId of projectIds) {
    bench.client.subscribe({
      id: `tasks:${projectId}`,
      table: 'tasks',
      scopes: { project_id: [projectId] },
    });
  }
}

export function subscribeBlobEntries(
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
    metadata: { implementation, ...(error instanceof Error && 'evidence' in error ? { evidence: error.evidence as import('../types.ts').JsonObject } : {}) },
  };
}

export class SyncularBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack(STACK_ID);

  async runBootstrap() { return runStartup('syncular'); }

  async runOnlinePropagation(): Promise<ScenarioOutcome> {
    await ensureStackUp(STACK_ID);
    await seedStack(STACK_ID, collaborationSeed);
    const fixtures = await requireFixtures();
    const writer = await createBenchClient(fixtures.sampleUserIds[0]!);
    const reader = await createBenchClient(fixtures.sampleUserIds[1]!);
    const taskId = fixtures.sampleTaskId!;
    try {
      for (const client of [writer, reader]) { subscribeTasks(client, [fixtures.sampleProjectId!]); await client.client.syncUntilIdle(500); }
      await reader.connectRealtimeReady(); await reader.client.sync();
      const result = await measureCollaboration({
      readData: () => reader.client.query('SELECT * FROM tasks'),
        localCommit: true,
        write: async (title, milestones) => {
          const row = writer.client.query('SELECT * FROM tasks WHERE id = ?', [taskId])[0] as unknown as LocalTaskRow;
          mutateTaskTitle(writer, row, title); milestones.localCommitted();
          const summary = await writer.client.sync();
          if (!summary.applied.length) throw new Error('Syncular server did not apply mutation');
          milestones.serverAccepted();
        },
        observe: (title, signal) => pollUntil(() => reader.client.query('SELECT title FROM tasks WHERE id = ?', [taskId])[0]?.title === title, signal),
        diagnostics: { localCommit: 'mutate returned after local commit', serverAccepted: 'successful combined push/pull response', reader: 'realtime WebSocket, 1ms local SQL polling', localStorage: 'bun:sqlite-memory' },
      });
      return { status: 'completed', ...result, metadata: { ...result.metadata, implementation: 'syncular-collaboration-v2' } };
    } finally { await closeAll([writer, reader]); }
  }

  async runReplicaReopen() { return runReopen('syncular'); }

  async runConflictUpdateUpdate() { return runConflicts('syncular', 'conflict-update-update'); }
  async runConflictUpdateDelete() { return runConflicts('syncular', 'conflict-update-delete'); }

  async runOfflineRestart(): Promise<ScenarioOutcome> { return runRecovery(STACK_ID, 'offline-restart'); }

  async runOfflineReplay(): Promise<ScenarioOutcome> { return runRecovery(STACK_ID, 'offline-replay'); }

  async runConnectedFanout() { return runFanout('syncular', 'connected-fanout'); }

  async runReconnectStorm() { return runFanout('syncular', 'reconnect-storm'); }

  async runLargeOfflineQueue(): Promise<ScenarioOutcome> { return runRecovery(STACK_ID, 'large-offline-queue'); }

  async runLocalQuery(): Promise<ScenarioOutcome> { return this.runScreens('local-query'); }

  async runDeepRelationshipQuery(): Promise<ScenarioOutcome> { return this.runScreens('deep-relationship-query'); }

  private async runScreens(scenario: ScreenCase): Promise<ScenarioOutcome> {
    await ensureStackUp(STACK_ID);
    await seedStack(STACK_ID, screenSeed(scenario));
    const fixtures = await requireFixtures();
    const bench = await createBenchClient(fixtures.sampleUserIds[0]!);
    try {
      subscribeOrgTables(bench, fixtures.sampleOrgId!);
      await bench.client.syncUntilIdle(1_000);
      const projectIds = bench.client.query('SELECT id FROM projects ORDER BY id').map(row => String(row.id));
      subscribeMemberships(bench, projectIds);
      subscribeTasks(bench, projectIds);
      await bench.client.syncUntilIdle(1_000);
      const result = await measureScreens(scenario, {
        execution: 'native-sql',
        readData: () => ({
          tasks: bench.client.query('SELECT * FROM tasks'),
          projects: bench.client.query('SELECT * FROM projects'),
          organizations: bench.client.query('SELECT * FROM organizations'),
        }),
        query: name => bench.client.query(screenQueries[name]),
        diagnostics: { queries: screenQueries, localStorage: 'bun:sqlite-memory', queryPlans: await captureScreenPlans(scenario, sql => bench.client.query(sql)) },
      });
      return { status: 'completed', ...result, metadata: { ...result.metadata, implementation: `${IMPLEMENTATION_PREFIX}-screens-v2`, engine: 'syncular-v2' } };
    } finally { await bench.close(); }
  }

  async runPermissionChange() { return runAccess(STACK_ID); }

  async runBlobFlow() { return runAttachments('syncular'); }
}
