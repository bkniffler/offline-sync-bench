import { serverStoragePolicy, type StoragePhase } from '../server-storage.ts';
import type { JsonObject, StackId } from '../types.ts';
export const storageImageFixture = `sha256:${'a'.repeat(64)}`;
export function serverStorageFixture(stackId: StackId = 'electric', kind: 'trial' | 'startup-client' = 'trial'): JsonObject {
  const at='2026-09-06T00:00:00Z';
  const snapshot = (phase: StoragePhase) => ({version:1,stackId,phase,method:serverStoragePolicy.measurement,startedAt:at,finishedAt:at,containers:[{
    containerId:'b'.repeat(64),name:'/test',service:'test',imageId:storageImageFixture,running:true,startedAt:at,
    writableLayer:{status:'measured',bytes:4096,reason:null},mounts:[],
  }]});
  return {policy:serverStoragePolicy,window:{startedAt:at,finishedAt:at},before:snapshot(`before-${kind}`),after:snapshot(`after-${kind}`)};
}
