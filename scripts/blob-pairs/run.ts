/** Controlled client-release pairs. Published n=1 artifacts are never rewritten. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cpus, loadavg, freemem, totalmem } from 'node:os';
import { prepareLargeFixture } from '../../src/attachments/large-fixture.ts';
import { runLargeFile, validateLargeFileResult, type LargeFileStack } from '../../src/attachments/large-run.ts';
import { ensureStackUp } from '../../src/stack-manager.ts';
const diagnostic = process.argv.includes('--diagnostic');
const environment = diagnostic ? '.tmp/blob-pairs-diagnostics' : '.tmp/blob-pairs';
const output=resolve(process.argv.slice(2).find(arg=>!arg.startsWith('--')) ?? (diagnostic ? '.results/blob-pairs-diagnostic-2026-09-11' : '.results/blob-pairs-2026-09-11')); await mkdir(output,{recursive:true});
assert(!await Bun.file(join(output,'RESULTS.json')).exists(),'Never overwrite a collection');
await ensureStackUp('syncular');
const server = JSON.parse(execFileSync('docker',['compose','-f','stacks/syncular/docker-compose.yml','exec','-T','syncular','bun','-e','console.log(JSON.stringify({core:require("@syncular/core/package.json").version,server:require("@syncular/server/package.json").version}))'],{encoding:'utf8'}));
assert.equal(server.server,'0.18.0');
const fixture=await prepareLargeFixture({});
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const plan:Array<{pair:number;client:LargeFileStack;version:string}>=[];
for(let pair=0;pair<(diagnostic ? 1 : 3);pair++) {
 const clients:LargeFileStack[]=pair%2 ? ['syncular-rust','syncular'] : ['syncular','syncular-rust'];
 for(const client of clients) {
  const reverse=(pair+(client==='syncular-rust'?1:0))%2;
  for(const version of reverse?['0.18.0','0.17.0']:['0.17.0','0.18.0']) plan.push({pair:pair+1,client,version});
 }
}
const runtime=[];
for(const version of ['0.17.0','0.18.0']) {
 const cwd=resolve(environment,version);
 const pkg=JSON.parse(await readFile(join(cwd,'node_modules/@syncular/client/package.json'),'utf8'));assert.equal(pkg.version,version);
 runtime.push({version,cwd,package:pkg,lockSha256:sha(await readFile(join(cwd,'bun.lock'))),cargoLockSha256:sha(await readFile(join(cwd,'drivers/syncular-rust/Cargo.lock'))),binarySha256:sha(await readFile(join(cwd,'drivers/syncular-rust/target/release/syncular-bench')))});
}
const report:any={kind:diagnostic ? 'syncular-blob-instrumented-diagnostics' : 'syncular-blob-client-release-pairs',version:1,startedAt:new Date().toISOString(),fixture,server,runtime,plan,
 profile: diagnostic ? 'Separate diagnostic runs: released JS with runtime database, crypto, full-body-slice and transport observers; native timer-only source patch plus shipped bench-internals feature. Nested spans overlap. These are NOT the unmodified-release comparison and must not replace it. See archived probes, source patch and Cargo locks.' : 'Exact registry clients, unchanged SDK sources, corrected common HTTP meter; server fixed at 0.18.0; new writer and reader processes/stores per attempt; object deleted and server task fixture reset before each attempt; OS/server caches retained; no compilation or test suite during collection. Upload includes native staging and metadata acceptance. Input read and final independent SHA-256 are outside published-style totals.',
 machine:{cpu:cpus()[0]?.model,bun:Bun.version,memoryBytes:totalmem()},publishedManifestSha256:sha(await readFile('results/large-files/RESULTS.json')),rows:[]};
await writeFile(join(output,'PLAN.json'),JSON.stringify(report,null,2)+'\n');
for(const item of plan) {
 const cwd=resolve(environment,item.version);
 const before={time:new Date().toISOString(),load:loadavg(),freeMemoryBytes:freemem()};
 console.log(`Pair ${item.pair} ${item.client} ${item.version}`);
 const result=await runLargeFile(item.client,fixture,{servicesReady:true,workerCwd:cwd,workerPath:join(cwd,'src/attachments/large-syncular-worker.ts'),binPath:item.client==='syncular-rust'?join(cwd,'drivers/syncular-rust/target/release/syncular-bench'):undefined});
 const row={...item,before,after:{time:new Date().toISOString(),load:loadavg(),freeMemoryBytes:freemem()},result};report.rows.push(row);
 await writeFile(join(output,'RESULTS.json'),JSON.stringify(report,null,2)+'\n');
 validateLargeFileResult(result,fixture);
 console.log(JSON.stringify({pair:item.pair,client:item.client,version:item.version,stageMs:result.phases[0].stageMs,uploadMs:result.uploadMs,downloadMs:result.downloadMs}));
}
report.finishedAt=new Date().toISOString();assert.equal(sha(await readFile('results/large-files/RESULTS.json')),report.publishedManifestSha256);
await writeFile(join(output,'RESULTS.json'),JSON.stringify(report,null,2)+'\n');
