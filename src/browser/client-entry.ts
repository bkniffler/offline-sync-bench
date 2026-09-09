import {Shape,ShapeStream} from '@electric-sql/client';
import {Zero} from '@rocicorp/zero';
import {schema,queries} from '../../services/zero-bench-app/src/schema.ts';
import {mutators} from '../../services/zero-bench-app/src/mutators.ts';
import {awaitBrowserFixture} from './initial-ready.ts';

type Config={stackId:'electric'|'zero';clientId:string;actorId:string;role:'writer'|'reader';syncBaseUrl:string;mutationBaseUrl?:string;auth?:string;expectedRows:Row[];diagnosticForwarding?:'buffered'|'forwarded'};
type Row=Record<string,unknown>;
declare global {var benchmarkDispatch:(method:string,params:any)=>Promise<unknown>;var benchReport:(payload:string)=>void;}
let config:Config,readRows:()=>Row[],close:()=>Promise<void>;
let write:(taskId:string,title:string,iteration:number)=>Promise<void>;
const waiting=new Map<string,{taskId:string}>();
const receipts:unknown[]=[];
const diagnosticEvents:Array<{event:string;data:any}>=[];
const completions=new Map<string,{taskId:string;promise:Promise<unknown>;resolve:(value:unknown)=>void}>();
const emit=(event:string,data:unknown)=>{
 if(config?.diagnosticForwarding&&['local','accepted','visible'].includes(event)){
  // Capture the receipt at emission time in both diagnostic modes. In
  // particular, Zero mutates its shared receipt when the server settles.
  diagnosticEvents.push(structuredClone({event,data}));
  if(config.diagnosticForwarding==='buffered')return;
 }
 globalThis.benchReport(JSON.stringify({event,data},(_key,value)=>typeof value==='bigint'?value.toString():value));
};
const matches=()=>{for(const[title,{taskId}]of waiting){const row=readRows().find(row=>row.id===taskId);if(row?.title===title){waiting.delete(title);const data={title,taskId,browserAtMs:performance.now(),row};emit('visible',data);completions.get(title)?.resolve(data);}}};
let fatal:string|null=null;
const fail=(error:unknown)=>{fatal=String(error);emit('fatal',{error:fatal});};
function check(){if(fatal)throw new Error(fatal);}
async function init(value:Config){
 if(value.diagnosticForwarding!==undefined&&!['buffered','forwarded'].includes(value.diagnosticForwarding))throw new Error('Unknown diagnostic forwarding mode');
 config=value;
 if(config.stackId==='electric'){
  const abort=new AbortController();
  const stream=new ShapeStream({url:`${config.syncBaseUrl}/v1/shape`,params:{table:'tasks'},signal:abort.signal,onError:error=>{fail(error);return undefined;}});
  const shape=new Shape(stream);readRows=()=>shape.currentRows as Row[];
  const unsubscribe=shape.subscribe(()=>{if(shape.error)fail(shape.error);else matches();});
  close=async()=>{unsubscribe();abort.abort();};
  await shape.rows;check();
  write=async(taskId,title,iteration)=>{
   const url=`${config.mutationBaseUrl}/admin/write`,request={taskId,title};
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),redirect:'error'});
   const body=await response.json();const receipt={iteration,url,method:'POST',request,response:{status:response.status,body}};
   receipts.push(receipt);
   if(response.status!==200||body.ok!==true||body.stackId!=='electric'||body.row?.id!==taskId||body.row.title!==title||typeof body.row.completed!=='boolean'||!Number.isSafeInteger(Number(body.row.server_version))||Number(body.row.server_version)<2)throw new Error('Electric mutation response mismatch');
   emit('accepted',{title,taskId,browserAtMs:performance.now(),receipt});
  };
 }else{
  const zero=new Zero({userID:config.actorId,auth:config.auth,cacheURL:config.syncBaseUrl,schema,mutators,storageKey:config.clientId,kvStore:'idb',logLevel:'error'});
  const all=zero.materialize(queries.tasks.all());readRows=()=>all.data as Row[];
  let ready!:()=>void,reject!: (error:unknown)=>void;
  const readiness=new Promise<void>((resolve,fail)=>{ready=resolve;reject=fail;});
  all.addListener((_rows,state,error)=>{if(state==='error'){reject(error);fail(error);}else {if(state==='complete')ready();matches();}});
  const unsubscribe=zero.connection.state.subscribe(value=>{if(value.name==='error'||value.name==='needs-auth')fail(`Zero connection ${value.name}`);});
  close=async()=>{unsubscribe();all.destroy();await zero.close();};
  await readiness;check();
  write=async(taskId,title,iteration)=>{
   const mutation=zero.mutate(mutators.tasks.update({id:taskId,title}));
   const receipt:any={iteration,taskId,title,local:null,server:null};receipts.push(receipt);
   const local=mutation.client.then(result=>{receipt.local=result;if(result.type!=='success')throw new Error('Zero local mutation rejected');emit('local',{title,taskId,browserAtMs:performance.now(),receipt});});
   const accepted=mutation.server.then(result=>{receipt.server=result;if(result.type!=='success')throw new Error('Zero server mutation rejected');emit('accepted',{title,taskId,browserAtMs:performance.now(),receipt});});
   await Promise.all([local,accepted]);check();
  };
 }
 const initialReadiness=await awaitBrowserFixture(()=>{check();return readRows();},config.expectedRows);
 return{clientId:config.clientId,role:config.role,stackId:config.stackId,origin:location.origin,userAgent:navigator.userAgent,initialReadiness,...(config.diagnosticForwarding?{diagnosticForwarding:config.diagnosticForwarding}:{}),
  storage:config.stackId==='zero'?'native-indexeddb':'sdk-memory-shape',secureContext:isSecureContext,
  visibility:document.visibilityState,nativeRowTypes:Object.fromEntries(Object.entries(readRows()[0]??{}).map(([key,value])=>[key,typeof value])),rows:readRows(),databases:await indexedDB.databases()};
}
globalThis.benchmarkDispatch=async(method,params)=>{
 check();
 if(method==='init')return init(params);
 if(method.startsWith('diagnostic-')){
  if(!config.diagnosticForwarding)throw new Error('Diagnostic operation requires explicit mode');
  if(method==='diagnostic-read')return{mode:config.diagnosticForwarding,events:diagnosticEvents};
  if(method==='diagnostic-arm'){
   if(config.role!=='reader'||waiting.size||completions.size)throw new Error('Diagnostic observer is not ready');
   let resolve!:(value:unknown)=>void;
   const promise=new Promise<unknown>(done=>{resolve=done;});
   completions.set(params.title,{taskId:params.taskId,promise,resolve});
   waiting.set(params.title,{taskId:params.taskId});matches();
   return{title:params.title,armed:true};
  }
  if(method==='diagnostic-wait'){
   const completion=completions.get(params.title);
   if(!completion||completion.taskId!==params.taskId)throw new Error('Diagnostic wait has no matching observer');
   try{return await completion.promise;}finally{completions.delete(params.title);}
  }
  if(method==='diagnostic-write'){
   if(config.role!=='writer')throw new Error('Diagnostic write requires writer');
   const startedAtMs=performance.now();await write(params.taskId,params.title,params.iteration);
   return{taskId:params.taskId,title:params.title,startedAtMs,finishedAtMs:performance.now()};
  }
  throw new Error(`Unknown diagnostic operation ${method}`);
 }
 if(method==='read')return{rows:readRows(),receipts,databases:await indexedDB.databases()};
 if(method==='arm'){if(waiting.size)throw new Error('Previous observer remains armed');waiting.set(params.title,{taskId:params.taskId});matches();return{title:params.title,armed:true};}
 if(method==='cancel'){waiting.delete(params.title);return null;}
 if(method==='write'){await write(params.taskId,params.title,params.iteration);return null;}
 if(method==='close'){await close();return null;}
 if(method==='noop')return params;
 if(method==='calibrate'){emit('calibration',params);return params;}
 throw new Error(`Unknown browser operation ${method}`);
};
