import { expect, test } from 'bun:test';
import { ACCESS_CONTRACT, ACCESS_REFRESH_CONTRACT, accessRefreshProfile, powerSyncAccessProfile, zeroAccessProfile, jazzAccessProfile, accessModes, accessProfile, accessProjects, accessRows, accessSeed, validateAccessResult, validateAccessState } from './access.ts';
import { assertRows } from './screens.ts';
import type { JsonObject } from '../types.ts';

const state = (retained = false) => ({ rows: accessRows(retained), pending: 0, rejected: 0, conflicts: 0 });
function fixture() {
  const digest = (retained: boolean) => assertRows('fixture', accessRows(retained), accessRows(retained));
  const initial = digest(false), final = digest(true);
  const server = { containerId: 'sync', startedAt: '2026-09-06T09:00:00Z', running: true, health: 'healthy' };
  const blocked = { blocked: true, rejectedConnections: 0, forwardedConnections: 2, requestBytes: 100, responseBytes: 200 };
  return { scenarioId: 'permission-change' as const, metrics: { online_revoke_request_ms: 10, online_convergence_ms: 20, offline_reconnect_revoke_request_ms: 10, offline_reconnect_convergence_ms: 20 }, metadata: {
    workloadContract: ACCESS_CONTRACT, fixture: accessSeed, accessProfile,
    cases: accessModes.map(mode => ({ mode, status: 'completed', initialDigest: initial, finalDigest: final, freshActorDigest: final, unaffectedActorDigest: initial, offlineDigest: initial,
      clients: [10, 11, 12].map((pid, i) => ({ pid, clientId: `client-${i}`, store: `store-${i}`, actorId: i === 2 ? accessProfile.unaffectedActor : accessProfile.actor, requestedProjects: accessProjects })), purgedClientPid: 10,
      revoke: { actorId: accessProfile.actor, projectId: accessProjects[0], ok: true, deletedCount: 1 }, revokeRequestMs: 10, convergenceMs: 20,
      serverBefore: server, serverAfter: server, resources: { method: 'external-ps-process-tree-v1', includeRoot: false, samples: [{}, {}] }, outage: { before: blocked, after: { ...blocked, rejectedConnections: 1 } },
    })),
  } };
}
test('access validates exact retained rows and rejects lost, substituted or locally rejected data', () => {
  expect(() => validateAccessState('initial', state())).not.toThrow();
  expect(() => validateAccessState('retained', state(true), true)).not.toThrow();
  const wrongProject = state(); wrongProject.rows = wrongProject.rows.slice(0, 500);
  expect(() => validateAccessState('wrong project', wrongProject, true)).toThrow('Invalid measurement');
  const corrupt = state(true); corrupt.rows[0] = { ...corrupt.rows[0], title: 'corrupted retained task' };
  expect(() => validateAccessState('corrupted', corrupt, true)).toThrow('Invalid measurement');
  expect(() => validateAccessState('pending', { ...state(true), pending: 1 }, true)).toThrow('pending');
});
test('access requires same-client purge, fresh authorization checks and a proven offline interval', () => {
  const good = fixture(); expect(() => validateAccessResult(good)).not.toThrow();
  for (const corrupt of [
    (c: JsonObject) => { c.purgedClientPid = 11; },
    (c: JsonObject) => { c.freshActorDigest = c.initialDigest; },
    (c: JsonObject) => { c.unaffectedActorDigest = c.finalDigest; },
    (c: JsonObject) => { (c.revoke as JsonObject).projectId = accessProjects[1]; },
    (c: JsonObject) => { (c.revoke as JsonObject).deletedCount = 0; },
    (c: JsonObject) => { (c.resources as JsonObject).includeRoot = true; },
    (c: JsonObject) => { c.offlineDigest = c.finalDigest; },
    (c: JsonObject) => { ((c.outage as JsonObject).after as JsonObject).responseBytes = 201; },
    (c: JsonObject) => { c.serverAfter = { ...(c.serverAfter as JsonObject), startedAt: '2026-09-06T09:01:00Z' }; },
    (c: JsonObject) => { (c.clients as JsonObject[])[1].requestedProjects = [accessProjects[1]]; },
  ]) {
    const bad = structuredClone(good); corrupt(bad.metadata.cases[1]);
    expect(() => validateAccessResult(bad)).toThrow('Invalid measurement');
  }
  const bad = structuredClone(good); bad.metrics.online_convergence_ms = 1;
  expect(() => validateAccessResult(bad)).toThrow('milestones');
});

