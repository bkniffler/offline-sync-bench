/** Build and admit functioning browser/storage configurations before publishing sizes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { assetCategory, embeddedWasm, footprintIds, footprintTotals, validateRuntimeReceipt } from '../src/client-footprint/artifacts.ts';
import { renderClientSize } from './client-size-renderer.ts';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
execFileSync(process.execPath, ['scripts/measure-browser-footprint.ts'], { stdio: 'inherit' });
const folder = resolve('.tmp/client-footprint-publication'); await rm(folder, { recursive: true, force: true }); await mkdir(folder, { recursive: true });
const sourceFiles = new Set(['package.json','bun.lock','scripts/publish-client-size.ts','scripts/measure-browser-footprint.ts','scripts/client-size-renderer.ts','src/browser/process.ts','src/client-footprint/artifacts.ts']);
const clients: any[] = [];
const archiveFile = async (path: string, bytes: Uint8Array) => {
 const gzip = gzipSync(bytes, { level: 9 }); const archive = `${path}.gz`;
 await mkdir(join(folder, archive, '..'), { recursive: true }); await writeFile(join(folder, archive), gzip);
 return { archive, bytes: bytes.length, sha256: sha(bytes), gzipBytes: gzip.length, gzipSha256: sha(gzip) };
};
for (const id of footprintIds) {
 const buildDirectory = resolve('.tmp/browser-footprint', id);
 const bytes = await readFile(join(buildDirectory, 'RESULTS.json')); const receipt = JSON.parse(bytes.toString());
 validateRuntimeReceipt(receipt);
 for (const input of Object.keys(receipt.build.inputs)) sourceFiles.add(relative(process.cwd(), resolve(input)));
 const evidence = await archiveFile(`evidence/${id}.json`, bytes);
 const network = await archiveFile(`evidence/${id}-netlog.json`, await readFile(join(buildDirectory, 'NETLOG.json')));
 const assets = [];
 for (const asset of receipt.assets) {
  const data = await readFile(join(buildDirectory, asset.path.slice(1)));
  assert.equal(sha(data), asset.sha256); assert.equal(data.length, asset.bytes);
  const captured = await archiveFile(`assets/${id}${asset.path}`, data);
  assert.equal(captured.gzipBytes, asset.gzipBytes);
  const buildOutput: any = Object.entries(receipt.build.outputs).find(([path]) => resolve(path) === join(buildDirectory, asset.path.slice(1)))?.[1];
  const inputs = Object.keys(buildOutput?.inputs ?? {});
  assets.push({ path: asset.path, type: asset.type, category: assetCategory(id, asset, inputs), ...captured, embeddedWasm: asset.type === 'javascript' ? embeddedWasm(data) : [] });
 }
 const wasm = assets.filter(a => a.type === 'wasm').length + assets.reduce((n, a) => n + a.embeddedWasm.length, 0);
 if (!['zero','electric'].includes(id)) assert(wasm > 0, `${id} must include its functioning native storage WASM`);
 clients.push({ id, status: 'completed', measuredAt: receipt.measuredAt, storage: receipt.verification[0].storage, persistent: id !== 'electric',
  ...footprintTotals(assets), assetCount: assets.length, core: assets.filter(a => a.category === 'core').length ? footprintTotals(assets.filter(a => a.category === 'core')) : { rawBytes: 0, gzipBytes: 0 }, storageAssets: assets.filter(a => a.category === 'storage').length ? footprintTotals(assets.filter(a => a.category === 'storage')) : { rawBytes: 0, gzipBytes: 0 }, assets, evidence, network, browserVersion: receipt.browser.version.product,
  verification: receipt.verification, omittedBuildOutputs: Object.keys(receipt.build.outputs).map(p => relative(buildDirectory, resolve(p))).filter(p => !assets.some(a => a.path === `/${p}`)) });
}
// Preserve the exact build inputs, including dependency code, rather than import declarations alone.
const inputs = await Promise.all([...sourceFiles].sort().map(async path => ({ path, bytes: (await readFile(path)).length, sha256: sha(await readFile(path)) })));
await writeFile(join(folder, 'source-files.txt'), inputs.map(i => i.path).join('\n') + '\n');
execFileSync('tar', ['--no-xattrs', '-czf', join(folder, 'SOURCE.tar.gz'), '-T', join(folder, 'source-files.txt')], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
await rm(join(folder, 'source-files.txt'));
const sourceArchive = await readFile(join(folder, 'SOURCE.tar.gz'));
const manifest = { version: 2, kind: 'browser-client-runtime-footprint', measuredAt: new Date().toISOString(),
 settings: { builder: 'esbuild', esbuildVersion: (await import('esbuild')).version, target: 'es2022', format: 'esm', splitting: true, minify: true, gzipLevel: 9, unitBytes: 1024,
  accounting: 'One copy of each requested JS/worker/WASM file, including WASM embedded in JavaScript; gzip each complete file separately. No unused backend chunks. Excludes HTML, data responses, HTTP headers, browser binaries and native-host executables.' },
 workload: 'Storage-ready browser startup, one local task, close/reload and readback; Electric reads a real one-row shape and refetches on reload. TanStack reopens its native SQLite cache with shape reads blocked. Native SDKs and their transport code are bundled; this is not an end-to-end synchronization or full UI application measurement.',
 source: { archive: 'SOURCE.tar.gz', sha256: sha(sourceArchive), bytes: sourceArchive.length, inputs }, clients };
await writeFile(join(folder, 'RESULTS.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(folder, 'README.md'), `# Browser client size\n\nThese are working storage configurations, with every requested JavaScript, worker and WASM file included. The browser performs a native write/read and reload/readback for the persistent clients. Electric reads a real shape; TanStack also verifies cached hydration with its shape endpoint blocked. The Chromium network log covers requests from pages and workers, and must agree with the served asset inventory.\n\n[Results](../../README.md#browser-client-size) · [Exact assets, byte counts and checksums](./RESULTS.json) · [Captured build inputs](./SOURCE.tar.gz) · [Scope and configurations](../../docs/appendices/deployment-footprint.md)\n\nThe total counts one copy per unique file; repeat loads and query-string variants do not multiply a shared file. Core counts SDK JavaScript and shared adapters. Storage counts separate engine loaders, storage workers and WASM; integrated storage code remains in Core. Jazz’s WASM also includes sync logic, so its Storage column is not a pure database comparison. The SQLite loader is split into a separate chunk for Syncular. Each file belongs to exactly one column. All JavaScript is minified. Gzip level 9 is applied separately to each complete file, including WASM. Embedded WASM is counted inside its containing JavaScript, never added again. HTML, server data, protocol overhead and the browser installation are excluded. This measures storage-ready startup, not a complete UI, all optional SDK features, synchronization throughput or multitab equivalence.\n\nSyncular uses SQLite WASM/OPFS; PowerSync uses one unencrypted wa-sqlite AccessHandlePoolVFS with dedicated workers and single-tab sync; Zero uses native IndexedDB; Jazz uses its persistent WASM runtime, worker and broker; TanStack uses its official browser SQLite persistence adapter and native IndexedDB outbox. Plain Electric has an in-memory read-only cache, so its smaller number does not represent an equivalent persistent offline client. Syncular Rust and Turso use native-host clients in the timing harness and have no browser number here.\n\nTanStack's packaged persistence worker embeds its SQLite WASM in JavaScript. Its persistence package is pinned to 0.2.20 and its declared wa-sqlite peer to 1.4.1; PowerSync retains its own 2.0.3 dependency. Package versions and integrity are preserved in the source archive's package manifest and lockfile. Zero receives two seconds for its native idle persistence before close; no application-written storage shim is used.\n\nRun \`bun run bundle:size\` with Docker available. Set \`BENCH_CHROMIUM\` to a Chromium executable on another machine; otherwise the existing browser-smoke configuration supplies the path. This starts/seeds only the local Electric fixture, creates fresh browser profiles, rebuilds and verifies every client, and replaces this package and the README table. There are no latency rounds. Verify the publication with \`python3 scripts/audit-client-size.py\`.\n`);
const output = 'results/client-size'; await rm(output, { recursive: true, force: true }); await rename(folder, output);
const binding = { path: `${output}/RESULTS.json`, sha256: sha(await readFile(`${output}/RESULTS.json`)), rendererSha256: sha(await readFile('scripts/client-size-renderer.ts')) };
await renderClientSize(binding, process.cwd());
const summary = JSON.parse(await readFile('SUMMARY.json', 'utf8')); summary.clientSize = binding; await writeFile('SUMMARY.json', JSON.stringify(summary, null, 2) + '\n');
const result = JSON.parse(await readFile('RESULTS.json', 'utf8')); result.clientSize = binding; result.summarySha256 = sha(await readFile('SUMMARY.json')); result.rendererSha256 = sha(await readFile('scripts/render-publication-summary.ts')); await writeFile('RESULTS.json', JSON.stringify(result, null, 2) + '\n');
execFileSync(process.execPath, ['scripts/render-publication-summary.ts','SUMMARY.json','README.md'], { stdio: 'inherit' });
console.log(JSON.stringify(clients.map(c => ({ id: c.id, rawKiB: c.rawBytes / 1024, gzipKiB: c.gzipBytes / 1024 }))));
