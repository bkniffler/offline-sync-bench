import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { deliveryQuery, matchingDeliveryRows, pollDelivery } from './observe.ts';
import { normalizeDockerStats } from './server-resources.ts';

test('delivery query requires every expected title/version, not a matching last row', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE tasks (id TEXT, title TEXT, server_version INTEGER); INSERT INTO tasks VALUES ('a', 'stale', 1), ('b', 'new-b', 2)");
  const q = deliveryQuery([{ id: 'a', title: 'new-a', serverVersion: 2 }, { id: 'b', title: 'new-b', serverVersion: 2 }]);
  expect(db.query(q.sql).all(...q.params)).toEqual([{ id: 'b' }]);
  db.exec("UPDATE tasks SET title='new-a', server_version=2 WHERE id='a'");
  expect(db.query(q.sql).all(...q.params)).toHaveLength(2); db.close();
});
test('local delivery observer rejects duplicated or missing rows without issuing a sync', async () => {
  await expect(pollDelivery([{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }], async () => [{ id: 'a' }, { id: 'a' }], 10)).rejects.toThrow('timed out');
});
test('missing Docker counters stay unavailable while measured zero is retained', () => {
  const missing = normalizeDockerStats({});
  expect(missing.cpuTotalNs).toBeNull(); expect(missing.memoryBytes).toBeNull(); expect(missing.rxBytes).toBeNull();
  const zero = normalizeDockerStats({ cpu_stats: { cpu_usage: { total_usage: 0 } }, memory_stats: { usage: 0, limit: 100 }, networks: { eth0: { rx_bytes: 0, tx_bytes: 0 } } });
  expect(zero.cpuTotalNs).toBe(0); expect(zero.memoryBytes).toBe(0); expect(zero.rxBytes).toBe(0);
});
test('native array delivery checks each title and version and preserves duplicate evidence', async () => {
  const expected = [{ id: 'a', title: 'new-a', serverVersion: 2 }, { id: 'b', title: 'new-b', serverVersion: 2 }];
  const stale = [{ id: 'a', title: 'new-a', server_version: 1 }, { id: 'b', title: 'new-b', server_version: 2 }];
  expect(matchingDeliveryRows(expected, stale)).toEqual([{ id: 'b' }]);
  const fresh = [{ ...stale[0], server_version: 2 }, stale[1]];
  await expect(pollDelivery(expected, async () => matchingDeliveryRows(expected, fresh), 10)).resolves.toBeUndefined();
  await expect(pollDelivery(expected, async () => matchingDeliveryRows(expected, [...fresh, fresh[0]]), 10)).rejects.toThrow('timed out');
  expect(() => matchingDeliveryRows([expected[0], expected[0]], fresh)).toThrow('distinct');
});
