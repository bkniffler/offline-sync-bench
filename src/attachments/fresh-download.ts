import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RecoveryProcess } from '../recovery/process.ts';
import { ExternalResources } from '../resources.ts';
import { tempRoot } from '../paths.ts';
import { getStack } from '../stacks.ts';
import { BlobTransferGate } from './transfer-gate.ts';
import { attachmentBytes, attachmentDigests, attachmentProject, attachmentReader } from './fixture.ts';
import { ContractError } from '../contracts/screens.ts';
import type { JsonObject } from '../types.ts';

export function validateFreshDownload(e: JsonObject) {
  if (e.method !== 'fresh-client-download-v1' || typeof e.store !== 'string' || !e.store || typeof e.clientId !== 'string' || !e.clientId || !Number.isSafeInteger(e.pid) || Number(e.pid) < 2 || e.pid === e.controllerPid || e.initialCacheCount !== 0 || e.finalCacheCount !== 1) throw new ContractError('Fresh download identity/cache evidence missing');
  const content = e.content as JsonObject;
  if (content?.byteLength !== attachmentBytes || content.sha256 !== attachmentDigests[0] || typeof e.downloadMs !== 'number' || !Number.isFinite(e.downloadMs) || e.downloadMs < 0) throw new ContractError('Fresh download content or timing mismatch');
  const traffic = e.traffic as JsonObject, attempts = traffic?.attempts as JsonObject[];
  if (traffic?.method !== 'http-object-download-cut-v1' || traffic.cutAfterBytes !== null || !Array.isArray(attempts) || attempts.length !== 1 || attempts[0].status !== 200 || attempts[0].method !== 'GET' || attempts[0].range !== null || attempts[0].contentLength !== attachmentBytes || attempts[0].upstreamBodyBytes !== attachmentBytes || attempts[0].forwardedBodyBytes !== attachmentBytes || attempts[0].completed !== true || attempts[0].interrupted !== false) throw new ContractError('Fresh download did not traverse the object transport');
  const resources = e.resources as JsonObject, samples = resources?.samples as JsonObject[];
  if (resources?.method !== 'external-ps-process-tree-v1' || resources.rootPid !== e.pid || resources.includeRoot !== true || !Array.isArray(samples) || samples.length < 2 || samples.some(s => !(s.processes as JsonObject[]).some(p => p.pid === e.pid) || (s.processes as JsonObject[]).some(p => p.pid === e.controllerPid))) throw new ContractError('Fresh download resource scope mismatch');
}
export async function measureFreshDownload(stackId: 'syncular' | 'syncular-rust', ref: string) {
  await mkdir(tempRoot, { recursive: true }); const dir = await mkdtemp(join(tempRoot, 'blob-first-reader-'));
  const store = join(dir, 'reader.sqlite'), clientId = randomUUID(), client = new RecoveryProcess();
  const gate = new BlobTransferGate('http://localhost:3230'), sampler = new ExternalResources(true, client.pid);
  const evidence: JsonObject = { method: 'fresh-client-download-v1', pid: client.pid, controllerPid: process.pid, store, clientId, actorId: attachmentReader };
  try {
    await gate.start();
    await client.open({ stackId, actorId: attachmentReader, projectId: attachmentProject, clientId, dbPath: store, syncBaseUrl: getStack(stackId).syncBaseUrl, blobDownloadProxy: gate.proxy() });
    evidence.initialCacheCount = await client.call<number>('blobCacheCount');
    await sampler.start(); const start = performance.now(); let received: number | undefined;
    evidence.content = await client.call<JsonObject>('fetchBlob', { ref }, event => { if (event === 'downloaded') received = performance.now(); });
    if (received === undefined) throw new ContractError('Fresh download completion event missing');
    evidence.downloadMs = received - start;
    const resources = await sampler.stop(); evidence.resources = resources.metadata;
    evidence.finalCacheCount = await client.call<number>('blobCacheCount');
    evidence.traffic = gate.snapshot() as unknown as JsonObject;
    validateFreshDownload(evidence);
    return { evidence, metrics: { fresh_download_ms: Number(evidence.downloadMs), ...Object.fromEntries(Object.entries(resources.metrics).map(([key, value]) => [`fresh_download_${key}`, value])) } };
  } catch (error) { evidence.networkAtFailure = gate.snapshot() as unknown as JsonObject; if (error instanceof Error) Object.assign(error, { evidence }); throw error; }
  finally { sampler.abort(); await client.kill(); await gate.close(); await rm(dir, { recursive: true, force: true }); }
}
