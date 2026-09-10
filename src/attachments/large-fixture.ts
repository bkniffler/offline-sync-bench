import { createHash, createCipheriv } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export interface FileFixture { path: string; bytes: number; sha256: string; source: string }
export const LARGE_FILE_BYTES = 500_000_000;
export async function hashFile(path: string) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}
/** Cache preparation and verification are outside all benchmark clocks. */
export async function prepareLargeFixture(options: { bytes?: number; url?: string; directory?: string } = {}): Promise<FileFixture> {
  const bytes = options.bytes ?? LARGE_FILE_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('File size must be a positive integer');
  const source = options.url ?? 'generated:aes-256-ctr/offline-sync-bench-large-file-v1';
  if (options.url && !['http:', 'https:'].includes(new URL(options.url).protocol)) throw new Error('Demo file URL must use HTTP(S)');
  const key = createHash('sha256').update(`${source}/${bytes}`).digest('hex').slice(0, 16);
  const path = resolve(options.directory ?? '.cache/attachments', `${bytes}-${key}.bin`), manifest = `${path}.json`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await stat(path);
    const recorded = JSON.parse(await readFile(manifest, 'utf8')) as FileFixture;
    const actual = await hashFile(path);
    if (actual.bytes !== bytes || actual.sha256 !== recorded.sha256 || recorded.source !== source || recorded.bytes !== bytes) throw new Error('Cached attachment is corrupt or its manifest differs; remove the cached file and manifest to prepare it again');
    return { path, ...actual, source };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const partial = `${path}.${process.pid}.part`;
  let input: Readable;
  if (options.url) {
    const response = await fetch(options.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Demo download failed: HTTP ${response.status}`);
    input = Readable.fromWeb(response.body as any);
  } else {
    // Deterministic high-entropy bytes avoid making compression look like fast transfer.
    const cipher = createCipheriv('aes-256-ctr', createHash('sha256').update(source).digest(), Buffer.alloc(16));
    input = Readable.from((async function* () {
      for (let left = bytes; left > 0; left -= Math.min(left, 1024 * 1024)) yield cipher.update(Buffer.alloc(Math.min(left, 1024 * 1024)));
      yield cipher.final();
    })());
  }
  let received = 0;
  const limit = new Transform({ transform(chunk, _encoding, done) {
    received += chunk.length;
    done(received > bytes ? new Error(`Demo file exceeds ${bytes} bytes`) : null, chunk);
  } });
  try {
    await pipeline(input, limit, createWriteStream(partial, { flags: 'wx' }));
    if (received !== bytes) throw new Error(`Demo file has ${received} bytes; expected ${bytes}`);
    const fixture = { path, ...await hashFile(partial), source };
    await rename(partial, path); await writeFile(manifest, JSON.stringify(fixture, null, 2) + '\n');
    return fixture;
  } finally { await rm(partial, { force: true }); }
}
