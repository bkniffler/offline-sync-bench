import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { configurationHash } from './configuration.ts';

export type BuildInputEntry = { kind: 'file'; sha256: string; bytes: number; mode: number }
  | { kind: 'directory'; mode: number }
  | { kind: 'symlink'; target: string; resolved: string | null };
export interface BuildInputInventory {
  version: 1;
  roots: Array<{ requested: string; resolved: string }>;
  entries: Record<string, BuildInputEntry>;
  fingerprint: string;
}
const inside = (root: string, path: string) => { const name = relative(root, path); return name === '' || name !== '..' && !name.startsWith('../') && !isAbsolute(name); };
const absolute = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Capture exact bytes and metadata under explicitly selected build inputs.
 * Links can reference another selected root, but cannot silently add an
 * uncaptured external input. Root aliases and missing link targets are retained.
 */
export function captureBuildInputs(paths: string[]): BuildInputInventory {
  if (!paths.length || paths.some(path => !absolute(path) || path === '/')) throw new Error('Build inputs require explicit absolute roots');
  const roots = [...new Set(paths)].sort().map(requested => ({ requested, resolved: realpathSync(requested) }));
  const entries: BuildInputInventory['entries'] = {}, buffer = Buffer.allocUnsafe(1024 * 1024);
  const allowed = (path: string) => roots.some(root => inside(root.resolved, path));
  const visit = (path: string): void => {
    if (entries[path]) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      let resolved: string | null;
      try { resolved = realpathSync(path); } catch (error: any) { if (error.code !== 'ENOENT') throw error; resolved = null; }
      if (resolved && !allowed(resolved)) throw new Error(`Build input link leaves selected roots: ${path}`);
      entries[path] = { kind: 'symlink', target: readlinkSync(path), resolved };
    } else if (stat.isDirectory()) {
      entries[path] = { kind: 'directory', mode: stat.mode & 0o777 };
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      const digest = createHash('sha256'), fd = openSync(path, 'r');
      try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n)); } finally { closeSync(fd); }
      const after = statSync(path);
      if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error(`Build input changed while hashing: ${path}`);
      entries[path] = { kind: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: digest.digest('hex') };
    } else throw new Error(`Unsupported build input: ${path}`);
  };
  for (const root of roots) { if (root.requested !== root.resolved && lstatSync(root.requested).isSymbolicLink()) visit(root.requested); visit(root.resolved); }
  const body = { version: 1 as const, roots, entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
  const inventory = { ...body, fingerprint: configurationHash(body) };
  validateBuildInputs(inventory); return inventory;
}
export function validateBuildInputs(value: BuildInputInventory): void {
  if (!value || value.version !== 1 || !Array.isArray(value.roots) || !value.roots.length || !value.entries || !validHash(value.fingerprint)) throw new Error('Build input inventory missing');
  const { fingerprint, ...body } = value;
  if (configurationHash(body) !== fingerprint || new Set(value.roots.map(root => root.requested)).size !== value.roots.length) throw new Error('Build input fingerprint or roots differ');
  const allowed = (path: string) => value.roots.some(root => inside(root.resolved, path) || path === root.requested);
  for (const root of value.roots) if (!absolute(root.requested) || !absolute(root.resolved) || root.resolved === '/' || !value.entries[root.resolved] || value.entries[root.resolved].kind === 'symlink') throw new Error('Resolved build input root missing');
  for (const [path, entry] of Object.entries(value.entries)) {
    if (!absolute(path) || !allowed(path) || !entry || !['file', 'directory', 'symlink'].includes(entry.kind)) throw new Error('Build input entry leaves selected roots');
    if (entry.kind === 'symlink') {
      if (typeof entry.target !== 'string' || !entry.target || entry.resolved !== null && (!absolute(entry.resolved) || !allowed(entry.resolved) || !value.entries[entry.resolved] || value.entries[entry.resolved].kind === 'symlink')) throw new Error('Build input link target missing');
    } else if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || entry.kind === 'file' && (!validHash(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)) throw new Error('Build input file identity invalid');
  }
}
export function assertBuildInputsUnchanged(inventory: BuildInputInventory): void {
  validateBuildInputs(inventory);
  if (captureBuildInputs(inventory.roots.map(root => root.requested)).fingerprint !== inventory.fingerprint) throw new Error('Build input bytes, metadata or paths changed');
}
export function resolvedBuildInputPath(inventory: BuildInputInventory, requested: string): string {
  const root = inventory.roots.filter(root => inside(root.requested, requested)).sort((a, b) => b.requested.length - a.requested.length)[0];
  if (!root) throw new Error('Path is outside declared build input roots');
  const physical = join(root.resolved, relative(root.requested, requested));
  const entry = inventory.entries[physical];
  if (entry?.kind === 'symlink') {
    if (!entry.resolved) throw new Error('Build input path resolves to a missing file');
    return entry.resolved;
  }
  return physical;
}
