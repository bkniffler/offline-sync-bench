import { ContractError } from './screens.ts';
import { validateZeroRecoveryState } from './zero-recovery.ts';
import type { JsonObject } from '../types.ts';

const target = 'org-1-project-1-task-000001';
/** Exact records are validated separately; these are native mutation outcomes
 * and fresh client identities, not a claim of an aggregate SDK queue counter. */
export function validateZeroConflictEvidence(metadata: JsonObject) {
  const clients = metadata.clients as JsonObject[];
  if (!Array.isArray(clients) || clients.length !== 3 || JSON.stringify(clients.map(c => c.role)) !== JSON.stringify(['writer', 'peer', 'observer'])) throw new ContractError('Zero conflict client evidence missing');
  const seen = new Map<string, Set<unknown>>();
  for (const client of clients) {
    const cache = (client.diagnostics as JsonObject)?.initialCache as JsonObject;
    if (!Number.isSafeInteger(client.pid) || Number(client.pid) < 1 || cache?.kvStore !== 'mem' || cache.rows !== 0 || client.clientId !== cache.id || client.store !== cache.id) throw new ContractError('Zero conflict client is not a fresh memory replica');
    for (const [field, value] of Object.entries({ pid: client.pid, id: cache.id, nativeClientId: cache.nativeClientId, storageKey: cache.storageKey })) {
      const ids = seen.get(field) ?? new Set(); seen.set(field, ids);
      if ((field !== 'pid' && (typeof value !== 'string' || !value)) || ids.has(value)) throw new ContractError('Zero conflict client identity reused');
      ids.add(value);
    }
    const check = (value: unknown, ids: string[], accepted: boolean) => {
      const state = validateZeroRecoveryState(value as JsonObject, ids, accepted);
      if (state.nativeClientId !== cache.nativeClientId || state.storageKey !== cache.storageKey) throw new ContractError('Zero conflict native client changed');
    };
    check(client.initialNative, [], true);
    check(client.finalNative, client.role === 'observer' ? [] : [target], true);
    if (client.role === 'writer') {
      check(metadata.nativeQueued, [target], false); check(metadata.nativeIsolated, [target], false);
      check((metadata.writerOutcome as JsonObject)?.nativeState, [target], true);
    }
    if (client.role === 'observer') check(metadata.nativeAcceptedPeer, [], true);
  }
  if (metadata.clientStorage !== 'memory; native Zero mutation queue, no process durability') throw new ContractError('Zero conflict persistence profile differs');
}
