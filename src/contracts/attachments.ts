import { assertRows, ContractError, fixtureTasks, hash, taskRecord, type Row } from './screens.ts';
import { attachmentSeed, attachmentRef, attachmentEntry, attachmentDigests, attachmentBytes, attachmentWriter, attachmentReader, attachmentProject } from '../attachments/fixture.ts';
import { validateFreshDownload } from '../attachments/fresh-download.ts';
import { validateDownloadRecovery } from '../attachments/download-recovery.ts';
import type { AttachmentState } from '../attachments/driver.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

export const ATTACHMENT_CONTRACT = 'attachments-v1';
export const attachmentProfile = {
  variants: ['initial-upload', 'retained-upload-queue'], payloadBytes: attachmentBytes, payloadSha256: attachmentDigests,
  objectState: 'two declared objects absent after application reset; other objects and OS caches retained',
  stage: 'prepared bytes through native blob staging and metadata local commit; payload generation excluded',
  transfer: 'from explicit sync invocation; object PUT acknowledgment, native applied-commit receipt and independent reader observation',
  clocks: 'parent monotonic IPC receipt times; reader local query polling at 5ms',
  download: 'new process and product store, authorized actor, empty cache and full GET with content verification',
  faults: 'preflight rejection of both upload PUT routes; separate fresh-client download cut after 65536 bytes and full-object retry',
  resources: 'external process trees; stage/sync cases include both clients, downloads include only their fresh client; controller and relay excluded',
};
export function validateAttachmentRef(ref: string, variant: 0 | 1): string {
  const parsed = JSON.parse(ref) as Row;
  assertRows('attachment content reference', [parsed], [attachmentRef(variant)]);
  return JSON.stringify(attachmentRef(variant));
}
export function validateAttachmentEntries(rows: Row[], variants: Array<0 | 1>) {
  const normalized = rows.map(row => {
    const variant = variants.find(v => attachmentEntry(v).id === row.id);
    if (variant === undefined || typeof row.blob !== 'string') throw new ContractError('Unexpected attachment metadata row');
    return { id: row.id, project_id: row.project_id, task_id: row.task_id, blob: validateAttachmentRef(row.blob, variant), created_at_ms: Number(row.created_at_ms) };
  });
  return assertRows('attachment metadata', normalized, variants.map(attachmentEntry));
}
export function validateAttachmentState(state: AttachmentState, variants: Array<0 | 1>, queued = false): JsonObject {
  if (state.pendingUploads !== Number(queued) || state.pendingCommits !== Number(queued) || state.rejected !== 0 || state.conflicts !== 0) throw new ContractError('Attachment queues or native rejection/conflict state differ');
  return { tasksDigest: assertRows('attachment tasks', state.tasks.map(taskRecord), fixtureTasks(attachmentSeed)), entriesDigest: validateAttachmentEntries(state.entries, variants),
    pendingUploads: state.pendingUploads, pendingCommits: state.pendingCommits, rejected: state.rejected, conflicts: state.conflicts };
}
const stateProof = (variants: Array<0 | 1>, queued = false) => validateAttachmentState({ tasks: fixtureTasks(attachmentSeed), entries: variants.map(attachmentEntry), pendingUploads: Number(queued), pendingCommits: Number(queued), rejected: 0, conflicts: 0 }, variants, queued);
function checkProof(proof: unknown, variants: Array<0 | 1>, queued = false) { if (hash(proof) !== hash(stateProof(variants, queued))) throw new ContractError('Attachment full data or queue proof missing'); }

