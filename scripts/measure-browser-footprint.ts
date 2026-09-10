import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ensureStackUp, seedStack } from '../src/stack-manager.ts';
import { BrowserProcess } from '../src/browser/process.ts';
const require = createRequire(import.meta.url);
const rootOf = (name: string) => dirname(require.resolve(`${name}/package.json`));
const pkg = (name: string) => { let path = dirname(require.resolve(name)); while (!require('node:fs').existsSync(join(path, 'package.json'))) path = dirname(path); return path; };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['syncular','powersync','zero','electric','electric-tanstack','jazz'];
if (ids.some(id => ['electric','electric-tanstack'].includes(id))) {
 await ensureStackUp('electric');
 await seedStack('electric', { resetFirst: true, orgCount: 1, projectsPerOrg: 1, usersPerOrg: 2, tasksPerProject: 1, membershipsPerProject: 2 });
}
const output = resolve('.tmp/browser-footprint'); await mkdir(output, { recursive: true });
const executable = process.env.BENCH_CHROMIUM ?? JSON.parse(await readFile('campaigns/browser-smoke.json', 'utf8')).runtime.executable;
for (const id of ids) {
 const folder = join(output, id); await rm(folder, { recursive: true, force: true }); await mkdir(folder, { recursive: true });
 const entries: Record<string,string> = { entry: `src/client-footprint/${id}.ts` };
 if (id === 'syncular') { entries['syncular-worker'] = 'src/client-footprint/syncular-worker.ts'; entries['sqlite-runtime'] = 'src/client-footprint/sqlite-runtime.ts'; }
 if (id === 'powersync') entries['powersync-worker'] = join(pkg('@powersync/web'), 'lib/worker/worker.js');
 if (id === 'jazz') { entries['jazz-worker'] = join(pkg('jazz-tools'), 'dist/worker/jazz-worker.js'); entries['jazz-broker-worker'] = join(pkg('jazz-tools'), 'dist/worker/jazz-broker-worker.js'); }
 const built = await build({ entryPoints: entries, outdir: folder, bundle: true, platform: 'browser', format: 'esm', splitting: true, minify: true, sourcemap: false, metafile: true, target: ['es2022'], logLevel: 'silent' });
 await writeFile(join(folder, 'BUILD.json'), JSON.stringify(built.metafile, null, 2));
 if (id === 'syncular') {
  await copyFile(join(pkg('@sqlite.org/sqlite-wasm'), 'dist/sqlite3.wasm'), join(folder, 'sqlite3.wasm'));
  const proxy = await readFile(join(pkg('@sqlite.org/sqlite-wasm'), 'dist/sqlite3-opfs-async-proxy.js'), 'utf8');
  await writeFile(join(folder, 'sqlite3-opfs-async-proxy.js'), (await transform(proxy, { minify: true, target: 'es2022' })).code);
 }
 if (id === 'powersync') {
  const wa = dirname(createRequire(require.resolve('@powersync/web')).resolve('@journeyapps/wa-sqlite/dist/wa-sqlite.mjs'));
  for (const name of ['wa-sqlite','wa-sqlite-async','mc-wa-sqlite','mc-wa-sqlite-async']) await copyFile(join(wa, `${name}.wasm`), join(folder, `${name}.wasm`));
 }
 if (id === 'jazz') await copyFile(join(pkg('jazz-wasm'), 'pkg/jazz_wasm_bg.wasm'), join(folder, 'jazz_wasm_bg.wasm'));
 if (id === 'electric-tanstack') {
  const assets = join(pkg('@tanstack/browser-db-sqlite-persistence'), 'dist/assets');
  await mkdir(join(folder, 'assets'));
  for (const name of require('node:fs').readdirSync(assets).filter((n: string) => n.endsWith('.js'))) {
   await writeFile(join(folder, 'assets', name), (await transform(await readFile(join(assets, name), 'utf8'), { minify: true, target: 'es2022' })).code);
  }
 }
 let currentPhase = 'write';
 const requests: any[] = [];
 const headers = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
 const server = Bun.serve({ port: 0, async fetch(request) {
  const url = new URL(request.url), path = decodeURIComponent(url.pathname);
  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  if (path === '/health') return new Response('<!doctype html><title>Client footprint</title>', { headers: { ...headers, 'content-type': 'text/html' } });
  if (path === '/shape' && id === 'electric-tanstack' && currentPhase === 'reopen') return new Response('offline reopen', { status: 503 });
  if (path === '/shape') return fetch(`http://localhost:3213/v1/shape${url.search}`);
  if (!/^\/(?:assets\/)?[\w-]+(?:\.[\w-]+)*\.(js|wasm)$/.test(path)) { requests.push({ path, status: 404 }); return new Response('Missing', { status: 404 }); }
  const file = Bun.file(join(folder, path.slice(1)));
  if (!await file.exists()) { requests.push({ path, status: 404 }); return new Response('Missing asset', { status: 404 }); }
  requests.push({ path, status: 200 });
  return new Response(file, { headers: { ...headers, 'content-type': path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' } });
 } });
 const profile = await mkdtemp(join(output, 'profile-')); const browser = new BrowserProcess(executable, profile, { netLogPath: join(folder, 'NETLOG.json') });
 const result: any = { id, measuredAt: new Date().toISOString(), profileWasEmpty: true, requests, build: built.metafile, verification: [] };
 try {
  result.browser = await browser.connect(server.url.origin, '');
  await browser.command('Runtime.enable', {}, true);
  for (const phase of ['write','reopen']) {
   currentPhase = phase;
   if (phase === 'reopen') {
    await browser.command('Page.navigate', { url: `${server.url.origin}/health?reopen` }, true);
    await new Promise(resolve => setTimeout(resolve, 200));
   }
   assert.equal(await browser.evaluate('typeof globalThis.sizeProbe'), 'undefined', 'Probe must start in a new document');
   const documentTimeOrigin = await browser.evaluate('performance.timeOrigin');
   await browser.evaluate("import('/entry.js')");
   const proof = await browser.evaluate(`Promise.race([globalThis.sizeProbe(${JSON.stringify(phase)}), new Promise((_, reject) => setTimeout(()=>reject(new Error('Client initialization exceeded 60 seconds')),60000))])`);
   result.verification.push({ phase, documentTimeOrigin, serverReadsBlocked: id === 'electric-tanstack' && phase === 'reopen', ...proof });
   assert.equal(proof.rows.length, 1, `${id} must read one real row`);
   if (!id.startsWith('electric')) assert.deepEqual(proof.rows, [{ id: 'task-1', title: 'footprint' }]);
  }
  assert(!requests.some(r => r.status !== 200), 'Required asset missing');
  result.status = 'completed';
 } catch (error) { result.status = 'failed'; result.error = String(error); }
 finally { result.cleanup = await browser.close(); server.stop(true); await rm(profile, { recursive: true, force: true }); }
 const netlog = JSON.parse(await readFile(join(folder, 'NETLOG.json'), 'utf8'));
 result.networkUrls = [...new Set(netlog.events.flatMap((event: any) => typeof event.params?.url === 'string' && /^https?:/.test(event.params.url) ? [event.params.url] : []))].sort();
 result.assetUrls = result.networkUrls.filter((url: string) => /\.(?:js|wasm)$/.test(new URL(url).pathname));
 assert(result.assetUrls.every((url: string) => new URL(url).origin === server.url.origin), 'Uncounted external runtime asset');
 result.assets = await Promise.all([...new Set(requests.filter(r => r.status === 200).map(r => r.path as string))].sort().map(async path => {
  const data = await readFile(join(folder, path.slice(1)));
  return { path, bytes: data.length, gzipBytes: gzipSync(data, { level: 9 }).length, sha256: sha(data), type: path.endsWith('.wasm') ? 'wasm' : 'javascript' };
 }));
 assert.deepEqual([...new Set(result.assetUrls.map((url: string) => new URL(url).pathname))].sort(), result.assets.map((a: any) => a.path).sort(), 'Browser-wide network trace and served assets disagree');
 await writeFile(join(folder, 'RESULTS.json'), JSON.stringify(result, null, 2) + '\n');
 console.log(JSON.stringify({ id, status: result.status, error: result.error, assets: result.assets.map((a: any) => [a.path,a.bytes]), proof: result.verification }));
}
