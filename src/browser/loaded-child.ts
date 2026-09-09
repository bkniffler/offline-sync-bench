import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { benchmarkRoot } from '../paths.ts';
import { sha256 } from '../source-snapshot.ts';
import { hash } from '../contracts/screens.ts';
import { browserProcessTable } from './process.ts';
import { browserBinding } from './provenance.ts';
import { validateLoadedBrowserCondition } from './loaded-validation.ts';
import { LOADED_WORKER_ENTRYPOINT } from './loaded-plan.ts';

/** Owns one diagnostic trial group. Raw child output is retained separately
 * from the parent's outcome, including malformed output and deadline failures. */
export async function runLoadedChild(path: string, input: any, environment: NodeJS.ProcessEnv, timeoutMs: number, workerEntrypoint = LOADED_WORKER_ENTRYPOINT) {
  const inputPath = `${path}.input.json`, workerPath = `${path}.worker.json`;
  const inputBytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  await writeFile(inputPath, inputBytes);
  const startedAt = new Date().toISOString(), started = performance.now();
  const log = createWriteStream(`${path}.log`), logFinished = finished(log);
  const child = spawn(process.execPath, [workerEntrypoint, inputPath, workerPath], {
    cwd: benchmarkRoot, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let spawnError: unknown, launchError: string | undefined, timedOut = false, deadlineAction: Promise<void> | undefined;
  const exited = new Promise<number | null>(resolve => {
    child.once('error', error => { spawnError = error; launchError = String(error); resolve(null); });
    child.once('close', resolve);
  });
  const group: any = { pid: child.pid ?? null, initial: [], beforeTermination: [], remaining: [], signals: [] };
  const inspect = async () => child.pid ? (await browserProcessTable()).filter(row => row.pgid === child.pid) : [];
  const terminate = async (reason: string) => {
    try { group.beforeTermination.push({ reason, at: new Date().toISOString(), members: await inspect() }); }
    catch (error) { group.inventoryError = String(error); }
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); group.signals.push({ reason, signal: 'SIGKILL', at: new Date().toISOString() }); }
      catch (error: any) { if (error.code !== 'ESRCH') group.signalError = String(error); }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true; group.deadlineElapsedMs = performance.now() - started;
    deadlineAction = terminate('whole-attempt-deadline');
  }, timeoutMs);
  try {
    group.initial = await inspect();
    if (child.pid && !group.initial.some((row: any) => row.pid === child.pid && row.ppid === process.pid)) {
      spawnError ??= new Error('Trial root did not establish its own process group');
      await terminate('invalid-initial-group');
    }
  } catch (error) { spawnError ??= error; await terminate('initial-inventory-failed'); }
  const code = await exited;
  if (launchError) group.launchError = launchError;
  clearTimeout(timer); await deadlineAction;
  log.end(); await logFinished;
  try {
    if ((await inspect()).length) await terminate('post-exit-helper-cleanup');
    const deadline = performance.now() + 10_000;
    do {
      group.remaining = await inspect();
      if (!group.remaining.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    group.emptyVerified = group.remaining.length === 0;
  } catch (error) { group.inventoryError = String(error); group.emptyVerified = false; }
  let worker: any, workerResultAvailable = false, workerResultSha256: string | null = null, invalid: unknown = spawnError;
  try {
    const bytes = await readFile(workerPath); workerResultAvailable = true; workerResultSha256 = sha256(bytes);
    worker = JSON.parse(bytes.toString());
    if (worker.version !== 1 || worker.runId !== input.runId || hash(worker.entry) !== hash(input.entry)
      || worker.inputSha256 !== sha256(inputBytes) || !['completed', 'failed'].includes(worker.status)
      || typeof worker.resultId !== 'string' || !worker.resultId) throw new Error('Loaded worker result identity differs');
    if (worker.status === 'completed') {
      if (code !== 0 || worker.evidence?.stackId !== input.entry.stackId || worker.evidence?.mode !== input.entry.mode
        || hash(worker.evidence.binding) !== hash(browserBinding(input.browser))) throw new Error('Loaded worker completion differs from its declared condition');
      validateLoadedBrowserCondition(worker.evidence);
    } else if (!worker.error) throw new Error('Failed loaded worker omitted its error');
  } catch (error) { invalid ??= error; }
  if (!group.emptyVerified) invalid ??= new Error('Loaded trial group cleanup is unverified');
  const status = timedOut ? 'timed-out' : invalid ? 'invalid' : worker.status;
  return {
    version: 1, runId: input.runId, resultId: typeof worker?.resultId === 'string' && worker.resultId ? worker.resultId : randomUUID(), entry: input.entry,
    inputSha256: sha256(inputBytes), workerEntrypoint, startedAt, finishedAt: new Date().toISOString(), durationMs: performance.now() - started,
    status, error: timedOut ? `Loaded trial exceeded ${timeoutMs}ms` : invalid ? String(invalid) : worker.error ?? null,
    workerResultAvailable, workerResultSha256, logSha256: sha256(await readFile(`${path}.log`)), workerDurationMs: worker?.durationMs ?? null,
    evidence: worker?.evidence ?? null, processGroup: group, exitCode: code,
  };
}
