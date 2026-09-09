import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { arrayScreenQuery, assertRows, fixtureTasks, type Row } from '../contracts/screens.ts';
import { recoverySeed, validateRecoveryState } from '../contracts/recovery.ts';
import { REOPEN_CONTRACT, reopenProfile } from '../contracts/reopen.ts';
import { seedStack, ensureStackUp } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import { tempRoot } from '../paths.ts';
import { ExternalResources } from '../resources.ts';
import { ClientNetworkGate } from './network-gate.ts';
import { RecoveryProcess } from './process.ts';
import type { JsonObject, StackId } from '../types.ts';

export async function runReopen(stackId: StackId) {
  await ensureStackUp(stackId);
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, 'replica-reopen-'));
  const stack = getStack(stackId), endpoints: Record<string, string> = { sync: stack.syncBaseUrl };
  const persistedCollection = stackId === 'electric-tanstack', jazz = stackId === 'jazz-v2';
  if (stackId === 'powersync' || persistedCollection) endpoints.app = stack.appBaseUrl!;
  const gate = new ClientNetworkGate(endpoints), resources = new ExternalResources(false);
  const runtime = stackId === 'powersync' || persistedCollection || jazz ? 'node' : 'bun';
  let client: RecoveryProcess | undefined, sampling = false;
  const evidence: JsonObject = { stage: 'setup' };
  try {
    const seeding = jazz ? (await import('../startup/jazz-seed.ts')).seedJazzStartup(recoverySeed.tasksPerProject, dir) : null;
    evidence.seeding = seeding;
    if (!jazz) await seedStack(stackId, recoverySeed);
    await gate.start();
    const config = { stackId, ...(persistedCollection || jazz ? { startup: true } : {}), ...(seeding ? { datasetId: String(seeding.datasetId) } : {}), clientId: randomUUID(), actorId: 'org-1-user-1', projectId: 'org-1-project-1', dbPath: join(dir, 'replica.sqlite'), syncBaseUrl: gate.url('sync')!, appBaseUrl: gate.url('app') };
    client = new RecoveryProcess(runtime); await client.open(config); await client.sync();
    const persistedRows = persistedCollection ? await client.call<Row[]>('rows') : null;
    const initialState = await client.read();
    const initialDigest = validateRecoveryState('initial replica', initialState, [], 'empty');
    const persistedInitialDigest = persistedRows ? validateRecoveryState('persisted initial replica', { ...initialState, rows: persistedRows }, [], 'empty') : null;
    const initialDiagnostics = client.diagnostics;
    const oldPid = client.pid;
    evidence.initial = { digest: initialDigest, persistedDigest: persistedInitialDigest, pid: oldPid, diagnostics: initialDiagnostics };
    // This startup case follows a successful product close. SIGKILL recovery
    // with pending work is the distinct offline-restart case.
    await client.close();
    gate.block(); const before = gate.snapshot();
    for (const name of Object.keys(endpoints)) {
      try { await fetch(gate.url(name)!, { signal: AbortSignal.timeout(2_000) }); }
      catch { /* A closed gate refuses TCP before any upstream HTTP handler. */ }
    }
    const fileBefore = await stat(config.dbPath);
    if (!fileBefore.isFile() || fileBefore.size < 1) throw new Error('Reopen requires the persisted product file');
    evidence.stage = 'offline-reopen';
    await resources.start(); sampling = true;
    const started = performance.now();
    client = new RecoveryProcess(runtime); await client.open({ ...config, reopen: true });
    evidence.reopened = { pid: client.pid, diagnostics: client.diagnostics };
    const processMs = performance.now() - started;
    const screen = await client.call<Row[]>('firstScreen');
    const firstScreenMs = performance.now() - started;
    const reopenedPersistedRows = persistedCollection ? await client.call<Row[]>('rows') : null;
    const state = await client.read();
    const allRowsMs = performance.now() - started;
    const usage = await resources.stop(); sampling = false;
    const after = gate.snapshot();
    const reopenedDigest = validateRecoveryState('reopened offline replica', state, [], 'empty');
    const expected = arrayScreenQuery('list', { tasks: fixtureTasks(recoverySeed) });
    const persistedReopenedDigest = reopenedPersistedRows ? validateRecoveryState('persisted reopened replica', { ...state, rows: reopenedPersistedRows }, [], 'empty') : null;
    const screenDigest = assertRows('reopened task screen', screen, expected);
    return { status: 'completed' as const, metrics: { ...usage.metrics, reopen_process_ms: processMs, reopen_first_screen_ms: firstScreenMs, reopen_all_rows_ms: allRowsMs },
      notes: [...(persistedCollection ? ['TanStack reopens its native SQLite collection cache and serves the screen through a native live query while the remote source is offline. No row injection, application-side filtering or offline executor is used; this does not establish durability of its separate mutation queue.'] : []), ...(jazz ? ['Jazz uses an independent edge-durable 2,000-task seeder, then opens the persistent NAPI store without connecting transport. One native local screen query initializes an SDK-maintained native subscription before the reader is exposed. Subscription setup is included in initialization; canonical IDs map from external_id. This experimental backend-secret profile makes no end-user authorization claim.'] : []), 'Bootstrap and close a clean product store, then open it in a new process with all configured client routes blocked. No fixture rows or queued work are passed to the new process.',
        'Milestones are cumulative from process launch: product initialization, the first correct 50-row task screen, and the full 2,000-row local snapshot. Parent monotonic durations include IPC; output validation follows outside timing.',
        'The OS file cache is not cleared after bootstrap. This is persisted-replica startup, not cold disk or initial network bootstrap. Resources cover new-process startup and local reads, excluding the controller and sampler.'],
      metadata: { implementation: `${stackId}-${REOPEN_CONTRACT}`, workloadContract: REOPEN_CONTRACT, fixture: recoverySeed, reopenProfile,
        ...(persistedCollection || jazz ? { replicaPersistence: { store: config.dbPath, existsBeforeReopen: true, bytesBeforeReopen: fileBefore.size, initialDiagnostics, seeding, initialState: initialState.nativeState ?? null, reopenedState: state.nativeState ?? null, persistedInitialDigest, persistedReopenedDigest } } : {}),
        process: { oldPid, newPid: client.pid, sameProductStore: true, productClosedBeforeReopen: true }, outage: { before, after },
        validation: { initialDigest, reopenedDigest, screenDigest, taskCount: state.rows.length, pendingAfter: state.pending }, diagnostics: client.diagnostics, resources: usage.metadata } };
  } catch (error) {
    evidence.outage = gate.snapshot();
    if (sampling) {
      try { const usage = await resources.stop(); evidence.resources = usage.metadata; evidence.resourceMetrics = usage.metrics; }
      catch (samplingError) { evidence.samplingError = String(samplingError); }
      sampling = false;
    }
    if (error instanceof Error) { evidence.errorStack = error.stack ?? null; Object.assign(error, { evidence }); }
    throw error;
  }
  finally { resources.abort(); await client?.kill(); await gate.close(); await rm(dir, { recursive: true, force: true }); }
}
