import { assertRows, ContractError, fixtureTasks, taskRecord, type Row } from './screens.ts';
import type { RecoveryMutation, RecoveryState } from '../recovery/protocol.ts';
import type { SeedOptions, StackId } from '../types.ts';

export const RECOVERY_CONTRACT = 'offline-recovery-v2';
export type RecoveryCase = 'offline-replay' | 'large-offline-queue' | 'offline-restart';
export const recoverySeed: Required<SeedOptions> = { resetFirst: true, orgCount: 1, projectsPerOrg: 1, usersPerOrg: 2, tasksPerProject: 2_000, membershipsPerProject: 2 };
export const recoverySizes = (scenario: RecoveryCase): number[] => scenario === 'large-offline-queue' ? [100, 500, 1_000] : [scenario === 'offline-restart' ? 1_000 : 10];
export function recoveryMutations(count: number): RecoveryMutation[] {
  return fixtureTasks(recoverySeed).slice(0, count).map((row, i) => ({ id: String(row.id), title: `offline-recovery-${count}-${i}` }));
}
export function recoveryExpected(mutations: RecoveryMutation[] = []): Row[] {
  const changes = new Map(mutations.map(row => [row.id, row.title]));
  return fixtureTasks(recoverySeed).map(row => changes.has(String(row.id)) ? { ...row, title: changes.get(String(row.id)), server_version: 2 } : row);
}
/** Validate every row, including untouched records; one matching tail write or
 * an empty outbox does not establish lossless replay. */
export function validateRecoveryState(label: string, state: RecoveryState, mutations: RecoveryMutation[], pending: 'queued' | 'empty'): string {
  if (!Number.isSafeInteger(state.pending) || state.pending < 0 || (pending === 'queued' ? state.pending === 0 : state.pending !== 0)) throw new ContractError(`${label}: expected ${pending} product outbox, got ${state.pending}`);
  if ((state.rejected !== null && state.rejected !== 0) || (state.conflicts !== null && state.conflicts !== 0)) throw new ContractError(`${label}: unexpected rejection or conflict in disjoint replay`);
  return assertRows(label, state.rows.map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id))), recoveryExpected(mutations));
}

export function recoveryGuarantees(stackId: StackId | undefined, scenario: RecoveryCase) {
  return { localStore: stackId === 'zero' ? 'memory' : 'persistent-file',
    queueStore: (stackId === 'zero' || (stackId === 'electric-tanstack' && scenario !== 'offline-restart')) ? 'memory' : 'persistent-file',
    offlineQueue: stackId === 'electric' ? 'benchmark-managed' : 'product-managed',
    restart: scenario === 'offline-restart' ? 'SIGKILL-and-reopen-offline' : 'live-process-replay' };
}
