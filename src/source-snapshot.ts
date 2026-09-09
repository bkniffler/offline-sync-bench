import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { JsonObject } from './types.ts';

export type SourceFile = { kind: 'file'; mode: number; sha256: string } | { kind: 'symlink'; target: string; sha256: string } | { kind: 'deleted' };
export type SourceFiles = Record<string, SourceFile>;
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validPath = (path: string) => Boolean(path) && !path.includes('\\') && !path.includes('\0') && !posix.isAbsolute(path) && posix.normalize(path) === path && !path.split('/').some(part => part === '..' || part === '.');

export function readSourceFiles(root: string, paths: string[]): { files: SourceFiles; contents: Record<string, string> } {
  const files: SourceFiles = {}, contents: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort()) {
    if (!validPath(path)) throw new Error(`Invalid source path: ${path}`);
    let info;
    try { info = lstatSync(join(root, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { files[path] = { kind: 'deleted' }; continue; } throw error; }
    if (info.isSymbolicLink()) {
      const target = readlinkSync(join(root, path));
      files[path] = { kind: 'symlink', target, sha256: sha256(target) };
    } else if (info.isFile()) {
      const bytes = readFileSync(join(root, path));
      files[path] = { kind: 'file', mode: info.mode & 0o777, sha256: sha256(bytes) };
      contents[path] = bytes.toString('base64');
    } else throw new Error(`Source path is not a file: ${path}`);
  }
  validateSourceFiles(files);
  return { files, contents };
}
export function validateSourceFiles(files: unknown): asserts files is SourceFiles {
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) throw new Error('Source provenance file inventory missing');
  for (const [path, item] of Object.entries(files)) {
    if (!validPath(path) || !item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid source provenance entry');
    if (item.kind === 'file') {
      if (!validHash(item.sha256) || !Number.isSafeInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw new Error('Invalid source file hash or mode');
    } else if (item.kind === 'symlink') {
      // Only relocatable links to another archived file can reproduce a checkout.
      const target = typeof item.target === 'string' ? posix.normalize(posix.join(posix.dirname(path), item.target)) : '';
      if (!item.target || posix.isAbsolute(item.target) || !validPath(target) || !Object.hasOwn(files, target) || (files as SourceFiles)[target].kind !== 'file' || item.sha256 !== sha256(item.target)) throw new Error('Source symlink must target an archived regular file');
    } else if (item.kind !== 'deleted') throw new Error('Invalid source entry kind');
    for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) if (Object.hasOwn(files, parent) && (files as SourceFiles)[parent].kind !== 'deleted') throw new Error('Source file conflicts with a parent path');
  }
}
export function validateSourceProvenance(source: JsonObject): void {
  if (source?.version !== 2 || typeof source.revision !== 'string' || !source.revision || typeof source.dirty !== 'boolean') throw new Error('Source provenance is missing or inconsistent');
  validateSourceFiles(source.files);
  if (source.sourceHash !== sha256(JSON.stringify(source.files))) throw new Error('Source provenance hash is inconsistent');
  const snapshot = source.snapshot as JsonObject;
  if (snapshot?.format !== 'benchmark-source-v1' || (snapshot.path !== 'SOURCE.json' && snapshot.path !== `results/sources/${source.sourceHash}/SOURCE.json`) || !validHash(snapshot.sha256)) throw new Error('Source provenance requires the exact campaign snapshot');
}
export function encodeSourceSnapshot(source: JsonObject, contents: Record<string, string>): Uint8Array {
  return Buffer.from(JSON.stringify({ format: 'benchmark-source-v1', sourceHash: source.sourceHash, revision: source.revision, dirty: source.dirty, files: source.files, contents }) + '\n');
}
export function validateSourceSnapshot(bytes: Uint8Array, source: JsonObject): void {
  validateSourceProvenance(source);
  if (sha256(bytes) !== (source.snapshot as JsonObject).sha256) throw new Error('Source snapshot artifact hash mismatch');
  const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (snapshot.format !== 'benchmark-source-v1' || snapshot.sourceHash !== source.sourceHash || snapshot.revision !== source.revision || snapshot.dirty !== source.dirty || JSON.stringify(snapshot.files) !== JSON.stringify(source.files)) throw new Error('Source snapshot identity mismatch');
  const contents = snapshot.contents;
  if (!contents || typeof contents !== 'object' || Array.isArray(contents)) throw new Error('Source snapshot contents missing');
  const files = source.files as unknown as SourceFiles;
  if (Object.keys(contents).length !== Object.values(files).filter(file => file.kind === 'file').length) throw new Error('Source snapshot file inventory mismatch');
  for (const [path, file] of Object.entries(files)) {
    if (file.kind !== 'file') { if (Object.hasOwn(contents, path)) throw new Error('Unexpected source snapshot contents'); continue; }
    const value = contents[path];
    if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value || sha256(Buffer.from(value, 'base64')) !== file.sha256) throw new Error(`Source snapshot contents mismatch: ${path}`);
  }
}
export async function writeSourceSnapshot(root: string, campaignDir: string, source: JsonObject): Promise<void> {
  const captured = readSourceFiles(root, Object.keys(source.files as JsonObject));
  if (sha256(JSON.stringify(captured.files)) !== source.sourceHash) throw new Error('Source changed while capturing campaign snapshot');
  const bytes = encodeSourceSnapshot(source, captured.contents);
  source.snapshot = { format: 'benchmark-source-v1', path: 'SOURCE.json', sha256: sha256(bytes) };
  validateSourceSnapshot(bytes, source);
  await writeFile(join(campaignDir, 'SOURCE.json'), bytes, { flag: 'wx' });
}
export async function readCampaignSource(campaignDir: string, source: JsonObject): Promise<Uint8Array> {
  validateSourceProvenance(source);
  const bytes = await readFile(join(campaignDir, String((source.snapshot as JsonObject).path)));
  validateSourceSnapshot(bytes, source);
  return bytes;
}

/** Restore only into a new directory. Deleted entries remain absent; links are
 * created after regular files and cannot point outside the archived inventory. */
export async function restoreSourceSnapshot(bytes: Uint8Array, source: JsonObject, destination: string): Promise<void> {
  validateSourceSnapshot(bytes, source);
  const { mkdir, writeFile, chmod, symlink } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8'));
  await mkdir(destination);
  const entries = Object.entries(source.files as unknown as SourceFiles);
  for (const [path, file] of entries) if (file.kind === 'file') {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), Buffer.from(snapshot.contents[path], 'base64'), { flag: 'wx' });
    await chmod(join(destination, path), file.mode);
  }
  for (const [path, file] of entries) if (file.kind === 'symlink') {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await symlink(file.target, join(destination, path));
  }
  const restored = readSourceFiles(destination, entries.map(([path]) => path));
  if (sha256(JSON.stringify(restored.files)) !== source.sourceHash) throw new Error('Restored source differs from campaign snapshot');
}
