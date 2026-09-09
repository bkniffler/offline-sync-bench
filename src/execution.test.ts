import { expect, test } from 'bun:test';
import { executeBenchmark, failureStatus, isFailed, validateResult } from './execution.ts';
import { getStack } from './stacks.ts';
import type { BenchmarkAdapter } from './types.ts';

test('failed attempts retain their start and elapsed time', async () => {
  const adapter = { stack: getStack('electric'), runBootstrap: async () => { await Bun.sleep(15); throw new Error('setup failure'); } } as unknown as BenchmarkAdapter;
  const result = await executeBenchmark({ runId: 'test', runDir: '/tmp' }, adapter, 'bootstrap');
  expect(result.status).toBe('failed'); expect(result.durationMs).toBeGreaterThanOrEqual(10);
  expect(result.startedAt < result.finishedAt).toBe(true);
});
test('classifies invalid contracts and timeouts across subprocess error messages', () => {
  expect(failureStatus(new Error('Runner: Invalid measurement: wrong tasks'))).toBe('invalid');
  expect(failureStatus(new Error('Runner ETIMEDOUT'))).toBe('timed-out');
  for (const status of ['invalid', 'timed-out', 'failed'] as const) expect(isFailed(status)).toBe(true);
  expect(isFailed('unsupported')).toBe(false);
});
test('a success label cannot bypass screen validation', () => {
  expect(() => validateResult({ scenarioId: 'local-query', status: 'completed', metrics: { row_count: 10_000 }, metadata: {} })).toThrow('shared fixture');
  expect(() => validateResult({ scenarioId: 'bootstrap', status: 'completed', metrics: { duration: NaN }, metadata: {} })).toThrow('non-finite');
});


test('a valid contract tag cannot certify an unrelated scenario', () => {
  for (const contract of ['screens-v2', 'collaboration-v2', 'offline-recovery-v2', 'conflicting-edits-v1', 'persisted-replica-reopen-v1', 'initial-startup-v1']) {
    expect(() => validateResult({ scenarioId: 'blob-flow', status: 'completed', metrics: {}, metadata: { workloadContract: contract } })).toThrow('does not match scenario');
  }
});


test('invalid measurements retain the adapter observations for diagnosis', async () => {
  const outcome = { status: 'completed', metrics: { row_count: 10_000, latency_ms: 1 }, notes: ['native query'],
    metadata: { fixture: { tasks: 10_000 }, observedIds: ['wrong-task'], implementation: 'test-adapter' } };
  const adapter = { stack: getStack('electric'), runLocalQuery: async () => structuredClone(outcome) } as unknown as BenchmarkAdapter;
  const result = await executeBenchmark({ runId: 'invalid-evidence', runDir: '/tmp' }, adapter, 'local-query');
  expect(result.status).toBe('invalid');
  expect(result.metrics).toEqual(outcome.metrics);
  expect(result.metadata.observedIds).toEqual(['wrong-task']);
  expect(result.metadata.fixture).toEqual(outcome.metadata.fixture);
  expect(result.metadata.validationFailure).toMatchObject({ reportedStatus: 'completed' });
  expect(result.notes[0]).toBe('native query');
  expect(result.notes.at(-1)).toContain('shared fixture');
});
