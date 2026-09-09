import { captureServerStorage, serverStoragePolicy } from '../server-storage.ts';
import { captureTursoPhysicalFiles } from './turso-physical.ts';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRows, ContractError, type Row } from '../contracts/screens.ts';
import { STARTUP_CONTRACT, startupConditions, configuredStartupSizes, startupKey, startupMemoryProfile, startupProfile, startupScreen, startupSeed, validateStartupSnapshot } from '../contracts/startup.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import { tempRoot } from '../paths.ts';
import { ExternalResources } from '../resources.ts';
import { ClientNetworkGate } from '../recovery/network-gate.ts';
import { RecoveryProcess } from '../recovery/process.ts';
import { restartStartupServer, serverState } from './server.ts';
import type { JsonObject, StackId } from '../types.ts';

export async function runStartup(stackId: StackId) {
  await ensureStackUp(stackId);
  if (stackId === 'syncular-rust') await (await import('../adapters/syncular-rust.ts')).ensureBenchBinary();
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, 'initial-startup-'));
  const stack = getStack(stackId), endpoints: Record<string, string> = { sync: stack.syncBaseUrl };
  const memory = stackId === 'electric' || stackId === 'zero';
  const persistedCollection = stackId === 'electric-tanstack';
  const jazz = stackId === 'jazz-v2';
  if (stackId === 'powersync' || memory || persistedCollection) endpoints.app = stack.appBaseUrl!;
  const runtime = stackId === 'powersync' || persistedCollection || jazz ? 'node' : 'bun';
  const sizes = configuredStartupSizes();
  const cases: JsonObject[] = [], metrics: Record<string, number | null> = {};
  const resources = new ExternalResources(false);
  let client: RecoveryProcess | undefined, gate: ClientNetworkGate | undefined;
  const evidence: JsonObject = { stage: 'setup', startupSizes: sizes, cases, metrics };
  let sampling = false, caseStarted: number | null = null;
  try {
    for (const count of sizes) {
      evidence.stage = `seed-${count}`;
      const seeding = jazz ? (await import('./jazz-seed.ts')).seedJazzStartup(count, dir) : null;
      if (!jazz) await seedStack(stackId, startupSeed(count));
      const restarted = await restartStartupServer(stackId);
      for (const condition of startupConditions) {
        evidence.stage = `${condition}-${count}`;
        const service = condition === 'process-cold' ? restarted : { before: serverState(stackId), after: serverState(stackId) };
        const key = startupKey(condition, count), dbPath = join(dir, `${key}.sqlite`);
        try { await stat(dbPath); throw new ContractError('Startup store already exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        gate = new ClientNetworkGate(endpoints); await gate.start();
        const config = { stackId, startup: true, ...(seeding ? { datasetId: String(seeding.datasetId) } : {}), clientId: randomUUID(), actorId: 'org-1-user-1', projectId: 'org-1-project-1', dbPath, syncBaseUrl: gate.url('sync')!, appBaseUrl: gate.url('app') };
        const expectedScreen = startupScreen(count);
        const eventData: Record<string, JsonObject> = {}, timings: Record<string, number> = {};
        const current: JsonObject = { count, condition, store: memory ? null : dbPath, seeding, events: eventData, timings };
        evidence.currentCase = current; caseStarted = null;
        current.serverStorage = { policy: serverStoragePolicy, before: captureServerStorage(stackId, 'before-startup-client') as unknown as JsonObject, after: null };
        if (stackId === 'turso') current.physicalServerBefore = captureTursoPhysicalFiles();
        await resources.start(); sampling = true;
        (current.serverStorage as JsonObject).window = { startedAt: new Date().toISOString(), finishedAt: null };
        const started = performance.now(); caseStarted = started;
        client = new RecoveryProcess(runtime); current.pid = client.pid;
        const { snapshot, ...observation } = await client.call<JsonObject>('bootstrap', { config, count, screen: expectedScreen }, (event, data) => {
          timings[event] = performance.now() - started;
          eventData[event] = data as JsonObject;
        });
        const usage = await resources.stop(); sampling = false; current.resources = usage.metadata;
        ((current.serverStorage as JsonObject).window as JsonObject).finishedAt = new Date().toISOString();
        const traffic = gate.snapshot(); current.traffic = traffic;
        // The worker captured the full snapshot at the materialization milestone.
        // Validate those exact values after the timing and sampling window.
        const state = await client.read();
        const physicalState = stackId === 'turso' ? { serverBefore: current.physicalServerBefore, serverAfter: captureTursoPhysicalFiles(), clientReplica: state.nativeState?.physical ?? null } : null;
        (current.serverStorage as JsonObject).after = captureServerStorage(stackId, 'after-startup-client') as unknown as JsonObject;
        const dataDigest = validateStartupSnapshot(snapshot as Row[], count);
        const activeDataDigest = persistedCollection ? validateStartupSnapshot(state.rows, count) : null;
        const persistence = persistedCollection ? state.nativeState?.startupPersistence as JsonObject : null;
        if (persistedCollection) {
          if (!persistence) throw new ContractError('Startup persisted snapshot proof missing');
          const file = await stat(dbPath);
          persistence.storeExists = file.isFile(); persistence.storeBytes = file.size;
        }
        const jazzStore = jazz ? await stat(dbPath) : null;
        const screenDigest = assertRows('initial startup screen', eventData['first-screen']?.screen as Row[], expectedScreen);
        if (state.pending !== 0 || state.rejected !== null && state.rejected !== 0 || state.conflicts !== null && state.conflicts !== 0) throw new ContractError('Initial startup has unexpected pending or failed writes');
        if (eventData.initialized?.pid !== client.pid || eventData['full-data']?.rows !== count) throw new ContractError('Initial startup process or row milestone missing');
        metrics[`${key}_initialized_ms`] = timings.initialized;
        metrics[`${key}_first_screen_ms`] = timings['first-screen'];
        metrics[`${key}_full_data_ms`] = timings['full-data'];
        for (const [name, value] of Object.entries(usage.metrics)) metrics[`${key}_${name}`] = value;
        metrics[`${key}_request_bytes`] = traffic.requestBytes; metrics[`${key}_response_bytes`] = traffic.responseBytes;
        const initialCache = (eventData.initialized.diagnostics as JsonObject)?.initialCache;
        if (memory && (!initialCache || (initialCache as JsonObject).id !== config.clientId)) throw new ContractError('Startup memory cache identity missing');
        cases.push({ count, condition, serverStorage: current.serverStorage, pid: client.pid, store: memory ? null : dbPath, storeAbsentBeforeLaunch: memory ? null : true,
          ...(physicalState ? { physicalState } : {}),
          ...(memory ? { cache: initialCache } : {}),
          ...(persistedCollection ? { persistence } : {}),
          ...(jazz ? { seeding, nativeQuery: state.nativeState?.startupQuery ?? null, screenSubscription: state.nativeState?.screenSubscription ?? null, file: { exists: jazzStore!.isFile(), bytes: jazzStore!.size } } : {}),
          ...(stackId === 'zero' ? { views: state.nativeState?.startupViews ?? null } : {}),
          service: { ...service, ready: service.after, after: serverState(stackId) }, observation, traffic,
          diagnostics: eventData.initialized.diagnostics, resources: usage.metadata,
          validation: { dataDigest, screenDigest, taskCount: (snapshot as Row[]).length, pending: state.pending, rejected: state.rejected, conflicts: state.conflicts,
            ...(persistedCollection ? { activeDataDigest, persistedDataDigest: dataDigest } : {}) } });
        await client.close(); client = undefined; await gate.close(); gate = undefined; delete evidence.currentCase;
      }
    }
    return { status: 'completed' as const, metrics,
      notes: [`Each scale seeds the same fixture, restarts only the sync-service process, then measures two fresh client processes and ${memory ? 'new SDK memory caches; no persistence is claimed' : 'new product files'}. The second client follows a fully validated first bootstrap. Service readiness is outside client timing; persistent server storage and OS caches are retained.`,
        `Parent monotonic event receipts measure initialization, the first observed correct 50-row task screen and the full local task snapshot. ${stackId === 'electric' ? 'Application queries over the SDK memory cache' : jazz ? 'Reads of the native maintained screen' : 'Native screen queries'} run until the first correct screen, with 5ms between polls. Progress counts are separated by at least 5 seconds. Native sync completion and the first correct screen each prompt one candidate snapshot; incomplete candidates remain progress evidence. A complete progress count also prompts capture and must agree with the snapshot. Full row values are verified after timing. The declared observation policy is part of the comparison profile. Query serialization, IPC and observation delay are included; these are observed availability times, not internal apply timestamps.`,
        'Rust permits queries between native sync rounds; a round is serialized. Turso initialization can materialize data before returning a usable database. PowerSync observes its SQLite database during SDK sync. These execution details remain in diagnostics.',
        ...(persistedCollection ? ['TanStack serves the screen through its native query engine. The full-data milestone reads the complete native SQLite persistence snapshot, waiting for it to catch up with the collection. The controller validates both persisted and active datasets outside timing. No offline write executor is used in this read-only startup case.'] : []),
        ...(jazz ? ['Jazz uses a separate edge-durable seeder that exits before both fresh readers. A native filtered/ordered/limited subscription maintains the screen through the installed SDK, with one initial local query and subscription setup included in initialization. Native local queries serve the full snapshot; row count uses the length of a native full-query result because this adapter exposes no aggregate count API. Canonical IDs are mapped from external_id. The backend-secret client and allow-all policy make no end-user authorization claim. Old server datasets and OS caches are retained; the measured dataset has a unique identity. WebSocket traffic is included in the client TCP gate. Results remain in the experimental lane.'] : []),
        ...(stackId === 'turso' ? ['Server main/WAL file sizes are read before and after each client, and native replica page/freelist counts are read after timing. These are retained physical-state observations, not fresh-database normalization or an accounting of transferred WAL frames.'] : []),
        ...(stackId === 'zero' ? ['Zero uses kvStore: mem, with native full-task and filtered screen views. Both queries must reach native complete state. TCP metering includes the client WebSocket stream through zero-cache; server-to-application query calls are outside client traffic. No process durability or row-level authorization is claimed.'] : []),
        'External resources cover process launch through observation and sync completion, covering the client worker and native descendants, excluding the controller and sampler. Per-case TCP counters include HTTP headers on configured sync/app routes, exclude TCP/IP overhead and any other routes, and are not application payload sizes.'],
      metadata: { implementation: `${stackId}-${STARTUP_CONTRACT}`, workloadContract: STARTUP_CONTRACT, fixture: sizes.map(startupSeed), startupSizes: sizes, startupProfile: memory ? startupMemoryProfile : startupProfile, cases,
        ...(jazz ? { experimental: true, queryExecution: 'native-reactive-query', productVersion: (cases[0]?.diagnostics as JsonObject)?.productVersion } : {}),
        ...(memory ? { queryExecution: stackId === 'zero' ? 'native-reactive-query' : 'application-processing' } : {}),
        diagnostics: (cases[0]?.diagnostics ?? {}) as JsonObject,
        resources: { method: 'external-ps-process-tree-v1', includeRoot: false, scope: 'separate launch-to-observation-and-sync-completion window per scale and server condition; samples in cases' } } };
  } catch (error) {
    const current = evidence.currentCase as JsonObject | undefined;
    if (current) {
      current.elapsedMs = caseStarted === null ? null : performance.now() - caseStarted;
      current.traffic = gate?.snapshot() ?? null;
      current.failure = error instanceof Error ? (error as Error & { evidence?: JsonObject }).evidence ?? null : null;
      if (sampling) {
        try { const usage = await resources.stop(); current.resources = usage.metadata; current.resourceMetrics = usage.metrics; }
        catch (samplingError) { current.samplingError = String(samplingError); }
        sampling = false;
      }
    }
    if (error instanceof Error) Object.assign(error, { evidence });
    throw error;
  }
  finally { resources.abort(); await client?.kill(); await gate?.close(); await rm(dir, { recursive: true, force: true }); }
}
