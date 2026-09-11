/** Publish validated single runs or all candidate samples from controlled release pairs. */
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { renderLargeFiles } from './large-file-renderer.ts';
import { digest as sha, singleRunSampling, summarizeLargeFilePairs } from '../src/attachments/large-publication.ts';
const root = 'results/large-files';
const path = `${root}/RESULTS.json`;
const controlled = process.argv[2] === '--controlled' ? process.argv[3] : undefined;
assert(process.argv[2] !== '--controlled' || controlled, 'Pass the controlled PAIRS.json path');
const sourceDirectory = controlled ? undefined : process.argv[2];
if (controlled || sourceDirectory) {
 const previous = JSON.parse(await readFile(path, 'utf8'));
 assert(previous.collections, 'Source collections are required');
 let incoming: any, rows: any[], sampling: Record<string, any>, collection: any;
 if (controlled) {
  const raw = await readFile(controlled);
  incoming = JSON.parse(raw.toString());
  ({ rows, sampling } = summarizeLargeFilePairs(incoming));
  collection = { kind: 'controlled-client-release-pairs', id: sha(raw).slice(0, 16), path: relative(resolve(root), resolve(controlled)), sha256: sha(raw), selectedStacks: rows.map(r => r.stackId) };
 } else {
  const raw = await readFile(join(sourceDirectory!, 'RESULTS.json'));
  incoming = JSON.parse(raw.toString());
  assert.equal(incoming.kind, 'large-native-attachments');
  assert.equal(incoming.sourceUnchanged, true);
  assert.equal(incoming.trials, 1);
  rows = incoming.rows;
  assert.deepEqual(rows.map(r => r.stackId).sort(), [...incoming.plan.stacks].sort());
  sampling = Object.fromEntries(rows.map(r => [r.stackId, singleRunSampling]));
  const id = sha(raw).slice(0, 16), destination = join(root, 'collections', id);
  await mkdir(destination, { recursive: true });
  for (const file of ['RESULTS.json', 'SOURCE.json', 'SOURCE.tar.gz', 'source-files.txt']) await copyFile(join(sourceDirectory!, file), join(destination, file));
  collection = { kind: 'single-run', id, path: `collections/${id}/RESULTS.json`, sha256: sha(raw), selectedStacks: rows.map(r => r.stackId) };
 }
 assert.equal(incoming.fixture.bytes, 500_000_000);
 assert.equal(incoming.fixture.sha256, previous.fixture.sha256);
 const selected = new Set(rows.map(r => r.stackId));
 const retained = previous.collections.map((c: any) => ({ ...c, selectedStacks: c.selectedStacks.filter((id: string) => !selected.has(id)) })).filter((c: any) => c.selectedStacks.length);
 const priorSampling = previous.sampling ?? Object.fromEntries(previous.rows.map((r: any) => [r.stackId, singleRunSampling]));
 const publication = { version: 3, aggregation: { path: 'src/attachments/large-publication.ts', sha256: sha(await readFile('src/attachments/large-publication.ts')) }, kind: 'large-native-attachments', measuredAt: incoming.finishedAt ?? incoming.measuredAt, fixture: previous.fixture,
  sampling: { ...priorSampling, ...sampling },
  plan: { stacks: previous.plan.stacks, stoppingRule: 'Use every candidate sample from selected controlled collections; retain independently collected single-run clients. No pooling across collections or choosing a representative run.' },
  collections: [...retained, collection], rows: previous.rows.map((row: any) => rows.find(r => r.stackId === row.stackId) ?? row), sourceUnchanged: true };
 const staged = `${root}/.STAGED.json`;
 await writeFile(staged, JSON.stringify(publication, null, 2) + '\n');
 try {
  await renderLargeFiles({ path: staged, sha256: sha(await readFile(staged)), rendererSha256: sha(await readFile('scripts/large-file-renderer.ts')) }, process.cwd());
  await copyFile(staged, path);
 } finally { await rm(staged, { force: true }); }
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
