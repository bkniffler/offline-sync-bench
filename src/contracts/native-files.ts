import type { BenchmarkResult } from '../types.ts';
import { attachmentBytes, attachmentDigests, attachmentTask } from '../attachments/fixture.ts';
import { ContractError, hash } from './screens.ts';
export const NATIVE_FILE_CONTRACT = 'native-files-v1';
export const nativeFileFixture = { taskCount: 50, fileCount: 2, bytesPerFile: attachmentBytes };
const require = (condition: unknown, message: string) => { if (!condition) throw new ContractError(message); };
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validateNativeFiles(result: Pick<BenchmarkResult, 'scenarioId' | 'metadata' | 'metrics'>): void {
  const m = result.metadata as Record<string, any>, metrics = result.metrics;
  require(result.scenarioId === 'blob-flow' && m.workloadContract === NATIVE_FILE_CONTRACT, 'Native file scenario/contract mismatch');
  require(hash(m.fixture) === hash(nativeFileFixture) && metrics.blob_size_bytes === attachmentBytes, 'Native file fixture mismatch');
  require(['powersync', 'jazz-v2'].includes(m.stackId), 'Native file stack missing');
  const phases = m.phases;
  require(Array.isArray(phases) && phases.length === 3, 'Native file phases missing');
  require(new Set(phases.map((p: any) => p.pid)).size === 3 && phases.every((p: any) => Number.isInteger(p.pid) && p.pid > 1 && p.pid !== m.controllerPid), 'Native file clients must have distinct processes');
  require(new Set(phases.map((p: any) => p.store)).size === 3, 'Native file stores must be distinct');
  for (const [i, p] of phases.entries()) {
    require(p.phase === ['writer', 'fresh', 'interrupted'][i] && p.storeWasAbsent === true && p.taskCount === 50, 'Native file phase identity/freshness/fixture invalid');
    require(p.resources?.method === 'external-ps-process-tree-v1' && p.resources.samples?.length >= 2, 'Native file resource evidence missing');
  }
  const files = phases[0].files;
  require(Array.isArray(files) && files.length === 2 && files[0].id !== files[1].id, 'Two native uploaded files required');
  for (let variant = 0; variant < 2; variant++) {
    const file = files[variant];
    require(file.variant === variant && file.bytes === attachmentBytes && file.sha256 === attachmentDigests[variant] && time(file.uploadMs), 'Native uploaded file bytes/hash/timing invalid');
    require(typeof file.taskId === 'string' && file.taskId.length > 0, 'Native file is not task-linked');
  }
  for (const [index, variant] of [[1, 0], [2, 1]] as const) {
    const p = phases[index];
    require(p.complete?.bytes === attachmentBytes && p.complete.sha256 === attachmentDigests[variant] && time(p.downloadMs), 'Native downloaded file bytes/hash/timing invalid');
    if (m.stackId === 'powersync') {
      require(p.before?.queue === null && p.before.files?.length === 0, 'PowerSync download cache was not empty');
      require(p.link?.id === files[variant].id && p.link.task_id === attachmentTask && p.complete.native?.state === 3 && p.complete.native.hasSynced === true, 'PowerSync native link/download receipt missing');
      require(p.transfers?.attempts?.some((a: any) => a.completed && a.forwardedBodyBytes === attachmentBytes), 'PowerSync complete HTTP transfer missing');
    } else {
      require(p.before?.fileCount === 0 && p.before.partCount === 0 && p.link?.file_id === files[variant].id && p.link.task_id === files[variant].taskId, 'Jazz native file freshness/link mismatch');
    }
  }
  const fault = phases[2].interruption;
  if (m.stackId === 'powersync') {
    require(m.nativeFileProfile === 'native-queue-streaming-object-store', 'PowerSync native file profile mismatch');
    require(m.objectPreparation?.objects?.length === 2 && m.objectPreparation.objects.every((o: any) => o.presentBefore === false), 'PowerSync objects must start absent');
    require(files.every((f: any) => f.staged?.state === 0 && f.complete?.state === 3 && f.complete.hasSynced === true), 'PowerSync native upload queue receipts missing');
    require(fault?.method === 'http-body-cut' && fault.gate.attempts.some((a: any) => a.interrupted && a.status === 200 && a.contentLength === attachmentBytes && a.forwardedBodyBytes === 65536 && !a.completed), 'PowerSync real download interruption missing');
    require(fault.failed?.state === 1 && !fault.failed.hasSynced && fault.partial?.bytes < attachmentBytes && fault.errors?.some((e: any) => e.operation === 'download'), 'PowerSync native retained retry evidence missing');
  } else {
    require(m.nativeFileProfile === 'native-chunked-sync-files', 'Jazz native file profile mismatch');
    require(files.every((f: any) => f.stageIncluded === true && f.partIds?.length === 8 && new Set(f.partIds).size === 8 && f.partSizes?.length === 8 && f.partSizes.every((n: number) => n === 262144)), 'Jazz native chunk manifest missing');
    require(fault?.method === 'native-chunk-then-disconnect' && fault.gate?.blocked && fault.deliveredBytes === 262144 && fault.partialPartCount > 0 && fault.partialPartCount < 8 && fault.failure?.includes('incomplete'), 'Jazz actual incomplete transfer evidence missing');
  }
  require(metrics.initial_upload_ms === files[0].uploadMs && metrics.second_upload_ms === files[1].uploadMs && metrics.fresh_download_ms === phases[1].downloadMs && metrics.download_interruption_recovery_ms === phases[2].downloadMs, 'Native file timing receipts differ from metrics');
}
