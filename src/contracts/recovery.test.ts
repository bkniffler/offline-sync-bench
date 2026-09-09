import { expect, test } from 'bun:test';
import { recoveryExpected, recoveryMutations, validateRecoveryState } from './recovery.ts';

test('checking only the last replayed row cannot satisfy recovery', () => {
  const mutations = recoveryMutations(10);
  const partial = recoveryExpected([mutations.at(-1)!]);
  expect(() => validateRecoveryState('reader', { rows: partial, pending: 0, rejected: 0, conflicts: 0 }, mutations, 'empty')).toThrow('reader row 0');
});
test('recovery validates untouched rows, native pending work and rejections', () => {
  const mutations = recoveryMutations(1_000);
  const rows = recoveryExpected(mutations);
  const state = { rows, pending: 0, rejected: 0, conflicts: 0 };
  expect(validateRecoveryState('reader', state, mutations, 'empty')).toHaveLength(64);
  expect(() => validateRecoveryState('writer', { ...state, pending: 1 }, mutations, 'empty')).toThrow('outbox');
  expect(() => validateRecoveryState('writer', state, mutations, 'queued')).toThrow('outbox');
  expect(() => validateRecoveryState('writer', { ...state, rejected: 1 }, mutations, 'empty')).toThrow('rejection');
  rows.at(-1)!.title = 'unintended change';
  expect(() => validateRecoveryState('reader', state, mutations, 'empty')).toThrow('row 1999');
});
