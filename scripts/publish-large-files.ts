/** Bind complete or selected-client large-file collections into the main README. */
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { renderLargeFiles } from './large-file-renderer.ts';
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const root = 'results/large-files';
const path = `${root}/RESULTS.json`;
const sourceDirectory = process.argv[2];
if (sourceDirectory) {
 const incomingRaw = await readFile(join(sourceDirectory, 'RESULTS.json'));
 const incoming = JSON.parse(incomingRaw.toString());
 assert.equal(incoming.kind, 'large-native-attachments'); assert.equal(incoming.sourceUnchanged, true); assert.equal(incoming.trials, 1);
 assert.equal(incoming.fixture.bytes, 500_000_000);
 assert.deepEqual(incoming.rows.map((r: any) => r.stackId).sort(), [...incoming.plan.stacks].sort());
 const previousRaw = await readFile(path), previous = JSON.parse(previousRaw.toString());
 assert.equal(incoming.fixture.sha256, previous.fixture.sha256);
 const packageCollection = async (directory: string, raw: Uint8Array, report: any) => {
  const id = sha(raw).slice(0, 16), relative = `collections/${id}`, destination = join(root, relative);
  await mkdir(destination, { recursive: true });
  for (const file of ['RESULTS.json', 'SOURCE.json', 'SOURCE.tar.gz', 'source-files.txt']) await copyFile(join(directory, file), join(destination, file));
  return { id, path: `${relative}/RESULTS.json`, sha256: sha(raw), selectedStacks: report.rows.map((r: any) => r.stackId) };
 };
 const collections = previous.collections ?? [await packageCollection(root, previousRaw, previous)];
 const selected = new Set(incoming.rows.map((r: any) => r.stackId));
 const retained = collections.map((c: any) => ({ ...c, selectedStacks: c.selectedStacks.filter((id: string) => !selected.has(id)) })).filter((c: any) => c.selectedStacks.length);
 retained.push(await packageCollection(sourceDirectory, incomingRaw, incoming));
 const publication = { version: 2, kind: incoming.kind, measuredAt: incoming.measuredAt, trials: 1, fixture: incoming.fixture,
  plan: { stacks: previous.plan.stacks, stoppingRule: 'One attempt per client from the explicitly selected source collections; no pooled samples.' },
  collections: retained, rows: previous.rows.map((row: any) => incoming.rows.find((r: any) => r.stackId === row.stackId) ?? row), sourceUnchanged: true };
 // Validate the staged selection before replacing the public manifest.
 const staged = `${root}/.STAGED.json`; await writeFile(staged, JSON.stringify(publication, null, 2) + '\n');
 await renderLargeFiles({ path: staged, sha256: sha(await readFile(staged)), rendererSha256: sha(await readFile('scripts/large-file-renderer.ts')) }, process.cwd());
 await copyFile(staged, path); await rm(staged);
 // Legacy top-level source files now live beside their original collection.
 for (const file of ['SOURCE.json', 'SOURCE.tar.gz', 'source-files.txt']) await rm(join(root, file), { force: true });
}
const binding = { path, sha256: sha(await readFile(path)), rendererSha256: sha(await readFile('scripts/large-file-renderer.ts')) };
await renderLargeFiles(binding, process.cwd());
const summary = JSON.parse(await readFile('SUMMARY.json', 'utf8'));
summary.largeFiles = binding;
await writeFile('SUMMARY.json', JSON.stringify(summary, null, 2) + '\n');
const results = JSON.parse(await readFile('RESULTS.json', 'utf8'));
results.largeFiles = binding;
results.summarySha256 = sha(await readFile('SUMMARY.json'));
results.rendererSha256 = sha(await readFile('scripts/render-publication-summary.ts'));
await writeFile('RESULTS.json', JSON.stringify(results, null, 2) + '\n');
execFileSync(process.execPath, ['scripts/render-publication-summary.ts', 'SUMMARY.json', 'README.md'], { stdio: 'inherit' });
execFileSync('python3', ['scripts/audit-large-files.py'], { stdio: 'inherit' });
