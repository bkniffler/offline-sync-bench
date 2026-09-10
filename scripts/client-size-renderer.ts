import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { footprintTotals } from '../src/client-footprint/artifacts.ts';
export const clientSizeRows = [
 ['Syncular JS','syncular'],['Syncular Rust',null],['PowerSync','powersync'],['Turso',null],
 ['Zero','zero'],['Electric','electric'],['Electric + TanStack DB','electric-tanstack'],['Jazz v2 (experimental)','jazz'],
] as const;
export async function renderClientSize(binding: { path: string; sha256: string; rendererSha256: string }, base: string): Promise<string[]> {
 const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
 assert.equal(sha(await readFile(import.meta.path)), binding.rendererSha256, 'Stale client-size renderer');
 const bytes = await readFile(resolve(base,binding.path)); assert.equal(sha(bytes), binding.sha256, 'Stale client-size binding');
 const data = JSON.parse(bytes.toString()); assert.equal(data.kind, 'browser-client-runtime-footprint');
 assert.deepEqual(data.clients.map((c: any) => c.id).sort(), clientSizeRows.flatMap(([,id]) => id ? [id] : []).sort());
 const rows = clientSizeRows.map(([label,id]) => {
  if (!id) return `| ${label} | Not applicable \\* | Not applicable \\* | Not applicable \\* |`;
  const c = data.clients.find((c: any) => c.id === id); assert.equal(c.status, 'completed');
  assert.deepEqual(footprintTotals(c.assets), { rawBytes: c.rawBytes, gzipBytes: c.gzipBytes });
  const size = (v: any) => `${(v.rawBytes / 1024).toFixed(2)}/${(v.gzipBytes / 1024).toFixed(2)} KiB`;
  assert.equal(c.core.rawBytes + c.storageAssets.rawBytes, c.rawBytes);
  assert.equal(c.core.gzipBytes + c.storageAssets.gzipBytes, c.gzipBytes);
  const mark = id === 'electric' ? ' \\*\\*' : id === 'jazz' ? ' \\*\\*\\*' : '';
  return `| ${label}${mark} | ${size(c.core)} | ${size(c.storageAssets)} | ${size(c)} |`;
 });
 return ['### Browser client size','',
  'Initialize a real browser client and verify local storage across a reload. Count the requested JavaScript, workers and WASM—including embedded WASM—once per file. JavaScript is minified; gzip totals use level 9. These are storage-ready startup sizes. Each cell shows **raw/gzip KiB**. Core includes SDK code and shared adapters; Storage includes separate engine loaders, workers and WASM. Integrated storage code stays in Core. 1 KiB = 1,024 bytes.','',
  '| Client | Core | Storage | Total |','| --- | ---: | ---: | ---: |', ...rows, '',
  '\\* Syncular Rust and Turso use native-host clients in this harness. PowerSync uses its Web SDK for this comparison.','',
  '\\*\\* Plain Electric is an in-memory, read-only client and refetches after reload; it is not an equivalent persistent offline client.','',
  '\\*\\*\\* Jazz’s WASM contains both storage and sync logic; its Storage figure is not a pure database size. TanStack includes native SQLite persistence and an IndexedDB outbox; its worker’s embedded WASM is counted once.','',
  '[Browser checks and complete asset inventory](./results/client-size/README.md) · [Scope and configurations](./docs/appendices/deployment-footprint.md)',''];
}
