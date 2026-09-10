import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { NativeFileConfig } from './native-protocol.ts';
import { attachmentBytes, attachmentDigests, attachmentPayload, attachmentTask } from './fixture.ts';
import { BlobTransferGate, relayBlobUrl } from './transfer-gate.ts';
import { NetworkGate } from '../recovery/network-gate.ts';

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as NativeFileConfig;
const evidence: Record<string, any> = { phase: config.phase, pid: process.pid, store: config.store, storeWasAbsent: !existsSync(config.store) };
const digest = (data: Uint8Array) => ({ bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') });
const check = (data: Uint8Array, variant: number) => {
  const result = digest(data);
  if (result.bytes !== attachmentBytes || result.sha256 !== attachmentDigests[variant]) throw new Error('Attachment full byte/hash validation failed');
  return result;
};
async function until(predicate: () => Promise<boolean>, description: string, ms = 120_000) {
  const deadline = performance.now() + ms;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error(`${description} timed out after ${ms} ms`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function powersync() {
  const { PowerSyncDatabase, Schema, Table, column, AttachmentQueue, AttachmentTable, NodeFileSystemAdapter, AttachmentState } = await import('@powersync/node');
  const { createConnector, AppSchema } = await import('../adapters/powersync-runner.ts');
  const extra = new Schema({ task_file_links: new Table({ task_id: column.text, filename: column.text }), attachments: new AttachmentTable() });
  const schema = new Schema([...AppSchema.tables, ...extra.tables]);
  const db = new PowerSyncDatabase({ schema, database: { dbFilename: config.store } });
  const local = new NodeFileSystemAdapter(`${config.store}-files`);
  const gate = new BlobTransferGate('http://localhost:3230'); await gate.start();
  const files = config.objects!;
  let activeId: string | null = null;
  const errors: Array<{ operation: string; error: string }> = [];
  const nativeTransport = local.createTransportAdapter({
    resolveUpload: file => ({ url: files.find(f => f.id === file.id)!.put }),
    resolveDownload: file => ({ url: relayBlobUrl(files.find(f => f.id === file.id)!.get, gate.proxy()) }),
    deleteFile: async () => { throw new Error('No attachment deletion belongs to this workload'); },
  });
  const queue = new AttachmentQueue({ db, localStorage: local, transportAdapter: nativeTransport,
    downloadAttachments: config.phase !== 'writer',
    watchAttachments: (onUpdate, signal) => {
      db.watch('SELECT id, filename FROM task_file_links WHERE id = ?', [activeId], {
        onResult: result => { void onUpdate((result.rows?._array ?? []).map(row => ({ id: row.id, filename: row.filename }))); },
        onError: error => { errors.push({ operation: 'watch', error: String(error) }); },
      }, { signal });
    },
    errorHandler: {
      onUploadError: async (_file, error) => { errors.push({ operation: 'upload', error: String(error) }); return true; },
      onDownloadError: async (_file, error) => { errors.push({ operation: 'download', error: String(error) }); return true; },
      onDeleteError: async (_file, error) => { errors.push({ operation: 'delete', error: String(error) }); return true; },
    },
  });
  const record = async (id: string) => queue.withAttachmentContext(async ctx => (await ctx.getAttachments()).find(file => file.id === id));
  try {
    await db.init(); await local.initialize();
    await db.connect(createConnector(config.phase === 'writer' ? 'org-1-user-1' : 'org-1-user-2', { appBaseUrl: config.appUrl, syncBaseUrl: config.serverUrl }));
    await db.waitForFirstSync();
    await until(async () => (await db.getAll('SELECT id FROM tasks')).length === 50, 'PowerSync attachment task fixture');
    evidence.taskCount = (await db.getAll('SELECT id FROM tasks')).length;
    evidence.api = 'AttachmentQueue + NodeFileSystemAdapter.createTransportAdapter';
    if (config.phase === 'writer') {
      evidence.files = [];
      for (const variant of [0, 1] as const) {
        activeId = files[variant]!.id;
        const bytes = attachmentPayload(variant);
        const stageStart = performance.now();
        await queue.saveFile({ id: activeId, data: new Uint8Array(bytes).buffer, fileExtension: 'bin', mediaType: 'application/octet-stream',
          updateHook: async (tx, attachment) => { await tx.execute('INSERT INTO task_file_links (id, task_id, filename) VALUES (?, ?, ?)', [attachment.id, attachmentTask, attachment.filename]); },
        });
        const stageMs = performance.now() - stageStart;
        const staged = await record(activeId);
        if (staged?.state !== AttachmentState.QUEUED_UPLOAD) throw new Error('Native upload was not queued before timing');
        const started = performance.now();
        await queue.startSync(); await queue.syncStorage();
        await until(async () => (await record(activeId!))?.state === AttachmentState.SYNCED, 'Native PowerSync upload');
        const uploadMs = performance.now() - started;
        await queue.stopSync();
        await until(async () => (await db.getAll('SELECT id FROM ps_crud')).length === 0, 'PowerSync metadata acceptance');
        const complete = await record(activeId);
        evidence.files.push({ variant, id: activeId, taskId: attachmentTask, stageMs, uploadMs, staged, complete, ...check(new Uint8Array(await readFile(complete!.localUri!)), variant) });
      }
    } else {
      const variant = config.variant!; activeId = files[variant]!.id;
      await until(async () => (await db.getAll('SELECT id FROM task_file_links WHERE id = ?', [activeId])).length === 1, 'PowerSync file metadata');
      evidence.link = await db.get('SELECT * FROM task_file_links WHERE id = ?', [activeId]);
      evidence.before = { queue: await record(activeId) ?? null, files: await (await import('node:fs/promises')).readdir(`${config.store}-files`) };
      if (evidence.before.queue || evidence.before.files.length) throw new Error('Fresh PowerSync file cache was not empty');
      if (config.phase === 'interrupted') {
        gate.interruptAfter(64 * 1024);
        await queue.startSync(); await queue.syncStorage();
        await until(async () => errors.some(e => e.operation === 'download'), 'Injected download failure');
        await queue.stopSync();
        const failed = await record(activeId);
        if (failed?.state !== AttachmentState.QUEUED_DOWNLOAD || failed.hasSynced) throw new Error('Failed download must remain in the native retry queue');
        let partial = new Uint8Array();
        if (failed.localUri && existsSync(failed.localUri)) partial = new Uint8Array(await readFile(failed.localUri));
        evidence.interruption = { method: 'http-body-cut', gate: gate.snapshot(), failed, partial: digest(partial), errors: [...errors] };
        if (partial.byteLength >= attachmentBytes) throw new Error('Interrupted file unexpectedly complete');
        gate.restore();
      }
      const started = performance.now();
      await queue.startSync(); await queue.syncStorage();
      await until(async () => (await record(activeId!))?.state === AttachmentState.SYNCED, 'Native PowerSync download');
      const complete = await record(activeId);
      const bytes = new Uint8Array(await readFile(complete!.localUri!));
      evidence.downloadMs = performance.now() - started;
      evidence.complete = { ...check(bytes, variant), native: complete };
      evidence.transfers = gate.snapshot();
      await queue.stopSync();
    }
    evidence.errors = errors;
  } finally { await queue.stopSync(); await db.close(); await gate.close(); }
}

async function jazz() {
  const { fileApp, deployFileApp, openFileDb } = await import('./jazz-files.ts');
  if (config.phase === 'writer') await deployFileApp(config.serverUrl);
  const gate = new NetworkGate(config.serverUrl, true); await gate.start();
  const { context, db } = openFileDb(config.store, gate.url);
  evidence.api = 'Db.createFileFromBlob / Db.loadFileAsBlob / Db.loadFileAsStream';
  const local = { tier: 'local', propagation: 'local-only' } as const;
  const remote = { tier: 'edge' } as const;
  try {
    if (config.phase === 'writer') {
      const tasks = [];
      for (let i = 0; i < 50; i++) tasks.push(await db.insert(fileApp.attachment_tasks, { dataset_id: config.datasetId, external_id: `task-${i}`, title: `Task ${i}` }).wait({ tier: 'edge' }));
      evidence.taskCount = tasks.length; evidence.files = [];
      for (const variant of [0, 1] as const) {
        const bytes = attachmentPayload(variant), blob = new Blob([new Uint8Array(bytes).buffer]);
        const started = performance.now();
        const file = await db.createFileFromBlob(fileApp, blob, { tier: 'edge', name: `attachment-${variant}`, mimeType: 'application/octet-stream' });
        const uploadMs = performance.now() - started;
        const link = await db.insert(fileApp.task_file_links, { dataset_id: config.datasetId, task_id: tasks[0]!.id, file_id: file.id, variant }).wait({ tier: 'edge' });
        evidence.files.push({ variant, id: file.id, taskId: tasks[0]!.id, linkId: link.id, uploadMs, stageIncluded: true, partIds: file.partIds, partSizes: file.partSizes, ...check(new Uint8Array(await (await db.loadFileAsBlob(fileApp, file, local)).arrayBuffer()), variant) });
      }
    } else {
      const variant = config.variant!;
      evidence.before = { fileCount: (await db.all(fileApp.files, local)).length, partCount: (await db.all(fileApp.file_parts, local)).length };
      if (evidence.before.fileCount || evidence.before.partCount) throw new Error('Fresh Jazz file cache was not empty');
      const tasks = await db.all(fileApp.attachment_tasks.where({ dataset_id: config.datasetId }), remote);
      if (tasks.length !== 50) throw new Error('Jazz attachment task fixture mismatch');
      evidence.taskCount = tasks.length;
      const link = await db.one(fileApp.task_file_links.where({ dataset_id: config.datasetId, variant }), remote);
      if (!link || link.task_id !== tasks.find(t => t.external_id === 'task-0')?.id) throw new Error('Jazz task/file link mismatch');
      evidence.link = link;
      if (config.phase === 'interrupted') {
        const stream = await db.loadFileAsStream(fileApp, link.file_id, remote), reader = stream.getReader();
        const first = await reader.read();
        if (first.done || first.value.byteLength !== 256 * 1024) throw new Error('Jazz first native chunk mismatch');
        gate.block(); await reader.cancel();
        let failure = '';
        try { await db.loadFileAsBlob(fileApp, link.file_id, local); } catch (error) { failure = String(error); }
        const partialParts = await db.all(fileApp.file_parts, local);
        evidence.interruption = { method: 'native-chunk-then-disconnect', deliveredBytes: first.value.byteLength, gate: gate.snapshot(), partialPartCount: partialParts.length, failure };
        if (!failure.includes('incomplete') || partialParts.length >= 8) throw new Error('Network interruption did not leave an incomplete Jazz file');
        gate.restore();
      }
      const started = performance.now();
      const bytes = new Uint8Array(await (await db.loadFileAsBlob(fileApp, link.file_id, remote)).arrayBuffer());
      evidence.downloadMs = performance.now() - started;
      evidence.complete = check(bytes, variant); evidence.traffic = gate.snapshot();
    }
  } finally { await context.shutdown(); await gate.close(); }
}
try {
  if (!evidence.storeWasAbsent) throw new Error('Native attachment process must open a fresh store');
  await (config.stackId === 'powersync' ? powersync() : jazz());
  await finish({ status: 'completed', evidence }, 0);
} catch (error) {
  await finish({ status: 'failed', error: String(error), evidence }, 1);
}

async function finish(result: unknown, code: number) {
  const release = new Promise<void>(resolve => { process.stdin.once('data', () => resolve()); process.stdin.resume(); });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await release; process.exit(code);
}
