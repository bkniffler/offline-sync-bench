/** Bind the validated large-file result package into the main README. */
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { renderLargeFiles } from './large-file-renderer.ts';
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const path = 'results/large-files/RESULTS.json';
const sourceDirectory = process.argv[2];
if (sourceDirectory) {
 const sourcePath = `${sourceDirectory}/RESULTS.json`;
 await renderLargeFiles({ path: sourcePath, sha256: sha(await readFile(sourcePath)), rendererSha256: sha(await readFile('scripts/large-file-renderer.ts')) }, process.cwd());
 for (const file of ['RESULTS.json', 'SOURCE.json', 'SOURCE.tar.gz', 'source-files.txt']) await copyFile(`${sourceDirectory}/${file}`, `results/large-files/${file}`);
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
