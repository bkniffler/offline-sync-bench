import { stat } from 'node:fs/promises';
import { SubscriptionManager, transformRows } from 'jazz-tools';
import { app, productVersion, type TaskRow } from '../adapters/jazz-native.ts';
import { canonicalJazzAccessRows, createJazzAccessClient, jazzAccessLocal } from './jazz-native.ts';
import type { RecoveryClientConfig, RecoveryDriver } from '../recovery/protocol.ts';

export async function createJazzAccessDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  const native=createJazzAccessClient(config), manager=new SubscriptionManager<TaskRow>();
  let subscriptionRows:TaskRow[]=[], connected=false;
  const errors:string[]=[], subscriptions:number[]=[];
  native.runtime.onAuthFailure(reason=>errors.push(reason));
  const check=()=>{if(errors.length)throw new Error(`Jazz access native error: ${errors.join('; ')}`);};
  const rows=async()=>{check();return canonicalJazzAccessRows(await native.nativeRows());};
  const sync=async()=>{
    check(); if(connected)return;
    native.connect();connected=true;
    subscriptions.push(native.client.subscribe(native.memberships,()=>{}, {tier:'edge'}));
    subscriptions.push(native.client.subscribe(native.full,delta=>{
      try{subscriptionRows=manager.handleDelta(delta,row=>transformRows<TaskRow>([row],app.wasmSchema,'tasks')[0],app.wasmSchema.tasks.columns).all;}
      catch(error){errors.push(String(error));}
    },{tier:'edge'}));
  };
  const unsupportedWrite=async()=>{throw new Error('Jazz access workload issues no client mutations');};
  return {rows,count:async()=>(await rows()).length,firstScreen:async()=>[],pending:async()=>0,
    read:async()=>{
      check();const raw=await native.nativeRows(), visible=await native.visibleRows(),file=await stat(config.dbPath);
      return {rows:canonicalJazzAccessRows(raw),pending:0,rejected:null,conflicts:null,nativeState:{accessCache:{kind:'jazz-node-sqlite',store:config.dbPath,clientId:config.clientId,
        actorId:config.actorId,nativeActorId:native.identity.nativeActorId,datasetId:config.datasetId!,device:file.dev,inode:file.ino,loadedPolicyBundle:true,
        rowSource:'NapiRuntime.query without session; local-only propagation',viewRows:JSON.parse(JSON.stringify(canonicalJazzAccessRows(visible))),subscriptionRows:JSON.parse(JSON.stringify(canonicalJazzAccessRows(subscriptionRows))),
        nativeRows:JSON.parse(JSON.stringify(raw)),memberships:JSON.parse(JSON.stringify(transformRows(await native.client.query(native.memberships,jazzAccessLocal),app.wasmSchema,'memberships'))),errors:[...errors],subscriptions:subscriptions.length}}};
    },
    sync,probeSync:sync,write:unsupportedWrite,remove:unsupportedWrite,
    close:async()=>{for(const id of subscriptions)native.client.unsubscribe(id);await native.client.shutdown();},
    diagnostics:{productVersion,localStorage:'jazz-node-sqlite',actorId:config.actorId,nativeActorId:native.identity.nativeActorId,datasetId:config.datasetId!,loadedPolicyBundle:true,
      authentication:'native local-first token; no backend credential in client context or transport',sync:'continuous task and membership subscriptions; native transport owns reconnect',
      observation:'unscoped local-only raw query, session-scoped local query and maintained subscription on the same native runtime; no application row deletion'},
  };
}
