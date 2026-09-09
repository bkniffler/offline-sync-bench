import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { configurationHash, environmentSummary } from './configuration.ts';
import { sha256 } from './source-snapshot.ts';
import type { JsonObject } from './types.ts';

export interface CargoConfiguration {
  version: 1;
  workingDirectory: string;
  cargoHome: string;
  probes: Record<string, JsonObject>;
  mergeOrder: string[];
  mergedFileSha256: string;
  mergedFileSettings: JsonObject;
  environment: JsonObject;
  fingerprint: string;
}
function merge(low: any, high: any): any {
  if (low === undefined) return high;
  if (Array.isArray(low) && Array.isArray(high)) return [...low, ...high];
  if (low && high && typeof low === 'object' && typeof high === 'object' && !Array.isArray(low) && !Array.isArray(high)) {
    const output = { ...low };
    for (const [key, value] of Object.entries(high)) output[key] = merge(low[key], value);
    return output;
  }
  if (typeof low !== typeof high || Array.isArray(low) !== Array.isArray(high)) throw new Error('Incompatible Cargo configuration types');
  return high;
}
function flatten(value: any, path = '', result: Record<string, string> = {}): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, path ? `${path}.${key}` : key, result);
  } else result[path] = typeof value === 'string' ? value : JSON.stringify(value);
  return result;
}
/** Capture file resolution separately from environment precedence and relative-path
 * interpretation. Cargo remains responsible for interpreting the actual build. */
export function captureCargoConfiguration(workingDirectory: string, environment: NodeJS.ProcessEnv): CargoConfiguration {
  const cwd = realpathSync(workingDirectory);
  const cargoHome = resolve(cwd, environment.CARGO_HOME || join(environment.HOME || '', '.cargo'));
  if (!environment.CARGO_HOME && !environment.HOME) throw new Error('Cargo configuration requires HOME or CARGO_HOME');
  const probes: Record<string, JsonObject> = {}, mergeOrder: string[] = [];
  function probe(path: string): boolean {
    if (probes[path]) return probes[path].present === true;
    let info;
    try { info = lstatSync(path); } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      probes[path] = { present: false }; return false;
    }
    const resolvedPath = realpathSync(path), target = statSync(resolvedPath);
    if (!target.isFile()) throw new Error('Cargo configuration input is not a regular file');
    const bytes = readFileSync(path);
    probes[path] = { present: true, sha256: sha256(bytes), bytes: bytes.length, mode: info.mode & 0o777, resolvedPath, targetMode: target.mode & 0o777 };
    return true;
  }
  function load(path: string, active: Set<string>): any {
    if (!probe(path)) throw new Error('Required Cargo configuration include is missing');
    const physical = String(probes[path].resolvedPath);
    if (active.has(physical)) throw new Error('Cargo configuration include cycle');
    const next = new Set(active).add(physical);
    let parsed: any;
    try { parsed = Bun.TOML.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Cannot parse Cargo configuration input'); }
    let result = {};
    if (parsed.include !== undefined) {
      if (!Array.isArray(parsed.include)) throw new Error('Invalid Cargo configuration includes');
      for (const item of parsed.include) {
        const target = typeof item === 'string' ? item : item?.path, optional = typeof item === 'object' && item?.optional === true;
        if (typeof target !== 'string' || !target.endsWith('.toml')) throw new Error('Invalid Cargo configuration include path');
        const included = resolve(dirname(path), target);
        if (!probe(included) && optional) continue;
        result = merge(result, load(included, next));
      }
      delete parsed.include;
    }
    mergeOrder.push(path);
    return merge(result, parsed);
  }
  const directories: string[] = [];
  for (let current = cwd;; current = dirname(current)) {
    directories.push(join(current, '.cargo'));
    if (dirname(current) === current) break;
  }
  if (!directories.includes(cargoHome)) directories.push(cargoHome);
  let merged = {};
  for (const directory of directories.reverse()) {
    const legacy = join(directory, 'config'), modern = join(directory, 'config.toml');
    const hasLegacy = probe(legacy), hasModern = probe(modern);
    if (hasLegacy || hasModern) merged = merge(merged, load(hasLegacy ? legacy : modern, new Set()));
  }
  const body = { version: 1 as const, workingDirectory: cwd, cargoHome, probes, mergeOrder,
    mergedFileSha256: configurationHash(merged), mergedFileSettings: environmentSummary(flatten(merged)), environment: environmentSummary(environment) };
  return { ...body, fingerprint: configurationHash(body) };
}
export function assertCargoConfiguration(expected: CargoConfiguration, environment: NodeJS.ProcessEnv): void {
  if (captureCargoConfiguration(expected.workingDirectory, environment).fingerprint !== expected.fingerprint) throw new Error('Cargo configuration or build environment changed during campaign');
}
export function validateCargoConfiguration(record: CargoConfiguration | undefined): void {
  const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!record || record.version !== 1 || !isAbsolute(record.workingDirectory ?? '') || !isAbsolute(record.cargoHome ?? '') || !record.probes || !Array.isArray(record.mergeOrder) || !validHash(record.mergedFileSha256) || !validHash(record.mergedFileSettings?.sha256) || !validHash(record.environment?.sha256)) throw new Error('Cargo configuration provenance missing or invalid');
  const { fingerprint, ...body } = record;
  if (!validHash(fingerprint) || configurationHash(body) !== fingerprint || !Object.keys(record.probes).length || Object.entries(record.probes).some(([path, entry]) => !isAbsolute(path) || typeof entry.present !== 'boolean' || entry.present && (!validHash(entry.sha256) || !isAbsolute(String(entry.resolvedPath)) || !Number.isSafeInteger(entry.bytes))) || record.mergeOrder.some(path => !record.probes[path]?.present)) throw new Error('Cargo configuration fingerprint or inputs invalid');
}
