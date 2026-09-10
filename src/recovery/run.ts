import { configuredRecoveryPolicy, validateRestoration } from '../contracts/recovery-policy.ts';
import { validateOutage } from '../contracts/outage.ts';
import { waitForRestoration } from './restoration.ts';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../contracts/screens.ts';
import { RECOVERY_CONTRACT, recoveryGuarantees, recoverySeed, recoverySizes, recoveryMutations, validateRecoveryState, type RecoveryCase } from '../contracts/recovery.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import { tempRoot } from '../paths.ts';
import { ExternalResources } from '../resources.ts';
import type { JsonObject, StackId } from '../types.ts';
import { ClientNetworkGate } from './network-gate.ts';
import { RecoveryProcess } from './process.ts';
import { validateElectricRecoveryState } from '../contracts/electric-recovery.ts';
import { awaitRecoveryReady } from './ready.ts';
import { validateZeroRecoveryState } from '../contracts/zero-recovery.ts';
import { validateJazzRecoveryState } from '../contracts/jazz-recovery.ts';

async function measureScale(stackId: StackId, scenario: RecoveryCase, count: number) {
  const jazz = stackId === 'jazz-v2', zero = stackId === 'zero', electric = ['electric', 'electric-tanstack'].includes(stackId);
  if (zero && scenario === 'offline-restart') throw new ContractError('Zero memory storage cannot satisfy offline restart');
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, 'recovery-'));
  const stack = getStack(stackId);
  const endpoints: Record<string, string> = { sync: stack.syncBaseUrl };
  if (stackId === 'powersync' || electric) endpoints.app = stack.appBaseUrl!;
  const gate = new ClientNetworkGate(endpoints, true);
  const outagePolicy = configuredRecoveryPolicy();
  const runtime = stackId === 'powersync' || jazz || stackId === 'electric-tanstack' ? 'node' : 'bun';
  const resources = new ExternalResources();
  let blockedAt: number | undefined, timing: JsonObject | undefined;
  let writer: RecoveryProcess | undefined, reader: RecoveryProcess | undefined, sampling = false;
  const evidence: JsonObject = { stackId, scenario, queueSize: count, stage: 'setup' };
  try {
    const seeding = jazz ? (await import('../startup/jazz-seed.ts')).seedJazzStartup(recoverySeed.tasksPerProject, dir) : null;
    evidence.seeding = seeding;
    if (!jazz) await seedStack(stackId, recoverySeed);
    await gate.start();
    const writerConfig = { stackId, ...(stackId === 'electric-tanstack' && scenario === 'offline-restart' ? { durableOutbox: true } : {}), ...(jazz || zero || electric ? { recovery: true } : {}), ...(jazz ? { datasetId: String(seeding!.datasetId) } : {}), clientId: randomUUID(), actorId: 'org-1-user-1', projectId: 'org-1-project-1', dbPath: join(dir, 'writer.sqlite'), syncBaseUrl: gate.url('sync')!, appBaseUrl: gate.url('app') };
    writer = new RecoveryProcess(runtime);
    await writer.open(writerConfig);
    reader = new RecoveryProcess(runtime);
    await reader.open({ ...writerConfig, clientId: randomUUID(), dbPath: join(dir, 'reader.sqlite'), syncBaseUrl: stack.syncBaseUrl, appBaseUrl: stack.appBaseUrl });
    const initialWriterPid = writer.pid, initialWriterCache = writer.diagnostics.initialCache ?? null;
    const [readyWriter, readyReader] = await Promise.all([awaitRecoveryReady(writer, 'initial writer'), awaitRecoveryReady(reader, 'initial reader')]);
    const initialWriter = readyWriter.state, initialWriterDigest = readyWriter.digest, initialReaderDigest = readyReader.digest;
    const electricState = (state: import('./protocol.ts').RecoveryState, changes: import('./protocol.ts').RecoveryMutation[], accepted: boolean, reopened = false, reader = false) => validateElectricRecoveryState(stackId as 'electric' | 'electric-tanstack', state, changes, accepted, reopened, reader);
    const nativeInitial = electric ? electricState(initialWriter, [], true) : jazz ? validateJazzRecoveryState(initialWriter, [], true) : zero ? validateZeroRecoveryState(initialWriter.nativeState, [], true) : null;
    const nativeReaderInitial = electric ? electricState(readyReader.state, [], true) : zero ? validateZeroRecoveryState(readyReader.state.nativeState, [], true) : null;
    await resources.start(); sampling = true;
    blockedAt = performance.now();
    gate.block();
    timing = { clock: outagePolicy.clock, anchor: 'immediately-before-gate-block', blockedAtMs: 0 };
    evidence.outagePolicy = outagePolicy; evidence.restoration = timing;
    const beforeOutage = gate.snapshot();
    const mutations = recoveryMutations(count);
    const queueStarted = performance.now();
    await writer.write(mutations);
    const localQueueCommitMs = performance.now() - queueStarted;
    timing.queueCommittedAtMs = performance.now() - blockedAt;
    let failedProbe: string | null = null;
    timing.probeStartedAtMs = performance.now() - blockedAt;
    try { await writer.call('probeSync'); } catch (error) { failedProbe = error instanceof Error ? error.message : String(error); }
    timing.probeFinishedAtMs = performance.now() - blockedAt;
    const offlineNetwork = gate.snapshot();
    if (offlineNetwork.rejectedConnections <= beforeOutage.rejectedConnections || offlineNetwork.requestBytes !== beforeOutage.requestBytes || offlineNetwork.forwardedConnections !== beforeOutage.forwardedConnections) throw new ContractError('Writer outage did not block all forwarded traffic');
    const queued = await writer.read();
    evidence.stage = 'offline-validation';
    evidence.pendingBefore = queued.pending;
    evidence.nativeBefore = queued.nativeState ?? null;
    evidence.outage = { before: beforeOutage, after: offlineNetwork, failedProbe };
    const queuedDigest = validateRecoveryState('queued writer', queued, mutations, 'queued');
    if (jazz) queued.nativeState = validateJazzRecoveryState(queued, mutations, false);
    if (zero) validateZeroRecoveryState(queued.nativeState, mutations.map(m => m.id), false);
    if (electric) queued.nativeState = electricState(queued, mutations, false);
    // The reader is independent and can still sync against the healthy service.
    await reader.sync();
    const offlineReaderDigest = validateRecoveryState('reader during writer outage', await reader.read(), [], 'empty');
    let restart: JsonObject | null = null;
    if (scenario === 'offline-restart') {
      const oldPid = writer.pid;
      const exit = await writer.kill();
      if (exit.signal !== 'SIGKILL') throw new ContractError('Restart case requires confirmed SIGKILL termination');
      writer = new RecoveryProcess(runtime);
      const reopenStarted = performance.now();
      evidence.stage = 'offline-reopen';
      evidence.reopen = { oldPid, newPid: writer.pid, signal: exit.signal, store: writerConfig.dbPath, networkBlocked: gate.snapshot().blocked };
      await writer.open({ ...writerConfig, reopen: true });
      const restored = await writer.read();
      evidence.stage = 'offline-reopen-validation';
      evidence.pendingAfterReopen = restored.pending;
      const reopenLocalMs = performance.now() - reopenStarted;
      const restoredDigest = validateRecoveryState('reopened offline writer', restored, mutations, 'queued');
      if (electric) restored.nativeState = electricState(restored, mutations, false, true);
      if (jazz) restored.nativeState = validateJazzRecoveryState(restored, mutations, false);
      if (restored.pending !== queued.pending || writer.pid === oldPid || !gate.snapshot().blocked) throw new ContractError('Offline restart did not preserve the pending queue in a new process');
      restart = { oldPid, newPid: writer.pid, signal: exit.signal, reopenLocalMs, restoredDigest, pendingAfterReopen: restored.pending, sameProductStore: true, networkBlockedAtReopen: true, ...(jazz || electric ? { nativeState: restored.nativeState ?? null } : {}) };
    }
    // Both completion callbacks use the parent's monotonic clock. They include
    // worker IPC receipt; neither is delayed until the other operation completes.
    timing.offlineValidatedAtMs = performance.now() - blockedAt;
    evidence.stage = 'awaiting-declared-restoration';
    await waitForRestoration(blockedAt + Number(outagePolicy.durationMs));
    const transferBefore = gate.snapshot();
    validateOutage(beforeOutage, transferBefore);
    evidence.stage = 'replay';
    const started = performance.now();
    timing.restoreStartedAtMs = started - blockedAt;
    gate.restore();
    timing.restoredAtMs = performance.now() - blockedAt;
    timing.timeline = gate.timeline(blockedAt);
    validateRestoration(outagePolicy, timing, beforeOutage as unknown as JsonObject, transferBefore as unknown as JsonObject);
    const queueDrain = writer.sync().then(async state => {
      evidence.pendingAfterSync = state.pending;
      if (state.pending !== 0) {
        evidence.nativeAfterSync = (await writer!.read()).nativeState ?? null;
        throw new ContractError(`Writer sync returned with ${state.pending} pending application writes`);
      }
      return performance.now() - started;
    });
    const visible = reader.observe(mutations).then(() => performance.now() - started);
    const [queueDrainMs, mirrorVisibleMs] = await Promise.all([queueDrain, visible]);
    const usage = await resources.stop(); sampling = false;
    const finalWriter = await writer.read();
    const finalWriterDigest = validateRecoveryState('converged writer', finalWriter, mutations, 'empty');
    if (jazz) finalWriter.nativeState = validateJazzRecoveryState(finalWriter, mutations, true);
    if (electric) finalWriter.nativeState = electricState(finalWriter, mutations, true, stackId === 'electric-tanstack' && scenario === 'offline-restart');
    if (zero) validateZeroRecoveryState(finalWriter.nativeState, mutations.map(m => m.id), true);
    const finalReader = await reader.read();
    const finalReaderDigest = validateRecoveryState('converged reader', finalReader, mutations, 'empty');
    if (zero) validateZeroRecoveryState(finalReader.nativeState, [], true);
    if (electric) finalReader.nativeState = electricState(finalReader, mutations, true, false, true);
    const transferAfter = gate.snapshot();
    timing.timeline = gate.timeline(blockedAt);
    validateRestoration(outagePolicy, timing, beforeOutage as unknown as JsonObject, transferBefore as unknown as JsonObject);
    const scale: JsonObject = { ...(electric ? { clients: { writerInitialPid: initialWriterPid, writerFinalPid: writer.pid, readerPid: reader.pid, writerCache: initialWriterCache, readerCache: reader.diagnostics.initialCache ?? null }, nativeInitial, nativeReaderInitial, nativeBefore: queued.nativeState ?? null, nativeReader: finalReader.nativeState ?? null } : {}), ...(zero ? { clients: { writerInitialPid: initialWriterPid, writerFinalPid: writer.pid, readerPid: reader.pid, writerCache: initialWriterCache, readerCache: reader.diagnostics.initialCache ?? null }, nativeInitial, nativeReaderInitial, nativeBefore: queued.nativeState ?? null, nativeReader: finalReader.nativeState ?? null } : {}), ...(jazz ? { seeding, clients: { writerInitialPid: initialWriterPid, writerFinalPid: writer.pid, readerPid: reader.pid, writerStore: writerConfig.dbPath, readerStore: join(dir, 'reader.sqlite'), datasetId: writerConfig.datasetId! }, nativeInitial, nativeBefore: queued.nativeState ?? null } : {}), queueSize: count, localQueueCommitMs, queueDrainMs, mirrorVisibleMs,
      pendingBefore: queued.pending, pendingAfter: 0, acknowledgedWrites: count,
      validation: { taskCount: recoverySeed.tasksPerProject, initialWriterDigest, initialReaderDigest, queuedDigest, offlineReaderDigest, finalWriterDigest, finalReaderDigest },
      outage: { method: 'client-only-tcp-gate', before: beforeOutage, after: transferBefore, probeFinished: offlineNetwork, failedProbe, healthyReaderSync: true, restoration: timing },
      restart, resources: usage.metadata, resourceMetrics: usage.metrics,
      outcomeCounters: { rejected: finalWriter.rejected, conflicts: finalWriter.conflicts }, nativeState: finalWriter.nativeState ?? null,
      transfer: { scope: 'writer TCP payload including HTTP headers; excludes reader traffic and TCP/IP framing', requestBytes: transferAfter.requestBytes - transferBefore.requestBytes, responseBytes: transferAfter.responseBytes - transferBefore.responseBytes },
    };
    return { scale, metrics: { ...Object.fromEntries(Object.entries(usage.metrics).map(([key, value]) => [`queue_${count}_${key}`, value])),
      [`queue_${count}_local_commit_ms`]: localQueueCommitMs, [`queue_${count}_drain_ms`]: queueDrainMs, [`queue_${count}_mirror_visible_ms`]: mirrorVisibleMs,
      ...(restart ? { [`queue_${count}_reopen_local_ms`]: Number(restart.reopenLocalMs) } : {}) }, diagnostics: writer.diagnostics };
  } catch (error) {
    if (timing && blockedAt !== undefined) timing.timeline = gate.timeline(blockedAt);
    evidence.failureTraffic = gate.snapshot();
    if (sampling) {
      try { const usage = await resources.stop(); evidence.resources = usage.metadata; evidence.resourceMetrics = usage.metrics; }
      catch (samplingError) { evidence.samplingError = String(samplingError); }
    }
    if (error instanceof Error) {
      const cause = (error as Error & { evidence?: JsonObject }).evidence;
      if (cause) evidence.failure = cause;
      Object.assign(error, { evidence });
    }
    throw error;
  } finally {
    resources.abort();
    // Stop processes before removing their stores, including when validation fails.
    await Promise.allSettled([writer?.kill(), reader?.kill()]);
    await gate.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runRecovery(stackId: StackId, scenario: RecoveryCase) {
  await ensureStackUp(stackId);
  const scales = [];
  const metrics: Record<string, number | null> = {};
  let diagnostics: JsonObject = {};
  for (const count of recoverySizes(scenario)) {
    try {
      const measured = await measureScale(stackId, scenario, count);
      scales.push(measured.scale); Object.assign(metrics, measured.metrics); diagnostics = measured.diagnostics;
    } catch (error) {
      if (error instanceof Error) Object.assign(error, { evidence: { completedScales: scales, metrics, failedScale: (error as Error & { evidence?: JsonObject }).evidence ?? null } });
      throw error;
    }
  }
  return { status: 'completed' as const, metrics, notes: [
    'The writer TCP gate drops existing connections and refuses new ones. The service and independent reader remain online. A blocked sync probe and unchanged reader data are required before reconnect.',
    'Restoration follows a predeclared absolute deadline from gate blocking. All offline checks must finish first; missed deadlines invalidate the attempt. Adapter-native probes remain explicit and do not determine restoration time. TCP event times use the controller clock and are not SDK state events.',
    'Queue drain and second-client visibility are timestamped independently from network restoration using the parent clock, including worker IPC receipt. All 2,000 records are validated before and after replay.',
    ...(stackId === 'electric' ? ['Electric recovery is an application reference implementation: a benchmark-owned SQLite cache and outbox, idempotent HTTP uploads and native Shape delivery. Persisted recovery establishes this application’s behavior, not a native Electric queue.'] : []),
    ...(stackId === 'electric-tanstack' && scenario === 'offline-restart' ? ['TanStack uses its native offline transaction executor with a durable SQLite StorageAdapter. Local acknowledgment requires the serialized queue to be committed with synchronous FULL; after SIGKILL, the SDK restores optimistic edits and retries uploads from that queue. The storage adapter is application-owned.'] : []),
    ...(stackId === 'electric-tanstack' && scenario !== 'offline-restart' ? ['TanStack uses its native offline transaction executor and serialized IndexedDB outbox. The Node fake-indexeddb queue is in memory, separately from the SQLite confirmed-data cache. No process-durability claim is made for pending writes. Native retry requests traverse the same gated application route as shape delivery.'] : []),
    ...(stackId === 'zero' ? ['Zero uses a live memory-backed client and its native mutation.client/server promises. Pending counts cover only this trial’s issued mutations; the aggregate native queue counter is unavailable. The SDK owns reconnect and replay. This profile makes no process-durability claim.'] : []),
    ...(stackId === 'jazz-v2' ? ['Jazz reports pending application rows by comparing native local and deferred edge-durable views; the aggregate native queue count remains unavailable. Reopen receives only the original store/configuration. Complete local and edge snapshots are validated before and after reconnect, with independent reader convergence. Historical batch receipts are not used as a completion signal. The backend-secret profile remains experimental and makes no end-user authorization claim.'] : []),
    'Resource samples cover the complete outage from before blocking through queue construction, offline validation, the declared wait, replay and crash recovery where applicable. Initial client/fixture setup is excluded. Scales use fresh clients and stores; campaign trials are independent repetitions.',
  ], metadata: { implementation: `${stackId}-${RECOVERY_CONTRACT}`, workloadContract: RECOVERY_CONTRACT, fixture: recoverySeed, scales, diagnostics,
    resources: { method: 'external-ps-process-tree-v1', scope: 'controller, writer, reader and descendants from before outage through recovery; detailed windows and samples per scale' },
    outagePolicy: configuredRecoveryPolicy(), guarantees: recoveryGuarantees(stackId, scenario) } };
}
