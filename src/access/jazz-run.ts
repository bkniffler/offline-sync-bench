import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACCESS_CONTRACT, accessModes, accessProfile, accessProjects, accessSeed, jazzAccessProfile, jazzCacheEvidence, validateAccessState, validateJazzAccessCache, validateJazzAccessServer, type AccessMode } from '../contracts/access.ts';
import { ContractError } from '../contracts/screens.ts';
import { ExternalResources } from '../resources.ts';
import { RecoveryProcess } from '../recovery/process.ts';
import { ClientNetworkGate } from '../recovery/network-gate.ts';
import { ensureStackUp } from '../stack-manager.ts';
import { restartStartupServer, serverState } from '../startup/server.ts';
import { getStack } from '../stacks.ts';
import { tempRoot } from '../paths.ts';
import type { JsonObject } from '../types.ts';

const sleep = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const classify = (error:unknown) => error instanceof ContractError ? 'invalid' : /timed out|timeout/i.test(String(error)) ? 'timed-out' : 'failed';

async function measureJazzAccess(mode:AccessMode) {
  await restartStartupServer('jazz-v2');
  await mkdir(tempRoot,{recursive:true});const dir=await mkdtemp(join(tempRoot,'jazz-access-'));
  const stack=getStack('jazz-v2'),datasetId=`access-${randomUUID()}`,processes:RecoveryProcess[]=[];
  const gate=new ClientNetworkGate({sync:stack.syncBaseUrl});
  const evidence:JsonObject={mode,stage:'setup',datasetId,clients:[]},metrics:Record<string,number|null>={};
  let resources:ExternalResources|undefined;
  const create=async(name:string,actorId:string,gated:boolean,admin=false)=>{
    const client=new RecoveryProcess('node');processes.push(client);
    const config={stackId:'jazz-v2' as const,accessNative:true,accessAdmin:admin,datasetId,actorId,clientId:randomUUID(),projectId:accessProjects[0],projectIds:accessProjects,dbPath:join(dir,`${name}.sqlite`),syncBaseUrl:gated?gate.url('sync')!:stack.syncBaseUrl};
    await client.open(config);
    const identity:JsonObject={pid:client.pid,store:config.dbPath,clientId:config.clientId,actorId,datasetId,nativeActorId:client.diagnostics.nativeActorId??null,requestedProjects:accessProjects};
    if(admin)evidence.admin={...identity,diagnostics:client.diagnostics};else(evidence.clients as JsonObject[]).push(identity);
    return {client,identity};
  };
  const open=async(name:string,actorId:string,gated:boolean,retained=false)=>{
    const instance=await create(name,actorId,gated);await instance.client.sync();
    const deadline=performance.now()+60_000;
    while(true){
      const state=await instance.client.read(),cache=jazzCacheEvidence(state);
      try{validateAccessState(`${name} readiness`,state,retained);validateJazzAccessCache(cache,instance.identity,retained);return {...instance,state,cache};}
      catch(error){if(!(error instanceof ContractError))throw error;if(performance.now()>=deadline){evidence[`${name}ReadinessFailure`]={cache,reason:error.message};throw new Error(`Jazz ${name} readiness timed out`);}}
      await sleep(50);
    }
  };
  try {
    await gate.start();
    const admin=await create('admin',accessProfile.actor,false,true);
    evidence.serverDataBefore=JSON.parse(JSON.stringify(await admin.client.read()));
    const affected=await open('affected',accessProfile.actor,true);
    evidence.initialCache=affected.cache;evidence.initialDigest=validateAccessState('initial affected',affected.state);
    evidence.serverBefore=serverState('jazz-v2');
    resources=new ExternalResources(true,affected.client.pid);
    if(mode==='offline-reconnect') {
      gate.block();const before=gate.snapshot();
      try{await fetch(gate.url('sync')!,{signal:AbortSignal.timeout(2_000)});}catch{/* Require the refused route in the outage evidence. */}
      evidence.outage={before,after:gate.snapshot()};
    }else await resources.start();
    evidence.stage='revoke';const revokedAt=performance.now();
    await admin.client.remove('revoke-membership');
    evidence.revokeRequestMs=performance.now()-revokedAt;
    evidence.revoke={actorId:accessProfile.actor,projectId:accessProjects[0],ok:true,deletedCount:1};
    let started=revokedAt;
    if(mode==='offline-reconnect') {
      const offline=await affected.client.read();evidence.offlineCache=jazzCacheEvidence(offline);
      evidence.offlineDigest=validateAccessState('offline after revoke',offline);validateJazzAccessCache(evidence.offlineCache as JsonObject,affected.identity);
      (evidence.outage as JsonObject).after=gate.snapshot();
      await resources.start();started=performance.now();gate.restore();
    }
    evidence.stage='same-client-purge';const trafficBefore=gate.snapshot(),deadline=performance.now()+60_000;
    let purgeError:unknown;
    try {
      while(true) {
        await affected.client.sync();const state=await affected.client.read(),cache=jazzCacheEvidence(state);evidence.finalCache=cache;
        const complete=[cache.cachedRows,cache.viewRows,cache.subscriptionRows].every(rows=>Array.isArray(rows)&&rows.length===accessSeed.tasksPerProject);
        if(complete){evidence.convergenceMs=performance.now()-started;validateJazzAccessCache(cache,affected.identity,true);evidence.finalDigest=validateAccessState('same client after purge',state,true);evidence.purgedClientPid=affected.client.pid;break;}
        if(performance.now()>=deadline)throw new Error('Jazz native access purge timed out');
        await sleep(5);
      }
    }catch(error){purgeError=error;evidence.purgeFailure={status:classify(error),reason:String(error)};}
    evidence.observationMs=performance.now()-started;
    const usage=await resources.stop();evidence.resources=usage.metadata;evidence.traffic={before:trafficBefore,after:gate.snapshot()};
    await affected.client.close();
    // A failed purge must not suppress independent authorization evidence.
    evidence.stage='fresh-client-validation';const failures:unknown[]=purgeError?[purgeError]:[];
    for(const[name,actorId,retained,cacheKey,digestKey]of[
      ['fresh-actor',accessProfile.actor,true,'freshActorCache','freshActorDigest'],
      ['unaffected-actor',accessProfile.unaffectedActor,false,'unaffectedActorCache','unaffectedActorDigest'],
    ]as const) {
      try{const fresh=await open(name,actorId,false,retained);evidence[cacheKey]=fresh.cache;evidence[digestKey]=validateAccessState(name,fresh.state,retained);await fresh.client.close();}
      catch(error){failures.push(error);evidence[`${name}Failure`]={status:classify(error),reason:String(error)};}
    }
    evidence.serverDataAfter=JSON.parse(JSON.stringify(await admin.client.read()));
    validateAccessState('server tasks after revocation',evidence.serverDataAfter as unknown as Awaited<ReturnType<RecoveryProcess['read']>>);
    if((evidence.clients as JsonObject[]).length===3)validateJazzAccessServer(evidence.serverDataBefore as unknown as Awaited<ReturnType<RecoveryProcess['read']>>,evidence.serverDataAfter as unknown as Awaited<ReturnType<RecoveryProcess['read']>>,evidence.clients as JsonObject[]);
    evidence.serverAfter=serverState('jazz-v2');
    const key=mode.replaceAll('-','_');
    metrics[`${key}_revoke_request_ms`]=Number(evidence.revokeRequestMs);
    metrics[`${key}_convergence_ms`]=failures.length?null:Number(evidence.convergenceMs);
    for(const[name,value]of Object.entries(usage.metrics))metrics[`${key}_${name}`]=value;
    if(failures.length){evidence.status=failures.some(e=>classify(e)==='invalid')?'invalid':failures.some(e=>classify(e)==='timed-out')?'timed-out':'failed';evidence.reason=failures.map(String).join('; ');}
    else evidence.status='completed';
    return {case:evidence,metrics};
  }catch(error){evidence.status=classify(error);evidence.reason=String(error);return {case:evidence,metrics};}
  finally{resources?.abort();await Promise.allSettled(processes.map(client=>client.close()));await Promise.allSettled(processes.map(client=>client.kill()));await gate.close();await rm(dir,{recursive:true,force:true});}
}

