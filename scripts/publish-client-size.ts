/** One deterministic build per browser entrypoint; no service or latency runs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { measureAllBundles, getBundleTargetsByIds, resolveEntrySource, resolveInstalledVersion, tempRoot } from '../src/bundle-size.ts';
const output='results/client-size';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const ids=['syncular-client-root-named','powersync-minimal','zero-minimal','electric-minimal','electric-tanstack-combo','jazz-v2-minimal'];
const targets=getBundleTargetsByIds(ids);
await mkdir(output,{recursive:true});
const rows=await measureAllBundles(targets);
assert(rows.every(row=>row.status==='completed'),'Every selected entrypoint must build; inspect build errors before publishing');
const artifacts=[];
for(const row of rows){
 const dir=join(tempRoot,`out-${row.id}`);let rawBytes=0,gzipBytes=0,count=0;
 for(const name of await readdir(dir)){
  if(!name.endsWith('.js'))continue;
  const raw=await readFile(join(dir,name)),gzip=gzipSync(raw,{level:9});
  assert.deepEqual(gunzipSync(gzip),raw);
  const path=`artifacts/${row.id}/${name}.gz`;await mkdir(join(output,'artifacts',row.id),{recursive:true});
  await writeFile(join(output,path),gzip);rawBytes+=raw.length;gzipBytes+=gzip.length;count++;
  artifacts.push({target:row.id,path,bytes:raw.length,gzipBytes:gzip.length,sha256:sha(raw),gzipSha256:sha(gzip)});
 }
 assert.deepEqual([rawBytes,gzipBytes,count],[row.rawBytes,row.gzipBytes,row.artifactCount]);
}
const inputs=[];
for(const path of ['src/bundle-size.ts','scripts/publish-client-size.ts','package.json','bun.lock']){
 const raw=await readFile(path),archive=`inputs/${basename(path)}.gz`;
 await mkdir(join(output,'inputs'),{recursive:true});await writeFile(join(output,archive),gzipSync(raw,{level:9}));
 inputs.push({path,archive,sha256:sha(raw)});
}
const manifest={version:1,kind:'browser-client-javascript-size',measuredAt:new Date().toISOString(),bunVersion:Bun.version,
 scope:'Minified browser ESM for named public client exports, including emitted JS chunks. Excludes externally loaded workers, WASM, storage engines and application code. Not a complete working-client deployment.',
 settings:{target:'browser',format:'esm',minify:true,splitting:true,sourcemap:'none',gzipLevel:9,unitBytes:1024},
 versions:Object.fromEntries(await Promise.all(['@syncular/client','@electric-sql/client','@rocicorp/zero','@powersync/web','@tanstack/db','@tanstack/electric-db-collection','@tanstack/offline-transactions','jazz-tools'].map(async name=>[name,await resolveInstalledVersion(name)]))),
 entries:targets.map(t=>({id:t.id,source:resolveEntrySource(t)})),rows,artifacts,inputs};
await writeFile(join(output,'RESULTS.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(join(output,'README.md'),[
 '# Client JavaScript size','',
 'Build one minified browser entrypoint per client and count all emitted JavaScript chunks. Public exports stay exported so tree shaking cannot replace the entrypoint with an array length. Gzip uses level 9 on each file separately; 1 KiB is 1,024 bytes. This is a code-size measurement, not another latency round.','',
 '| Client | SDK version | Minified JS | Gzip JS |','| --- | --- | ---: | ---: |',
 ...rows.map(r=>`| ${r.label} | ${r.version} | ${r.rawKb!.toFixed(2)} KiB | ${r.gzipKb!.toFixed(2)} KiB |`),'',
 '**Scope:** browser JavaScript only. SDKs can fetch additional WASM, workers or storage engines; those assets are not included. PowerSync uses its browser SDK, while its latency tests use Node. Syncular Rust and Turso use native clients in this harness and are not browser-bundle measurements. Imports do not establish equivalent application functionality.','',
 '[Exact entrypoints, dependency versions, inputs and file hashes](./RESULTS.json). The adjacent `artifacts/` directory contains the actual gzip-compressed emitted JS. `inputs/` preserves the builder, publication script, package manifest and lockfile. Build once with `bun scripts/publish-client-size.ts`; verify with `python3 scripts/audit-client-size.py`.','',
 '[How these sizes differ from a full client installation](../../docs/appendices/deployment-footprint.md) · [Benchmark overview](../../README.md#client-javascript-size)','',
].join('\n'));
console.log(JSON.stringify(rows.map(r=>({id:r.id,minifiedKiB:r.rawKb,gzipKiB:r.gzipKb}))));
