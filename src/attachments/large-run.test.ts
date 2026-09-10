import { test, expect } from 'bun:test';
import { validateLargeFileResult } from './large-run.ts';
import { readFile } from 'node:fs/promises';
// Standalone receipt fixture: no running service or existing result is needed.
const payload = { path: 'fixture.bin', bytes: 500_000_000, sha256: 'a'.repeat(64), source: 'fixture' };
const receipt = () => ({ stackId: 'syncular', status: 'completed', uploadMs: 110, downloadMs: 200, phases: [
 { phase: 'writer', pid: 100, store: 'writer', storeWasAbsent: true, taskCount: 50, stageMs: 10, uploadMs: 100,
   file: { ...payload, taskId: 'task', commitId: 'commit', applied: ['commit'] } },
 { phase: 'fresh', pid: 101, store: 'fresh', storeWasAbsent: true, taskCount: 50, initialCacheCount: 0,
   link: { task_id: 'task' }, complete: { bytes: payload.bytes, sha256: payload.sha256 }, downloadMs: 200,
   transfers: { attempts: [{ status: 200, contentLength: payload.bytes, forwardedBodyBytes: payload.bytes, completed: true, interrupted: false }] } },
] });
test('large transfer requires full bytes, empty independent cache, native commit and staging-inclusive timing', () => {
 expect(() => validateLargeFileResult(receipt(), payload)).not.toThrow();
 const mutations = [
  (r: any) => r.phases[1].complete.bytes--,
  (r: any) => r.phases[1].complete.sha256 = 'b'.repeat(64),
  (r: any) => r.phases[1].initialCacheCount = 1,
  (r: any) => r.phases[1].pid = 100,
  (r: any) => r.phases[0].file.applied = [],
  (r: any) => r.phases[1].transfers.attempts[0].forwardedBodyBytes--,
  (r: any) => r.uploadMs = 100,
 ];
 for (const mutate of mutations) { const result = receipt(); mutate(result); expect(() => validateLargeFileResult(result, payload)).toThrow(); }
});
