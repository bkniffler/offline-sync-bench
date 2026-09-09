import { build, version as esbuildVersion } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { hash } from '../contracts/screens.ts';
import { benchmarkRoot } from '../paths.ts';
import { sha256 } from '../source-snapshot.ts';
import type { DependencyIdentity, DependencyInventory } from '../dependencies.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

export type ClientRuntime = { kind: 'native-host' } | { kind: 'chromium'; executable: string; installationRoot: string };
export type ChromiumRuntime = Extract<ClientRuntime, { kind: 'chromium' }>;
export interface BrowserIdentity {
  version: 1; fingerprint: string; sourceHash: string; dependenciesFingerprint: string;
  installationFingerprint: string; bundleSha256: string; browserVersion: string;
  path: string; sha256: string; bundlePath: string;
}
type FileEntry = { kind: 'file'; sha256: string; bytes: number; mode: number } | { kind: 'directory'; mode: number } | { kind: 'symlink'; target: string; resolved: string };
interface BrowserRecord {
  version: 1; sourceHash: string; dependenciesFingerprint: string; runtime: ChromiumRuntime;
  installation: ReturnType<typeof captureBrowserInstallation>; browserVersion: string;
  bundle: { sha256: string; bytes: number; esbuildVersion: string; options: typeof bundleOptions; inputs: Record<string, { resolved: string; sha256: string; bytes: number }> };
  fingerprint: string;
}
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const safe = (path: string) => typeof path === 'string' && !!path && !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const bundleOptions = { entryPoints: ['src/browser/client-entry.ts'], bundle: true, platform: 'browser' as const, format: 'iife' as const, target: ['es2022'], write: false, metafile: true };

