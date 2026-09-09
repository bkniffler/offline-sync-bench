import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError, fixtureTasks } from '../contracts/screens.ts';
import { recoverySeed } from '../contracts/recovery.ts';
import { CONFLICT_CONTRACT, conflictTarget, conflictPolicy, conflictRows, conflictFinalRows, assertConflictRows, assertConflictOutcome, offlineTitle, peerTitle, type ConflictCase } from '../contracts/conflicts.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import { tempRoot } from '../paths.ts';
import { ExternalResources } from '../resources.ts';
import { ClientNetworkGate } from './network-gate.ts';
import { RecoveryProcess } from './process.ts';
import { awaitRecoveryReady } from './ready.ts';
import { restartStartupServer, serverState } from '../startup/server.ts';
import type { JsonObject, StackId } from '../types.ts';

export async function runConflicts(stackId: StackId, scenario: ConflictCase) {
  const policy = conflictPolicy(stackId, scenario);
  await ensureStackUp(stackId);
  if (stackId !== 'jazz-v2') await seedStack(stackId, recoverySeed);
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, 'conflicts-'));
  const stack = getStack(stackId), endpoints: Record<string, string> = { sync: stack.syncBaseUrl };
  if (stack.appBaseUrl) endpoints.app = stack.appBaseUrl;
  const gate = new ClientNetworkGate(endpoints), resources = new ExternalResources();
  const clients: RecoveryProcess[] = [];
  const evidence: JsonObject = { stage: 'setup', policy: { ...policy } };
  const records: JsonObject[] = [];
  let resourcesStarted = false;
  let datasetId: string | undefined;
  try {
    if (stackId === 'jazz-v2') { evidence.seeding = (await import('../startup/jazz-seed.ts')).seedJazzStartup(2_000, dir); datasetId = String((evidence.seeding as JsonObject).datasetId); }
    evidence.serverPreparation = await restartStartupServer(stackId);
    await gate.start();
    for (const name of ['writer', 'peer', 'observer'] as const) {
      const client = new RecoveryProcess(['powersync', 'jazz-v2', 'electric-tanstack'].includes(stackId) ? 'node' : 'bun'); clients.push(client);
      const config = { stackId, conflicts: true, conflictRole: name, ...(['zero', 'jazz-v2', 'electric', 'electric-tanstack'].includes(stackId) ? { recovery: true } : {}), ...(datasetId ? { datasetId } : {}), clientId: randomUUID(), actorId: name === 'peer' ? 'org-1-user-2' : 'org-1-user-1', projectId: 'org-1-project-1', dbPath: join(dir, `${name}.sqlite`),
        syncBaseUrl: name === 'writer' ? gate.url('sync')! : stack.syncBaseUrl, appBaseUrl: name === 'writer' ? gate.url('app') : stack.appBaseUrl };
      await client.open(config);
      records.push({ role: name, pid: client.pid, clientId: config.clientId, store: stackId === 'zero' ? config.clientId : config.dbPath, diagnostics: client.diagnostics });
    }
    const [writer, peer, observer] = clients;
    const initialStates = await Promise.all(clients.map(client => awaitRecoveryReady(client, 'initial conflict replica')));
    const initial = fixtureTasks(recoverySeed);
    const validation: JsonObject = { initialTaskCount: 2_000 };
    evidence.validation = validation; evidence.clients = records;
    for (const [i, name] of ['initialWriter', 'initialPeer', 'initialObserver'].entries()) {
      const state = initialStates[i].state; records[i].initialNative = state.nativeState ?? null;
      if (state.pending !== 0 || (state.conflicts !== null && state.conflicts !== 0) || (state.rejected !== null && state.rejected !== 0)) throw new ContractError(`${name} is not a clean replica`);
      validation[name] = assertConflictRows(name, state, initial);
    }
    gate.block(); const before = gate.snapshot();
    evidence.stage = 'queued-write';
    await writer.write([{ id: conflictTarget, title: offlineTitle, checkVersion: true }]);
    let probeError: string | null = null;
    try { await writer.call('probeSync'); } catch (error) { probeError = String(error); }
    let after = gate.snapshot();
    evidence.outage = { method: 'client-only-tcp-gate', before, after, probeError };
    if (after.rejectedConnections <= before.rejectedConnections || after.requestBytes !== before.requestBytes || after.forwardedConnections !== before.forwardedConnections) throw new ContractError('Writer was not isolated during conflicting edits');
    const queued = await writer.read();
    if (queued.pending !== 1 || (queued.conflicts !== null && queued.conflicts !== 0) || (queued.rejected !== null && queued.rejected !== 0)) throw new ContractError('Conflicting write was not queued locally');
    validation.queuedWriter = assertConflictRows('queued writer', queued, conflictRows(offlineTitle, policy.localVersion ?? 2));
    evidence.nativeQueued = queued.nativeState ?? null;
    evidence.pendingBefore = queued.pending;
    evidence.stage = 'peer-write';
    if (scenario === 'conflict-update-delete') await peer.remove(conflictTarget);
    else await peer.write([{ id: conflictTarget, title: peerTitle, checkVersion: true }]);
    await peer.sync();
    const peerExpected = scenario === 'conflict-update-delete' ? null : peerTitle;
    // Third-client observation proves server delivery, not merely B's optimistic view.
    await observer.observe([{ id: conflictTarget, title: peerExpected, ...(peerExpected ? { serverVersion: policy.peerVersion ?? 2 } : {}) }]);
    const accepted = await observer.read(), isolated = await writer.read();
    validation.acceptedPeer = assertConflictRows('accepted peer operation', accepted, conflictRows(peerExpected, policy.peerVersion ?? 2));
    validation.isolatedWriter = assertConflictRows('still-isolated writer', isolated, conflictRows(offlineTitle, policy.localVersion ?? 2));
    evidence.nativeAcceptedPeer = accepted.nativeState ?? null; evidence.nativeIsolated = isolated.nativeState ?? null;
    after = gate.snapshot(); (evidence.outage as JsonObject).after = after;
    if (!after.blocked || after.requestBytes !== before.requestBytes || after.responseBytes !== before.responseBytes || after.forwardedConnections !== before.forwardedConnections) throw new ContractError('Conflict writer exchanged data before peer acceptance');
    evidence.peerAcceptedBeforeReconnect = true;
    evidence.stage = 'resolution';
    evidence.serverBefore = serverState(stackId);
    await resources.start(); resourcesStarted = true;
    const started = performance.now(); gate.restore();
    await writer.sync();
    const writerSettledMs = performance.now() - started;
    const outcome = await writer.read();
    evidence.writerOutcome = { pending: outcome.pending, conflicts: outcome.conflicts, rejected: outcome.rejected, nativeState: outcome.nativeState ?? null };
    assertConflictOutcome(outcome, policy);
    const title = policy.winner === 'deleted' ? null : policy.winner === 'peer' ? peerTitle : offlineTitle;
    await Promise.all(clients.map(client => client.observe([{ id: conflictTarget, title, ...(policy.finalVersion !== null ? { serverVersion: policy.finalVersion } : {}) }])));
    const allClientsConvergedMs = performance.now() - started;
    resourcesStarted = false; const usage = await resources.stop(); evidence.resources = usage.metadata;
    evidence.serverAfter = serverState(stackId);
    evidence.stage = 'final-validation';
    const expected = conflictFinalRows(policy);
    for (const [i, name] of ['finalWriter', 'finalPeer', 'finalObserver'].entries()) {
      const state = await clients[i].read();
      records[i].finalNative = state.nativeState ?? null;
      if (state.pending !== 0) throw new ContractError(`${name} still has queued writes`);
      if (i !== 0 && ((state.conflicts !== null && state.conflicts !== 0) || (state.rejected !== null && state.rejected !== 0))) throw new ContractError(`${name} has unexpected native failures`);
      validation[name] = assertConflictRows(name, state, expected);
    }
    validation.finalTaskCount = expected.length;
    return { status: 'completed' as const, metrics: { ...usage.metrics, writer_settled_ms: writerSettledMs, all_clients_converged_ms: allClientsConvergedMs },
      notes: ['A queues a stale edit behind a client-only TCP outage. B changes or deletes the same task; a third client must observe B before A reconnects.',
        'The declared policy determines the expected winner, native disposition and application version. Every remaining task is checked on all three clients. An empty queue alone cannot establish correctness.',
        'Resolution time includes native disposition followed by all three client observations and controller IPC. Conflict policies are separate comparison profiles; PowerSync policy belongs to this application backend.'],
      metadata: { ...evidence, clients: records, clientStorage: stackId === 'zero' ? 'memory; native Zero mutation queue, no process durability' : stackId === 'electric' ? 'benchmark-owned persistent SQLite cache and outbox' : stackId === 'electric-tanstack' ? 'product persistent SQLite cache; native fake-indexeddb-memory queue, no process durability' : 'product persistent store and queue', implementation: `${stackId}-${CONFLICT_CONTRACT}`, workloadContract: CONFLICT_CONTRACT, fixture: recoverySeed, policy: { ...policy }, pendingBefore: queued.pending,
        peerAcceptedBeforeReconnect: true, outage: { method: 'client-only-tcp-gate', before, after, probeError }, validation, writerOutcome: evidence.writerOutcome,
        diagnostics: writer.diagnostics, resources: usage.metadata } };
  } catch (error) {
    evidence.clients = records;
    // Preserve final views and native dispositions even when convergence fails.
    const snapshots = await Promise.allSettled(clients.map(client => client.read()));
    evidence.failureSnapshots = snapshots.map((s, i) => s.status === 'fulfilled' ? { role: records[i]?.role ?? String(i), state: s.value } : { role: records[i]?.role ?? String(i), error: String(s.reason) }) as unknown as JsonObject[];
    if (resourcesStarted) try { evidence.resources = (await resources.stop()).metadata; } catch {}
    if (error instanceof Error) { if ('evidence' in error) evidence.failure = error.evidence as JsonObject; Object.assign(error, { evidence }); } throw error;
  }
  finally { resources.abort(); await Promise.allSettled(clients.map(client => client.kill())); await gate.close(); await rm(dir, { recursive: true, force: true }); }
}
