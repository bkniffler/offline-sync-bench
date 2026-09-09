import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSourceSnapshot, readSourceFiles, restoreSourceSnapshot, sha256, validateSourceProvenance, validateSourceSnapshot, writeSourceSnapshot } from './source-snapshot.ts';
import type { JsonObject } from './types.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bench-source-'));
  await mkdir(join(root, 'src')); await mkdir(join(root, 'campaign'));
  await writeFile(join(root, 'src/run.sh'), '#!/bin/sh\necho source\n'); await chmod(join(root, 'src/run.sh'), 0o755);
  await writeFile(join(root, 'src/binary.bin'), new Uint8Array([0, 255, 254, 1]));
  await symlink('run.sh', join(root, 'src/link.sh'));
  const captured = readSourceFiles(root, ['src/run.sh', 'src/binary.bin', 'src/link.sh', 'src/deleted.ts']);
  const source: JsonObject = { version: 2, revision: 'fixture-revision', dirty: true, sourceHash: sha256(JSON.stringify(captured.files)), files: captured.files };
  return { root, captured, source };
}
test('snapshot preserves dirty source bytes, executable modes, links and deletion records', async () => {
  const { root, captured, source } = await fixture();
  try {
    await writeSourceSnapshot(root, join(root, 'campaign'), source);
    const bytes = await readFile(join(root, 'campaign/SOURCE.json')); validateSourceSnapshot(bytes, source);
    await restoreSourceSnapshot(bytes, source, join(root, 'restored'));
    expect(readSourceFiles(join(root, 'restored'), Object.keys(captured.files)).files).toEqual(captured.files);
    await expect(restoreSourceSnapshot(bytes, source, join(root, 'restored'))).rejects.toThrow('EEXIST');
    const saved = JSON.parse(bytes.toString());
    expect(Buffer.from(saved.contents['src/binary.bin'], 'base64')).toEqual(Buffer.from([0, 255, 254, 1]));
    expect(saved.files['src/run.sh'].mode).toBe(0o755);
    expect(saved.files['src/link.sh'].target).toBe('run.sh');
    expect(saved.files['src/deleted.ts'].kind).toBe('deleted');
    expect(saved.contents['src/deleted.ts']).toBeUndefined();
    await chmod(join(root, 'src/run.sh'), 0o644);
    expect(readSourceFiles(root, Object.keys(captured.files)).files).not.toEqual(captured.files);
    await expect(writeSourceSnapshot(root, join(root, 'campaign'), source)).rejects.toThrow('Source changed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('source validation rejects corrupted bytes even if the outer snapshot checksum is recomputed', async () => {
  const { root, captured, source } = await fixture();
  try {
    const bytes = encodeSourceSnapshot(source, captured.contents);
    source.snapshot = { path: 'SOURCE.json', format: 'benchmark-source-v1', sha256: sha256(bytes) };
    validateSourceSnapshot(bytes, source);
    const altered = encodeSourceSnapshot(source, { ...captured.contents, 'src/binary.bin': Buffer.from([0, 255, 255, 1]).toString('base64') });
    expect(() => validateSourceSnapshot(altered, source)).toThrow('artifact hash');
    (source.snapshot as JsonObject).sha256 = sha256(altered);
    expect(() => validateSourceSnapshot(altered, source)).toThrow('contents mismatch');
    const missing = { ...source }; delete missing.snapshot;
    expect(() => validateSourceProvenance(missing)).toThrow('exact campaign snapshot');
    await symlink('../../outside', join(root, 'src/external-link'));
    expect(() => readSourceFiles(root, ['src/external-link'])).toThrow('archived regular file');
  } finally { await rm(root, { recursive: true, force: true }); }
});
