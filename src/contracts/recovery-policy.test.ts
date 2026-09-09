import {expect,test} from 'bun:test';
import {recoveryPolicy,validateRestoration} from './recovery-policy.ts';
import {recoveryOutageFixture} from '../test-fixtures/recovery-outage.ts';
import {waitForRestoration} from '../recovery/restoration.ts';
import {validateCampaign,validateConfiguredParameters,type CampaignConfig} from '../campaign.ts';
import type {BenchmarkResult} from '../types.ts';

test('recovery refuses adaptive restoration, hidden traffic and missing retry evidence',()=>{
 const check=(o:any)=>validateRestoration(recoveryPolicy(),o.restoration,o.before,o.after);
 expect(()=>check(recoveryOutageFixture())).not.toThrow();
 for(const mutate of [
  (o:any)=>delete o.restoration,
  (o:any)=>o.restoration.restoreStartedAtMs=19_999,
  (o:any)=>o.restoration.restoredAtMs=20_251,
  (o:any)=>o.restoration.offlineValidatedAtMs=20_000,
  (o:any)=>o.restoration.timeline.sync[2].atMs=19_000,
  (o:any)=>o.restoration.timeline.sync.splice(1,1),
  (o:any)=>o.restoration.timeline.sync[1].kind='forwarded',
  (o:any)=>delete o.restoration.timeline.sync,
  (o:any)=>o.after.endpoints.sync.requestBytes++,
 ]){const o=recoveryOutageFixture();mutate(o);expect(()=>check(o)).toThrow();}
});
test('absolute restoration wait rejects late readiness and tolerates early timer wakeups',async()=>{
 let now=100;const waits:number[]=[];
 await waitForRestoration(200,()=>now,async ms=>{waits.push(ms);now+=waits.length===1 ? 40 : ms;});
 expect(waits).toEqual([100,60]);expect(now).toBe(200);
 await expect(waitForRestoration(200,()=>201,async()=>{throw new Error('Must not extend outage');})).rejects.toThrow('missed');
});
test('recovery duration is declared and bound to campaign parameters',()=>{
 const config:CampaignConfig={version:1,purpose:'diagnostic',seed:1,trials:1,trialTimeoutMs:900000,stacks:['zero'],scenarios:['offline-replay'],network:{id:'local-loopback',injectedLatencyMs:0,injectedLossPct:0},stoppingRule:'Run all attempts'};
 for(const value of [null,'20000',1,999,120001,NaN])expect(()=>validateCampaign({...config,parameters:{recoveryOutageMs:value}} as any)).toThrow('duration');
 expect(()=>validateCampaign({...config,parameters:{recoveryOutageMs:14000}})).not.toThrow();
 const r={metadata:{workloadContract:'offline-recovery-v2',outagePolicy:recoveryPolicy(14000)}} as unknown as BenchmarkResult;
 expect(()=>validateConfiguredParameters(r,{recoveryOutageMs:14000})).not.toThrow();
 expect(()=>validateConfiguredParameters(r)).toThrow('policy');
});
