import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export const clientSizeRows = [
 ['Syncular JS','syncular-client-root-named'],['Syncular Rust',null],['PowerSync','powersync-minimal'],['Turso',null],
 ['Zero','zero-minimal'],['Electric','electric-minimal'],['Electric + TanStack DB','electric-tanstack-combo'],['Jazz v2 (experimental)','jazz-v2-minimal'],
] as const;
export async function renderClientSize(binding: { path: string; sha256: string; rendererSha256: string }, base: string): Promise<string[]> {
 assert.equal(createHash('sha256').update(await readFile(import.meta.path)).digest('hex'),binding.rendererSha256,'Stale client-size renderer');
 const bytes=await readFile(resolve(base,binding.path));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),binding.sha256,'Stale client-size binding');
 const data=JSON.parse(bytes.toString());assert.equal(data.kind,'browser-client-javascript-size');
 assert.deepEqual(data.rows.map((r:any)=>r.id).sort(),clientSizeRows.flatMap(([,id])=>id?[id]:[]).sort());
 const rows=clientSizeRows.map(([label,id])=>{
  if(!id)return `| ${label} | Not applicable \\* | Not applicable \\* |`;
  const r=data.rows.find((r:any)=>r.id===id);assert.equal(r.status,'completed');assert.equal(r.profile,'named-import');
  for(const key of ['rawBytes','gzipBytes'])assert(Number.isSafeInteger(r[key])&&r[key]>0);
  return `| ${label} | ${(r.rawBytes/1024).toFixed(2)} KiB | ${(r.gzipBytes/1024).toFixed(2)} KiB |`;
 });
 return ['### Client JavaScript size','',
  'Build a browser bundle exporting each client’s sync API. Measure all emitted JavaScript after minification and gzip compression. **JavaScript only:** additional WASM, runtime-loaded workers and storage engines are excluded. Smaller is better; 1 KiB = 1,024 bytes.','',
  '| Client | Minified JS | Gzip JS |','| --- | ---: | ---: |',...rows,'',
  '\\* Syncular Rust and Turso use native clients in these benchmarks, so browser JavaScript size does not apply to those tested clients. PowerSync’s size uses its Web SDK; its latency tests use Node.','',
  '[Build details and exact imports](./results/client-size/README.md) · [Scope and excluded assets](./docs/appendices/deployment-footprint.md)',''];
}