export function validateAttachmentResult(result: Pick<BenchmarkResult, 'scenarioId' | 'metadata' | 'metrics'>) {
  const m = result.metadata, metrics = result.metrics;
  if (result.scenarioId !== 'blob-flow' || m.workloadContract !== ATTACHMENT_CONTRACT || hash(m.fixture) !== hash(attachmentSeed) || hash(m.attachmentProfile) !== hash(attachmentProfile)) throw new ContractError('Attachment workload/profile mismatch');
  const prep = m.objectPreparation as JsonObject, objects = prep?.objects as JsonObject[];
  if (prep?.method !== 'remove-declared-objects-after-application-reset-v1' || prep.endpoint !== 'http://localhost:3230' || prep.bucket !== 'syncular-blobs' || prep.region !== 'us-east-1' || !Array.isArray(objects) || objects.length !== 2 || objects.some((o, i) => o.variant !== i || o.blobId !== attachmentRef(i as 0 | 1).blobId || o.key !== `blob/bench/sha256/${attachmentDigests[i]}` || typeof o.presentBefore !== 'boolean' || o.presentAfter !== false)) throw new ContractError('Attachment object absence proof missing');
  const server = m.serverBefore as JsonObject;
  if (!server?.containerId || server.running !== true || server.health !== 'healthy' || !Number.isFinite(Date.parse(String(server.startedAt))) || hash(server) !== hash(m.serverAfter)) throw new ContractError('Attachment server changed or was unhealthy');
  const clients = m.clients as JsonObject[], first = m.freshDownload as JsonObject, recovery = m.downloadRecovery as JsonObject;
  if (!Array.isArray(clients) || clients.length !== 2 || clients[0].actorId !== attachmentWriter || clients[1].actorId !== attachmentReader || clients.some(c => c.projectId !== attachmentProject || c.storeWasAbsent !== true)) throw new ContractError('Attachment writer/reader scope or fresh stores missing');
  const all = [...clients, first, recovery];
  if (all.some(c => !Number.isSafeInteger(c?.pid) || Number(c.pid) < 2 || typeof c.store !== 'string' || !c.store || typeof c.clientId !== 'string' || !c.clientId) || ['pid', 'store', 'clientId'].some(key => new Set(all.map(c => c[key])).size !== 4) || first.actorId !== attachmentReader || recovery.actorId !== attachmentReader) throw new ContractError('Attachments require four distinct clients and stores with declared actors');
  const initial = m.initial as JsonObject;
  checkProof(initial?.writer, []); checkProof(initial?.reader, []);
  const cases = m.cases as JsonObject[];
  if (!Array.isArray(cases) || cases.length !== 2) throw new ContractError('Attachment cases missing');
  for (const [i, c] of cases.entries()) {
    const variants: Array<0 | 1> = i === 0 ? [0] : [0, 1];
    if (c.variant !== i || typeof c.commitId !== 'string' || !c.commitId) throw new ContractError('Attachment case identity missing');
    validateAttachmentRef(String(c.ref), i as 0 | 1);
    checkProof(c.staged, variants, true); checkProof(c.writerFinal, variants); checkProof(c.readerFinal, variants);
    if (c.observedEntriesDigest !== validateAttachmentEntries(variants.map(attachmentEntry), variants)) throw new ContractError('Observed metadata content proof missing');
    const ack = c.acknowledgment as JsonObject, uploads = c.uploads as JsonObject[];
    if (ack?.pushed !== 1 || hash(ack.applied) !== hash([c.commitId]) || hash(ack.rejected) !== hash([]) || hash(ack.retryable) !== hash([]) || !Array.isArray(uploads) || uploads.length !== 1 || uploads[0].route !== 'presigned' || uploads[0].byteLength !== attachmentBytes || uploads[0].atMs !== c.uploadMs) throw new ContractError('Attachment upload acknowledgment or applied commit missing');
    const prefix = i === 0 ? 'initial' : 'retry';
    for (const [field, metric] of [['stageMs', 'stage_commit_ms'], ['uploadMs', 'upload_ms'], ['serverAcceptedMs', 'server_accepted_ms'], ['metadataVisibleMs', 'metadata_visible_ms']] as const) if (typeof c[field] !== 'number' || !Number.isFinite(c[field]) || Number(c[field]) < 0 || metrics[`${prefix}_${metric}`] !== c[field]) throw new ContractError('Attachment raw milestones and metrics differ');
    if (Number(c.uploadMs) > Number(c.serverAcceptedMs)) throw new ContractError('Metadata acceptance preceded upload acknowledgment');
    const resources = c.resources as JsonObject, samples = resources?.samples as JsonObject[];
    if (resources?.method !== 'external-ps-process-tree-v1' || resources.includeRoot !== false || resources.rootPid !== m.controllerPid || !Array.isArray(samples) || samples.length < 2 || samples.some(s => !(s.processes as JsonObject[]).every(p => p.pid !== m.controllerPid) || clients.some(client => !(s.processes as JsonObject[]).some(p => p.pid === client.pid)))) throw new ContractError('Attachment stage/sync resources require both client trees without controller');
    if (i === 1) {
      const failure = c.failure as JsonObject;
      if (failure?.failed !== true || typeof failure.reason !== 'string' || !failure.reason || failure.rejectedPutsBefore !== 0 || failure.rejectedPutsAfter !== 2 || !Array.isArray(failure.uploadReceipts) || failure.uploadReceipts.length || typeof failure.elapsedMs !== 'number' || !Number.isFinite(failure.elapsedMs) || failure.elapsedMs < 0 || metrics.retry_failed_attempt_ms !== failure.elapsedMs) throw new ContractError('Retained upload queue fault proof missing');
      checkProof(failure.writer, [0, 1], true); checkProof(failure.reader, [0]);
    }
  }
  validateFreshDownload(first); validateDownloadRecovery(recovery, attachmentDigests[1]!, attachmentBytes);
  if (metrics.fresh_download_ms !== first.downloadMs || metrics.download_interruption_failed_attempt_ms !== recovery.failedAttemptMs || metrics.download_interruption_recovery_ms !== recovery.recoveryMs || metrics.blob_size_bytes !== attachmentBytes || (m.resources as JsonObject)?.method !== 'external-ps-process-tree-v1') throw new ContractError('Attachment download metrics or resource declaration differ');
}
