import { ContractError } from './screens.ts';
import type { JsonObject } from '../types.ts';

/** A closed connection does not prove native allocations were released. The
 * seeder must exit before creating the independently materialized reader. */
export function validateSeedIsolation(metadata: JsonObject) {
  const evidence = metadata.seedingIsolation as JsonObject, seed = evidence?.seeding as JsonObject, reader = evidence?.reader as JsonObject;
  if (evidence?.method !== 'separate-seed-process-v1' || !seed || !reader || seed.pid === reader.pid || seed.store === reader.store || seed.datasetId !== reader.datasetId || typeof seed.datasetId !== 'string' || !seed.datasetId) throw new ContractError('Separate seeder/reader identity and dataset proof missing');
  for (const p of [seed, reader]) if (!Number.isSafeInteger(p.pid) || Number(p.pid) < 2 || !Number.isSafeInteger(p.parentPid) || Number(p.parentPid) < 2 || p.pid === p.parentPid || typeof p.store !== 'string' || !p.store) throw new ContractError('Seed/reader process and store identity missing');
  if (seed.parentPid !== reader.parentPid || seed.exitCode !== 0 || seed.exitSignal !== null || seed.edgeDurable !== true || seed.exitObservedBeforeReaderSpawn !== true) throw new ContractError('Seed process did not confirm durability and exit before the reader');
  const times = [seed.completedAt, seed.exitedAt, reader.startedAt].map(value => Date.parse(String(value)));
  if (times.some(value => !Number.isFinite(value)) || times[0] > times[1] || times[1] > times[2]) throw new ContractError('Seeding and reader lifecycle order differs');
  const validation = metadata.validation as JsonObject;
  if (seed.taskCount !== 100_000 || seed.taskCount !== validation?.taskCount || seed.tasksDigest !== validation?.tasksDigest || typeof seed.tasksDigest !== 'string' || seed.productVersion !== metadata.productVersion) throw new ContractError('Seeder and measured reader did not validate the same full fixture');
  const resource = metadata.resources as JsonObject, samples = resource?.samples as JsonObject[];
  if (resource?.method !== 'external-ps-process-tree-v1' || resource.rootPid !== reader.pid || resource.includeRoot !== true || !Array.isArray(samples) || samples.length < 2 || samples.some(sample => {
    const processes = sample.processes as JsonObject[];
    return !Array.isArray(processes) || !processes.some(p => p.pid === reader.pid) || processes.some(p => p.pid === seed.pid || p.pid === reader.parentPid);
  })) throw new ContractError('Screen resources include seeder/controller or lack the measured reader');
}
