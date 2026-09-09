import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { restoreSourceSnapshot } from './source-snapshot.ts';

const args = process.argv.slice(2);
function flag(name: string) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const manifestPath = flag('--manifest'), output = flag('--out');
if (!manifestPath || !output) throw new Error('Use --manifest <CAMPAIGN.json or RESULTS.json> --out <new-directory> [--snapshot <SOURCE.json>]');
const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
const defaultPath = join(dirname(resolve(manifestPath)), String(manifest.source?.snapshot?.path ?? 'SOURCE.json'));
const bytes = await readFile(resolve(flag('--snapshot') ?? defaultPath));
await restoreSourceSnapshot(bytes, manifest.source, resolve(output));
console.log(`Restored and verified ${Object.keys(manifest.source.files).length} source entries in ${resolve(output)}. Revision ${manifest.source.revision}; dirty=${manifest.source.dirty}. Install the recorded dependencies before running the benchmark.`);
