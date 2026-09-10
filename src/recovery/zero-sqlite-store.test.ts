import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createZeroSQLiteStore } from './zero-sqlite-store.ts';

test('Zero KV transactions isolate uncommitted values across handles and persist commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-kv-test-')), path = join(dir, 'store.sqlite');
  try {
    const provider = createZeroSQLiteStore(path), a = provider.create('a'), same = provider.create('a'), b = provider.create('b');
    let write = await a.write(); await write.put('key', { value: 1 });
    let acquired = false;
    const waiting = same.read().then(tx => { acquired = true; return tx; });
    await Promise.resolve(); expect(acquired).toBe(false);
    write.release(); // rollback
    let read = await waiting; expect(await read.get('key')).toBeUndefined(); read.release();
    write = await a.write(); await write.put('key', { value: 2 }); await write.commit(); write.release();
    read = await b.read(); expect(await read.has('key')).toBe(false); read.release();
    await a.close(); await same.close(); await b.close();
    const reopened = createZeroSQLiteStore(path).create('a');
    read = await reopened.read(); expect(await read.get('key')).toEqual({ value: 2 }); read.release();
    await reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
