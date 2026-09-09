import { spawnSync } from 'node:child_process';
import { hash } from './contracts/screens.ts';
import { getStack } from './stacks.ts';
import type { JsonObject, StackId } from './types.ts';

export const serverStoragePolicy = {
  version: 1,
  preparation: 'retain existing server volumes and writable layers; scenario-specific logical fixture preparation',
  measurement: 'docker-inspect-size-and-container-du-kib-v1',
  scope: 'writable layer bytes and allocated KiB for named volumes and writable bind mounts; read-only configuration inputs excluded',
  timing: 'outside client workload timing; before/after trial, and after fixture preparation before/after each startup client',
  limitations: 'live non-atomic observations; filesystem metadata traversal may warm caches; no OS-cache reset, historical-state reconstruction, application-byte accounting or storage normalization',
} as const;
export type StoragePhase = 'before-trial' | 'after-trial' | 'before-startup-client' | 'after-startup-client';
export type StorageMeasurement = { status: 'measured'; bytes: number; reason: null } | { status: 'unavailable'; bytes: null; reason: string };
export interface StorageContainer {
  containerId: string; name: string; service: string; imageId: string;
  running: boolean; startedAt: string;
  writableLayer: StorageMeasurement;
  mounts: Array<{ type: 'volume' | 'bind'; name: string | null; destination: string; readWrite: boolean; allocation: StorageMeasurement }>;
}
export interface ServerStorageSnapshot {
  version: 1; stackId: StackId; phase: StoragePhase; method: typeof serverStoragePolicy.measurement;
  startedAt: string; finishedAt: string; containers: StorageContainer[];
}
const measured = (bytes: number): StorageMeasurement => ({ status: 'measured', bytes, reason: null });
const unavailable = (reason: string): StorageMeasurement => ({ status: 'unavailable', bytes: null, reason });
const validBytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** du -k reports allocated KiB, not logical file length or sync payload bytes. */
export function parseAllocatedStorage(stdout: string, destination: string): StorageMeasurement {
  const match = /^(\d+)[\t ]+(.+)$/.exec(stdout.trim());
  const bytes = match ? Number(match[1]) * 1024 : NaN;
  return match?.[2] === destination && validBytes(bytes) ? measured(bytes) : unavailable('du output did not identify one valid allocation total for the mounted path');
}
export function storageMounts(container: any): Array<{ type: 'volume' | 'bind'; name: string | null; destination: string; readWrite: boolean }> {
  return (container.Mounts ?? []).filter((m: any) => m.Type === 'volume' || m.Type === 'bind' && m.RW === true)
    .map((m: any) => ({ type: m.Type, name: m.Name ?? null, destination: m.Destination, readWrite: m.RW }))
    .sort((a: { destination: string }, b: { destination: string }) => a.destination.localeCompare(b.destination));
}
const docker = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
const requiredDocker = (args: string[]) => {
  const result = docker(args);
  if (result.status !== 0) throw new Error(`Server-storage ${args[0]} failed (${result.error?.name ?? result.status})`);
  return result.stdout.trim();
};
export function captureServerStorage(stackId: StackId, phase: StoragePhase): ServerStorageSnapshot {
  const startedAt = new Date().toISOString();
  const ids = requiredDocker(['compose', '-f', getStack(stackId).composeFile, 'ps', '--all', '-q']).split(/\s+/).filter(Boolean);
  if (!ids.length) throw new Error(`Server-storage container inventory missing for ${stackId}`);
  const inspected = JSON.parse(requiredDocker(['inspect', '--size', ...ids])) as any[];
  const containers = inspected.map((container): StorageContainer => ({
    containerId: container.Id, name: container.Name, service: container.Config.Labels?.['com.docker.compose.service'] ?? '', imageId: container.Image,
    running: container.State.Running, startedAt: container.State.StartedAt,
    writableLayer: validBytes(container.SizeRw) ? measured(container.SizeRw) : unavailable('Docker did not expose writable-layer size'),
    mounts: storageMounts(container).map(mount => {
      const result = docker(['exec', container.Id, 'du', '-sk', mount.destination]);
      return { ...mount, allocation: result.status === 0 ? parseAllocatedStorage(result.stdout, mount.destination) : unavailable(`Mounted-path allocation unavailable: du ${result.error?.name ?? `exit ${result.status}`}`) };
    }),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const snapshot: ServerStorageSnapshot = { version: 1, stackId, phase, method: serverStoragePolicy.measurement, startedAt, finishedAt: new Date().toISOString(), containers };
  validateServerStorage(snapshot, stackId, phase); return snapshot;
}
function validateMeasurement(value: StorageMeasurement) {
  if (!value || (value.status === 'measured' ? !validBytes(value.bytes) || value.reason !== null : value.status !== 'unavailable' || value.bytes !== null || typeof value.reason !== 'string' || !value.reason.trim())) throw new Error('Server-storage measurement must be measured bytes or explicit unavailable evidence');
}
export function validateServerStorage(snapshot: ServerStorageSnapshot, stackId: StackId, phase: StoragePhase): void {
  if (!snapshot || snapshot.version !== 1 || snapshot.stackId !== stackId || snapshot.phase !== phase || snapshot.method !== serverStoragePolicy.measurement || !Array.isArray(snapshot.containers) || !snapshot.containers.length) throw new Error('Server-storage snapshot identity or container inventory missing');
  const started = Date.parse(snapshot.startedAt), finished = Date.parse(snapshot.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) throw new Error('Server-storage observation interval invalid');
  const ids = new Set(), names = new Set();
  for (const c of snapshot.containers) {
    if (!/^[a-f0-9]{64}$/.test(c.containerId) || !c.name || !c.service || !/^sha256:[a-f0-9]{64}$/.test(c.imageId) || ids.has(c.containerId) || names.has(c.name) || typeof c.running !== 'boolean' || !Number.isFinite(Date.parse(c.startedAt)) || !Array.isArray(c.mounts)) throw new Error('Server-storage container identity missing or duplicated');
    ids.add(c.containerId); names.add(c.name); validateMeasurement(c.writableLayer);
    const destinations = new Set();
    for (const m of c.mounts) {
      if (!['volume','bind'].includes(m.type) || typeof m.destination !== 'string' || !m.destination.startsWith('/') || destinations.has(m.destination) || typeof m.readWrite !== 'boolean' || m.type === 'bind' && (!m.readWrite || m.name !== null) || m.type === 'volume' && (typeof m.name !== 'string' || !m.name)) throw new Error('Server-storage mount identity missing or duplicated');
      destinations.add(m.destination); validateMeasurement(m.allocation);
      if (m.allocation.status === 'measured' && m.allocation.bytes % 1024 !== 0) throw new Error('Mounted allocation must use KiB units');
    }
  }
}
export function validateServerStoragePair(value: JsonObject, stackId: StackId, kind: 'trial' | 'startup-client', expectedContainers?: JsonObject[]): void {
  if (!value || !value.policy || hash(value.policy) !== hash(serverStoragePolicy)) throw new Error('Server-storage preparation policy missing');
  const before = value.before as unknown as ServerStorageSnapshot, after = value.after as unknown as ServerStorageSnapshot;
  validateServerStorage(before, stackId, `before-${kind}`); validateServerStorage(after, stackId, `after-${kind}`);
  const window = value.window as JsonObject;
  const start = Date.parse(String(window?.startedAt)), end = Date.parse(String(window?.finishedAt));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || Date.parse(before.finishedAt) > start || end > Date.parse(after.startedAt)) throw new Error('Server-storage observations overlap the declared workload window');
  if (Date.parse(before.finishedAt) > Date.parse(after.startedAt)) throw new Error('Server-storage before/after sequence invalid');
  const identity = (c: StorageContainer) => ({ id: c.containerId, name: c.name, service: c.service, image: c.imageId, mounts: c.mounts.map(({ allocation: _, ...m }) => m) });
  if (hash(before.containers.map(identity)) !== hash(after.containers.map(identity))) throw new Error('Server-storage containers or mounts changed during observation');
  if (kind === 'startup-client' && before.containers.some((c,i) => c.running !== after.containers[i].running || c.startedAt !== after.containers[i].startedAt)) throw new Error('Server-storage service restarted during client measurement');
  if (expectedContainers) {
    if (expectedContainers.length !== before.containers.length) throw new Error('Server-storage inventory differs from campaign configuration');
    for (const c of before.containers) {
      const expected = expectedContainers.find(e => e.name === c.name);
      const mounts = (expected?.mounts as JsonObject[] | undefined)?.filter(m => m.type === 'volume' || m.type === 'bind' && m.readWrite === true).map(({ type, name, destination, readWrite }) => ({ type, name, destination, readWrite })).sort((a,b) => String(a.destination).localeCompare(String(b.destination)));
      if (!expected || expected.imageId !== c.imageId || expected.service !== c.service || hash(mounts) !== hash(c.mounts.map(({ allocation: _, ...m }) => m))) throw new Error('Server-storage service or mount differs from campaign configuration');
    }
  }
}
