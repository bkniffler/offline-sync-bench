import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RecoveryProcess } from '../recovery/process.ts';
import { ExternalResources } from '../resources.ts';
import { tempRoot } from '../paths.ts';
import { getStack } from '../stacks.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { restartStartupServer, serverState } from '../startup/server.ts';
import { ATTACHMENT_CONTRACT, attachmentProfile, validateAttachmentEntries, validateAttachmentRef, validateAttachmentResult, validateAttachmentState } from '../contracts/attachments.ts';
import { ContractError, type Row } from '../contracts/screens.ts';
import { attachmentBytes, attachmentEntry, attachmentPayload, attachmentProject, attachmentReader, attachmentSeed, attachmentWriter } from './fixture.ts';
import { prepareAttachmentObjects } from './prepare.ts';
import { measureAttachmentSync } from './milestones.ts';
import { measureFreshDownload } from './fresh-download.ts';
import { measureDownloadRecovery } from './download-recovery.ts';
import type { AttachmentState } from './driver.ts';
import type { JsonObject } from '../types.ts';

export async function runAttachments(stackId: 'syncular' | 'syncular-rust') {
  await ensureStackUp(stackId);
  if (stackId === 'syncular-rust') await (await import('../adapters/syncular-rust.ts')).ensureBenchBinary();
  await seedStack(stackId, attachmentSeed); await restartStartupServer(stackId);
  const objectPreparation = await prepareAttachmentObjects();
  await mkdir(tempRoot, { recursive: true }); const dir = await mkdtemp(join(tempRoot, 'attachments-'));
  const clients: RecoveryProcess[] = [], resources = new ExternalResources(false);
  const metadata: JsonObject = { workloadContract: ATTACHMENT_CONTRACT, fixture: attachmentSeed, attachmentProfile, objectPreparation,
    controllerPid: process.pid, clients: [], cases: [], serverBefore: serverState(stackId),
    resources: { method: 'external-ps-process-tree-v1', scope: 'raw client-only samples stored for each upload/download case' },
    diagnostics: { localStorage: stackId === 'syncular' ? 'bun:sqlite-file' : 'rusqlite-file', reader: 'distinct actor and process; realtime plus local metadata query at 5ms', transport: 'native upload/metadata sync; download relay preserves signed Host/path/query', bridge: stackId === 'syncular' ? 'JSON-lines worker around the native JS client' : 'JSON-lines worker and native Rust command driver; payload hex conversion included in staging/download materialization' } };
  const metrics: Record<string, number | null> = { blob_size_bytes: attachmentBytes };
  const open = async (name: string, actorId: string) => {
    const store = join(dir, `${name}.sqlite`), clientId = randomUUID(), client = new RecoveryProcess(); clients.push(client);
    let storeWasAbsent = false;
    try { await stat(store); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; storeWasAbsent = true; }
    (metadata.clients as JsonObject[]).push({ pid: client.pid, clientId, store, actorId, projectId: attachmentProject, storeWasAbsent });
    await client.open({ stackId, clientId, actorId, projectId: attachmentProject, dbPath: store, syncBaseUrl: getStack(stackId).syncBaseUrl, attachments: true });
    await client.sync(); return client;
  };
  const state = (client: RecoveryProcess) => client.call<AttachmentState>('attachmentState');
  try {
    const writer = await open('writer', attachmentWriter), reader = await open('reader', attachmentReader);
    await reader.call('connectDelivery'); await reader.sync();
    metadata.initial = { writer: validateAttachmentState(await state(writer), []), reader: validateAttachmentState(await state(reader), []) };
    for (const variant of [0, 1] as const) {
      const prefix = variant === 0 ? 'initial' : 'retry', variants: Array<0 | 1> = variant === 0 ? [0] : [0, 1];
      const c: JsonObject = { variant }; (metadata.cases as JsonObject[]).push(c);
      await writer.call('attachmentPrepare', { variant });
      await resources.start();
      const stagedAt = performance.now();
      const staged = await writer.call<{ ref: string; commitId: string }>('attachmentStage', { variant });
      c.stageMs = performance.now() - stagedAt; c.ref = validateAttachmentRef(staged.ref, variant); c.commitId = staged.commitId;
      c.staged = validateAttachmentState(await state(writer), variants, true);
      if (variant === 1) {
        const failure: JsonObject = { rejectedPutsBefore: await writer.call<number>('attachmentFault', { blocked: true }), uploadReceipts: [] };
        c.failure = failure; const failedAt = performance.now();
        try { await writer.call('attachmentSync', {}, (event, data) => { if (event === 'blobUploaded') (failure.uploadReceipts as unknown[]).push(data); }); failure.failed = false; }
        catch (error) { failure.failed = true; failure.reason = error instanceof Error ? error.message : String(error); }
        failure.elapsedMs = performance.now() - failedAt;
        failure.writer = validateAttachmentState(await state(writer), [0, 1], true);
        failure.reader = validateAttachmentState(await state(reader), [0]);
        failure.rejectedPutsAfter = await writer.call<number>('attachmentFault', { blocked: false });
        if (failure.failed !== true || failure.rejectedPutsAfter !== 2) throw new ContractError('Both upload routes must fail and retain native pending work');
        metrics.retry_failed_attempt_ms = Number(failure.elapsedMs);
      }
      const milestone = await measureAttachmentSync(
        armed => reader.call<Row[]>('attachmentObserve', { ids: variants.map(v => attachmentEntry(v).id) }, event => { if (event === 'armed') armed(); }),
        uploaded => writer.call<JsonObject>('attachmentSync', {}, (event, data) => { if (event === 'blobUploaded') uploaded(data as JsonObject); }),
      );
      const usage = await resources.stop();
      const { rows, ...timing } = milestone; Object.assign(c, timing);
      c.resources = usage.metadata; c.observedEntriesDigest = validateAttachmentEntries(rows, variants);
      c.writerFinal = validateAttachmentState(await state(writer), variants); c.readerFinal = validateAttachmentState(await state(reader), variants);
      for (const [field, metric] of [['stageMs', 'stage_commit_ms'], ['uploadMs', 'upload_ms'], ['serverAcceptedMs', 'server_accepted_ms'], ['metadataVisibleMs', 'metadata_visible_ms']] as const) metrics[`${prefix}_${metric}`] = Number(c[field]);
      Object.assign(metrics, Object.fromEntries(Object.entries(usage.metrics).map(([key, value]) => [`${prefix}_${key}`, value])));
    }
    await writer.close(); await reader.close();
    const cases = metadata.cases as JsonObject[];
    const first = await measureFreshDownload(stackId, String(cases[0].ref));
    metadata.freshDownload = first.evidence; Object.assign(metrics, first.metrics);
    const recovery = await measureDownloadRecovery(stackId, attachmentReader, attachmentProject, String(cases[1].ref), attachmentPayload(1));
    metadata.downloadRecovery = recovery.evidence; Object.assign(metrics, recovery.metrics);
    metadata.serverAfter = serverState(stackId);
    validateAttachmentResult({ scenarioId: 'blob-flow', metadata, metrics });
    return { status: 'completed' as const, metrics, metadata: { ...metadata, implementation: `${stackId}-${ATTACHMENT_CONTRACT}` }, notes: [
      'One initial upload and one retained-queue retry use identical deterministic 2 MiB payloads across adapters. Both declared objects are absent before timing; every task, metadata reference and native queue is validated.',
      'Staging measures prepared bytes through the native cache and metadata local commit. Upload, server acceptance and metadata visibility start at explicit sync invocation. PUT acknowledgment and the native applied-commit receipt are distinct; reader visibility is recorded independently. Exact validation follows timing.',
      'Upload resource windows include staging, intermediate queue checks, optional failed attempt and successful sync/observation. Download windows cover only their fresh client process trees; controller, relay and sampler are excluded. Detailed raw samples accompany each case.',
      'First download uses a new process and empty product cache. Interrupted download uses another fresh process, cuts the real response after 64 KiB, requires failure without partial caching, then verifies a full-object retry. No byte-range resume or writer-restart claim is made.',
      'Local loopback, object presence reset, retained OS/server caches and native host clients form the declared profile. Rust bridge payload conversion is included in staging/download materialization. Object relay counters are HTTP response body bytes, not total wire traffic.',
    ] };
  } catch (error) { if (error instanceof Error) Object.assign(error, { evidence: { ...metadata, metrics, failureEvidence: 'evidence' in error ? error.evidence as JsonObject : null } }); throw error; }
  finally { resources.abort(); await Promise.allSettled(clients.map(client => client.kill())); await rm(dir, { recursive: true, force: true }); }
}
