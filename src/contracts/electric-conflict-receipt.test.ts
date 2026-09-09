import { expect, test } from 'bun:test';
import { validateElectricConflictReceipt } from './electric-conflict-receipt.ts';
import { resultProfile } from '../profiles.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

const expected = { taskId: 'task', operation: 'update', idempotencyKey: 'queued-key' };
const updated = { method: 'application-sql-conflict-receipt-v1', ...expected, txid: 123, affectedRows: 1, disposition: 'updated', serverVersion: 3, replayed: false };
test('conflict receipts distinguish applied updates, exact retries and missing-row no-ops', () => {
  expect(() => validateElectricConflictReceipt(updated, expected)).not.toThrow();
  expect(() => validateElectricConflictReceipt({ ...updated, replayed: true }, expected)).not.toThrow();
  expect(() => validateElectricConflictReceipt({ ...updated, affectedRows: 0, disposition: 'missing-row-noop', serverVersion: null }, expected)).not.toThrow();
  expect(() => validateElectricConflictReceipt({ ...updated, operation: 'delete', disposition: 'deleted', serverVersion: null }, { ...expected, operation: 'delete' })).not.toThrow();
  for (const change of [
    { idempotencyKey: 'other-write' }, { taskId: 'other-task' }, { operation: 'delete' }, { txid: null }, { txid: -1 },
    { affectedRows: 2 }, { affectedRows: '1' }, { affectedRows: 0 }, { serverVersion: null }, { serverVersion: 1 }, { replayed: null },
    { affectedRows: 0, disposition: 'missing-row-noop', serverVersion: 3 },
  ]) expect(() => validateElectricConflictReceipt({ ...updated, ...change }, expected)).toThrow();
});
test('conflict profiles preserve queue ownership and persistence even for an identical write policy', () => {
  const result = { stackId: 'electric', scenarioId: 'conflict-update-update', status: 'completed', metrics: {}, metadata: { workloadContract: 'conflicting-edits-v1', policy: { id: 'same-sql-policy' }, resources: { method: 'external-ps-process-tree-v1' }, clientStorage: 'benchmark-owned persistent cache and outbox' } } as unknown as BenchmarkResult;
  const campaign = { source: { sourceHash: 'source' }, machine: {}, network: {}, images: {} };
  const a = resultProfile(result, campaign);
  const b = resultProfile({ ...result, metadata: { ...result.metadata, clientStorage: 'native memory outbox' } }, campaign);
  expect(a.comparisonKey).not.toBe(b.comparisonKey);
  expect((a.guarantee as JsonObject).clientStorage).toBe(result.metadata.clientStorage);
});
