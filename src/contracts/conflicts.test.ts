import { expect, test } from 'bun:test';
import { assertConflictRows, assertConflictOutcome, conflictRows, conflictFinalRows, conflictPolicy, conflictTarget, offlineTitle, peerTitle } from './conflicts.ts';
import type { RecoveryState } from '../recovery/protocol.ts';

test('a converged last-write winner cannot pass a version-precondition policy', () => {
  const policy = conflictPolicy('syncular', 'conflict-update-update');
  const wrong: RecoveryState = { rows: conflictRows(offlineTitle), pending: 0, conflicts: 0, rejected: 0 };
  expect(() => assertConflictRows('final', wrong, conflictFinalRows(policy))).toThrow('row 0');
  expect(() => assertConflictOutcome(wrong, policy)).toThrow('disposition');
  const correct: RecoveryState = { rows: conflictRows(peerTitle), pending: 0, conflicts: 1, rejected: 0, nativeState: { conflicts: [{ code: 'sync.version_conflict', rowId: conflictTarget }] } };
  expect(() => assertConflictOutcome(correct, policy)).not.toThrow();
  expect(assertConflictRows('final', correct, conflictFinalRows(policy))).toHaveLength(64);
});
test('delete retention requires absence and the declared native response', () => {
  const policy = conflictPolicy('syncular-rust', 'conflict-update-delete');
  const wrong: RecoveryState = { rows: conflictRows(offlineTitle), pending: 0, conflicts: 0, rejected: 1, nativeState: { rejections: [{ code: 'sync.forbidden' }] } };
  expect(() => assertConflictRows('final', wrong, conflictFinalRows(policy))).toThrow('1999');
  expect(() => assertConflictOutcome(wrong, policy)).toThrow('sync.row_missing');
});
test('application SQL policy is explicit and every untouched task remains validated', () => {
  const policy = conflictPolicy('powersync', 'conflict-update-update');
  expect(policy.enforcement).toContain('application backend');
  const state: RecoveryState = { rows: conflictFinalRows(policy), pending: 0, conflicts: null, rejected: null };
  expect(() => assertConflictOutcome(state, policy)).not.toThrow();
  state.rows[1999].title = 'unexpected mutation';
  expect(() => assertConflictRows('final', state, conflictFinalRows(policy))).toThrow('row 1999');
});
