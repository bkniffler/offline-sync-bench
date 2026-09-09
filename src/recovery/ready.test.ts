import { expect, test } from 'bun:test';
import { recoveryExpected } from '../contracts/recovery.ts';
import { awaitRecoveryReady } from './ready.ts';

test('native completion before canonical catch-up cannot start recovery', async () => {
  let reads = 0;
  const rows = recoveryExpected();
  const result = await awaitRecoveryReady({ sync: async () => {}, read: async () => ({ rows: ++reads === 1 ? rows.slice(0, 10) : rows, pending: 0, rejected: null, conflicts: null }) }, 'writer', { pollMs: 0 });
  expect(reads).toBe(2); expect(result.digest).toHaveLength(64); expect(result.state.rows).toHaveLength(2_000);
});

test('readiness timeout preserves the incomplete data observation', async () => {
  let failure: any;
  try { await awaitRecoveryReady({ sync: async () => {}, read: async () => ({ rows: [], pending: 0, rejected: null, conflicts: null }) }, 'writer', { timeoutMs: 10, pollMs: 1 }); }
  catch (error) { failure = error; }
  expect(failure?.evidence.recoveryReadiness.observations).toBeGreaterThan(0);
  expect(failure?.evidence.recoveryReadiness.lastMismatch).toContain('expected 2000 rows, got 0');
});

test('readiness propagates native sync failures without waiting for a mismatch timeout', async () => {
  const failure = Object.assign(new Error('native connection failed'), { evidence: { native: 'error' } });
  const promise = awaitRecoveryReady({ sync: async () => { throw failure; }, read: async () => { throw new Error('unexpected read'); } }, 'writer');
  expect(promise).rejects.toBe(failure);
  await promise.catch(() => {});
});
test('healthy backlog witness must receive every changed record before readiness', async () => {
  const mutations = [{ id: 'org-1-project-1-task-000001', title: 'backlog' }];
  let reads = 0;
  const result = await awaitRecoveryReady({ sync: async () => {}, read: async () => ({ rows: recoveryExpected(++reads === 1 ? [] : mutations), pending: 0, rejected: null, conflicts: null }) }, 'backlog witness', { mutations, pollMs: 0 });
  expect(reads).toBe(2);
  expect(result.state.rows[0].title).toBe('backlog');
});
