import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLargeFixture } from './large-fixture.ts';

test('cached payload is deterministic and corrupt bytes are rejected', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'bench-file-'));
 try {
  const first = await prepareLargeFixture({ bytes: 10001, directory });
  expect(await prepareLargeFixture({ bytes: 10001, directory })).toEqual(first);
  const second = await prepareLargeFixture({ bytes: 10001, directory: join(directory, 'second') });
  expect(second.sha256).toBe(first.sha256);
  const bytes = await readFile(first.path); bytes[5] ^= 255; await writeFile(first.path, bytes);
  await expect(prepareLargeFixture({ bytes: 10001, directory })).rejects.toThrow('corrupt');
 } finally { await rm(directory, { recursive: true, force: true }); }
});

test('demo URL is downloaded once and wrong-sized responses cannot become fixtures', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'bench-download-')); let requests = 0;
 const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response(new Uint8Array(100)); } });
 try {
  const first = await prepareLargeFixture({ bytes: 100, directory, url: server.url.toString() });
  expect(await prepareLargeFixture({ bytes: 100, directory, url: server.url.toString() })).toEqual(first); expect(requests).toBe(1);
  await expect(prepareLargeFixture({ bytes: 99, directory, url: server.url.toString() })).rejects.toThrow('exceeds');
  await expect(prepareLargeFixture({ bytes: 101, directory, url: server.url.toString() })).rejects.toThrow('expected 101');
 } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
});
