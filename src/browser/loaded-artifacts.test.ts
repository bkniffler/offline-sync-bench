import { expect, test } from 'bun:test';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../source-snapshot.ts';
import { verifyLoadedAttemptArtifacts } from './loaded-analysis.ts';

// Minimal raw-file fixtures only. No source, browser or service provenance is
// fabricated here; full-campaign verification remains a separate live gate.
async function fixture(root: string) {
  const dir = join(root, 'original'); await mkdir(dir);
  const m: any = { id: 'synthetic-raw-artifacts', config: { runtime: { kind: 'chromium', executable: '/tmp/fixture-browser/Chrome', installationRoot: '/tmp/fixture-browser' } },
    browser: { bundlePath: 'BROWSER.bundle.js', fingerprint: 'fixture-only' } };
  const entry = { stackId: 'electric', pair: 1, mode: 'buffered', order: 1 };
  const resultFile = '0001-electric-pair-1-buffered.json';
  const input = { runId: m.id, entry, runtime: m.config.runtime, browser: m.browser, bundlePath: join(dir, 'BROWSER.bundle.js') };
  const inputBytes = Buffer.from(JSON.stringify(input));
  const worker: any = { version: 1, runId: m.id, resultId: 'fixture-result', entry,
    inputSha256: sha256(inputBytes), status: 'failed', error: 'Synthetic worker failure', evidence: { fixture: true },
    startedAt: '2026-09-07T00:00:00.100Z', finishedAt: '2026-09-07T00:00:00.300Z', durationMs: 200 };
  const workerBytes = Buffer.from(JSON.stringify(worker));
  const a: any = { ...entry, resultFile, logFile: `${resultFile}.log`, inputFile: `${resultFile}.input.json`, workerResultFile: `${resultFile}.worker.json`,
    result: { version: 1, runId: m.id, resultId: worker.resultId, entry, status: 'failed', error: worker.error, evidence: worker.evidence,
      startedAt: '2026-09-07T00:00:00.000Z', finishedAt: '2026-09-07T00:00:00.500Z', durationMs: 500,
      workerResultAvailable: true, workerResultSha256: sha256(workerBytes), workerDurationMs: worker.durationMs, inputSha256: sha256(inputBytes), logSha256: sha256('') } };
  const saveParent = () => writeFile(join(dir, resultFile), JSON.stringify(a.result));
  await writeFile(join(dir, a.inputFile), inputBytes);
  await writeFile(join(dir, a.workerResultFile), workerBytes);
  await writeFile(join(dir, a.logFile), ''); await saveParent();
  return { root, dir, m, a, input, worker, saveParent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test('raw trial files verify after relocation without their original directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loaded-artifacts-relocation-'));
  try {
    const f = await fixture(root);
    await verifyLoadedAttemptArtifacts(f.dir, f.m, f.a, 0);
    await writeFile(join(f.dir, 'FIXTURE.json'), JSON.stringify({ m: f.m, a: f.a }));
    const relocated = join(root, 'relocated'); await cp(f.dir, relocated, { recursive: true });
    await rm(f.dir, { recursive: true });
    const saved = JSON.parse(await readFile(join(relocated, 'FIXTURE.json'), 'utf8'));
    await expect(verifyLoadedAttemptArtifacts(relocated, saved.m, saved.a, 0)).resolves.toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

const corruptions: Array<[string, (f: Fixture) => Promise<unknown>, string | undefined]> = [
  ['changed log', f => appendFile(join(f.dir, f.a.logFile), 'changed'), 'log changed'],
  ['missing log', f => rm(join(f.dir, f.a.logFile)), undefined],
  ['changed input bytes', f => appendFile(join(f.dir, f.a.inputFile), ' '), 'input differs'],
  ['missing worker output', f => rm(join(f.dir, f.a.workerResultFile)), undefined],
  ['changed worker bytes', f => appendFile(join(f.dir, f.a.workerResultFile), ' '), 'worker output changed'],
  ['changed raw parent', f => writeFile(join(f.dir, f.a.resultFile), JSON.stringify({ ...f.a.result, error: 'different' })), 'raw result differs'],
  ['path outside campaign', async f => { f.a.resultFile = '../outside.json'; }, 'artifact names'],
  ['hidden worker output', async f => {
    f.a.result.workerResultAvailable = false; f.a.result.workerResultSha256 = null; f.a.workerResultFile = null; await f.saveParent();
  }, 'requires retained worker'],
  ['changed copied worker duration', async f => { f.a.result.workerDurationMs += 1; await f.saveParent(); }, 'worker result differs'],
  ['changed copied failure explanation', async f => {
    f.worker.error = 'Different native failure'; const bytes = Buffer.from(JSON.stringify(f.worker));
    await writeFile(join(f.dir, f.a.workerResultFile), bytes); f.a.result.workerResultSha256 = sha256(bytes); await f.saveParent();
  }, 'worker result differs'],
  ['worker outside parent clock window', async f => {
    f.worker.finishedAt = '2026-09-07T00:00:01.000Z'; const bytes = Buffer.from(JSON.stringify(f.worker));
    await writeFile(join(f.dir, f.a.workerResultFile), bytes); f.a.result.workerResultSha256 = sha256(bytes); await f.saveParent();
  }, 'worker result differs'],
  ['changed input condition with updated byte digest', async f => {
    f.input.entry = { ...f.input.entry, mode: 'forwarded' }; const bytes = Buffer.from(JSON.stringify(f.input));
    await writeFile(join(f.dir, f.a.inputFile), bytes); f.a.result.inputSha256 = sha256(bytes); await f.saveParent();
  }, 'input differs'],
  ['symlinked artifact', async f => {
    const outside = join(f.root, 'outside.log'); await writeFile(outside, '');
    await rm(join(f.dir, f.a.logFile)); await symlink(outside, join(f.dir, f.a.logFile));
  }, 'regular file'],
];
for (const [name, corrupt, message] of corruptions) test(`raw trial verification rejects ${name}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'loaded-artifacts-corrupt-'));
  try {
    const f = await fixture(root); await corrupt(f);
    const check = expect(verifyLoadedAttemptArtifacts(f.dir, f.m, f.a, 0)).rejects;
    if (message) await check.toThrow(message); else await check.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed worker output stays available as bytes for an invalid attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loaded-artifacts-invalid-'));
  try {
    const f = await fixture(root), bytes = Buffer.from('{incomplete-json');
    f.a.result.status = 'invalid'; f.a.result.error = 'Synthetic invalid worker output'; f.a.result.evidence = null;
    f.a.result.workerResultSha256 = sha256(bytes); await writeFile(join(f.dir, f.a.workerResultFile), bytes); await f.saveParent();
    await expect(verifyLoadedAttemptArtifacts(f.dir, f.m, f.a, 0)).resolves.toBeUndefined();
    expect(await readFile(join(f.dir, f.a.workerResultFile))).toEqual(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
