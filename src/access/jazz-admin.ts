import { randomUUID } from 'node:crypto';
import { deploy } from 'jazz-tools/dev';
import { toWriteRecord, transformRows } from 'jazz-tools';
import { app, appId, adminSecret, productVersion, jazzMembershipMigration } from '../adapters/jazz-native.ts';
import { validateJazzDeployment } from '../contracts/jazz-deployment.ts';
import { accessRows, accessProfile, accessProjects, validateAccessState } from '../contracts/access.ts';
import { canonicalJazzAccessRows, createJazzAccessClient, jazzAccessIdentity, jazzAccessLocal, jazzAccessPermissions } from './jazz-native.ts';
import type { RecoveryClientConfig, RecoveryDriver } from '../recovery/protocol.ts';
import type { JsonObject } from '../types.ts';

export async function createJazzAccessAdmin(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  const deployment = await deploy({ appId, serverUrl: config.syncBaseUrl, adminSecret, schema: app.wasmSchema, permissions: jazzAccessPermissions, migration: jazzMembershipMigration });
  validateJazzDeployment(deployment);
  const native = createJazzAccessClient(config, true); native.connect();
  let revokeId = '', revoked = false;
  const receipts: JsonObject[] = [];
  const batch = native.client.beginBatch('direct');
  const actors = [accessProfile.actor,accessProfile.unaffectedActor].map(actorId => ({ actorId, nativeActorId: jazzAccessIdentity(config.datasetId!,actorId).nativeActorId }));
  for(const actor of actors) for(const projectId of accessProjects) {
    const id = randomUUID(); if(actor.actorId===accessProfile.actor&&projectId===accessProjects[0]) revokeId=id;
    native.client.insertInternal('memberships',toWriteRecord({dataset_id:config.datasetId,project_id:projectId,user_id:actor.nativeActorId},app.wasmSchema,'memberships'),{id},undefined,undefined,batch);
  }
  for(const row of accessRows()) native.client.insertInternal('tasks',toWriteRecord({ ...row, id:undefined, dataset_id:config.datasetId, external_id:row.id, completed:Boolean(row.completed), updated_at:new Date(1_700_000_000_000) },app.wasmSchema,'tasks'),{id:randomUUID()},undefined,undefined,batch);
  await native.client.commitBatch(batch).wait({tier:'edge'});
  const rows = async () => canonicalJazzAccessRows(await native.nativeRows());
  const digest = validateAccessState('Jazz edge-durable seed',{rows:await rows(),pending:0,rejected:null,conflicts:null});
  receipts.push({operation:'seed',batchId:batch,edge:'success',tasksDigest:digest});
  const read = async () => ({rows:await rows(),pending:0,rejected:null,conflicts:null,nativeState:{memberships:JSON.parse(JSON.stringify(transformRows(await native.client.query(native.memberships,jazzAccessLocal),app.wasmSchema,'memberships'))),receipts:[...receipts],actors}});
  return { rows,read,count:async()=>(await rows()).length,firstScreen:async()=>[],pending:async()=>0,
    write:async()=>{throw new Error('Jazz access admin only seeds and revokes a membership');},
    remove:async id=>{
      if(id!=='revoke-membership'||revoked)throw new Error('Jazz access accepts one membership revocation');
      const handle=native.client.delete(revokeId); await handle.wait({tier:'edge'}); revoked=true;
      receipts.push({operation:'revoke',batchId:handle.batchId,edge:'success',actorId:accessProfile.actor,projectId:accessProjects[0],nativeMembershipId:revokeId,deletedCount:1});
    },
    sync:async()=>{},probeSync:async()=>{},close:()=>native.client.shutdown(),
    diagnostics:{productVersion,datasetId:config.datasetId!,actors,seedDigest:digest,seedBatchId:batch,edgeDurable:true,deployment:JSON.parse(JSON.stringify(deployment))},
  };
}
