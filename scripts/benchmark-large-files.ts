/** One independently validated 500 MB upload and uncached download per native SDK. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { cpus, platform, release, totalmem } from 'node:os';
import { prepareLargeFixture, LARGE_FILE_BYTES } from '../src/attachments/large-fixture.ts';
import { largeFileStacks, runLargeFile, type LargeFileStack } from '../src/attachments/large-run.ts';
const args = process.argv.slice(2);
const arg = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const bytes = Number(arg('--bytes') ?? LARGE_FILE_BYTES);
const output = resolve(arg('--output') ?? `.results/large-files-${new Date().toISOString().replaceAll(':', '-')}`);
const selected = arg('--stack') ? [arg('--stack') as LargeFileStack] : [...largeFileStacks];
if (selected.some(id => !largeFileStacks.includes(id))) throw new Error('Choose a native attachment client');
if (bytes !== LARGE_FILE_BYTES && !arg('--output')) throw new Error('Development sizes require a separate --output directory');
await mkdir(output, { recursive: true });
try { await readFile(join(output, 'RESULTS.json')); throw new Error('Output already has a run; use a new directory to retain all attempts'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
console.log(`Preparing and verifying ${bytes.toLocaleString()} bytes in .cache/attachments`);
const payload = await prepareLargeFixture({ bytes, url: arg('--url') });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const files = [...new Set([
 ...execFileSync('git', ['ls-files', 'src', 'services', 'stacks', 'drivers'], { encoding: 'utf8' }).trim().split('\n'),
 ...(await readdir('src/attachments')).filter(n => n.endsWith('.ts')).map(n => `src/attachments/${n}`),
 'scripts/benchmark-large-files.ts', 'package.json', 'bun.lock',
])].sort();
const inputs = await Promise.all(files.map(async path => ({ path, sha256: sha(await readFile(path)) })));
const listPath = join(output, 'source-files.txt'); await writeFile(listPath, files.join('\n') + '\n');
execFileSync('tar', ['-czf', join(output, 'SOURCE.tar.gz'), '-T', listPath]);
const source = { files: inputs, archive: 'SOURCE.tar.gz', sha256: sha(await readFile(join(output, 'SOURCE.tar.gz'))) };
await writeFile(join(output, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
const report: any = {
 version: 1, kind: 'large-native-attachments', measuredAt: new Date().toISOString(), trials: 1,
 fixture: { ...payload, path: relative(process.cwd(), payload.path) },
 plan: { stacks: selected, phases: ['writer', 'fresh'], phaseTimeoutMs: 600_000, stoppingRule: 'One attempt per client, sequentially; preserve failures; no automatic retries.' },
 machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), bun: Bun.version },
 source: { path: 'SOURCE.json', sha256: sha(await readFile(join(output, 'SOURCE.json'))) },
 rows: [],
};
await writeFile(join(output, 'RESULTS.json'), JSON.stringify(report, null, 2) + '\n');
for (const stack of selected) {
 console.log(`Starting ${stack}: one upload, then a new empty-cache download process`);
 const row = await runLargeFile(stack, payload); report.rows.push(row);
 await writeFile(join(output, 'RESULTS.json'), JSON.stringify(report, null, 2) + '\n');
 console.log(JSON.stringify({ stack, status: row.status, uploadMs: row.uploadMs, downloadMs: row.downloadMs, error: row.error }));
}
for (const input of inputs) if (sha(await readFile(input.path)) !== input.sha256) throw new Error(`Source changed during collection: ${input.path}; do not publish this run`);
report.sourceUnchanged = true;
await writeFile(join(output, 'RESULTS.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Saved ${join(output, 'RESULTS.json')}`);
