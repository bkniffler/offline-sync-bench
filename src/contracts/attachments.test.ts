import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ATTACHMENT_CONTRACT, attachmentProfile, validateAttachmentResult, validateAttachmentState, validateAttachmentEntries } from './attachments.ts';
import { fixtureTasks } from './screens.ts';
import { attachmentPayload, attachmentBytes, attachmentDigests, attachmentEntry, attachmentSeed, attachmentReader, attachmentWriter, attachmentProject } from '../attachments/fixture.ts';
import type { JsonObject } from '../types.ts';

const proof = (variants: Array<0 | 1>, queued = false) => validateAttachmentState({ tasks: fixtureTasks(attachmentSeed), entries: variants.map(attachmentEntry), pendingUploads: Number(queued), pendingCommits: Number(queued), rejected: 0, conflicts: 0 }, variants, queued);
const processResources = (pid: number) => ({ method: 'external-ps-process-tree-v1', rootPid: pid, includeRoot: true, samples: [0, 1].map(() => ({ processes: [{ pid }] })) });
function result() {
  const cases = [0, 1].map(i => {
    const variants: Array<0 | 1> = i === 0 ? [0] : [0, 1];
    return { variant: i, commitId: `commit-${i}`, ref: attachmentEntry(i as 0 | 1).blob, stageMs: 2, uploadMs: 5, serverAcceptedMs: 10, metadataVisibleMs: 8,
      staged: proof(variants, true), writerFinal: proof(variants), readerFinal: proof(variants), observedEntriesDigest: validateAttachmentEntries(variants.map(attachmentEntry), variants),
      acknowledgment: { pushed: 1, applied: [`commit-${i}`], rejected: [], retryable: [] }, uploads: [{ route: 'presigned', byteLength: attachmentBytes, atMs: 5 }],
      resources: { method: 'external-ps-process-tree-v1', rootPid: 10, includeRoot: false, samples: [0, 1].map(() => ({ processes: [{ pid: 11 }, { pid: 12 }] })) },
      ...(i === 1 ? { failure: { failed: true, reason: 'injected outage', rejectedPutsBefore: 0, rejectedPutsAfter: 2, uploadReceipts: [], elapsedMs: 1, writer: proof([0, 1], true), reader: proof([0]) } } : {}),
    };
  });
  const full = { method: 'GET', status: 200, contentLength: attachmentBytes, range: null, upstreamBodyBytes: attachmentBytes, forwardedBodyBytes: attachmentBytes, completed: true, interrupted: false };
  const partial = { ...full, upstreamBodyBytes: 65536, forwardedBodyBytes: 65536, completed: false, interrupted: true };
  const server = { containerId: 'sync-service', running: true, health: 'healthy', startedAt: '2026-09-06T08:00:00Z' };
  const metadata: JsonObject = { workloadContract: ATTACHMENT_CONTRACT, fixture: attachmentSeed, attachmentProfile, controllerPid: 10,
    clients: [{ pid: 11, clientId: 'writer', store: '/tmp/writer', actorId: attachmentWriter, projectId: attachmentProject, storeWasAbsent: true }, { pid: 12, clientId: 'reader', store: '/tmp/reader', actorId: attachmentReader, projectId: attachmentProject, storeWasAbsent: true }],
    objectPreparation: { method: 'remove-declared-objects-after-application-reset-v1', endpoint: 'http://localhost:3230', bucket: 'syncular-blobs', region: 'us-east-1', objects: attachmentDigests.map((digest, variant) => ({ variant, blobId: `sha256:${digest}`, key: `blob/bench/sha256/${digest}`, presentBefore: true, presentAfter: false })) },
    serverBefore: server, serverAfter: { ...server }, initial: { writer: proof([]), reader: proof([]) }, cases,
    freshDownload: { method: 'fresh-client-download-v1', pid: 13, controllerPid: 10, clientId: 'first-download', store: '/tmp/first-download', actorId: attachmentReader, initialCacheCount: 0, finalCacheCount: 1,
      content: { sha256: attachmentDigests[0], byteLength: attachmentBytes }, downloadMs: 8, traffic: { method: 'http-object-download-cut-v1', cutAfterBytes: null, attempts: [full] }, resources: processResources(13) },
    downloadRecovery: { method: 'fresh-client-interrupted-download-v1', expectedSha256: attachmentDigests[1], expectedBytes: attachmentBytes, cutAfterBytes: 65536,
      pid: 14, controllerPid: 10, clientId: 'recovery-download', store: '/tmp/recovery-download', storeWasAbsent: true, actorId: attachmentReader,
      initialCacheCount: 0, cacheAfterFailure: 0, cacheAfterRecovery: 1, failed: true, failure: 'truncated response', recovered: { sha256: attachmentDigests[1], byteLength: attachmentBytes }, failedAttemptMs: 4, recoveryMs: 9,
      interrupted: { method: 'http-object-download-cut-v1', cutAfterBytes: 65536, attempts: [partial] }, restored: { method: 'http-object-download-cut-v1', cutAfterBytes: null, attempts: [partial, full] }, resources: processResources(14) },
    resources: { method: 'external-ps-process-tree-v1' },
  };
  return { scenarioId: 'blob-flow' as const, metadata, metrics: { blob_size_bytes: attachmentBytes, initial_stage_commit_ms: 2, initial_upload_ms: 5, initial_server_accepted_ms: 10, initial_metadata_visible_ms: 8,
    retry_stage_commit_ms: 2, retry_upload_ms: 5, retry_server_accepted_ms: 10, retry_metadata_visible_ms: 8, retry_failed_attempt_ms: 1, fresh_download_ms: 8, download_interruption_failed_attempt_ms: 4, download_interruption_recovery_ms: 9 } };
}
test('attachment state checks every task, all metadata fields and native pending work', () => {
  for (const variant of [0, 1] as const) expect(createHash('sha256').update(attachmentPayload(variant)).digest('hex')).toBe(attachmentDigests[variant]);
  const state = { tasks: fixtureTasks(attachmentSeed), entries: [attachmentEntry(0)], pendingUploads: 1, pendingCommits: 1, rejected: 0, conflicts: 0 };
  expect(() => validateAttachmentState(state, [0], true)).not.toThrow();
  state.tasks.at(-1)!.title = 'changed'; expect(() => validateAttachmentState(state, [0], true)).toThrow();
  state.tasks = fixtureTasks(attachmentSeed); state.entries[0].task_id = 'wrong-task'; expect(() => validateAttachmentState(state, [0], true)).toThrow();
  state.entries = [attachmentEntry(0)]; state.pendingUploads = 0; expect(() => validateAttachmentState(state, [0], true)).toThrow();
});
test('attachment results reject stale objects, invented receipts, reused clients and altered milestone summaries', () => {
  expect(() => validateAttachmentResult(result())).not.toThrow();
  const edits: Array<(m: JsonObject) => void> = [
    m => { ((m.objectPreparation as JsonObject).objects as JsonObject[])[0].presentAfter = true; },
    m => { ((m.cases as JsonObject[])[0].acknowledgment as JsonObject).applied = ['different-commit']; },
    m => { (m.cases as JsonObject[])[0].metadataVisibleMs = 10; },
    m => { (m.cases as JsonObject[])[0].staged = proof([0]); },
    m => { ((m.cases as JsonObject[])[1].failure as JsonObject).reader = proof([0, 1]); },
    m => { (((m.cases as JsonObject[])[0].resources as JsonObject).samples as JsonObject[])[0].processes = [{ pid: 10 }, { pid: 11 }, { pid: 12 }]; },
    m => { (m.freshDownload as JsonObject).pid = 11; },
    m => { (m.downloadRecovery as JsonObject).actorId = attachmentWriter; },
    m => { (m.serverAfter as JsonObject).containerId = 'new-service'; },
  ];
  for (const edit of edits) { const r = result(); edit(r.metadata); expect(() => validateAttachmentResult(r)).toThrow(); }
});
