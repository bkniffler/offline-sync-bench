import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { sha256 } from './source-snapshot.ts';
import { benchmarkRoot } from './paths.ts';
import { getStack } from './stacks.ts';
import type { JsonObject, StackId } from './types.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, canonical(v)]));
  return value;
}
export const configurationHash = (value: unknown) => sha256(JSON.stringify(canonical(value)));
const command = (args: string[]) => {
  try { return execFileSync('docker', args, { cwd: benchmarkRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`Cannot inspect Docker configuration (${args[0]})`); }
};
const runtimeNames = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'TZ', 'CI', 'DEBUG', 'TERM', 'NO_COLOR', 'FORCE_COLOR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CC', 'CXX', 'AR', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'LIBRARY_PATH', 'PKG_CONFIG_PATH', 'SQLITE_TMPDIR'];
const runtimePrefix = /^(?:BENCH_|SYNCULAR_|ELECTRIC_|JAZZ_|POWERSYNC_|TURSO_|ZERO_|REPLICACHE_|NODE_|BUN_|UV_|RUST|CARGO_|DOCKER_|COMPOSE_|LC_|LD_|DYLD_)/;
const generated = new Set(['BENCH_EXPECTED_RUST_SHA256', 'BENCH_EXPECTED_RUST_STAT', 'BENCH_RECOVERY_PARENT_PID']);
const credentialName = /password|secret|token|credential|auth|private|(?:api|access)[_-]?key/i;

/** Preserve exact equality fingerprints without putting credentials or arbitrary
 * command/environment strings into readable report artifacts. */
export function environmentSummary(environment: Record<string, string | undefined>): JsonObject {
  const values: JsonObject = {};
  for (const name of Object.keys(environment).sort()) {
    const value = environment[name];
    if (value === undefined) values[name] = { present: false };
    else if (!credentialName.test(name) && (value === '' || /^(?:true|false|production|development|test|error|warn|info|debug|trace)$/.test(value) || /^\d+(?:[.,]\d+)*(?:ms|s|m|h|[kmg]b?)?$/i.test(value) || /^(?:TZ|LANG|LC_[A-Z_]+)$/.test(name) && /^[A-Za-z0-9_/+.@-]+$/.test(value))) values[name] = { present: true, value };
    else values[name] = { present: true, redacted: true };
  }
  return { sha256: configurationHash(Object.fromEntries(Object.keys(environment).sort().map(name => [name, environment[name] ?? null]))), values };
}
export function runtimeEnvironment(environment: NodeJS.ProcessEnv): JsonObject {
  const names = new Set([...runtimeNames, ...Object.keys(environment).filter(name => runtimePrefix.test(name))]);
  return environmentSummary(Object.fromEntries([...names].filter(name => !generated.has(name)).map(name => [name, environment[name]])));
}
const commandSummary = (value: unknown): JsonObject => ({ sha256: configurationHash(value ?? null), argumentCount: Array.isArray(value) ? value.length : value == null ? 0 : 1 });
const environmentMap = (entries: string[] = []) => Object.fromEntries(entries.map(entry => { const index = entry.indexOf('='); return [entry.slice(0, index < 0 ? undefined : index), index < 0 ? '' : entry.slice(index + 1)]; }));