export function validateClientRuntime(runtime?: ClientRuntime): void {
  if (runtime === undefined) return;
  if (!runtime || runtime.kind === 'native-host' && Object.keys(runtime).join() !== 'kind'
    || !['native-host', 'chromium'].includes(runtime.kind)) throw new Error('Invalid client runtime');
  if (runtime.kind === 'chromium' && (Object.keys(runtime).sort().join() !== 'executable,installationRoot,kind' || !isAbsolute(runtime.executable ?? '') || !isAbsolute(runtime.installationRoot ?? '') || resolve(runtime.installationRoot) === '/' || !inside(resolve(runtime.installationRoot), resolve(runtime.executable)))) throw new Error('Chromium runtime requires an explicit installation directory containing its executable');
}
export function captureBrowserInstallation(runtime: ChromiumRuntime) {
  validateClientRuntime(runtime);
  const root = realpathSync(runtime.installationRoot), executable = realpathSync(runtime.executable);
  if (!inside(root, executable) || !lstatSync(root).isDirectory()) throw new Error('Browser executable leaves its installation');
  const entries: Record<string, FileEntry> = {}, buffer = Buffer.allocUnsafe(1024 * 1024);
  const visit = (name: string) => {
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!inside(root, target)) throw new Error('Browser installation symlink leaves captured runtime');
      entries[name] = { kind: 'symlink', target: readlinkSync(path), resolved: relative(root, target) };
    } else if (stat.isDirectory()) {
      entries[name] = { kind: 'directory', mode: stat.mode & 0o777 };
      for (const child of readdirSync(path).sort()) visit(name === '.' ? child : `${name}/${child}`);
    } else if (stat.isFile()) {
      const digest = createHash('sha256'), fd = openSync(path, 'r');
      try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n)); } finally { closeSync(fd); }
      entries[name] = { kind: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha256: digest.digest('hex') };
    } else throw new Error('Unsupported browser installation entry');
  };
  visit('.');
  const name = relative(root, executable), entry = entries[name];
  if (entry?.kind !== 'file' || !(entry.mode & 0o111)) throw new Error('Browser entry point is not executable');
  const body = { root, executable: name, entries };
  return { ...body, fingerprint: hash(body) };
}
export async function prepareBrowser(directory: string, runtime: ChromiumRuntime, source: JsonObject, dependencies: DependencyIdentity): Promise<BrowserIdentity> {
  if (process.env.ESBUILD_BINARY_PATH) throw new Error('Browser bundle requires the inventoried esbuild installation; ESBUILD_BINARY_PATH is not supported');
  const installation = captureBrowserInstallation(runtime);
  const versionText = execFileSync(runtime.executable, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  const browserVersion = versionText.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0];
  if (!browserVersion) throw new Error('Chromium executable did not report a version');
  const output = await build({ ...bundleOptions, absWorkingDir: benchmarkRoot, logLevel: 'silent' });
  if (output.outputFiles?.length !== 1 || !output.metafile) throw new Error('Expected one complete browser SDK bundle');
  const bytes = output.outputFiles[0].contents;
  const inputs: BrowserRecord['bundle']['inputs'] = {};
  for (const name of Object.keys(output.metafile.inputs).sort()) {
    const actual = realpathSync(join(benchmarkRoot, name));
    if (!inside(benchmarkRoot, actual)) throw new Error('Browser bundle input leaves captured checkout/dependencies');
    const input = readFileSync(actual);
    inputs[name] = { resolved: relative(benchmarkRoot, actual), sha256: sha256(input), bytes: input.length };
  }
  const body = { version: 1 as const, sourceHash: String(source.sourceHash), dependenciesFingerprint: dependencies.fingerprint, runtime, installation, browserVersion,
    bundle: { sha256: sha256(bytes), bytes: bytes.length, esbuildVersion, options: bundleOptions, inputs } };
  const record: BrowserRecord = { ...body, fingerprint: hash(body) }, recordBytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
  await writeFile(join(directory, 'BROWSER.json'), recordBytes); await writeFile(join(directory, 'BROWSER.bundle.js'), bytes);
  return { version: 1, fingerprint: record.fingerprint, sourceHash: body.sourceHash, dependenciesFingerprint: dependencies.fingerprint, installationFingerprint: installation.fingerprint,
    bundleSha256: body.bundle.sha256, browserVersion, path: 'BROWSER.json', sha256: sha256(recordBytes), bundlePath: 'BROWSER.bundle.js' };
}
export function validateBrowserIdentity(identity: BrowserIdentity | undefined, runtime: ClientRuntime | undefined, source: JsonObject, dependencies?: DependencyIdentity): void {
  validateClientRuntime(runtime);
  if (runtime?.kind !== 'chromium') { if (identity) throw new Error('Native campaign must not claim a browser runtime'); return; }
  if (!identity || identity.version !== 1 || ![identity.fingerprint, identity.installationFingerprint, identity.bundleSha256, identity.sha256].every(validHash)
    || identity.sourceHash !== source.sourceHash || identity.dependenciesFingerprint !== dependencies?.fingerprint || !/^\d+\.\d+\.\d+\.\d+$/.test(identity.browserVersion)
    || !safe(identity.path) || !safe(identity.bundlePath)) throw new Error('Browser runtime provenance missing or inconsistent with campaign');
}
export async function readCampaignBrowser(directory: string, identity: BrowserIdentity, runtime: ClientRuntime, source: JsonObject, dependencies: DependencyIdentity, inventory?: DependencyInventory) {
  validateBrowserIdentity(identity, runtime, source, dependencies);
  const bytes = await readFile(join(directory, identity.path)), bundle = await readFile(join(directory, identity.bundlePath));
  if (sha256(bytes) !== identity.sha256 || sha256(bundle) !== identity.bundleSha256) throw new Error('Browser artifact checksum differs');
  const record = JSON.parse(bytes.toString()) as BrowserRecord, { fingerprint, ...body } = record;
  if (fingerprint !== identity.fingerprint || hash(body) !== fingerprint || hash(record.runtime) !== hash(runtime) || record.sourceHash !== identity.sourceHash || record.dependenciesFingerprint !== identity.dependenciesFingerprint
    || record.browserVersion !== identity.browserVersion || record.bundle.sha256 !== identity.bundleSha256 || record.bundle.bytes !== bundle.length || hash(record.bundle.options) !== hash(bundleOptions)) throw new Error('Browser provenance record differs from identity');
  const { fingerprint: installationHash, ...installation } = record.installation;
  if (installationHash !== identity.installationFingerprint || hash(installation) !== installationHash || !isAbsolute(installation.root) || !safe(installation.executable)) throw new Error('Browser installation inventory differs');
  const executable = installation.entries[installation.executable];
  if (executable?.kind !== 'file' || !(executable.mode & 0o111)) throw new Error('Browser executable inventory missing');
  for (const [name, entry] of Object.entries(installation.entries)) {
    if (name !== '.' && !safe(name) || !entry || !['file', 'directory', 'symlink'].includes(entry.kind)) throw new Error('Invalid browser installation entry');
    if (entry.kind === 'symlink') { if (!safe(entry.resolved) || !installation.entries[entry.resolved]) throw new Error('Browser link target is not inventoried'); }
    else if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || entry.kind === 'file' && (!validHash(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) throw new Error('Invalid browser file identity');
  }
  if (!Object.hasOwn(record.bundle.inputs, 'src/browser/client-entry.ts') || !Object.keys(record.bundle.inputs).some(name => name.startsWith('node_modules/'))) throw new Error('Browser bundle input inventory missing');
  if (inventory && record.bundle.esbuildVersion !== inventory.packages.esbuild?.version) throw new Error('Browser bundler differs from inventoried esbuild');
  for (const [name, input] of Object.entries(record.bundle.inputs)) {
    if (!safe(name) || !safe(input.resolved) || !validHash(input.sha256)) throw new Error('Invalid browser bundle input');
    const dependency = /(^|\/)node_modules\//.test(input.resolved);
    const expected = dependency ? inventory?.entries[input.resolved] : (source.files as JsonObject)[input.resolved] as any;
    if (expected && (expected.kind !== 'file' || expected.sha256 !== input.sha256 || dependency && expected.bytes !== input.bytes) || !expected && (inventory || !dependency)) throw new Error(`Browser input differs from source/dependencies: ${name}`);
  }
  return { bytes, bundle, record };
}
export function assertBrowserUnchanged(runtime: ChromiumRuntime, identity: BrowserIdentity): void {
  if (captureBrowserInstallation(runtime).fingerprint !== identity.installationFingerprint) throw new Error('Browser installation changed during campaign');
}
export const browserBinding = (identity: BrowserIdentity) => ({ fingerprint: identity.fingerprint, installationFingerprint: identity.installationFingerprint, bundleSha256: identity.bundleSha256, browserVersion: identity.browserVersion });
export function validateTrialBrowser(result: BenchmarkResult, runtime?: ClientRuntime, identity?: BrowserIdentity): void {
  if (runtime?.kind !== 'chromium') { if (result.metadata.clientRuntime !== undefined && result.metadata.clientRuntime !== 'native-host') throw new Error('Browser or unknown runtime result in a native campaign'); return; }
  if (result.metadata.clientRuntime !== 'chromium') throw new Error('Browser attempt lost its runtime identity');
  if (result.status === 'completed' && (!identity || result.metadata.clientRuntime !== 'chromium' || hash(result.metadata.browserBinding) !== hash(browserBinding(identity)))) throw new Error('Trial browser differs from campaign provenance');
  if (result.status === 'completed' && !(result.metadata.browserEvidence as any)?.clients?.every((client: any) => client.connection.version.product === `Chrome/${identity!.browserVersion}`)) throw new Error('Trial browser version differs from inventoried executable');
  if (result.status === 'unsupported' && (result.metadata.clientRuntime !== 'chromium' || (result.metadata.coverage as JsonObject)?.status !== 'not-implemented')) throw new Error('Browser coverage must be explicit');
}
