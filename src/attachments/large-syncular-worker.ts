import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { attachmentSeed, attachmentProject, attachmentTask, attachmentReader, attachmentWriter } from './fixture.ts';
import { BlobTransferGate } from './transfer-gate.ts';
const config = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const evidence: any = { phase: config.phase, pid: process.pid, store: config.store, storeWasAbsent: !existsSync(config.store) };
const actor = config.phase === 'writer' ? attachmentWriter : attachmentReader;
const gate = new BlobTransferGate('http://localhost:3230');
const expectedRef = { blobId: `sha256:${config.payload.sha256}`, byteLength: config.payload.bytes, mediaType: 'application/octet-stream' };
const entry = { id: config.datasetId, project_id: attachmentProject, task_id: attachmentTask, blob: JSON.stringify(expectedRef), created_at_ms: 1_700_000_000_000 };
let close = async () => {};
try {
  assert(evidence.storeWasAbsent); await gate.start();
  if (config.stackId === 'syncular') {
    const { createBenchClient, subscribeTasks, subscribeBlobEntries } = await import('../adapters/syncular.ts');
    const bench = await createBenchClient(actor, undefined, { dbPath: config.store, clientId: randomUUID(), syncBaseUrl: config.serverUrl, blobDownloadProxy: gate.proxy() });
    close = () => bench.close();
    subscribeTasks(bench, [attachmentProject]); subscribeBlobEntries(bench, [attachmentProject]);
    await bench.client.syncUntilIdle(1000);
    evidence.taskCount = bench.client.query('SELECT id FROM tasks').length;
    assert.equal(evidence.taskCount, attachmentSeed.tasksPerProject);
    if (config.phase === 'writer') {
      const bytes = new Uint8Array(await readFile(config.payload.path));
      const staging = performance.now();
      const ref = await bench.client.uploadBlob(bytes, { mediaType: 'application/octet-stream' });
      evidence.stageMs = performance.now() - staging;
      assert.deepEqual(JSON.parse(bench.client.blobRefString(ref)), expectedRef);
      const commitId = bench.client.mutate([{ table: 'task_blob_entries', op: 'upsert', values: entry }]);
      const started = performance.now(); const report = await bench.client.sync();
      evidence.uploadMs = performance.now() - started;
      assert(report.applied.includes(commitId)); assert.equal(report.rejected.length, 0);
      evidence.file = { ...config.payload, taskId: attachmentTask, ref: expectedRef, commitId, applied: report.applied };
    } else {
      evidence.initialCacheCount = Number(bench.client.query('SELECT count(*) AS n FROM _syncular_blobs')[0]!.n);
      assert.equal(evidence.initialCacheCount, 0);
      evidence.link = bench.client.query('SELECT * FROM task_blob_entries WHERE id = ?', [entry.id])[0];
      assert.equal(evidence.link.blob, entry.blob);
      const started = performance.now(); const { bytes } = await bench.client.fetchBlob(entry.blob);
      evidence.downloadMs = performance.now() - started;
      evidence.complete = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
  } else {
    const { RustClient } = await import('../adapters/syncular-rust.ts');
    const client = await RustClient.start({ binPath: config.binPath, actorId: actor, clientId: randomUUID(), dbPath: config.store, syncBaseUrl: config.serverUrl });
    close = () => client.close(); evidence.nativePid = client.pid;
    await client.call('setBlobDownloadProxy', { ...gate.proxy() });
    await client.subscribe(`tasks:${attachmentProject}`, 'tasks', { project_id: [attachmentProject] });
    await client.subscribe(`blobs:${attachmentProject}`, 'task_blob_entries', { project_id: [attachmentProject] });
    await client.syncToIdle();
    evidence.taskCount = await client.count('SELECT count(*) AS n FROM tasks'); assert.equal(evidence.taskCount, 50);
    if (config.phase === 'writer') {
      const stage = await client.call('benchStageBlobFile', { path: config.payload.path, timeoutMs: 600_000 });
      assert.deepEqual(stage.ref, expectedRef); evidence.stageMs = stage.stageMs;
      const mutation = await client.call('mutate', { mutations: [{ table: 'task_blob_entries', op: 'upsert', values: entry }] });
      const started = performance.now(); const result = await client.call('sync', { timeoutMs: 600_000 });
      evidence.uploadMs = performance.now() - started;
      const report = result.report as any;
      assert.equal(result.ok, true); assert(report.applied.includes(mutation.clientCommitId)); assert.equal(report.rejected.length, 0);
      evidence.file = { ...config.payload, taskId: attachmentTask, ref: expectedRef, commitId: mutation.clientCommitId, applied: report.applied };
    } else {
      evidence.initialCacheCount = await client.count('SELECT count(*) AS n FROM _syncular_blobs'); assert.equal(evidence.initialCacheCount, 0);
      evidence.link = (await client.queryRows('SELECT * FROM task_blob_entries WHERE id = ?', [entry.id]))[0];
      assert.equal(evidence.link.blob, entry.blob);
      const result = await client.call('benchFetchBlobDigest', { blob: entry.blob, timeoutMs: 600_000 });
      evidence.downloadMs = result.downloadMs; evidence.complete = { bytes: result.bytes, sha256: result.sha256 };
    }
  }
  if (config.phase === 'fresh') {
    assert.deepEqual(evidence.complete, { bytes: config.payload.bytes, sha256: config.payload.sha256 });
    evidence.transfers = gate.snapshot();
  }
  await close(); await gate.close();
  console.log(JSON.stringify({ status: 'completed', evidence }));
} catch (error) {
  await close().catch(() => {}); await gate.close();
  console.log(JSON.stringify({ status: 'failed', error: String(error), evidence })); process.exitCode = 1;
}