export async function runJazzAccess() {
  await ensureStackUp('jazz-v2');const cases:JsonObject[]=[],metrics:Record<string,number|null>={};
  for(const mode of accessModes){const result=await measureJazzAccess(mode);cases.push(result.case);Object.assign(metrics,result.metrics);}
  return {status:cases.every(c=>c.status==='completed')?'completed' as const:cases.some(c=>c.status==='invalid')?'invalid' as const:cases.some(c=>c.status==='timed-out')?'timed-out' as const:'failed' as const,metrics,
    notes:['Canonical two-project access revocation using authenticated native actors, shared client-only TCP outage control and independent native processes.',
      'Raw local task records, session-scoped query results and maintained subscription rows must all converge in the same SQLite runtime. Native transport owns reconnect; no application reset or row deletion is performed.',
      'Failed purge observations retain the final cache and independent fresh-actor/server checks. Null convergence metrics do not represent zero latency. Online acknowledgment includes controller IPC to the already running native administrator.',
      'The affected process and its descendants are sampled directly. Administrative work, fixture creation, controller and later fresh-client checks are excluded from client resources. Removing task records does not establish forensic erasure or deletion of copied data.'],
    metadata:{implementation:'jazz-v2-access-revocation-v1',workloadContract:ACCESS_CONTRACT,fixture:accessSeed,accessProfile:jazzAccessProfile,cases,
      diagnostics:{localStorage:'jazz-node-sqlite',authorization:'native local-first actor identity and deployed membership relation',refresh:'continuous native subscriptions and transport reconnect; raw and visible local records checked'},
      resources:{method:'external-ps-process-tree-v1',scope:'affected process and descendants; controller, administrator and sampler excluded'}}};
}
