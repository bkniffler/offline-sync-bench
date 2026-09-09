import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { RecoveryProcess } from './process.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a locally initialized product can close and exit normally without a forced kill', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-close-'));
  const worker = new RecoveryProcess();
  try {
    await worker.open({ stackId: 'syncular', clientId: 'close-test', actorId: 'org-1-user-1', projectId: 'org-1-project-1', dbPath: join(dir, 'local.sqlite'), syncBaseUrl: 'http://127.0.0.1:9' });
    await worker.close();
    await expect(worker.kill()).resolves.toEqual({ code: 0, signal: null });
  } finally { await worker.kill(); await rm(dir, { recursive: true, force: true }); }
});

test('cleanup after process exit retains the original PID and can run twice', async () => {
  const worker = new RecoveryProcess();
  const originalPid = worker.pid;
  expect(originalPid).toBeGreaterThan(1);
  await worker.kill();
  expect(worker.pid).toBe(originalPid);
  await expect(worker.kill()).resolves.toMatchObject({ signal: 'SIGKILL' });
});

test('a detached recovery worker exits when its controlling process is killed', async () => {
  const module = new URL('./process.ts', import.meta.url).href;
  const parent = spawn(process.execPath, ['-e', `import { RecoveryProcess } from ${JSON.stringify(module)}; const worker = new RecoveryProcess(); console.log(JSON.stringify({ pid: worker.pid })); await new Promise(() => {});`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let workerPid: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    workerPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Parent startup timed out')), 5_000);
      createInterface({ input: parent.stdout }).once('line', line => { clearTimeout(timer); resolve(JSON.parse(line).pid); });
      parent.once('error', error => { clearTimeout(timer); reject(error); });
    });
    expect(alive(workerPid)).toBe(true);
    process.kill(-parent.pid!, 'SIGKILL');
    const deadline = performance.now() + 5_000;
    while (alive(workerPid) && performance.now() < deadline) await Bun.sleep(25);
    expect(alive(workerPid)).toBe(false);
  } finally {
    for (const pid of [parent.pid, workerPid]) if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  }
}, 10_000);

test('a worker preserves structured startup failure evidence across process messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-failure-evidence-'));
  const worker = new RecoveryProcess();
  try {
    await worker.call('bootstrap', { config: { stackId: 'syncular', startup: true, clientId: 'failure-test', actorId: 'org-1-user-1', projectId: 'org-1-project-1', dbPath: join(dir, 'local.sqlite'), syncBaseUrl: 'http://127.0.0.1:9' }, count: -1, screen: [] });
    throw new Error('Expected invalid count failure');
  } catch (error) {
    expect(String(error)).toContain('Startup row count');
    expect((error as Error & { evidence: unknown }).evidence).toMatchObject({ startupObservation: { expectedRows: -1, fullData: false, timeoutMs: 90_000 } });
  } finally { await worker.kill(); await rm(dir, { recursive: true, force: true }); }
});
