import { resultProfile } from '../profiles.ts';
import type { BenchmarkResult } from '../types.ts';
import { expect, test } from 'bun:test';
import { validateNativeFiles, NATIVE_FILE_CONTRACT, nativeFileFixture } from './native-files.ts';
import { attachmentBytes, attachmentDigests } from '../attachments/fixture.ts';
import type { JsonObject } from '../types.ts';
function receipt() {
  const resources = { method: 'external-ps-process-tree-v1', samples: [{}, {}] };
  const files = [0, 1].map(variant => ({ variant, id: `file-${variant}`, taskId: 'task', bytes: attachmentBytes, sha256: attachmentDigests[variant], uploadMs: 10 + variant, stageIncluded: true, partIds: Array.from({ length: 8 }, (_, i) => `${variant}-${i}`), partSizes: Array(8).fill(262144) }));
  const phases = ['writer', 'fresh', 'interrupted'].map((phase, i) => ({ phase, pid: 100 + i, store: `/store/${phase}`, storeWasAbsent: true, taskCount: 50, resources,
    ...(i === 0 ? { files } : { before: { fileCount: 0, partCount: 0 }, link: { file_id: files[i - 1]!.id, task_id: 'task' }, complete: { bytes: attachmentBytes, sha256: attachmentDigests[i - 1] }, downloadMs: 20 + i }),
    ...(i === 2 ? { interruption: { method: 'native-chunk-then-disconnect', gate: { blocked: true }, deliveredBytes: 262144, partialPartCount: 1, failure: 'File is incomplete: missing part' } } : {}),
  }));
  return { scenarioId: 'blob-flow' as const, metrics: { blob_size_bytes: attachmentBytes, initial_upload_ms: 10, second_upload_ms: 11, fresh_download_ms: 21, download_interruption_recovery_ms: 22 }, metadata: { workloadContract: NATIVE_FILE_CONTRACT, fixture: nativeFileFixture, stackId: 'jazz-v2', controllerPid: 99, nativeFileProfile: 'native-chunked-sync-files', phases } as unknown as JsonObject };
}
test('native file receipts bind fresh clients, complete bytes, native chunks, real outage and exact timings', () => {
  validateNativeFiles(receipt());
  const damages = [
    (r: any) => r.metadata.phases[1].pid = r.metadata.phases[0].pid,
    (r: any) => r.metadata.phases[1].store = r.metadata.phases[0].store,
    (r: any) => r.metadata.phases[1].before.partCount = 8,
    (r: any) => r.metadata.phases[1].complete.sha256 = 'incorrect',
    (r: any) => r.metadata.phases[2].interruption.gate.blocked = false,
    (r: any) => r.metadata.phases[2].interruption.partialPartCount = 8,
    (r: any) => r.metadata.phases[0].files[0].partSizes[0] = 1,
    (r: any) => r.metadata.phases[1].link.file_id = 'another-file',
    (r: any) => r.metrics.fresh_download_ms = 1,
  ];
  for (const damage of damages) { const r = receipt(); damage(r); expect(() => validateNativeFiles(r)).toThrow(); }
});

test('native attachment reporting admits measured resources and separates protocol guarantees', () => {
  const base = receipt();
  base.metadata.resources = { method: 'external-ps-process-tree-v1', scope: 'per-phase samples' };
  const result: BenchmarkResult = { ...base, stackId: 'jazz-v2', status: 'completed', runId: 'test', resultId: 'test', startedAt: '2026-09-10T00:00:00Z', finishedAt: '2026-09-10T00:00:01Z', durationMs: 1000, notes: [] };
  const campaign = { source: { sourceHash: 'test-source' }, machine: {}, network: {}, images: {} };
  const profile = resultProfile(result, campaign);
  expect(profile.eligible).toBe(true);
  expect(profile.guarantee).toBe('native-chunked-sync-files');
  delete result.metadata.resources;
  expect(resultProfile(result, campaign).eligible).toBe(false);
});
