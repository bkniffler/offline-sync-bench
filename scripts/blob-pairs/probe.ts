/** Diagnostic-only observers. No replacement SDK algorithms. Nested spans overlap. */
import { Database } from 'bun:sqlite';
import { BunClientDatabase } from '@syncular/client/bun';
let active = false;
let records: any[] = [];
export function start() { records = []; active = true; }
export function take() { active = false; return records; }
export function span(label: string) {
  const enabled = active, began = performance.now(), cpu = process.cpuUsage();
  return () => { if (enabled) { const used = process.cpuUsage(cpu); records.push({label, ms: performance.now()-began, processCpuMs:(used.user+used.system)/1000}); } };
}
function wrap(target: any, name: string, label: string | ((args:any[])=>string), async=false) {
  const original=target[name];
  target[name] = async ? async function(this:any,...args:any[]) { const end=span(typeof label==='string'?label:label(args));try{return await original.apply(this,args);}finally{end();} }
    : function(this:any,...args:any[]) {const end=span(typeof label==='string'?label:label(args));try{return original.apply(this,args);}finally{end();}};
}
function sql(args:any[]) { return String(args[0]).replace(/\s+/g,' ').trim(); }
wrap(BunClientDatabase.prototype,'exec',args=>'sql.exec '+sql(args));
wrap(BunClientDatabase.prototype,'query',args=>'sql.query '+sql(args));
wrap(Database.prototype,'run',args=>'sql.control '+sql(args));
wrap(crypto.subtle,'digest','sha256',true);
const slice=Uint8Array.prototype.slice;
Uint8Array.prototype.slice=function(...args:any[]) {
 if(this.byteLength!==500_000_000) return slice.apply(this,args as any);
 const end=span('fullBodySlice');try{return slice.apply(this,args as any);}finally{end();}
};
export function transport<T extends object>(value:T,prefix:string):T {
 if (typeof value === 'function') {
   const holder = { call: value }; wrap(holder, 'call', prefix+'sync', true); return holder.call as T;
 }
 for (const key of Object.keys(value)) if(typeof (value as any)[key]==='function') wrap(value,key,prefix+key,true);
 return value;
}
