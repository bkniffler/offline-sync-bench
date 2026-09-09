import { ContractError } from './screens.ts';
import type { JsonObject } from '../types.ts';

export function validateTursoPhysicalState(value: JsonObject, containerId: unknown) {
  for (const key of ['serverBefore', 'serverAfter']) {
    const server = value?.[key] as JsonObject, files = server?.files as JsonObject;
    if (server?.method !== 'server-main-and-wal-file-stat-v1' || server.containerId !== containerId || typeof containerId !== 'string' || !containerId || !files || Object.keys(files).sort().join(',') !== 'server.db,server.db-wal') throw new ContractError('Turso physical server file evidence missing');
    for (const name of ['server.db', 'server.db-wal']) {
      const file = files[name] as JsonObject;
      if (typeof file?.exists !== 'boolean' || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || !file.exists && file.bytes !== 0) throw new ContractError('Turso physical file size invalid');
    }
    if (!(files['server.db'] as JsonObject).exists || Number((files['server.db'] as JsonObject).bytes) + Number((files['server.db-wal'] as JsonObject).bytes) <= 0) throw new ContractError('Turso physical server database absent');
  }
  const replica = value.clientReplica as JsonObject;
  const size = Number(replica?.pageSize), pages = Number(replica?.pageCount), free = Number(replica?.freelistCount);
  if (![replica?.pageSize, replica?.pageCount, replica?.freelistCount].every(value => typeof value === 'number') || replica?.method !== 'native-client-replica-pragmas-v1' || ![512, 1024, 2048, 4096, 8192, 16384, 32768, 65536].includes(size)
    || !Number.isSafeInteger(pages) || pages < 1 || !Number.isSafeInteger(free) || free < 0 || free > pages) throw new ContractError('Turso physical replica page evidence invalid');
}