test('application refresh needs cache disposal and persisted data proof in its separate profile', () => {
  const good = fixture();
  const metadata = good.metadata as JsonObject;
  metadata.workloadContract = ACCESS_REFRESH_CONTRACT; metadata.accessProfile = accessRefreshProfile('sqlite');
  for (const item of metadata.cases as JsonObject[]) {
    item.initialCache = { generation: 1, kind: 'sqlite', store: '/cache.sqlite', persistedDigest: item.initialDigest };
    item.finalCache = { generation: 2, kind: 'sqlite', store: '/cache.sqlite', previousCacheDisposed: true, previousFileRemoved: true, persistedDigest: item.finalDigest };
  }
  expect(() => validateAccessResult(good)).not.toThrow();
  for (const key of ['generation', 'previousCacheDisposed', 'previousFileRemoved', 'persistedDigest']) {
    const bad = structuredClone(good); delete ((bad.metadata.cases[0] as JsonObject).finalCache as JsonObject)[key];
    expect(() => validateAccessResult(bad)).toThrow('proof');
  }
  const nativeClaim = structuredClone(good); (nativeClaim.metadata as JsonObject).workloadContract = ACCESS_CONTRACT;
  expect(() => validateAccessResult(nativeClaim)).toThrow('profile');
});

test('PowerSync native purge binds its scope and the same SQLite file to its adapter', () => {
  const good = { ...fixture(), stackId: 'powersync' as const };
  const metadata = good.metadata as JsonObject;
  metadata.accessProfile = powerSyncAccessProfile;
  for (const item of metadata.cases as JsonObject[]) {
    item.initialReplica = { kind: 'powersync-node-sqlite-file', path: 'store-0', device: 1, inode: 123 };
    item.finalReplica = { ...item.initialReplica as JsonObject };
  }
  expect(() => validateAccessResult(good)).not.toThrow();
  for (const change of [
    (m: JsonObject) => { m.accessProfile = accessProfile; },
    (m: JsonObject) => { delete (m.cases as JsonObject[])[0].initialReplica; },
    (m: JsonObject) => { ((m.cases as JsonObject[])[0].finalReplica as JsonObject).inode = 456; },
    (m: JsonObject) => { ((m.cases as JsonObject[])[0].initialReplica as JsonObject).path = 'other-store'; },
  ]) { const bad = structuredClone(good); change(bad.metadata); expect(() => validateAccessResult(bad)).toThrow('Invalid measurement'); }
  expect(() => validateAccessResult({ ...good, stackId: 'syncular' })).toThrow('native adapter');
});


test('Zero purge requires correct raw cache and visible rows in the same native client', () => {
  const good = { ...fixture(), stackId: 'zero' as const };
  const metadata = good.metadata as JsonObject; metadata.accessProfile = zeroAccessProfile;
  for (const item of metadata.cases as JsonObject[]) {
    const cache = (i: number, retained: boolean) => ({ kind: 'zero-memory', rowSource: 'Zero.inspector.client.rows(tasks)', kvStore: 'mem',
      store: `store-${i}`, storageKey: `client-${i}`, nativeClientId: `native-${i}`, queryState: 'complete', cachedRows: accessRows(retained), viewRows: accessRows(retained) });
    item.initialCache = cache(0, false) as unknown as JsonObject; item.finalCache = cache(0, true) as unknown as JsonObject;
    item.offlineCache = cache(0, false) as unknown as JsonObject; item.freshActorCache = cache(1, true) as unknown as JsonObject; item.unaffectedActorCache = cache(2, false) as unknown as JsonObject;
  }
  expect(() => validateAccessResult(good)).not.toThrow();
  for (const change of [
    (c: JsonObject) => { (c.finalCache as JsonObject).cachedRows = (c.initialCache as JsonObject).cachedRows; },
    (c: JsonObject) => { (c.finalCache as JsonObject).viewRows = (c.initialCache as JsonObject).viewRows; },
    (c: JsonObject) => { (c.finalCache as JsonObject).nativeClientId = 'replacement'; },
    (c: JsonObject) => { (c.finalCache as JsonObject).rowSource = 'filtered view'; },
    (c: JsonObject) => { (c.offlineCache as JsonObject).cachedRows = (c.finalCache as JsonObject).cachedRows; },
    (c: JsonObject) => { (c.freshActorCache as JsonObject).nativeClientId = 'native-0'; },
  ]) { const bad = structuredClone(good); change(bad.metadata.cases[1]); expect(() => validateAccessResult(bad)).toThrow('Invalid measurement'); }
  const downgrade = structuredClone(good); downgrade.metadata.accessProfile = accessProfile;
  expect(() => validateAccessResult(downgrade)).toThrow('profile');
});

