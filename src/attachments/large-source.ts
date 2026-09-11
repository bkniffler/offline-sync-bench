/** Capture executable benchmark inputs before timing and verify them afterwards. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export async function captureLargeSource(output: string, extraFiles: string[] = []) {
  const files = [...new Set([
    ...execFileSync('git', ['ls-files', 'src', 'services', 'stacks', 'drivers'], { encoding: 'utf8' }).trim().split('\n'),
    ...(await readdir('src/attachments')).filter(n => n.endsWith('.ts')).map(n => `src/attachments/${n}`),
    'scripts/benchmark-large-files.ts', 'package.json', 'bun.lock', ...extraFiles,
  ])].sort();
  const inputs = await Promise.all(files.map(async path => ({ path, sha256: sha256(await readFile(path)) })));
  const listPath = join(output, 'source-files.txt');
  await writeFile(listPath, files.join('\n') + '\n');
  execFileSync('tar', ['--no-xattrs', '-czf', join(output, 'SOURCE.tar.gz'), '-T', listPath], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const source = { files: inputs, archive: 'SOURCE.tar.gz', sha256: sha256(await readFile(join(output, 'SOURCE.tar.gz'))) };
  await writeFile(join(output, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
  return { binding: { path: 'SOURCE.json', sha256: sha256(await readFile(join(output, 'SOURCE.json'))) }, inputs };
}
export async function verifyLargeSource(inputs: Array<{path:string;sha256:string}>) {
  for (const input of inputs) if (sha256(await readFile(input.path)) !== input.sha256) throw new Error(`Source changed during collection: ${input.path}; do not publish this run`);
}
