import { assertRows, ContractError, fixtureTasks, hash, taskRecord } from './screens.ts';
import { validateOutage } from './outage.ts';
import type { RecoveryState } from '../recovery/protocol.ts';
import type { BenchmarkResult, JsonObject, SeedOptions } from '../types.ts';

export const ACCESS_CONTRACT = 'access-revocation-v1';
export const ACCESS_REFRESH_CONTRACT = 'access-refresh-v1';
export const accessSeed: Required<SeedOptions> = { resetFirst: true, orgCount: 1, projectsPerOrg: 2, usersPerOrg: 2, tasksPerProject: 500, membershipsPerProject: 2 };
export const accessProjects = ['org-1-project-1', 'org-1-project-2'];
export const accessModes = ['online', 'offline-reconnect'] as const;
export type AccessMode = typeof accessModes[number];
export const accessProfile = { modes: [...accessModes], actor: 'org-1-user-1', unaffectedActor: 'org-1-user-2', requestedProjects: accessProjects,
  revokedProject: accessProjects[0], retainedProject: accessProjects[1], strategy: 'native scope purge in the same client and product store; explicit native sync after acknowledgment or route restoration',
  completion: 'full retained dataset observed; exact row validation after timing',
  offline: 'all affected-client routes blocked through server revoke and local snapshot check',
  freshClients: 'same actor sees retained project only; unaffected actor still sees both',
  resources: 'affected client process and descendants; controller and sampler excluded',
};
export const accessRefreshProfile = (kind: 'memory' | 'sqlite') => ({ ...accessProfile,
  strategy: 'application disposes prior scoped cache and bootstraps a replacement in the same process; no native-purge claim',
  cacheKind: kind, persistence: kind === 'sqlite' ? 'old cache files removed; replacement persisted rows checked' : 'memory snapshot; no process durability claim',
});
export const powerSyncAccessProfile = { ...accessProfile, nativeEngine: 'powersync',
  strategy: 'continuous native sync removes revoked membership buckets from the same SQLite file; SDK reconnect retries after route restoration',
  authorization: 'signed JWT subject and access-only grant; source project_memberships determines eligible buckets',
  requestedScope: 'all projects authorized for the actor, including both original fixture projects',
  identity: 'benchmark token issuer supplies the declared actor; login and adversarial credential issuance are outside this workload',
};
export const zeroAccessProfile = { ...accessProfile, nativeEngine: 'zero',
  strategy: 'continuous native membership-query invalidation in the same memory client; SDK transport owns reconnect',
  cache: 'native raw task cache and active materialized view; no application deletion or replacement',
  persistence: 'memory only; no process durability claim',
  authorization: 'verified JWT subject and access-only grant; native whereExists over project_memberships',
  requestedScope: 'all projects authorized for the actor, including both original fixture projects',
  identity: 'benchmark signing key supplies the declared actor; production identity issuance is outside this workload',
};
export const jazzAccessProfile = { ...accessProfile, nativeEngine: 'jazz-v2',
  strategy: 'continuous native task and membership subscriptions in the same SQLite runtime; native transport owns reconnect after gate restoration',
  cache: 'unscoped local-only native task query, session-scoped local query and maintained subscription; no application deletion or replacement',
  authorization: 'native local-first token identifies the actor; deployed membership policy correlates dataset and project with the authenticated native subject',
  identity: 'public deterministic benchmark seeds map canonical actors to native subjects within each isolated dataset; no production identity issuance claim',
  persistence: 'same native SQLite path, device and inode; task records checked, no forensic-erasure claim',
  resources: 'affected client process and descendants sampled directly; administrative client, controller and sampler excluded',
  failure: '60-second purge deadline; retain raw and visible state, then independently check both fresh actors and unchanged server task data',
};
export const accessRows = (retainedOnly = false) => fixtureTasks(accessSeed).filter(row => !retainedOnly || row.project_id === accessProjects[1]);
export function validateAccessState(label: string, state: RecoveryState, retainedOnly = false) {
  if (state.pending !== 0 || state.rejected !== null && state.rejected !== 0 || state.conflicts !== null && state.conflicts !== 0) throw new ContractError(`${label}: unexpected pending writes, rejections or conflicts`);
  return assertRows(label, state.rows.map(taskRecord), accessRows(retainedOnly));
}
export function zeroCacheEvidence(state: RecoveryState): JsonObject {
  return { ...state.nativeState?.accessCache as JsonObject, cachedRows: JSON.parse(JSON.stringify(state.rows)) };
}
export const jazzCacheEvidence = zeroCacheEvidence;
export function validateJazzAccessCache(cache: JsonObject, client: JsonObject, retained = false) {
  if(cache?.kind!=='jazz-node-sqlite'||cache.rowSource!=='NapiRuntime.query without session; local-only propagation'||cache.store!==client.store||cache.clientId!==client.clientId||cache.actorId!==client.actorId||cache.nativeActorId!==client.nativeActorId||cache.datasetId!==client.datasetId||typeof cache.nativeActorId!=='string'||!cache.nativeActorId||typeof cache.datasetId!=='string'||!cache.datasetId.startsWith('access-')||cache.loadedPolicyBundle!==true||cache.subscriptions!==2||!Number.isSafeInteger(cache.device)||!Number.isSafeInteger(cache.inode)||Number(cache.inode)<1||!Array.isArray(cache.errors)||cache.errors.length)throw new ContractError('Jazz native access identity/policy evidence missing');
  for(const key of ['cachedRows','viewRows','subscriptionRows']) {
    if(!Array.isArray(cache[key]))throw new ContractError('Jazz raw and visible access records missing');
    assertRows(`Jazz ${key}`,(cache[key] as Record<string,unknown>[]).map(taskRecord),accessRows(retained));
  }
  const native=cache.nativeRows as Record<string,unknown>[];
  if(!Array.isArray(native)||new Set(native.map(r=>r.id)).size!==native.length||native.some(r=>typeof r.id!=='string'||!r.id||r.dataset_id!==cache.datasetId))throw new ContractError('Jazz native task identity missing');
  assertRows('Jazz native cache projection',native.map(r=>taskRecord({...r,id:r.external_id})),accessRows(retained));
}
export function validateJazzAccessServer(before: RecoveryState, after: RecoveryState, clients: JsonObject[]) {
  validateAccessState('Jazz server before revoke',before);validateAccessState('Jazz server after revoke',after);
  const original=before.nativeState?.memberships as JsonObject[],remaining=after.nativeState?.memberships as JsonObject[];
  const actor=clients[0],unaffected=clients[2];
  if(!actor||!unaffected||!Array.isArray(original)||!Array.isArray(remaining)||original.length!==4||remaining.length!==3||new Set(original.map(m=>m.id)).size!==4)throw new ContractError('Jazz server membership evidence missing');
  for(const identity of [actor,unaffected])for(const project of accessProjects)if(original.filter(m=>m.dataset_id===identity.datasetId&&m.project_id===project&&m.user_id===identity.nativeActorId).length!==1)throw new ContractError('Jazz server membership actor mapping differs');
  const removed=original.find(m=>m.user_id===actor.nativeActorId&&m.project_id===accessProjects[0])!;
  if(hash([...remaining].sort((a,b)=>String(a.id).localeCompare(String(b.id))))!==hash(original.filter(m=>m.id!==removed.id).sort((a,b)=>String(a.id).localeCompare(String(b.id)))))throw new ContractError('Jazz server changed unrelated memberships');
  const receipts=after.nativeState?.receipts as JsonObject[];
  if(!Array.isArray(receipts)||receipts.length!==2||receipts[0].operation!=='seed'||receipts[0].edge!=='success'||receipts[1].operation!=='revoke'||receipts[1].edge!=='success'||receipts[1].nativeMembershipId!==removed.id||receipts[1].deletedCount!==1||!receipts[1].batchId)throw new ContractError('Jazz native edge revocation receipt missing');
}
function validateZeroCache(cache: JsonObject, expectedDigest: string, client: JsonObject) {
  if (cache?.kind !== 'zero-memory' || cache.rowSource !== 'Zero.inspector.client.rows(tasks)' || cache.kvStore !== 'mem' || cache.store !== client.store || cache.storageKey !== client.clientId || typeof cache.nativeClientId !== 'string' || !cache.nativeClientId || cache.queryState !== 'complete' || !Array.isArray(cache.cachedRows) || !Array.isArray(cache.viewRows)) throw new ContractError('Zero native cache identity/evidence missing');
  const retained = expectedDigest === assertRows('retained', accessRows(true), accessRows(true));
  for (const name of ['cachedRows', 'viewRows']) {
    const rows = (cache[name] as Record<string, unknown>[]).map(taskRecord);
    if (assertRows(`Zero ${name}`, rows, accessRows(retained)) !== expectedDigest) throw new ContractError('Zero native cache digest differs');
  }
}
export function validateAccessResult(result: Pick<BenchmarkResult, 'scenarioId' | 'metadata' | 'metrics'> & Partial<Pick<BenchmarkResult, 'stackId'>>) {
  const { metadata, metrics } = result;
  const refresh = metadata.workloadContract === ACCESS_REFRESH_CONTRACT;
  const kind = (metadata.accessProfile as JsonObject)?.cacheKind;
  const powerSync = result.stackId === 'powersync';
  if ((metadata.accessProfile as JsonObject)?.nativeEngine === 'powersync' && !powerSync || powerSync && refresh) throw new ContractError('PowerSync access profile requires its native adapter');
  const zero = result.stackId === 'zero';
  if ((metadata.accessProfile as JsonObject)?.nativeEngine === 'zero' && !zero || zero && refresh) throw new ContractError('Zero access profile requires its native adapter');
  const jazz = result.stackId === 'jazz-v2';
  if ((metadata.accessProfile as JsonObject)?.nativeEngine === 'jazz-v2' && !jazz || jazz && refresh) throw new ContractError('Jazz access profile requires its native adapter');
  const profile = refresh ? accessRefreshProfile(kind as 'memory' | 'sqlite') : powerSync ? powerSyncAccessProfile : zero ? zeroAccessProfile : jazz ? jazzAccessProfile : accessProfile;
  if (refresh && !['memory', 'sqlite'].includes(String(kind))) throw new ContractError('Access refresh cache kind missing');
  if (result.scenarioId !== 'permission-change' || (!refresh && metadata.workloadContract !== ACCESS_CONTRACT) || hash(metadata.fixture) !== hash(accessSeed) || hash(metadata.accessProfile) !== hash(profile)) throw new ContractError('Access revocation contract/profile mismatch');
  const digest = (retained: boolean) => { const rows = accessRows(retained); return assertRows('expected access rows', rows, rows); };
  const initial = digest(false), final = digest(true), cases = metadata.cases as JsonObject[];
  if (!Array.isArray(cases) || cases.length !== accessModes.length) throw new ContractError('Access revocation cases missing');
  for (const [i, item] of cases.entries()) {
    if (item.mode !== accessModes[i] || item.status !== 'completed' || item.initialDigest !== initial || item.finalDigest !== final || item.freshActorDigest !== final || item.unaffectedActorDigest !== initial) throw new ContractError('Access revocation data proof missing');
    const clients = item.clients as JsonObject[];
    if (!Array.isArray(clients) || clients.length !== 3 || new Set(clients.map(c => c.pid)).size !== 3 || new Set(clients.map(c => c.store)).size !== 3 || new Set(clients.map(c => c.clientId)).size !== 3 || clients.some(c => !Number.isSafeInteger(c.pid) || Number(c.pid) < 1 || typeof c.store !== 'string' || !c.store || typeof c.clientId !== 'string' || !c.clientId || hash(c.requestedProjects) !== hash(accessProjects)) || clients[0].actorId !== accessProfile.actor || clients[1].actorId !== accessProfile.actor || clients[2].actorId !== accessProfile.unaffectedActor || item.purgedClientPid !== clients[0].pid) throw new ContractError('Access revocation requires same-client purge and distinct fresh verification clients');
    if (refresh) {
      const initialCache = item.initialCache as JsonObject, finalCache = item.finalCache as JsonObject;
      if (initialCache?.generation !== 1 || !Number.isSafeInteger(finalCache?.generation) || Number(finalCache?.generation) < 2 || finalCache.previousCacheDisposed !== true || initialCache.kind !== kind || finalCache.kind !== kind || !initialCache.store || initialCache.store !== finalCache.store) throw new ContractError('Application cache replacement proof missing');
      if (kind === 'sqlite' && (finalCache.previousFileRemoved !== true || initialCache.persistedDigest !== initial || finalCache.persistedDigest !== final)) throw new ContractError('Application cache file disposal or persisted dataset proof missing');
    }
    if (powerSync) {
      const before = item.initialReplica as JsonObject, after = item.finalReplica as JsonObject;
      if (before?.kind !== 'powersync-node-sqlite-file' || before.path !== clients[0].store || !Number.isSafeInteger(before.device) || Number(before.device) < 0 || !Number.isSafeInteger(before.inode) || Number(before.inode) < 1 || hash(before) !== hash(after)) throw new ContractError('PowerSync same-file native purge proof missing');
    }
    if (zero) {
      const before = item.initialCache as JsonObject, after = item.finalCache as JsonObject;
      validateZeroCache(before, initial, clients[0]); validateZeroCache(after, final, clients[0]);
      validateZeroCache(item.freshActorCache as JsonObject, final, clients[1]); validateZeroCache(item.unaffectedActorCache as JsonObject, initial, clients[2]);
      if (before.nativeClientId !== after.nativeClientId || new Set([before.nativeClientId, (item.freshActorCache as JsonObject).nativeClientId, (item.unaffectedActorCache as JsonObject).nativeClientId]).size !== 3) throw new ContractError('Zero native client replaced or reused');
      if (item.mode === 'offline-reconnect') { validateZeroCache(item.offlineCache as JsonObject, initial, clients[0]); if ((item.offlineCache as JsonObject).nativeClientId !== before.nativeClientId) throw new ContractError('Zero offline client changed'); }
    }
    if(jazz) {
      const before=item.initialCache as JsonObject,after=item.finalCache as JsonObject;
      validateJazzAccessCache(before,clients[0]);validateJazzAccessCache(after,clients[0],true);
      validateJazzAccessCache(item.freshActorCache as JsonObject,clients[1],true);validateJazzAccessCache(item.unaffectedActorCache as JsonObject,clients[2]);
      if(before.device!==after.device||before.inode!==after.inode||clients[0].nativeActorId!==clients[1].nativeActorId||clients[0].nativeActorId===clients[2].nativeActorId||new Set(clients.map(c=>c.datasetId)).size!==1)throw new ContractError('Jazz same-file or actor mapping differs');
      if(item.mode==='offline-reconnect'){const offline=item.offlineCache as JsonObject;validateJazzAccessCache(offline,clients[0]);if(before.device!==offline.device||before.inode!==offline.inode)throw new ContractError('Jazz offline store replaced');}
      if(!item.serverDataBefore||!item.serverDataAfter)throw new ContractError('Jazz server task preservation missing');
      validateJazzAccessServer(item.serverDataBefore as unknown as RecoveryState,item.serverDataAfter as unknown as RecoveryState,clients);
    }
    const revoke = item.revoke as JsonObject;
    if (revoke?.actorId !== accessProfile.actor || revoke.projectId !== accessProjects[0] || revoke.ok !== true || revoke.deletedCount !== 1) throw new ContractError('Membership revoke acknowledgment missing');
    const server = item.serverBefore as JsonObject;
    if (!server?.containerId || server.running !== true || server.health !== 'healthy' || !Number.isFinite(Date.parse(String(server.startedAt))) || hash(server) !== hash(item.serverAfter)) throw new ContractError('Access service changed or was unhealthy');
    const resource = item.resources as JsonObject;
    if (resource?.method !== 'external-ps-process-tree-v1' || (jazz ? resource.includeRoot !== true || resource.rootPid !== clients[0].pid : resource.includeRoot !== false) || !Array.isArray(resource.samples) || resource.samples.length < 2) throw new ContractError('Access client resource scope missing');
    const key = accessModes[i].replaceAll('-', '_');
    for (const [metric, field] of [['revoke_request_ms', 'revokeRequestMs'], ['convergence_ms', 'convergenceMs']] as const) if (typeof item[field] !== 'number' || !Number.isFinite(item[field]) || Number(item[field]) < 0 || metrics[`${key}_${metric}`] !== item[field]) throw new ContractError('Access milestones missing or inconsistent');
    if (item.mode === 'online' && Number(item.convergenceMs) < Number(item.revokeRequestMs)) throw new ContractError('Online purge precedes revoke acknowledgment');
    if (item.mode === 'offline-reconnect') {
      if (item.offlineDigest !== initial) throw new ContractError('Offline cache changed before reconnection');
      const outage = item.outage as JsonObject;
      validateOutage(outage?.before as JsonObject, outage?.after as JsonObject);
      if ((outage.after as JsonObject).responseBytes !== (outage.before as JsonObject).responseBytes) throw new ContractError('Offline client received revocation data');
    }
  }
}
