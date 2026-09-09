import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from '../contracts/screens.ts';
import { RecoveryProcess } from '../recovery/process.ts';
import { ExternalResources } from '../resources.ts';
import { tempRoot } from '../paths.ts';
import { getStack } from '../stacks.ts';
import { BlobTransferGate } from './transfer-gate.ts';
import type { JsonObject } from '../types.ts';
import { interruptionBytes } from './fixture.ts';
export { attachmentBytes, interruptionBytes, attachmentPayload } from './fixture.ts';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function validateDownloadRecovery(evidence: JsonObject, expectedSha256: string, expectedBytes: number) {
  if (evidence.method !== 'fresh-client-interrupted-download-v1' || evidence.expectedSha256 !== expectedSha256 || evidence.expectedBytes !== expectedBytes || evidence.cutAfterBytes !== interruptionBytes || evidence.storeWasAbsent !== true || typeof evidence.store !== 'string' || !evidence.store || typeof evidence.clientId !== 'string' || !evidence.clientId || !Number.isSafeInteger(evidence.pid) || Number(evidence.pid) < 2 || evidence.pid === evidence.controllerPid) throw new ContractError('Interrupted download configuration or fresh-client identity missing');
  if (evidence.initialCacheCount !== 0 || evidence.cacheAfterFailure !== 0 || evidence.cacheAfterRecovery !== 1 || evidence.failed !== true || typeof evidence.failure !== 'string' || !evidence.failure) throw new ContractError('Interrupted download must fail without caching a partial blob');
  const recovered = evidence.recovered as JsonObject;
  if (recovered?.sha256 !== expectedSha256 || recovered.byteLength !== expectedBytes) throw new ContractError('Recovered download content mismatch');
  const interrupted = evidence.interrupted as JsonObject, restored = evidence.restored as JsonObject;
  const failed = interrupted?.attempts as JsonObject[], all = restored?.attempts as JsonObject[];
  if (interrupted?.method !== 'http-object-download-cut-v1' || restored?.method !== interrupted.method || interrupted.cutAfterBytes !== interruptionBytes || restored.cutAfterBytes !== null || !Array.isArray(failed) || !failed.length || !Array.isArray(all) || all.length <= failed.length) throw new ContractError('Interrupted and restored network observations missing');
  if (JSON.stringify(all.slice(0, failed.length)) !== JSON.stringify(failed)) throw new ContractError('Transfer history changed after restoration');
  for (const attempt of all) if (attempt.method !== 'GET' || attempt.status !== 200 || attempt.contentLength !== expectedBytes || attempt.range !== null || !Number.isSafeInteger(attempt.upstreamBodyBytes) || Number(attempt.upstreamBodyBytes) < Number(attempt.forwardedBodyBytes) || Number(attempt.upstreamBodyBytes) > expectedBytes) throw new ContractError('Expected full-object HTTP transfer evidence missing');
  if (failed.some(attempt => attempt.interrupted !== true || attempt.completed !== false || attempt.forwardedBodyBytes !== interruptionBytes) || interruptionBytes >= expectedBytes) throw new ContractError('Fault must interrupt a positive partial response body');
  if (all.slice(failed.length).some(attempt => attempt.interrupted !== false || attempt.completed !== true || attempt.forwardedBodyBytes !== expectedBytes)) throw new ContractError('Restored download did not transfer a complete object');
  for (const field of ['failedAttemptMs', 'recoveryMs']) if (typeof evidence[field] !== 'number' || !Number.isFinite(evidence[field]) || Number(evidence[field]) < 0) throw new ContractError('Download timing missing');
  const resources = evidence.resources as JsonObject, samples = resources?.samples as JsonObject[];
  if (resources?.method !== 'external-ps-process-tree-v1' || resources.includeRoot !== true || resources.rootPid !== evidence.pid || !Array.isArray(samples) || samples.length < 2 || samples.some(sample => !(sample.processes as JsonObject[]).some(p => p.pid === evidence.pid) || (sample.processes as JsonObject[]).some(p => p.pid === evidence.controllerPid))) throw new ContractError('Download resources must cover only the fresh client process tree');
}

/** Kept separate from the preflight upload-queue fault. A fresh product store
 * downloads an existing authorized blob; restoring the relay retries the full
 * GET through the same native client. No byte-range resume claim is made. */
export async function measureDownloadRecovery(stackId: 'syncular' | 'syncular-rust', actorId: string, projectId: string, ref: string, expected: Uint8Array) {
  await mkdir(tempRoot, { recursive: true }); const dir = await mkdtemp(join(tempRoot, 'blob-download-'));
  const store = join(dir, 'reader.sqlite'), clientId = randomUUID();
  const gate = new BlobTransferGate('http://localhost:3230'); // Declared public MinIO origin in this stack.
  const client = new RecoveryProcess();
  const sampler = new ExternalResources(true, client.pid);
  const evidence: JsonObject = { method: 'fresh-client-interrupted-download-v1', stage: 'setup', clientId, actorId, projectId, pid: client.pid, controllerPid: process.pid, store,
    expectedSha256: digest(expected), expectedBytes: expected.length, cutAfterBytes: interruptionBytes, objectOrigin: gate.origin };
  try {
    try { await stat(store); evidence.storeWasAbsent = false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; evidence.storeWasAbsent = true; }
    await gate.start();
    await client.open({ stackId, actorId, projectId, clientId, dbPath: store, syncBaseUrl: getStack(stackId).syncBaseUrl, blobDownloadProxy: gate.proxy() });
    evidence.initialCacheCount = await client.call<number>('blobCacheCount');
    await sampler.start(); gate.interruptAfter(interruptionBytes); evidence.stage = 'interrupted-download';
    const failedAt = performance.now();
    try { await client.call('fetchBlob', { ref }); evidence.failed = false; }
    catch (error) { evidence.failed = true; evidence.failure = error instanceof Error ? error.message : String(error); }
    evidence.failedAttemptMs = performance.now() - failedAt;
    evidence.interrupted = gate.snapshot() as unknown as JsonObject;
    evidence.cacheAfterFailure = await client.call<number>('blobCacheCount');
    if (evidence.failed !== true) throw new ContractError('The native download succeeded despite the required interruption');
    gate.restore(); evidence.stage = 'restored-download';
    const restoredAt = performance.now(); let receivedAt: number | undefined;
    evidence.recovered = await client.call<JsonObject>('fetchBlob', { ref }, event => { if (event === 'downloaded') receivedAt = performance.now(); });
    if (receivedAt === undefined) throw new ContractError('Download completion event missing');
    evidence.recoveryMs = receivedAt - restoredAt;
    evidence.restored = gate.snapshot() as unknown as JsonObject;
    evidence.cacheAfterRecovery = await client.call<number>('blobCacheCount');
    const resources = await sampler.stop(); evidence.resources = resources.metadata;
    validateDownloadRecovery(evidence, digest(expected), expected.length);
    evidence.stage = 'completed';
    return { evidence, metrics: { download_interruption_failed_attempt_ms: Number(evidence.failedAttemptMs), download_interruption_recovery_ms: Number(evidence.recoveryMs),
      ...Object.fromEntries(Object.entries(resources.metrics).map(([name, value]) => [`download_interruption_${name}`, value])) } };
  } catch (error) {
    evidence.networkAtFailure = gate.snapshot() as unknown as JsonObject;
    if (error instanceof Error) Object.assign(error, { evidence }); throw error;
  } finally { sampler.abort(); await client.kill(); await gate.close(); await rm(dir, { recursive: true, force: true }); }
}
