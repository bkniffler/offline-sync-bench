import { ContractError } from './screens.ts';
import type { JsonObject } from '../types.ts';

/** These are receipts for the operations issued by this trial, not an SDK-wide
 * pending count. Complete record correctness is checked separately. */
export function validateZeroRecoveryState(native: JsonObject | undefined, taskIds: string[], accepted: boolean): JsonObject {
  const ids = [...taskIds].sort();
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (native?.method !== 'native-mutation-promises-v1' || native.nativeQueueCount !== null || native.kvStore !== 'mem'
    || typeof native.nativeClientId !== 'string' || !native.nativeClientId || typeof native.storageKey !== 'string' || !native.storageKey
    || !Array.isArray(native.mutationErrors) || native.mutationErrors.length
    || !equal(native.acceptedLocalTaskIds, ids) || !equal(native.pendingTaskIds, accepted ? [] : ids)
    || !Array.isArray(native.receipts) || native.receipts.length !== ids.length
    || !equal(native.receipts.map(r => (r as JsonObject)?.taskId).sort(), ids)
    || native.receipts.some(r => (r as JsonObject)?.client !== 'success' || (r as JsonObject)?.server !== (accepted ? 'success' : 'pending'))
    || (native.views as JsonObject)?.all !== 'complete' || (native.views as JsonObject)?.screen !== 'complete') {
    throw new ContractError('Zero native mutation receipt proof missing or inconsistent');
  }
  return native;
}
