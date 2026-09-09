import type { ScenarioId } from '../types.ts';

/** A valid contract name does not certify an unrelated workload. */
export const contractScenarios: Record<string, readonly ScenarioId[]> = {
  'attachments-v1': ['blob-flow'],
  'access-refresh-v1': ['permission-change'],
  'access-revocation-v1': ['permission-change'],
  'client-fanout-recovery-v1': ['connected-fanout', 'reconnect-storm'],
  'screens-v2': ['local-query', 'deep-relationship-query'],
  'collaboration-v2': ['online-propagation'],
  'offline-recovery-v2': ['offline-replay', 'large-offline-queue', 'offline-restart'],
  'conflicting-edits-v1': ['conflict-update-update', 'conflict-update-delete'],
  'persisted-replica-reopen-v1': ['replica-reopen'],
  'initial-startup-v1': ['bootstrap'],
};
export function hasScenarioContract(contract: unknown, scenario: ScenarioId): boolean {
  return typeof contract === 'string' && Object.hasOwn(contractScenarios, contract) && contractScenarios[contract].includes(scenario);
}
