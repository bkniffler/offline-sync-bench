import { expect, test } from 'bun:test';
import { attachmentBytes, interruptionBytes, validateDownloadRecovery } from './download-recovery.ts';
import type { JsonObject } from '../types.ts';

function proof(): JsonObject {
  const failed = { method: 'GET', status: 200, contentLength: attachmentBytes, range: null, upstreamBodyBytes: interruptionBytes, forwardedBodyBytes: interruptionBytes, interrupted: true, completed: false };
  return { method: 'fresh-client-interrupted-download-v1', expectedSha256: 'a'.repeat(64), expectedBytes: attachmentBytes, cutAfterBytes: interruptionBytes,
    storeWasAbsent: true, store: '/fresh/reader.sqlite', clientId: 'fresh-reader', pid: 100, controllerPid: 90,
    initialCacheCount: 0, cacheAfterFailure: 0, cacheAfterRecovery: 1, failed: true, failure: 'unexpected EOF',
    recovered: { byteLength: attachmentBytes, sha256: 'a'.repeat(64) }, failedAttemptMs: 12, recoveryMs: 18,
    interrupted: { method: 'http-object-download-cut-v1', cutAfterBytes: interruptionBytes, attempts: [{ ...failed }] },
    restored: { method: 'http-object-download-cut-v1', cutAfterBytes: null, attempts: [{ ...failed }, { ...failed, upstreamBodyBytes: attachmentBytes, forwardedBodyBytes: attachmentBytes, interrupted: false, completed: true }] },
    resources: { method: 'external-ps-process-tree-v1', includeRoot: true, rootPid: 100, samples: [{ processes: [{ pid: 100 }] }, { processes: [{ pid: 100 }] }] },
  };
}
test('download evidence rejects preflight faults, warm caches, partial recovery and controller sampling', () => {
  expect(() => validateDownloadRecovery(proof(), 'a'.repeat(64), attachmentBytes)).not.toThrow();
  const mutations: Array<(p: JsonObject) => void> = [
    p => { p.initialCacheCount = 1; },
    p => { p.cacheAfterFailure = 1; },
    p => { p.storeWasAbsent = false; },
    p => { p.failed = false; },
    p => { (p.recovered as JsonObject).sha256 = 'b'.repeat(64); },
    p => { ((p.interrupted as JsonObject).attempts as JsonObject[])[0]!.forwardedBodyBytes = 0; },
    p => { for (const key of ['interrupted', 'restored']) ((p[key] as JsonObject).attempts as JsonObject[])[0]!.forwardedBodyBytes = attachmentBytes; },
    p => { ((p.restored as JsonObject).attempts as JsonObject[])[1]!.forwardedBodyBytes = interruptionBytes; },
    p => { ((p.restored as JsonObject).attempts as JsonObject[])[1]!.range = 'bytes=65536-'; },
    p => { (p.resources as JsonObject).rootPid = 90; },
    p => { (((p.resources as JsonObject).samples as JsonObject[])[0]!.processes as JsonObject[]).push({ pid: 90 }); },
  ];
  for (const mutate of mutations) { const p = proof(); mutate(p); expect(() => validateDownloadRecovery(p, 'a'.repeat(64), attachmentBytes)).toThrow(); }
});