export function mountedInput(path: string): JsonObject {
  const visit = (absolute: string, name: string, files: JsonObject): void => {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) {
      // A link alone cannot account for an external mounted configuration file.
      throw new Error(`Mounted configuration symlink requires explicit input coverage: ${name}`);
    }
    if (info.isDirectory()) {
      files[name] = { kind: 'directory', mode: info.mode & 0o777 };
      for (const child of readdirSync(absolute).sort()) visit(join(absolute, child), name === '.' ? child : `${name}/${child}`, files);
    } else if (info.isFile()) files[name] = { kind: 'file', mode: info.mode & 0o777, bytes: info.size, sha256: sha256(readFileSync(absolute)) };
    else throw new Error('Unsupported mounted configuration input');
  };
  const files: JsonObject = {}; visit(path, '.', files);
  return { sha256: configurationHash(files), files };
}
export function containerConfiguration(container: any, mounts: JsonObject[] = []): JsonObject {
  const config = container.Config ?? {}, host = container.HostConfig ?? {};
  // Docker inspect can enumerate the same resolved mounts in different orders.
  // Their destinations identify mount points; declared command/HostConfig arrays
  // retain their original order and every resolved mount field remains hashed.
  const resolvedMounts = [...mounts].sort((a, b) => {
    const left = `${a.destination}\0${configurationHash(a)}`, right = `${b.destination}\0${configurationHash(b)}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { name: container.Name, service: config.Labels?.['com.docker.compose.service'] ?? null, imageId: container.Image,
    configurationSha256: configurationHash(config), hostConfigurationSha256: configurationHash(host),
    environment: environmentSummary(environmentMap(config.Env)), command: commandSummary(config.Cmd), entrypoint: commandSummary(config.Entrypoint),
    user: config.User ?? '', workingDirectory: config.WorkingDir ?? '',
    resources: { nanoCpus: host.NanoCpus ?? 0, cpuQuota: host.CpuQuota ?? 0, cpuPeriod: host.CpuPeriod ?? 0, cpuShares: host.CpuShares ?? 0,
      cpusetCpus: host.CpusetCpus ?? '', memory: host.Memory ?? 0, memorySwap: host.MemorySwap ?? 0, memoryReservation: host.MemoryReservation ?? 0, pidsLimit: host.PidsLimit ?? null, shmSize: host.ShmSize ?? 0 },
    networkMode: host.NetworkMode ?? null, portBindings: host.PortBindings ?? {}, mounts: resolvedMounts,
  };
}
export interface ConfigurationRecord {
  version: 1; sourceHash: string; runtime: JsonObject; services: Record<string, JsonObject>; fingerprint: string;
}
export interface ConfigurationIdentity { version: 1; sourceHash: string; fingerprint: string; path: string; sha256: string; stacks: string[] }
export function configurationIdentity(record: ConfigurationRecord, bytes: Uint8Array): ConfigurationIdentity {
  return { version: 1, sourceHash: record.sourceHash, fingerprint: record.fingerprint, path: 'CONFIGURATION.json', sha256: sha256(bytes), stacks: Object.keys(record.services).sort() };
}
export function captureConfiguration(stackIds: StackId[], source: JsonObject, environment: NodeJS.ProcessEnv = process.env): ConfigurationRecord {
  const dotenv: JsonObject = {};
  for (const name of readdirSync(benchmarkRoot).filter(name => name === '.env' || name.startsWith('.env.')).sort()) {
    const path = join(benchmarkRoot, name), info = lstatSync(path);
    if (info.isDirectory()) continue;
    dotenv[name] = { sha256: sha256(readFileSync(path)), bytes: info.size, ...(info.isSymbolicLink() ? { target: readlinkSync(path) } : {}) };
  }
  const runtime: JsonObject = { environment: runtimeEnvironment(environment), dotenv,
    dockerContext: command(['context', 'show']),
    dockerContextEndpointSha256: configurationHash(JSON.parse(command(['context', 'inspect', '--format', '{{json .Endpoints.docker}}']))),
    scope: 'Benchmark/product/runtime/build-tool environment families, common locale/proxy/temp/library inputs, root dotenv files and selected Docker context endpoint. Generated process IDs and executable guard receipts are excluded.' };
  const services: Record<string, JsonObject> = {};
  for (const id of [...stackIds].sort()) {
    const stack = getStack(id), composeFile = relative(benchmarkRoot, stack.composeFile), composeSha256 = sha256(readFileSync(stack.composeFile));
    if (((source.files as JsonObject)?.[composeFile] as JsonObject)?.sha256 !== composeSha256) throw new Error('Resolved Compose input differs from archived source');
    const resolved = JSON.parse(command(['compose', '-f', stack.composeFile, 'config', '--format', 'json']));
    const ids = command(['compose', '-f', stack.composeFile, 'ps', '--all', '-q']).split(/\s+/).filter(Boolean);
    if (!ids.length) throw new Error(`No configured containers found for ${id}`);
    const containers = (JSON.parse(command(['inspect', ...ids])) as any[]).sort((a, b) => a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0).map(container => {
      const mounts = (container.Mounts ?? []).map((mount: any): JsonObject => ({ type: mount.Type, source: mount.Source, destination: mount.Destination, readWrite: mount.RW,
        name: mount.Name ?? null, mode: mount.Mode ?? '', propagation: mount.Propagation ?? '',
        input: mount.Type === 'bind' ? mountedInput(mount.Source) : { scope: 'mutable volume contents are not configuration inputs' } }));
      return containerConfiguration(container, mounts);
    });
    services[id] = { composeFile, composeSha256, resolvedComposeSha256: configurationHash(resolved),
      declaredServices: Object.fromEntries(Object.entries(resolved.services ?? {}).map(([name, value]: [string, any]) => [name, { environment: environmentSummary(value.environment ?? {}), command: commandSummary(value.command), entrypoint: commandSummary(value.entrypoint) }])),
      containers };
  }
  const body = { version: 1 as const, sourceHash: String(source.sourceHash), runtime, services };
  return { ...body, fingerprint: configurationHash(body) };
}
export async function writeConfiguration(directory: string, record: ConfigurationRecord): Promise<ConfigurationIdentity> {
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n'); await writeFile(join(directory, 'CONFIGURATION.json'), bytes); return configurationIdentity(record, bytes);
}
export function assertConfigurationUnchanged(stackIds: StackId[], source: JsonObject, expected: ConfigurationIdentity, environment?: NodeJS.ProcessEnv): void {
  if (captureConfiguration(stackIds, source, environment).fingerprint !== expected.fingerprint) throw new Error('Runtime or resolved service configuration changed during campaign');
}
const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateConfigurationIdentity(identity: ConfigurationIdentity | undefined, source: JsonObject, stacks: string[]): void {
  if (!identity || identity.version !== 1 || !validHash(identity.fingerprint) || !validHash(identity.sha256) || identity.sourceHash !== source.sourceHash || typeof identity.path !== 'string' || !identity.path || identity.path.startsWith('/') || identity.path.split('/').some(part => part === '..' || !part) || !Array.isArray(identity.stacks) || stacks.some(id => !identity.stacks.includes(id)) || new Set(identity.stacks).size !== identity.stacks.length) throw new Error('Runtime/service configuration provenance is missing or invalid');
}
export function validateConfigurationRecord(bytes: Uint8Array, identity: ConfigurationIdentity, source: JsonObject, stacks: string[]): void {
  validateConfigurationIdentity(identity, source, stacks);
  if (sha256(bytes) !== identity.sha256) throw new Error('Configuration artifact hash differs');
  const record = JSON.parse(Buffer.from(bytes).toString()) as ConfigurationRecord, { fingerprint, ...body } = record;
  if (record.version !== 1 || record.sourceHash !== source.sourceHash || fingerprint !== identity.fingerprint || configurationHash(body) !== fingerprint || JSON.stringify(Object.keys(record.services).sort()) !== JSON.stringify(identity.stacks)) throw new Error('Configuration fingerprint differs');
  if (!validHash((record.runtime.environment as JsonObject)?.sha256) || !record.runtime.dotenv || !validHash(record.runtime.dockerContextEndpointSha256)) throw new Error('Runtime environment evidence missing');
  for (const id of stacks) {
    const service = record.services[id], containers = service?.containers as JsonObject[];
    if (!service || !validHash(service.resolvedComposeSha256) || !validHash(service.composeSha256) || service.composeSha256 !== ((source.files as JsonObject)?.[String(service.composeFile)] as JsonObject)?.sha256 || !Array.isArray(containers) || !containers.length || containers.some(container => !validHash(container.configurationSha256) || !validHash(container.hostConfigurationSha256) || typeof container.imageId !== 'string' || !container.imageId.startsWith('sha256:') || !Array.isArray(container.mounts))) throw new Error('Resolved service evidence missing or inconsistent with source');
  }
}
export async function readCampaignConfiguration(directory: string, identity: ConfigurationIdentity, source: JsonObject, stacks: string[]): Promise<Buffer> {
  validateConfigurationIdentity(identity, source, stacks); const bytes = await readFile(join(directory, identity.path)); validateConfigurationRecord(bytes, identity, source, stacks); return bytes;
}
