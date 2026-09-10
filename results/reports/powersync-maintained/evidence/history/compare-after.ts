import { rm } from 'node:fs/promises';
import { NetworkGate } from '../src/recovery/network-gate.ts';
const gate=new NetworkGate('http://127.0.0.1:3217');await gate.start();
const modes=[['direct','http://127.0.0.1:3217'],['relay',gate.url]];
await Promise.all(modes.map(async([mode,url])=>{await rm(`.tmp/powersync-${mode}-probe.jsonl`,{force:true}); await rm(`.tmp/powersync-${mode}-probe.stderr`,{force:true});
 const child=Bun.spawn(['node','--experimental-strip-types','.tmp/powersync-setup-client.ts',mode,url],{stdout:Bun.file(`.tmp/powersync-${mode}-probe.jsonl`),stderr:Bun.file(`.tmp/powersync-${mode}-probe.stderr`)});console.log(mode,await child.exited);}));
console.log(JSON.stringify(gate.snapshot()));await gate.close();
