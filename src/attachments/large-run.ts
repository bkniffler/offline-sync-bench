import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Client } from 'bun';
import { benchmarkRoot, tempRoot } from '../paths.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import { attachmentSeed } from './fixture.ts';
import { ensureFileReplicationRules } from './native-run.ts';
import type { FileFixture } from './large-fixture.ts';
export const largeFileStacks = ['syncular', 'syncular-rust', 'powersync', 'jazz-v2'] as const;
export type LargeFileStack = typeof largeFileStacks[number];
const phaseTimeoutMs = 600_000;

export function validateLargeFileResult(result: any, payload: FileFixture) {
  assert(largeFileStacks.includes(result.stackId));
  assert.equal(result.status, 'completed'); assert.equal(result.phases.length, 2);
  const [writer, fresh] = result.phases;
  assert.equal(writer.phase, 'writer'); assert.equal(fresh.phase, 'fresh');
  assert.notEqual(writer.pid, fresh.pid); assert.notEqual(writer.store, fresh.store);
  for (const phase of result.phases) { assert(phase.storeWasAbsent); assert.equal(phase.taskCount, 50); }
  const file = writer.file ?? writer.files?.[0];
  if (writer.files) assert.equal(writer.files.length, 1);
  assert.equal(file.bytes, payload.bytes); assert.equal(file.sha256, payload.sha256); assert(file.taskId);
  assert.equal(fresh.complete.bytes, payload.bytes); assert.equal(fresh.complete.sha256, payload.sha256);
  assert(fresh.link); assert.equal(fresh.link.task_id, file.taskId);
  if (result.stackId === 'jazz-v2') {
    assert.equal(fresh.before.fileCount, 0); assert.equal(fresh.before.partCount, 0);
    assert.equal(fresh.link.file_id, file.id);
    assert.equal(file.partSizes.reduce((sum: number, n: number) => sum + n, 0), payload.bytes);
    assert.equal(new Set(file.partIds).size, Math.ceil(payload.bytes / 262144));
  } else {
    if (result.stackId === 'powersync') {
      assert.equal(fresh.before.queue, null); assert.equal(fresh.before.files.length, 0);
      assert.equal(fresh.complete.native.state, 3); assert.equal(fresh.complete.native.hasSynced, true);
      assert.equal(fresh.link.id, file.id); assert.equal(file.complete.state, 3); assert(file.complete.hasSynced);
    } else { assert.equal(fresh.initialCacheCount, 0); assert(file.applied.includes(file.commitId)); }
    const transfers = fresh.transfers.attempts;
    assert.equal(transfers.length, 1); const transfer = transfers[0];
    assert.equal(transfer.status, 200); assert.equal(transfer.contentLength, payload.bytes);
    assert.equal(transfer.forwardedBodyBytes, payload.bytes); assert(transfer.completed); assert(!transfer.interrupted);
  }
  const upload = (writer.stageMs ?? file.stageMs ?? 0) + (writer.uploadMs ?? file.uploadMs);
  assert(Number.isFinite(upload) && upload >= 0); assert(Number.isFinite(fresh.downloadMs) && fresh.downloadMs >= 0);
  assert.equal(result.uploadMs, upload); assert.equal(result.downloadMs, fresh.downloadMs);
}

