import { validateElectricRecoveryState } from '../contracts/electric-recovery.ts';
import { validateJazzRecoveryState } from '../contracts/jazz-recovery.ts';
import { validateZeroRecoveryState } from '../contracts/zero-recovery.ts';
import type { JsonObject, StackId } from '../types.ts';
import type { RecoveryState, RecoveryMutation } from '../recovery/protocol.ts';

export const extendedFanout = (stackId: StackId) => ['electric', 'electric-tanstack', 'zero', 'jazz-v2'].includes(stackId);
/** Full auxiliary data is checked before retaining compact native receipts. */
export function fanoutClientState(stackId: StackId, state: RecoveryState, changes: RecoveryMutation[], reader: boolean): JsonObject {
  const native = state.nativeState ?? {};
  if (stackId === 'electric' || stackId === 'electric-tanstack') return validateElectricRecoveryState(stackId, state, changes, true, false, reader);
  if (stackId === 'zero') return validateZeroRecoveryState(native, reader ? [] : changes.map(m => m.id), true);
  if (stackId === 'jazz-v2') return { ...validateJazzRecoveryState(state, changes, true), protocolCalls: native.protocolCalls ?? null, delivery: native.delivery ?? null };
  return native;
}
