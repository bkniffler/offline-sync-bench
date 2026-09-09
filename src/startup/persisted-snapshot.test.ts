import { expect, test } from 'bun:test';
import { readPersistedSnapshot } from './persisted-snapshot.ts';

test('full-data capture waits for the native persisted snapshot instead of accepting active-memory counts', async () => {
  let scans = 0;
  const result = await readPersistedSnapshot(async () => ++scans < 3 ? [{ id: 'a' }] : [{ id: 'a' }, { id: 'b' }], 2);
  expect(result.scans).toBe(3);
  expect(result.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
  await expect(readPersistedSnapshot(async () => [], 1, 0)).rejects.toThrow('did not catch up');
  await expect(readPersistedSnapshot(async () => [{ id: 'a' }, { id: 'b' }], 1)).rejects.toThrow('exceeds');
  await expect(readPersistedSnapshot(async () => { throw new Error('native SQLite read failed'); }, 1)).rejects.toThrow('native SQLite read failed');
});
