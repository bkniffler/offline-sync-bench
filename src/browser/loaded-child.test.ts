import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLoadedChild } from './loaded-child.ts';
import { sha256 } from '../source-snapshot.ts';

// Benign fixture workers exercise real owned child groups without any SDK,
// browser or service. Their explicit alternate entrypoint is rejected by the
// diagnostic campaign verifier and can never supply native timing samples.
const input = { runId: 'synthetic-child-lifecycle', entry: { stackId: 'electric', pair: 1, mode: 'buffered', order: 1 } };
const worker = `
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const [inputPath, outputPath] = process.argv.slice(2);
const bytes = await readFile(inputPath), input = JSON.parse(bytes.toString());
if (process.env.LOADED_FIXTURE_HELPER) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
  console.log('helper-pid=' + child.pid);
}
console.log('fixture-ready');
await Bun.sleep(200);
if (process.env.LOADED_FIXTURE_HANG) await new Promise(() => {});
await writeFile(outputPath, JSON.stringify({ version: 1, runId: input.runId, resultId: 'synthetic-worker-failure', entry: input.entry,
  inputSha256: createHash('sha256').update(bytes).digest('hex'), status: 'failed', error: 'Synthetic worker failure', evidence: null, durationMs: 200 }));
process.exit(1);
`;

test('loaded child preserves failed worker output and its log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loaded-child-failure-'));
  try {
    const entrypoint = join(dir, 'fixture.ts'), resultPath = join(dir, 'result.json'); await writeFile(entrypoint, worker);
    const result = await runLoadedChild(resultPath, input, { ...process.env, LOADED_FIXTURE_HELPER: '', LOADED_FIXTURE_HANG: '' }, 5000, entrypoint);
    expect(result.status).toBe('failed'); expect(result.error).toContain('Synthetic worker failure');
    expect(result.workerEntrypoint).toBe(entrypoint); expect(result.processGroup.emptyVerified).toBe(true);
    expect(result.workerResultSha256).toBe(sha256(await readFile(`${resultPath}.worker.json`)));
    expect(result.logSha256).toBe(sha256(await readFile(`${resultPath}.log`)));
    expect(await readFile(`${resultPath}.log`, 'utf8')).toContain('fixture-ready');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loaded child deadline terminates its owned root and helper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loaded-child-deadline-'));
  try {
    const entrypoint = join(dir, 'fixture.ts'), resultPath = join(dir, 'result.json'); await writeFile(entrypoint, worker);
    const result = await runLoadedChild(resultPath, input, { ...process.env, LOADED_FIXTURE_HELPER: '1', LOADED_FIXTURE_HANG: '1' }, 1500, entrypoint);
    expect(result.status).toBe('timed-out'); expect(result.workerResultAvailable).toBe(false);
    const log = await readFile(`${resultPath}.log`, 'utf8'), match = /helper-pid=(\d+)/.exec(log);
    expect(match).not.toBeNull();
    const group = result.processGroup, before = group.beforeTermination.find((s: any) => s.reason === 'whole-attempt-deadline');
    expect(before.members.some((p: any) => p.pid === group.pid)).toBe(true);
    expect(before.members.some((p: any) => p.pid === Number(match![1]))).toBe(true);
    expect(group.signals.some((s: any) => s.reason === 'whole-attempt-deadline')).toBe(true);
    expect(group.emptyVerified).toBe(true); expect(group.remaining).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);

test('loaded child cleans up an owned helper that outlives the failed worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loaded-child-orphan-'));
  try {
    const entrypoint = join(dir, 'fixture.ts'), resultPath = join(dir, 'result.json'); await writeFile(entrypoint, worker);
    const result = await runLoadedChild(resultPath, input, { ...process.env, LOADED_FIXTURE_HELPER: '1', LOADED_FIXTURE_HANG: '' }, 5000, entrypoint);
    expect(result.status).toBe('failed');
    expect(result.processGroup.signals.some((s: any) => s.reason === 'post-exit-helper-cleanup')).toBe(true);
    expect(result.processGroup.emptyVerified).toBe(true); expect(result.processGroup.remaining).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15000);
