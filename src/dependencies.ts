import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from './source-snapshot.ts';
import type { JsonObject } from './types.ts';

type Entry = { kind: 'file'; sha256: string; bytes: number; mode: number } | { kind: 'directory'; mode: number } | { kind: 'symlink'; target: string; resolvedTarget: string | null };
export interface DependencyInventory {
  version: 1;
  roots: string[];
  rootManifestSha256: string;
  entries: Record<string, Entry>;
  packages: Record<string, { declared: string; version: string; manifest: string }>;
  fingerprint: string;
}
export interface DependencyIdentity {
  version: 1; fingerprint: string; rootManifestSha256: string; roots: string[];
  fileCount: number; bytes: number; path: string; sha256: string;
}
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const safePath = (path: string) => !!path && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || !part);
const fileHash = (path: string, buffer: Buffer) => {
  const hash = createHash('sha256'), fd = openSync(path, 'r');
  try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n)); return hash.digest('hex'); }
  finally { closeSync(fd); }
};
const digest = (inventory: Omit<DependencyInventory, 'fingerprint'>) => sha256(JSON.stringify(inventory));

/** Hash installed host package bytes, including native addons, outside all
 * measured trial processes. Container dependencies are identified by images. */
export function captureDependencies(root: string, manifests = ['package.json']): DependencyInventory {
  root = realpathSync(root);
  const roots = [...new Set(manifests.map(path => join(dirname(path), 'node_modules')).filter(path => existsSync(join(root, path))))].sort();
  if (!roots.includes('node_modules')) throw new Error('Installed benchmark dependencies are missing');
  const allowed = roots.map(path => realpathSync(join(root, path)));
  const entries: Record<string, Entry> = {}, buffer = Buffer.allocUnsafe(1024 * 1024);
  const walk = (name: string) => {
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      let target: string | null;
      try { target = realpathSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; target = null; }
      if (target && !allowed.some(directory => inside(directory, target!))) throw new Error(`Dependency symlink leaves the captured installation: ${name}`);
      entries[name] = { kind: 'symlink', target: readlinkSync(path), resolvedTarget: target === null ? null : relative(root, target).split(sep).join('/') };
    } else if (stat.isDirectory()) {
      entries[name] = { kind: 'directory', mode: stat.mode & 0o777 };
      for (const child of readdirSync(path).sort()) walk(`${name}/${child}`);
    } else if (stat.isFile()) entries[name] = { kind: 'file', sha256: fileHash(path, buffer), bytes: stat.size, mode: stat.mode & 0o777 };
    else throw new Error(`Unsupported dependency entry: ${name}`);
  };
  for (const directory of roots) {
    if (lstatSync(join(root, directory)).isSymbolicLink()) throw new Error('Dependency roots must be concrete directories');
    walk(directory);
  }
  const manifestBytes = readFileSync(join(root, 'package.json')), manifest = JSON.parse(manifestBytes.toString());
  const packages: DependencyInventory['packages'] = {};
  for (const [name, declared] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const path = realpathSync(join(root, 'node_modules', name, 'package.json'));
    const installed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof declared !== 'string' || installed.version !== declared) throw new Error(`Installed dependency differs from exact manifest pin: ${name}`);
    const file = relative(root, path).split(sep).join('/');
    if (entries[file]?.kind !== 'file') throw new Error(`Installed package manifest is outside the inventory: ${name}`);
    packages[name] = { declared, version: installed.version, manifest: file };
  }
  const body = { version: 1 as const, roots, rootManifestSha256: sha256(manifestBytes), entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), packages };
  return { ...body, fingerprint: digest(body) };
}
export function dependencyIdentity(inventory: DependencyInventory, bytes: Uint8Array): DependencyIdentity {
  const files = Object.values(inventory.entries).filter(entry => entry.kind === 'file');
  return { version: 1, fingerprint: inventory.fingerprint, rootManifestSha256: inventory.rootManifestSha256, roots: inventory.roots,
    fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), path: 'DEPENDENCIES.json', sha256: sha256(bytes) };
}
export async function writeDependencies(root: string, directory: string, manifests: string[]): Promise<DependencyIdentity> {
  const inventory = captureDependencies(root, manifests), bytes = Buffer.from(JSON.stringify(inventory, null, 2) + '\n');
  await writeFile(join(directory, 'DEPENDENCIES.json'), bytes);
  return dependencyIdentity(inventory, bytes);
}
export function assertDependenciesUnchanged(root: string, expected: DependencyIdentity, manifests: string[]): void {
  if (captureDependencies(root, manifests).fingerprint !== expected.fingerprint) throw new Error('Installed dependency bytes or metadata changed during campaign');
}
export function validateDependencyIdentity(identity: DependencyIdentity | undefined, source: JsonObject): void {
  const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!identity || identity.version !== 1 || !validHash(identity.fingerprint) || !validHash(identity.sha256) || !validHash(identity.rootManifestSha256) || !safePath(identity.path) || !Array.isArray(identity.roots) || !identity.roots.includes('node_modules') || identity.roots.some(path => !safePath(path) || !path.endsWith('node_modules')) || new Set(identity.roots).size !== identity.roots.length || !Number.isSafeInteger(identity.fileCount) || identity.fileCount < 1 || !Number.isSafeInteger(identity.bytes) || identity.bytes < 1) throw new Error('Installed dependency provenance is missing or invalid');
  if (identity.rootManifestSha256 !== ((source.files as JsonObject)?.['package.json'] as JsonObject)?.sha256) throw new Error('Installed dependencies differ from the archived package manifest');
}
export function validateDependencyInventory(bytes: Uint8Array, identity: DependencyIdentity, source: JsonObject): void {
  validateDependencyIdentity(identity, source);
  if (sha256(bytes) !== identity.sha256) throw new Error('Dependency inventory artifact hash differs');
  const inventory = JSON.parse(Buffer.from(bytes).toString()) as DependencyInventory;
  const { fingerprint, ...body } = inventory;
  if (inventory.version !== 1 || fingerprint !== identity.fingerprint || digest(body) !== fingerprint || inventory.rootManifestSha256 !== identity.rootManifestSha256 || JSON.stringify(inventory.roots) !== JSON.stringify(identity.roots)) throw new Error('Dependency inventory fingerprint differs');
  if (inventory.roots.some(root => inventory.entries[root]?.kind !== 'directory')) throw new Error('Dependency root directory evidence missing');
  for (const [path, entry] of Object.entries(inventory.entries)) {
    if (!safePath(path) || !inventory.roots.some(root => path === root || path.startsWith(`${root}/`))) throw new Error('Dependency entry leaves declared roots');
    if (entry.kind === 'symlink') {
      if (typeof entry.target !== 'string' || !entry.target || entry.resolvedTarget !== null && (!safePath(entry.resolvedTarget) || !inventory.entries[entry.resolvedTarget] || inventory.entries[entry.resolvedTarget].kind === 'symlink')) throw new Error('Dependency symlink lacks its declared captured target');
    } else if (!['directory', 'file'].includes(entry.kind) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || entry.kind === 'file' && (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) throw new Error('Invalid dependency file evidence');
  }
  for (const pkg of Object.values(inventory.packages)) if (pkg.declared !== pkg.version || typeof pkg.version !== 'string' || !pkg.version || inventory.entries[pkg.manifest]?.kind !== 'file') throw new Error('Dependency package identity differs');
  const actual = dependencyIdentity(inventory, bytes);
  if (actual.fileCount !== identity.fileCount || actual.bytes !== identity.bytes) throw new Error('Dependency inventory totals differ');
}
export async function readCampaignDependencies(directory: string, identity: DependencyIdentity, source: JsonObject): Promise<Buffer> {
  validateDependencyIdentity(identity, source);
  const bytes = await readFile(join(directory, identity.path));
  validateDependencyInventory(bytes, identity, source); return bytes;
}

if (import.meta.main) {
  const manifestFlag = process.argv.indexOf('--manifest'), rootFlag = process.argv.indexOf('--root');
  if (manifestFlag < 0 || !process.argv[manifestFlag + 1]) throw new Error('Use --manifest <CAMPAIGN.json or RESULTS.json> [--root <installed checkout>]');
  const manifestPath = resolve(process.argv[manifestFlag + 1]);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await readCampaignDependencies(dirname(manifestPath), manifest.dependencies, manifest.source);
  const root = rootFlag < 0 ? process.cwd() : process.argv[rootFlag + 1];
  if (!root) throw new Error('--root requires an installed checkout path');
  assertDependenciesUnchanged(root, manifest.dependencies, Object.keys(manifest.source.files).filter(path => path.endsWith('package.json')));
  console.log(`Installed dependency inventory matches ${manifest.dependencies.fingerprint}`);
}
