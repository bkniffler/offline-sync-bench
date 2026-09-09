import type { SyncClient } from '@syncular/client';
import type { RustClient } from '../adapters/syncular-rust.ts';
import type { Row } from '../contracts/screens.ts';
import type { JsonObject } from '../types.ts';
import { attachmentEntry, attachmentPayload } from './fixture.ts';

export interface AttachmentState { tasks: Row[]; entries: Row[]; pendingUploads: number; pendingCommits: number; rejected: number; conflicts: number }
export interface AttachmentOperations {
  prepare(variant: 0 | 1): Promise<void>;
  stage(variant: 0 | 1): Promise<{ ref: string; commitId: string }>;
  sync(uploaded: (receipt: JsonObject) => void): Promise<JsonObject>;
  fault(blocked: boolean): Promise<number>;
  state(): Promise<AttachmentState>;
  observe(ids: string[]): Promise<Row[]>;
}
const entrySql = 'SELECT id, project_id, task_id, blob, created_at_ms FROM task_blob_entries';
const observationQuery = (ids: string[]) => `${entrySql} WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`;

export function jsAttachments(client: SyncClient, fault: { blocked: boolean; rejectedPuts: number }, setObserver: (observer?: (receipt: JsonObject) => void) => void): AttachmentOperations {
  const count = (sql: string) => Number(client.query(sql)[0]!.n);
  const prepared = new Map<number, Uint8Array>();
  return {
    prepare: async variant => { prepared.set(variant, attachmentPayload(variant)); },
    stage: async variant => {
      if (!prepared.has(variant)) throw new Error('Attachment payload was not prepared');
      const ref = client.blobRefString(await client.uploadBlob(prepared.get(variant)!, { mediaType: 'application/octet-stream' }));
      prepared.delete(variant);
      const commitId = client.mutate([{ table: 'task_blob_entries', op: 'upsert', values: { ...attachmentEntry(variant), blob: ref } }]);
      return { ref, commitId };
    },
    sync: async uploaded => { setObserver(uploaded); try { const result = await client.sync(); return { pushed: result.pushed, applied: [...result.applied], rejected: [...result.rejected], retryable: [...result.retryable] }; } finally { setObserver(); } },
    fault: async blocked => { fault.blocked = blocked; return fault.rejectedPuts; },
    state: async () => ({ tasks: client.query('SELECT * FROM tasks ORDER BY id'), entries: client.query(`${entrySql} ORDER BY id`), pendingUploads: count('SELECT count(*) AS n FROM _syncular_blob_uploads'), pendingCommits: client.pendingCommits().length, rejected: client.rejections().length, conflicts: client.conflicts().length }),
    observe: async ids => {
      const deadline = performance.now() + 60_000;
      while (performance.now() < deadline) { const rows = client.query(observationQuery(ids), ids); if (rows.length === ids.length) return rows; await new Promise(resolve => setTimeout(resolve, 5)); }
      throw new Error('Attachment metadata observation timed out');
    },
  };
}
export function rustAttachments(client: RustClient): AttachmentOperations {
  const prepared = new Map<number, Uint8Array>();
  return {
    prepare: async variant => { prepared.set(variant, attachmentPayload(variant)); },
    stage: async variant => {
      if (!prepared.has(variant)) throw new Error('Attachment payload was not prepared');
      const result = await client.call('uploadBlob', { bytes: { $bytes: Buffer.from(prepared.get(variant)!).toString('hex') }, mediaType: 'application/octet-stream' });
      prepared.delete(variant);
      const ref = JSON.stringify(result.ref);
      const mutation = await client.call('mutate', { mutations: [{ table: 'task_blob_entries', op: 'upsert', values: { ...attachmentEntry(variant), blob: ref } }] });
      return { ref, commitId: String(mutation.clientCommitId) };
    },
    sync: async uploaded => {
      const result = await client.call('sync', { benchBlobMilestones: true }, (event, data) => { if (event === 'blobUploaded') uploaded(data); });
      if (result.ok !== true) throw new Error(`Native attachment sync failed: ${JSON.stringify(result)}`);
      const report = result.report as JsonObject;
      return { pushed: report.pushed, applied: report.applied, rejected: report.rejected, retryable: report.retryable };
    },
    fault: async blocked => Number((await client.call('blockBlobUploads', { blocked })).rejectedPuts),
    state: async () => ({ tasks: await client.queryRows('SELECT * FROM tasks ORDER BY id'), entries: await client.queryRows(`${entrySql} ORDER BY id`),
      pendingUploads: await client.count('SELECT count(*) AS n FROM _syncular_blob_uploads'), pendingCommits: ((await client.call('pendingCommitIds')).ids as unknown[]).length,
      rejected: ((await client.call('rejections')).rejections as unknown[]).length, conflicts: ((await client.call('conflicts')).conflicts as unknown[]).length }),
    observe: async ids => {
      const result = await client.waitForQuery({ sql: observationQuery(ids), params: ids, matchCount: { op: 'eq', value: ids.length }, timeoutMs: 60_000, pollIntervalMs: 5 });
      if (!result.ok) throw new Error('Native attachment metadata observation timed out');
      return result.rows as Row[];
    },
  };
}
