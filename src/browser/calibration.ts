import {randomUUID} from 'node:crypto';
import type {BrowserProcess} from './process.ts';

// Same CDP call serialization and parent clock as the workload. This estimates
// idle bridge cost, not SDK overhead; never subtract it from measured latency.
export async function calibrateBrowserBridge(writer:BrowserProcess,reader:BrowserProcess){
 const samples:Array<{iteration:number;armMs:number;twoCallsMs:number;bindingMs:number}>=[];
 for(let iteration=-5;iteration<100;iteration++){
  const token=randomUUID(),started=performance.now();
  const armed=await reader.call('noop',{token});
  if(armed.token!==token)throw new Error('CDP calibration arm mismatch');
  const armMs=performance.now()-started;
  let bindingMs:number|undefined;
  let resolve!:()=>void,reject!:(error:Error)=>void;
  const event=new Promise<void>((ok,no)=>{resolve=ok;reject=no;});
  const remove=writer.onEvent((name,data)=>{if(name==='calibration'&&data.token===token){bindingMs=performance.now()-started;resolve();}});
  const timer=setTimeout(()=>reject(new Error('CDP calibration binding timed out')),5000);
  try{
   const [{receipt,twoCallsMs}]=await Promise.all([writer.call('calibrate',{token}).then(receipt=>({receipt,twoCallsMs:performance.now()-started})),event]);
   if(receipt.token!==token||bindingMs===undefined)throw new Error('CDP calibration receipt mismatch');
   if(iteration>=0)samples.push({iteration,armMs,twoCallsMs,bindingMs});
  }finally{clearTimeout(timer);remove();}
 }
 return{method:'cdp-idle-two-call-binding-v1',warmups:5,iterations:100,clock:'controller-monotonic',samples,limitation:'Idle CDP arm + dispatch + immediate binding round trip. No network or SDK work; receipt sizes and load differ from the benchmark. No subtraction or causal attribution.'};
}