async function phase(config: any, directory: string) {
  const native = ['powersync', 'jazz-v2'].includes(config.stackId);
  const configPath = join(directory, `${config.phase}.json`); await writeFile(configPath, JSON.stringify(config));
  const child = spawn(native ? 'node' : process.execPath, [config.workerPath ?? (native ? 'src/attachments/native-worker.ts' : 'src/attachments/large-syncular-worker.ts'), configPath], { cwd: config.workerCwd ?? benchmarkRoot, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stdout = '', stderr = '', timedOut = false;
  const started = performance.now();
  child.stdout.on('data', chunk => { stdout += chunk; if (native && stdout.includes('"evidence"')) child.stdin.end('exit\n'); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => { timedOut = true; if (child.pid) process.kill(-child.pid, 'SIGKILL'); }, phaseTimeoutMs);
  let code;
  try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  const elapsedMs = performance.now() - started;
  let result: any;
  try { result = JSON.parse(stdout.trim().split('\n').at(-1)!); } catch { result = { status: 'failed', evidence: { phase: config.phase, pid: child.pid, store: config.store }, error: `Worker exited ${code}; ${stderr || stdout.slice(-2000)}` }; }
  result.evidence.phaseElapsedMs = elapsedMs;
  if (timedOut) Object.assign(result, { status: 'timed-out', error: `${config.phase} exceeded the ${phaseTimeoutMs} ms phase deadline`, deadlineMs: phaseTimeoutMs, elapsedMs });
  if (code !== 0 && result.status === 'completed') Object.assign(result, { status: 'failed', error: `Worker exited ${code}` });
  return result;
}

export async function runLargeFile(stackId: LargeFileStack, payload: FileFixture, options: { workerPath?: string; workerCwd?: string; binPath?: string; servicesReady?: boolean } = {}) {
  const result: any = { stackId, status: 'running', phases: [], phaseTimeoutMs, startedAt: new Date().toISOString() };
  await mkdir(tempRoot, { recursive: true }); const directory = await mkdtemp(join(tempRoot, 'large-file-'));
  const datasetId = randomUUID(); let storage: S3Client | undefined; let objectKey: string | undefined;
  try {
    if (!options.servicesReady) await ensureStackUp(stackId);
    if (stackId !== 'jazz-v2') {
      if (!options.servicesReady) await ensureStackUp('syncular');
      if (stackId === 'powersync') await ensureFileReplicationRules();
      await seedStack(stackId, attachmentSeed);
      storage = new S3Client({ endpoint: 'http://localhost:3230', region: 'us-east-1', bucket: 'syncular-blobs', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' });
      objectKey = stackId === 'powersync' ? `native-attachments/powersync/${datasetId}.bin` : `blob/bench/sha256/${payload.sha256}`;
      const presentBefore = await storage.exists(objectKey); if (presentBefore) await storage.delete(objectKey);
      assert.equal(await storage.exists(objectKey), false);
      result.objectPreparation = { key: objectKey, presentBefore, presentAfter: false };
    }
    const binPath = options.binPath ?? (stackId === 'syncular-rust' ? await (await import('../adapters/syncular-rust.ts')).ensureBenchBinary() : undefined);
    const stack = getStack(stackId);
    for (const name of ['writer', 'fresh']) {
      const config = { workerPath: options.workerPath, workerCwd: options.workerCwd, stackId, phase: name, payload, datasetId, binPath, store: join(directory, name), serverUrl: stack.syncBaseUrl, appUrl: stack.appBaseUrl, variant: 0,
        objects: storage ? [{ id: datasetId, key: objectKey, put: storage.presign(objectKey!, { method: 'PUT', expiresIn: 3600 }), get: storage.presign(objectKey!, { method: 'GET', expiresIn: 3600 }) }] : [] };
      const output = await phase(config, directory); result.phases.push(output.evidence);
      if (output.status !== 'completed') { Object.assign(result, { status: output.status, error: output.error, failedPhase: name }); return result; }
    }
    const [writer, fresh] = result.phases;
    Object.assign(result, { status: 'completed', uploadMs: (writer.stageMs ?? writer.files?.[0].stageMs ?? 0) + (writer.uploadMs ?? writer.files[0].uploadMs), downloadMs: fresh.downloadMs });
    validateLargeFileResult(result, payload);
  } catch (error) { Object.assign(result, { status: 'failed', error: String(error) }); }
  finally {
    result.finishedAt = new Date().toISOString();
    await rm(directory, { recursive: true, force: true });
    if (storage && objectKey) await storage.delete(objectKey).catch(() => {});
  }
  return result;
}