test('Jazz purge cannot pass on filtered views, replaced storage or unverified membership revocation', () => {
  const good={...fixture(),stackId:'jazz-v2' as const};const metadata=good.metadata as JsonObject;metadata.accessProfile=jazzAccessProfile;
  for(const item of metadata.cases as JsonObject[]) {
    const clients=item.clients as JsonObject[];
    clients.forEach((client,i)=>Object.assign(client,{datasetId:'access-test',nativeActorId:i===2?'native-user-2':'native-user-1'}));
    const cache=(i:number,retained=false):JsonObject=>({kind:'jazz-node-sqlite',rowSource:'NapiRuntime.query without session; local-only propagation',store:`store-${i}`,clientId:`client-${i}`,actorId:clients[i].actorId,nativeActorId:clients[i].nativeActorId,datasetId:'access-test',device:1,inode:123+i,loadedPolicyBundle:true,subscriptions:2,errors:[],
      cachedRows:accessRows(retained) as JsonObject[],viewRows:accessRows(retained) as JsonObject[],subscriptionRows:accessRows(retained) as JsonObject[],nativeRows:accessRows(retained).map(row=>({...row,id:`native-${row.id}`,external_id:row.id,dataset_id:'access-test'})) as JsonObject[]});
    item.initialCache=cache(0);item.finalCache=cache(0,true);item.offlineCache=cache(0);item.freshActorCache=cache(1,true);item.unaffectedActorCache=cache(2);
    item.resources={method:'external-ps-process-tree-v1',rootPid:10,includeRoot:true,samples:[{},{}]};
    const memberships=['native-user-1','native-user-2'].flatMap((user,i)=>accessProjects.map((project,p)=>({id:`member-${i}-${p}`,dataset_id:'access-test',user_id:user,project_id:project})));
    item.serverDataBefore={...state(),nativeState:{memberships}} as unknown as JsonObject;
    item.serverDataAfter={...state(),nativeState:{memberships:memberships.slice(1),receipts:[{operation:'seed',edge:'success'},{operation:'revoke',edge:'success',nativeMembershipId:'member-0-0',deletedCount:1,batchId:'revoke-batch'}]}} as unknown as JsonObject;
  }
  expect(()=>validateAccessResult(good)).not.toThrow();
  for(const change of [
    (item:JsonObject)=>{(item.finalCache as JsonObject).cachedRows=accessRows() as JsonObject[];},
    (item:JsonObject)=>{(item.finalCache as JsonObject).nativeRows=(item.initialCache as JsonObject).nativeRows;},
    (item:JsonObject)=>{(item.finalCache as JsonObject).viewRows=accessRows() as JsonObject[];},
    (item:JsonObject)=>{(item.finalCache as JsonObject).subscriptionRows=accessRows() as JsonObject[];},
    (item:JsonObject)=>{(item.finalCache as JsonObject).inode=456;},
    (item:JsonObject)=>{(item.finalCache as JsonObject).loadedPolicyBundle=false;},
    (item:JsonObject)=>{(item.offlineCache as JsonObject).cachedRows=accessRows(true) as JsonObject[];},
    (item:JsonObject)=>{(item.freshActorCache as JsonObject).nativeActorId='native-user-2';},
    (item:JsonObject)=>{(item.resources as JsonObject).rootPid=99;},
    (item:JsonObject)=>{delete item.serverDataBefore;},
    (item:JsonObject)=>{const state=item.serverDataAfter as JsonObject;((state.nativeState as JsonObject).memberships as JsonObject[])[0].user_id='wrong';},
    (item:JsonObject)=>{const state=item.serverDataAfter as JsonObject;((state.nativeState as JsonObject).receipts as JsonObject[])[1].edge='pending';},
  ]){const bad=structuredClone(good);change(bad.metadata.cases[1]);expect(()=>validateAccessResult(bad)).toThrow('Invalid measurement');}
  const downgrade=structuredClone(good);downgrade.metadata.accessProfile=accessProfile;expect(()=>validateAccessResult(downgrade)).toThrow('profile');
  expect(()=>validateAccessResult({...good,stackId:'syncular'})).toThrow('native adapter');
});
