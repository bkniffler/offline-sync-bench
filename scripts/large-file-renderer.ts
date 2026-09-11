import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateLargeFileResult } from '../src/attachments/large-run.ts';
export const largeFileLabels = [['syncular','Syncular JS'],['syncular-rust','Syncular Rust'],['powersync','PowerSync'],['turso','Turso'],['zero','Zero'],['electric','Electric'],['electric-tanstack','Electric + TanStack DB'],['jazz-v2','Jazz v2 (experimental)']] as const;
export async function renderLargeFiles(binding: { path: string; sha256: string; rendererSha256: string }, base: string) {
 const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
 assert.equal(sha(await readFile(import.meta.path)), binding.rendererSha256);
 const raw = await readFile(resolve(base, binding.path)); assert.equal(sha(raw), binding.sha256);
 const data = JSON.parse(raw.toString());
 assert.equal(data.kind, 'large-native-attachments'); assert.equal(data.fixture.bytes, 500_000_000);
 assert.equal(data.trials, 1); assert.equal(data.sourceUnchanged, true);
 assert.deepEqual(data.rows.map((r: any) => r.stackId).sort(), ['syncular','syncular-rust','powersync','jazz-v2'].sort());
 if (data.collections) {
  const selected = new Set<string>();
  for (const collection of data.collections) {
   const rawCollection = await readFile(resolve(base, dirname(binding.path), collection.path));
   assert.equal(sha(rawCollection), collection.sha256, 'Collection digest mismatch');
   const source = JSON.parse(rawCollection.toString());
   assert(source.sourceUnchanged); assert.equal(source.trials, 1);
   assert.equal(source.fixture.sha256, data.fixture.sha256); assert.equal(source.fixture.bytes, data.fixture.bytes);
   for (const id of collection.selectedStacks) {
    assert(!selected.has(id), 'Duplicate selected client'); selected.add(id);
    assert.deepEqual(data.rows.find((r: any) => r.stackId === id), source.rows.find((r: any) => r.stackId === id), 'Result differs from collected receipt');
   }
  }
  assert.deepEqual([...selected].sort(), data.rows.map((r: any) => r.stackId).sort());
 }
 const notes: string[] = [];
 const note = (text: string) => { let index = notes.indexOf(text); if (index < 0) { index = notes.length; notes.push(text); } return '\\*'.repeat(index + 1); };
 const rows = largeFileLabels.map(([id, label]) => {
  const result = data.rows.find((r: any) => r.stackId === id);
  if (!result) { const star = note('These libraries have no native attachment upload/download feature; Electric is read-only.'); return `| ${label} | Not supported ${star} | Not supported ${star} |`; }
  if (result.status !== 'completed') {
   assert(['failed','timed-out'].includes(result.status));
   const star = note(data.explanations?.[id] ?? `${label}: ${String(result.error).replaceAll('|', '/').replaceAll('\n',' ').slice(0, 300)}`);
   const status = result.status === 'timed-out' ? 'Timed out' : 'Failed';
   return `| ${label} | ${status} ${star} | ${status} ${star} |`;
  }
  validateLargeFileResult(result, data.fixture);
  const caveat = id === 'syncular' || id === 'syncular-rust' ? 'Syncular JS/Rust 0.18.0: upload includes metadata acceptance; JS metering no longer buffers the upload body again, and Rust uses the public fetch_blob_bytes() API without hex encoding. Other clients retain their earlier results.'
   : id === 'powersync' ? 'PowerSync uses its experimental native attachment queue and filesystem transport. Its retained upload timing excludes the final metadata-acceptance wait, so it has a different stopping point from Syncular.'
   : id === 'jazz-v2' ? 'Jazz uses its default 256 KiB chunks (1,908 parts). Its native helper awaits each part insertion; the other measured clients transfer whole objects through MinIO.' : '';
  const star = caveat ? ` ${note(caveat)}` : '';
  return `| ${label} | ${result.uploadMs.toFixed(2)} ms${star} | ${result.downloadMs.toFixed(2)} ms${star} |`;
 });
 return ['### Uploading and downloading a 500 MB file', '',
  'Upload one 500,000,000-byte file linked to a task, then download it in a new process with an empty client cache. Upload includes native staging; download ends when complete bytes are materialized. Verify the full SHA-256 hash. One run per client (n=1), using local services; file preparation and final hash validation are outside the clock.', '',
  '| Client | Upload | Fresh download |', '| --- | ---: | ---: |', ...rows, '',
  ...notes.flatMap((text, i) => [`${'\\*'.repeat(i + 1)} ${text}`, '']),
  '[Workload, cached fixture and raw results](./results/large-files/README.md)', ''];
}
