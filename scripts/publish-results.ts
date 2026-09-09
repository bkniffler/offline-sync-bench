import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishCampaign, validateManifest } from '../src/campaign-report.ts';
import { reportDetailsPath } from '../src/report-editorial.ts';

const usage = 'bun scripts/publish-results.ts --campaign CAMPAIGN.json --assets DIRECTORY --output NEW_DIRECTORY';
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  if (!['--campaign', '--assets', '--output'].includes(flag) || !value || value.startsWith('--') || flags.has(flag)) throw new Error(usage);
  flags.set(flag, value);
}
if (flags.size !== 3) throw new Error(usage);
const campaignPath = resolve(flags.get('--campaign')!);
const assets = await realpath(resolve(flags.get('--assets')!));
const requestedOutput = resolve(flags.get('--output')!);
const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
const manifest = JSON.parse(await readFile(campaignPath, 'utf8'));
validateManifest(manifest);
if (existsSync(output)) throw new Error('Output must be a new directory');
if (!(await stat(assets)).isDirectory()) throw new Error('Assets must be a directory');
const withinAssets = relative(assets, output);
if (withinAssets !== '..' && !withinAssets.startsWith('../') && !withinAssets.startsWith('/')) throw new Error('Output must be outside the assets directory');
for (const name of ['RESULTS.json', 'RESULTS.md', 'ARCHIVE.json', 'RESTORE.py']) {
  if (existsSync(join(assets, name))) throw new Error(`Assets must not contain generated ${name}`);
}
async function checkAssets(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Assets must not contain symlinks');
    if (entry.isDirectory()) await checkAssets(join(directory, entry.name));
  }
}
await checkAssets(assets);
const work = await mkdtemp(join(dirname(output), '.publication-build-'));
const build = join(work, 'published'), packed = join(work, 'packed'), restored = join(work, 'restored');
const packager = fileURLToPath(new URL('./package-publication.py', import.meta.url));
async function archive(command: 'pack' | 'restore', source: string, destination: string) {
  const child = Bun.spawn(['python3', packager, command, source, destination], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Archive ${command} failed: ${stderr || stdout}`);
  return JSON.parse(stdout);
}
try {
  await cp(assets, build, { recursive: true, force: false, errorOnExist: true });
  await publishCampaign(campaignPath, build);
  const packaged = await archive('pack', build, packed);
  const checked = await archive('restore', packed, restored);
  const names = ['RESULTS.json', 'RESULTS.md', reportDetailsPath(manifest.id)];
  const original = await Promise.all(names.map(name => readFile(join(restored, name))));
  await publishCampaign(join(restored, 'RESULTS.json'), restored);
  for (let i = 0; i < names.length; i++) {
    if (!original[i].equals(await readFile(join(restored, names[i])))) throw new Error(`Regeneration changed ${names[i]}`);
  }
  if (existsSync(output)) throw new Error('Output appeared during publication; refusing to replace it');
  await rename(packed, output);
  await rm(work, { recursive: true, force: true });
  console.log(JSON.stringify({ status: 'published-and-restored', output, campaignId: manifest.id, packaged, checked }, null, 2));
} catch (error) {
  console.error(`Publication failed. Temporary evidence remains at ${work}`);
  throw error;
}
