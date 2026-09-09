import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACCESS_CONTRACT, ACCESS_REFRESH_CONTRACT, accessRefreshProfile, powerSyncAccessProfile, zeroAccessProfile, zeroCacheEvidence, accessModes, accessProfile, accessProjects, accessSeed, validateAccessState, type AccessMode } from '../contracts/access.ts';
import { ContractError } from '../contracts/screens.ts';
import { ExternalResources } from '../resources.ts';
import { RecoveryProcess } from '../recovery/process.ts';
import { ClientNetworkGate } from '../recovery/network-gate.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { restartStartupServer, serverState } from '../startup/server.ts';
import { getStack } from '../stacks.ts';
import { tempRoot } from '../paths.ts';
import type { JsonObject, StackId } from '../types.ts';

async function measureAccess(stackId: StackId, mode: AccessMode) {
  await seedStack(stackId, accessSeed); await restartStartupServer(stackId);
  const stack = getStack(stackId), processes: RecoveryProcess[] = [];
  await mkdir(tempRoot, { recursive: true }); const dir = await mkdtemp(join(tempRoot, 'access-'));
  const refresh = ['electric', 'electric-tanstack'].includes(stackId);
  const powerSync = stackId === 'powersync';
  const zero = stackId === 'zero';
  const endpoints: Record<string, string> = { sync: stack.syncBaseUrl };
  if (refresh || powerSync) endpoints.app = stack.appBaseUrl!;
  const gate = new ClientNetworkGate(endpoints), resources = new ExternalResources(false);
  const evidence: JsonObject = { mode, stage: 'setup', clients: [] };
  const open = async (name: string, actorId: string, gated: boolean, retainedOnly = false) => {
    const client = new RecoveryProcess(refresh || powerSync || zero ? 'node' : 'bun'); processes.push(client);
    const config = { stackId, actorId, accessRefresh: refresh, accessNative: powerSync || zero, appBaseUrl: refresh || powerSync ? (gated ? gate.url('app') : stack.appBaseUrl) : undefined, clientId: randomUUID(), projectId: accessProjects[0], projectIds: accessProjects, dbPath: join(dir, `${name}.sqlite`), syncBaseUrl: gated ? gate.url('sync')! : stack.syncBaseUrl };
    (evidence.clients as JsonObject[]).push({ pid: client.pid, store: config.dbPath, clientId: config.clientId, actorId, requestedProjects: accessProjects });
    await client.open(config); await client.sync();
    if (powerSync || zero) {
      const deadline = performance.now() + 60_000;
      while (true) {
        const state = await client.read();
        try { validateAccessState(`${name} readiness`, state, retainedOnly); break; }
        catch (error) { if (!(error instanceof ContractError)) throw error; if (performance.now() >= deadline) throw new Error(`${stackId} access readiness timed out: ${error.message}`); }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    return client;
  };
  try {
    await gate.start();
    const affected = await open('affected', accessProfile.actor, true);
    const initialState = await affected.read();
    evidence.initialDigest = validateAccessState('initial affected client', initialState);
    if (refresh) evidence.initialCache = initialState.nativeState?.accessCache ?? null;
    if (zero) evidence.initialCache = zeroCacheEvidence(initialState);
    if (powerSync) evidence.initialReplica = initialState.nativeState?.accessReplica ?? null;
    evidence.serverBefore = serverState(stackId);
    if (mode === 'offline-reconnect') {
      gate.block(); const before = gate.snapshot();
      for (const route of Object.keys(endpoints)) try { await fetch(gate.url(route)!, { signal: AbortSignal.timeout(2_000) }); } catch { /* The route probe must be refused. */ }
      evidence.outage = { before, after: gate.snapshot() };
    } else await resources.start();
    evidence.stage = 'revoke';
    const revokedAt = performance.now();
    const response = await fetch(`${stack.adminBaseUrl}/admin/revoke-membership`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actorId: accessProfile.actor, projectId: accessProjects[0] }), signal: AbortSignal.timeout(30_000) });
    const receipt = await response.json() as { ok?: boolean; deletedCount?: number };
    evidence.revokeRequestMs = performance.now() - revokedAt;
    evidence.revoke = { actorId: accessProfile.actor, projectId: accessProjects[0], ok: receipt.ok === true, deletedCount: receipt.deletedCount ?? null };
    if (!response.ok || receipt.ok !== true || receipt.deletedCount !== 1) throw new ContractError('Revoke must remove exactly the declared membership');
    let started = revokedAt;
    if (mode === 'offline-reconnect') {
      const offlineState = await affected.read();
      evidence.offlineDigest = validateAccessState('offline client after revoke', offlineState);
      if (zero) evidence.offlineCache = zeroCacheEvidence(offlineState);
      (evidence.outage as JsonObject).after = gate.snapshot();
      await resources.start(); started = performance.now(); gate.restore();
    }
    evidence.stage = refresh ? 'application-refresh' : 'same-client-purge';
    const trafficBefore = gate.snapshot();
    const deadline = performance.now() + 60_000;
    let state;
    do {
      await affected.sync(); state = await affected.read();
      const viewCount = zero ? ((state.nativeState?.accessCache as JsonObject)?.viewRows as unknown[] | undefined)?.length : state.rows.length;
      if (state.rows.length === accessSeed.tasksPerProject && viewCount === accessSeed.tasksPerProject) break;
      if (performance.now() > deadline) {
        if (zero) evidence.lastCache = zeroCacheEvidence(state);
        throw new Error('Access revocation purge timed out');
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (true);
    evidence.convergenceMs = performance.now() - started;
    const usage = await resources.stop(); evidence.resources = usage.metadata;
    evidence.traffic = { before: trafficBefore, after: gate.snapshot() };
    if (zero) evidence.finalCache = zeroCacheEvidence(state);
    evidence.finalDigest = validateAccessState('same client after purge', state, true);
    if (refresh) evidence.finalCache = state.nativeState?.accessCache ?? null;
    if (powerSync) evidence.finalReplica = state.nativeState?.accessReplica ?? null;
    evidence.purgedClientPid = affected.pid;
    await affected.close();
    evidence.stage = 'fresh-client-validation';
    const fresh = await open('fresh-actor', accessProfile.actor, false, true);
    const freshState = await fresh.read();
    evidence.freshActorDigest = validateAccessState('fresh revoked actor', freshState, true);
    if (zero) evidence.freshActorCache = zeroCacheEvidence(freshState);
    await fresh.close();
    const witness = await open('unaffected-actor', accessProfile.unaffectedActor, false);
    const witnessState = await witness.read();
    evidence.unaffectedActorDigest = validateAccessState('fresh unaffected actor', witnessState);
    if (zero) evidence.unaffectedActorCache = zeroCacheEvidence(witnessState);
    await witness.close();
    evidence.serverAfter = serverState(stackId);
    const key = mode.replaceAll('-', '_');
    return { case: { ...evidence, status: 'completed' }, metrics: { [`${key}_revoke_request_ms`]: Number(evidence.revokeRequestMs), [`${key}_convergence_ms`]: Number(evidence.convergenceMs), ...Object.fromEntries(Object.entries(usage.metrics).map(([name, value]) => [`${key}_${name}`, value])) } };
  } catch (error) { if (error instanceof Error) Object.assign(error, { evidence }); throw error; }
  finally { resources.abort(); await Promise.allSettled(processes.map(client => client.kill())); await gate.close(); await rm(dir, { recursive: true, force: true }); }
}
export async function runAccess(stackId: StackId) {
  await ensureStackUp(stackId);
  if (stackId === 'syncular-rust') await (await import('../adapters/syncular-rust.ts')).ensureBenchBinary();
  const refresh = ['electric', 'electric-tanstack'].includes(stackId);
  const contract = refresh ? ACCESS_REFRESH_CONTRACT : ACCESS_CONTRACT;
  const profile = refresh ? accessRefreshProfile(stackId === 'electric-tanstack' ? 'sqlite' : 'memory') : stackId === 'powersync' ? powerSyncAccessProfile : stackId === 'zero' ? zeroAccessProfile : accessProfile;
  const cases: JsonObject[] = [], metrics: Record<string, number | null> = {}, notes: string[] = [];
  for (const mode of accessModes) {
    try { const result = await measureAccess(stackId, mode); cases.push(result.case); Object.assign(metrics, result.metrics); }
    catch (error) { const reason = error instanceof Error ? error.message : String(error); cases.push({ mode, status: error instanceof ContractError ? 'invalid' : /timed out|timeout/i.test(reason) ? 'timed-out' : 'failed', reason, evidence: error instanceof Error && 'evidence' in error ? error.evidence as JsonObject : null }); notes.push(`${mode}: ${reason}`); }
  }
  return { status: cases.every(c => c.status === 'completed') ? 'completed' as const : cases.some(c => c.status === 'invalid') ? 'invalid' as const : cases.some(c => c.status === 'timed-out') ? 'timed-out' as const : 'failed' as const, metrics,
    notes: [...notes, ...(refresh ? ['This is an application cache replacement profile. It disposes the old snapshot, removes old SQLite cache files when present, and bootstraps a newly authorized snapshot. It does not establish native purge in an existing replica.'] : []), 'Two 500-task projects are materialized in the declared client cache. Revocation deletes one actor membership; the same client invokes its declared sync or refresh strategy and must remove exactly that project while preserving every retained row. Authorization of the replacement rows is checked independently on fresh clients.',
      'Online timing starts before the admin revoke request and includes its acknowledgment. Offline recovery timing starts at route restoration, after the server revoke and proof that all original rows remain cached offline. Both include the declared sync/refresh operation, full snapshot observation and IPC; exact validation follows outside timing.',
      'Fresh clients request both projects: the revoked actor must receive only the retained project, while an unaffected actor still receives both. The service process remains healthy and unchanged. Client resources exclude controller, sampler and the later fresh-client checks.',
      'An offline client cannot receive a revocation until reconnect. Removing rows from the tested product store does not establish erasure of data copied elsewhere.'],
    metadata: { implementation: `${stackId}-${contract}`, workloadContract: contract, fixture: accessSeed, accessProfile: profile, cases,
      diagnostics: { localStorage: refresh ? (stackId === 'electric-tanstack' ? 'tanstack-node-sqlite-cache' : 'electric-shape-memory') : stackId === 'zero' ? 'zero-memory' : `${stackId}-persistent-file`, authorization: 'server membership-derived per-project scopes', refresh: refresh ? 'application cache replacement' : stackId === 'powersync' ? 'native continuous sync and SDK reconnect retries; same SQLite file identity checked' : stackId === 'zero' ? 'native query invalidation and SDK reconnect; raw cache checked' : 'explicit native sync' },
      resources: { method: 'external-ps-process-tree-v1', includeRoot: false, scope: 'affected client; raw samples per mode' } } };
}
