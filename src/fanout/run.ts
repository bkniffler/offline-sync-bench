import { electricWriteUnsupported } from '../electric-support.ts';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExternalResources } from '../resources.ts';
import { awaitRecoveryReady } from '../recovery/ready.ts';
import { extendedFanout, fanoutClientState } from './client-state.ts';
import { RecoveryProcess } from '../recovery/process.ts';
import { ClientNetworkGate } from '../recovery/network-gate.ts';
import { recoverySeed } from '../contracts/recovery.ts';
import { clientCounts, FANOUT_CONTRACT, fanoutMutations, fanoutProfile, fanoutReady, validateFanoutState, type FanoutCase } from '../contracts/fanout.ts';
import { ContractError } from '../contracts/screens.ts';
import { percentile } from '../metrics.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import { tempRoot } from '../paths.ts';
import { restartStartupServer, serverState } from '../startup/server.ts';
import { ServerResources } from './server-resources.ts';
import type { RecoveryMutation } from '../recovery/protocol.ts';
import type { JsonObject, StackId } from '../types.ts';

type Reader = { client: RecoveryProcess; gate: ClientNetworkGate; evidence: JsonObject };
function arm(client: RecoveryProcess, mutations: RecoveryMutation[]) {
  let armed!: () => void, rejectArmed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { armed = resolve; rejectArmed = reject; });
  const done = client.call('observeDelivery', mutations.map(m => ({ ...m, serverVersion: 2 })), event => { if (event === 'armed') armed(); });
  void done.catch(rejectArmed);
  return { ready, done };
}
async function measureScale(stackId: StackId, scenario: FanoutCase, count: number) {
  const stack = getStack(stackId), runtime = ['powersync', 'electric-tanstack', 'jazz-v2'].includes(stackId) ? 'node' : 'bun';
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, 'fanout-'));
  const endpoints: Record<string, string> = { sync: stack.syncBaseUrl };
  if (stack.appBaseUrl) endpoints.app = stack.appBaseUrl;
  const resources = new ExternalResources(false), servers = new ServerResources(stackId);
  const readers: Reader[] = [], processes: RecoveryProcess[] = [];
  const evidence: JsonObject = { clientCount: count, stage: 'setup', readers: [] };
  const jazz = stackId === 'jazz-v2', extended = extendedFanout(stackId);
  let datasetId: string | undefined;
  let resourcesStarted = false, serversStarted = false;
  const snapshot = (state: import('../recovery/protocol.ts').RecoveryState, changes: RecoveryMutation[], reader: boolean) => fanoutClientState(stackId, state, changes, reader);
  const config = (name: string) => ({ stackId, fanout: true, ...(extended ? { recovery: true } : {}), ...(datasetId ? { datasetId } : {}), clientId: randomUUID(), actorId: 'org-1-user-1', projectId: 'org-1-project-1', dbPath: join(dir, `${name}.sqlite`), syncBaseUrl: stack.syncBaseUrl, appBaseUrl: stack.appBaseUrl });
  try {
    if (jazz) { evidence.seeding = (await import('../startup/jazz-seed.ts')).seedJazzStartup(2_000, dir); datasetId = String((evidence.seeding as JsonObject).datasetId); }
    else await seedStack(stackId, recoverySeed);
    evidence.serverPreparation = await restartStartupServer(stackId);
    const writer = new RecoveryProcess(runtime); processes.push(writer); await writer.open(config('writer'));
    const initialWriter = (await awaitRecoveryReady(writer, 'initial fanout writer')).state;
    evidence.writerDiagnostics = writer.diagnostics; evidence.writerInitialState = snapshot(initialWriter, [], false);
    evidence.writerPid = writer.pid;
    evidence.initialWriterDigest = validateFanoutState('initial writer', initialWriter, []);
    for (let offset = 0; offset < count; offset += 5) await Promise.all(Array.from({ length: Math.min(5, count - offset) }, async (_, j) => {
      const gate = new ClientNetworkGate(endpoints), client = new RecoveryProcess(runtime);
      const reader = { client, gate, evidence: { pid: client.pid, clientIndex: offset + j } as JsonObject };
      readers.push(reader); processes.push(client);
      await gate.start();
      const readerConfig = { ...config(`reader-${offset + j}`), deliveryMode: true, syncBaseUrl: gate.url('sync')!, appBaseUrl: gate.url('app') };
      reader.evidence.store = stackId === 'zero' ? readerConfig.clientId : readerConfig.dbPath; reader.evidence.cacheKind = fanoutProfile(scenario, stackId).clientCache; reader.evidence.clientId = readerConfig.clientId;
      await client.open(readerConfig);
      const initial = (await awaitRecoveryReady(client, 'initial fanout reader')).state;
      reader.evidence.diagnostics = client.diagnostics; reader.evidence.initialState = snapshot(initial, [], true);
      reader.evidence.initialDigest = validateFanoutState('initial reader', initial, []);
      await client.call('connectDelivery');
    }));
    console.log(`[fanout] ${stackId}/${scenario} readers=${count} bootstrapped`);
    evidence.stage = 'readiness';
    const warmup = readers.map(reader => arm(reader.client, fanoutReady));
    await Promise.all(warmup.map(w => w.ready));
    await writer.write(fanoutReady); await writer.sync(); await Promise.all(warmup.map(w => w.done));
    evidence.readinessWriterDigest = validateFanoutState('ready writer', await writer.read(), fanoutReady);
    for (const reader of readers) { const state = await reader.client.read(); reader.evidence.readyDigest = validateFanoutState('ready reader', state, fanoutReady); reader.evidence.readyState = snapshot(state, fanoutReady, true); }
    const mutations = fanoutMutations(scenario), finalMutations = [...fanoutReady, ...mutations];
    if (scenario === 'reconnect-storm') {
      evidence.stage = 'blocked-backlog';
      for (const reader of readers) reader.gate.block();
      await Promise.all(readers.map(reader => reader.client.call('pauseDelivery')));
      for (const reader of readers) {
        const before = reader.gate.snapshot();
        for (const route of Object.keys(endpoints)) try { await fetch(reader.gate.url(route)!, { signal: AbortSignal.timeout(2_000) }); } catch { /* TCP route probe must be refused. */ }
        reader.evidence.outage = { before, after: reader.gate.snapshot() };
      }
      await writer.write(mutations); await writer.sync();
      const witness = new RecoveryProcess(runtime); processes.push(witness); await witness.open(config('healthy-witness'));
      const witnessState = (await awaitRecoveryReady(witness, 'healthy fanout witness', { mutations: finalMutations })).state;
      evidence.healthyWitnessDigest = validateFanoutState('healthy server witness', witnessState, finalMutations);
      evidence.healthyWitness = { pid: witness.pid, diagnostics: witness.diagnostics, nativeState: snapshot(witnessState, finalMutations, true) };
      await witness.close();
      evidence.backlogCount = mutations.length;
      for (const reader of readers) {
        const state = await reader.client.read(); reader.evidence.offlineDigest = validateFanoutState('blocked reader', state, fanoutReady); reader.evidence.offlineState = snapshot(state, fanoutReady, true);
        (reader.evidence.outage as JsonObject).after = reader.gate.snapshot();
      }
    }
    console.log(`[fanout] ${stackId}/${scenario} readers=${count} ${scenario === 'reconnect-storm' ? 'backlog verified; restoring routes' : 'live delivery ready'}`);
    evidence.stage = 'measured-delivery';
    const watches = scenario === 'connected-fanout' ? readers.map(r => arm(r.client, mutations)) : [];
    await Promise.all(watches.map(w => w.ready));
    evidence.serverBefore = serverState(stackId);
    evidence.serviceIdentitiesBefore = servers.identities();
    const trafficBefore = readers.map(reader => reader.gate.snapshot());
    await servers.start(); serversStarted = true;
    await resources.start(); resourcesStarted = true;
    const started = performance.now();
    let completions: Promise<void>[];
    if (scenario === 'connected-fanout') {
      completions = watches.map((watch, i) => watch.done.then(() => { readers[i].evidence.completedMs = performance.now() - started; }));
    } else {
      for (const reader of readers) reader.gate.restore();
      completions = readers.map(reader => (async () => {
        await reader.client.call('resumeDelivery', mutations.map(m => ({ ...m, serverVersion: 2 })));
        reader.evidence.completedMs = performance.now() - started;
      })());
    }
    const delivered = Promise.all(completions); void delivered.catch(() => {});
    if (scenario === 'connected-fanout') { await writer.write(mutations); await writer.sync(); }
    await delivered;
    resourcesStarted = false; const usage = await resources.stop(); evidence.resources = usage.metadata;
    serversStarted = false; evidence.serverResources = await servers.stop();
    evidence.serverAfter = serverState(stackId);
    evidence.serviceIdentitiesAfter = servers.identities();
    evidence.resources = usage.metadata;
    evidence.stage = 'final-validation';
    const finalWriter = await writer.read(); evidence.finalWriterDigest = validateFanoutState('converged writer', finalWriter, finalMutations); evidence.writerFinalState = snapshot(finalWriter, finalMutations, false);
    for (const [i, reader] of readers.entries()) {
      const state = await reader.client.read(); reader.evidence.finalDigest = validateFanoutState('converged reader', state, finalMutations); reader.evidence.finalState = snapshot(state, finalMutations, true);
      reader.evidence.traffic = { before: trafficBefore[i], after: reader.gate.snapshot() };
    }
    evidence.readers = readers.map(r => r.evidence);
    const samples = readers.map(r => Number(r.evidence.completedMs)), key = `clients_${count}`;
    return { case: { ...evidence, status: 'completed', diagnostics: writer.diagnostics }, metrics: {
      [`${key}_all_converged_ms`]: Math.max(...samples), [`${key}_p50_ms`]: percentile(samples, 50), [`${key}_p95_ms`]: percentile(samples, 95),
      ...Object.fromEntries(Object.entries(usage.metrics).map(([name, value]) => [`${key}_${name}`, value])),
    } };
  } catch (error) { evidence.readers = readers.map(r => r.evidence);
    if (resourcesStarted) try { evidence.resources = (await resources.stop()).metadata; } catch {}
    if (serversStarted) try { evidence.serverResources = await servers.stop(); } catch {}
    if (error instanceof Error) { if ('evidence' in error) evidence.failure = error.evidence as JsonObject; Object.assign(error, { evidence }); } throw error; }
  finally { resources.abort(); servers.abort(); await Promise.allSettled(processes.map(client => client.kill())); await Promise.allSettled(readers.map(r => r.gate.close())); await rm(dir, { recursive: true, force: true }); }
}
export async function runFanout(stackId: StackId, scenario: FanoutCase) {
  if (stackId === 'electric') return electricWriteUnsupported();
  await ensureStackUp(stackId);
  if (stackId === 'syncular-rust') await (await import('../adapters/syncular-rust.ts')).ensureBenchBinary();
  const counts = clientCounts(), cases: JsonObject[] = [], metrics: Record<string, number | null> = {}, notes: string[] = [];
  for (const count of counts) {
    try { const result = await measureScale(stackId, scenario, count); cases.push(result.case); Object.assign(metrics, result.metrics); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); cases.push({ clientCount: count, status: error instanceof ContractError ? 'invalid' : /timed out|timeout/i.test(message) ? 'timed-out' : 'failed', reason: message, evidence: error instanceof Error && 'evidence' in error ? error.evidence as JsonObject : null }); notes.push(`${count} readers: ${message}`); }
  }
  return { status: cases.every(c => c.status === 'completed') ? 'completed' as const : cases.some(c => c.status === 'invalid') ? 'invalid' as const : cases.some(c => c.status === 'timed-out') ? 'timed-out' as const : 'failed' as const, metrics,
    notes: [...notes, 'Every reader owns a distinct process and store or memory cache; the profile identifies cache persistence and ownership. A live readiness marker proves delivery before the measured operation. Full 2,000-row snapshots validate every reader, including untouched tasks.',
      scenario === 'connected-fanout' ? 'The clock starts before one writer update. Already-connected readers observe local state; no harness catch-up request is issued after the write. Per-client completion receipts are timestamped independently.' : 'All reader routes are blocked while 100 distinct updates accumulate. An independent healthy witness verifies the server backlog and every disconnected reader must remain at its prior state. The clock starts before simultaneous route restoration, native catch-up sync and subscription reconnection.',
      'Syncular JS/Rust use WebSocket wakes and native sync; PowerSync uses continuous SDK sync; Turso uses successive native long-poll pulls with a 1s timeout. Zero uses native materialized streams; Electric and TanStack retain live shape delivery; Jazz keeps a full edge subscription. Observers read only local state on a shared 5ms scheduling interval. Completion includes IPC and observation delay.',
      'Client resources cover readers and writer, excluding controller and sampler. Server samples retain raw Docker counters and bracketing request/receipt times; missing counters remain null. Reader TCP counters include HTTP/WebSocket payload framing on configured routes, not TCP/IP overhead. Extended client counts are explicit campaign parameters.'],
    metadata: { implementation: `${stackId}-${FANOUT_CONTRACT}`, workloadContract: FANOUT_CONTRACT, fixture: { seed: recoverySeed, clientCounts: counts }, deliveryProfile: fanoutProfile(scenario, stackId), cases,
      diagnostics: (cases.find(c => c.status === 'completed')?.diagnostics ?? { localStorage: 'unavailable; no completed case' }) as JsonObject,
      resources: { method: 'external-ps-process-tree-v1', includeRoot: false, scope: 'readers and writer; per-scale samples in cases' } } };
}
