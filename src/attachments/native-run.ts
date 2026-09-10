import { promisify } from 'node:util';
import postgres from 'postgres';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Client } from 'bun';
import { benchmarkRoot, tempRoot } from '../paths.ts';
import { ExternalResources } from '../resources.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';
import { attachmentBytes, attachmentSeed } from './fixture.ts';
import { NATIVE_FILE_CONTRACT, nativeFileFixture, validateNativeFiles } from '../contracts/native-files.ts';
import type { NativeFileConfig, NativeFileStack } from './native-protocol.ts';
import type { JsonObject } from '../types.ts';

export async function runNativeFiles(stackId: NativeFileStack) {
  await ensureStackUp(stackId);
  const datasetId = randomUUID();
  const stack = getStack(stackId);
  const objects: NonNullable<NativeFileConfig['objects']> = [];
  if (stackId === 'powersync') {
    await ensureStackUp('syncular'); // Same MinIO service used by the Syncular attachment case.
    await ensureFileReplicationRules();
    await seedStack(stackId, attachmentSeed);
    const storage = new S3Client({ endpoint: 'http://localhost:3230', region: 'us-east-1', bucket: 'syncular-blobs', accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' });
    for (const variant of [0, 1]) {
      const id = `${datasetId}-${variant}`, key = `native-attachments/powersync/${id}.bin`;
      if (await storage.exists(key)) throw new Error('New benchmark object already exists');
      objects.push({ id, key, put: storage.presign(key, { method: 'PUT', expiresIn: 3600 }), get: storage.presign(key, { method: 'GET', expiresIn: 3600 }) });
    }
  }
  await mkdir(tempRoot, { recursive: true }); const dir = await mkdtemp(join(tempRoot, 'native-files-'));
  const metadata: JsonObject = { workloadContract: NATIVE_FILE_CONTRACT, implementation: `${stackId}-native-files`, stackId, datasetId,
    fixture: nativeFileFixture, controllerPid: process.pid, phases: [],
    resources: { method: 'external-ps-process-tree-v1', scope: 'Per-phase worker process trees, including native clients and their relays; complete samples are stored in phases[].resources.' },
    diagnostics: { localStorage: stackId === 'powersync' ? 'native-sqlite-and-filesystem' : 'native-fjall-file-parts' },
    objectPreparation: stackId === 'powersync' ? { endpoint: 'http://localhost:3230', bucket: 'syncular-blobs', objects: objects.map(({ id, key }) => ({ id, key, presentBefore: false })) } : { method: 'native-generated-file-and-part-ids' },
    nativeFileProfile: stackId === 'powersync' ? 'native-queue-streaming-object-store' : 'native-chunked-sync-files',
  };
  try {
    for (const phase of ['writer', 'fresh', 'interrupted'] as const) {
      const config: NativeFileConfig = { stackId, phase, datasetId, store: join(dir, phase), serverUrl: stack.syncBaseUrl, appUrl: stack.appBaseUrl, objects, variant: phase === 'interrupted' ? 1 : 0 };
      const configPath = join(dir, `${phase}.json`); await writeFile(configPath, JSON.stringify(config));
      const child = spawn('node', ['src/attachments/native-worker.ts', configPath], { cwd: benchmarkRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      const resources = new ExternalResources(true, child.pid!);
      let stdout = '', stderr = '';
      let received!: () => void;
      const ready = new Promise<void>(resolve => { received = resolve; });
      child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.includes('\"evidence\"')) received(); }); child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
      const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      // The worker waits for our exit command after returning its result, so the
      // sampler can stop while the measured process is still alive.
      await resources.start();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
      let code: number | null;
      await Promise.race([ready, exit]);
      const usage = await resources.stop();
      child.stdin.write('exit\n');
      try { code = await exit; } finally { clearTimeout(timeout); }
      const lastLine = stdout.trim().split('\n').at(-1);
      let output: any;
      try { output = JSON.parse(lastLine ?? ''); } catch { throw new Error(`Native file worker exited ${code}: ${stderr}\n${stdout.slice(-4000)}`); }
      output.evidence.resources = usage.metadata;
      (metadata.phases as JsonObject[]).push(output.evidence);
      if (code !== 0 || output.status !== 'completed') throw new Error(`Native ${stackId} ${phase}: ${output.error ?? stderr}`);
    }
    const phases = metadata.phases as JsonObject[];
    const files = phases[0]!.files as JsonObject[];
    const metrics = { blob_size_bytes: attachmentBytes, initial_upload_ms: Number(files[0]!.uploadMs), second_upload_ms: Number(files[1]!.uploadMs),
      fresh_download_ms: Number(phases[1]!.downloadMs), download_interruption_recovery_ms: Number(phases[2]!.downloadMs) };
    validateNativeFiles({ scenarioId: 'blob-flow', metrics, metadata });
    return { status: 'completed' as const, metrics, metadata, notes: [
      'Two deterministic 2 MiB objects are linked to tasks. Upload uses the SDK file feature; fresh and interrupted downloads run in separate processes with initially empty product stores. Full object hashes are verified.',
      stackId === 'powersync' ? 'PowerSync uses its experimental native AttachmentQueue and Node streaming transport against the same MinIO backend as Syncular. Upload excludes prepared-byte staging and includes queue startup. A real HTTP response is cut after 64 KiB; the SDK retains its download queue and retries after restoration.' : 'Jazz uses its native file helpers with default 256 KiB parts and edge durability. Upload includes chunk creation and persistence. The connection is dropped after the first delivered chunk, the read is cancelled, and an offline native read must reject incomplete data before retrying from the retained part cache.',
      'These are native feature paths with different staging and retry boundaries; timings are not an identical transport-only comparison. Resource samples cover each entire client phase including setup.',
    ] };
  } catch (error) { if (error instanceof Error) Object.assign(error, { evidence: metadata }); throw error; }
  finally { await rm(dir, { recursive: true, force: true }); }
}

/** A bind-mounted rule edit does not restart the PowerSync service. Verify the
 * deployed rule text before seeding, and reload only when configuration differs. */
export async function ensureFileReplicationRules() {
  const storage = postgres('postgres://bench:bench@localhost:55436/powersync_storage', { max: 1 });
  const expected = await readFile(join(benchmarkRoot, 'stacks/powersync/config/sync-config.yaml'), 'utf8');
  const matches = async () => {
    const rows = await storage`select content from powersync.sync_rules where state = 'ACTIVE'`;
    return rows.length === 1 && rows[0]!.content === expected;
  };
  try {
    if (await matches()) return;
    await promisify(execFile)('docker', ['compose', '-f', getStack('powersync').composeFile, 'restart', 'powersync'], { cwd: benchmarkRoot });
    const deadline = Date.now() + 120_000;
    while (!await matches()) {
      if (Date.now() >= deadline) throw new Error('PowerSync attachment rule activation timed out');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally { await storage.end({ timeout: 2 }); }
}
