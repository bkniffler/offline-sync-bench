import { resultProfile } from './profiles.ts';
import type { BenchmarkResult } from './types.ts';
import { expect, test } from 'bun:test';
import { parseAllocatedStorage, storageMounts, validateServerStoragePair } from './server-storage.ts';
import { serverStorageFixture, storageImageFixture } from './test-fixtures/server-storage.ts';
import type { JsonObject } from './types.ts';
const pair=()=>serverStorageFixture() as any;
test('storage allocation distinguishes allocated KiB, zero and unavailable output',()=>{
  expect(parseAllocatedStorage('123\t/data\n','/data')).toEqual({status:'measured',bytes:125952,reason:null});
  expect(parseAllocatedStorage('0 /data with spaces\n','/data with spaces').bytes).toBe(0);
  for(const raw of ['123 /other','-1 /data','12.5 /data','1 /data\n2 /data','9007199254740991 /data','permission denied']) {
    const value=parseAllocatedStorage(raw,'/data');expect(value.status).toBe('unavailable');expect(value.bytes).toBeNull();
  }
});
test('storage inventory includes named data volumes and writable binds, excluding read-only configuration',()=>{
  expect(storageMounts({Mounts:[{Type:'bind',Destination:'/config',RW:false},{Type:'bind',Destination:'/cache',RW:true},{Type:'volume',Name:'db',Destination:'/data',RW:false}]})).toEqual([{type:'bind',name:null,destination:'/cache',readWrite:true},{type:'volume',name:'db',destination:'/data',readWrite:false}]);
});
test('storage observations cannot overlap the workload or silently change services and mounts',()=>{
  expect(()=>validateServerStoragePair(pair(),'electric','trial')).not.toThrow();
  for(const change of [
    (v:any)=>{v.before.finishedAt='2026-09-06T00:00:01Z';},
    (v:any)=>{v.window.finishedAt='2026-09-06T00:00:01Z';},
    (v:any)=>{v.after.phase='before-trial';},
    (v:any)=>{v.before.stackId='zero';},
    (v:any)=>{v.after.containers[0].containerId='c'.repeat(64);},
    (v:any)=>{v.after.containers=[];},
    (v:any)=>{v.before.containers.push(v.before.containers[0]);},
    (v:any)=>{v.after.containers[0].writableLayer.bytes=-1;},
    (v:any)=>{v.after.containers[0].writableLayer={status:'unavailable',bytes:0,reason:'missing'};},
  ]){const v=pair();change(v);expect(()=>validateServerStoragePair(v,'electric','trial')).toThrow();}
  const startup=serverStorageFixture('electric','startup-client') as any;
  startup.after.containers[0].startedAt='2026-09-05T00:00:00Z';
  expect(()=>validateServerStoragePair(startup,'electric','startup-client')).toThrow('restarted');
});
test('publication storage inventories bind to complete configuration and preserve unavailable counters',()=>{
  const v=pair();
  const mount={type:'volume',name:'database',destination:'/data',readWrite:true};
  for(const snapshot of [v.before,v.after]) snapshot.containers[0].mounts=[{...mount,allocation:{status:'unavailable',bytes:null,reason:'du unavailable'}}];
  const config=[{name:'/test',service:'test',imageId:storageImageFixture,mounts:[mount]}] as JsonObject[];
  expect(()=>validateServerStoragePair(v,'electric','trial',config)).not.toThrow();
  for(const change of [
    (c:any)=>{c[0].mounts=[];},
    (c:any)=>{c[0].mounts[0].name='other';},
    (c:any)=>{c[0].imageId='sha256:other';},
    (c:any)=>{c.push(c[0]);},
  ]){const changed=structuredClone(config);change(changed);expect(()=>validateServerStoragePair(v,'electric','trial',changed)).toThrow('configuration');}
});

test('storage preparation policy separates profiles while observed allocation remains trial evidence',()=>{
  const result={stackId:'electric',scenarioId:'local-query',metrics:{},metadata:{serverStorage:serverStorageFixture()}} as unknown as BenchmarkResult;
  const campaign={source:{sourceHash:'test'},machine:{},images:{},network:{}};
  const baseline=resultProfile(result,campaign).comparisonKey;
  ((result.metadata.serverStorage as any).before.containers[0].writableLayer).bytes+=4096;
  expect(resultProfile(result,campaign).comparisonKey).toBe(baseline);
  (result.metadata.serverStorage as any).policy={...(result.metadata.serverStorage as any).policy,preparation:'fresh volumes'};
  expect(resultProfile(result,campaign).comparisonKey).not.toBe(baseline);
});
