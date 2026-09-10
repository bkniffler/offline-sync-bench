/** Development receipts, deliberately separate from the publication campaigns.
 * Run after the targeted checks; preserve rejected attempts as well as passes. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { validateResult } from '../src/execution.ts';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const checks = [
  ['2026-09-09T23-31-37-403Z', 'electric', 'deep-relationship-query', 'superseded by indexed application queries'],
  ['2026-09-09T23-32-05-956Z', 'electric', 'replica-reopen', 'verified'],
  ['2026-09-09T23-34-41-340Z', 'jazz-v2', 'deep-relationship-query', 'verified'],
  ['2026-09-09T23-36-22-213Z', 'electric-tanstack', 'offline-restart', 'rejected by the old validator; retained unchanged'],
  ['2026-09-09T23-38-01-104Z', 'syncular-rust', 'blob-flow', 'verified'],
  ['2026-09-09T23-40-14-225Z', 'zero', 'replica-reopen', 'custom KV adapter deadlocked; replaced with native SQLiteStore'],
  ['2026-09-09T23-43-15-559Z', 'zero', 'replica-reopen', 'custom KV adapter deadlocked; replaced with native SQLiteStore'],
  ['2026-09-09T23-45-41-840Z', 'zero', 'replica-reopen', 'initial complete notification preceded fixture visibility; fixed readiness validation'],
  ['2026-09-09T23-46-48-892Z', 'zero', 'replica-reopen', 'closed before native scheduled persistence; offline hydration failed'],
  ['2026-09-09T23-48-41-179Z', 'zero', 'replica-reopen', 'verified'],
  ['2026-09-09T23-50-02-212Z', 'electric-tanstack', 'offline-restart', 'aborted: overlapping Electric fixture reseed invalidated this development check'],
  ['2026-09-09T23-50-03-357Z', 'electric', 'deep-relationship-query', 'excluded: overlapping development checks on shared backend'],
  ['2026-09-09T23-51-06-018Z', 'electric-tanstack', 'offline-restart', 'verified'],
  ['2026-09-09T23-54-04-439Z', 'electric', 'deep-relationship-query', 'verified'],
];
const root = 'results/diagnostics/coverage-fixes';
await mkdir(`${root}/raw`, { recursive: true });
const receipts = [];
for (const [runId, stackId, scenarioId, disposition] of checks) {
  const source = `.results/${runId}/${stackId}/${scenarioId}.json`, raw = await readFile(source), result = JSON.parse(raw.toString());
  if (disposition === 'verified') {
    if (result.status !== 'completed') throw new Error(`Check did not pass: ${source}`);
    validateResult(result);
  }
  const file = `raw/${runId}-${stackId}-${scenarioId}.json.gz`, bytes = gzipSync(raw, { level: 9 });
  await writeFile(`${root}/${file}`, bytes);
  receipts.push({ stackId, scenarioId, source, file, sha256: sha(raw), compressedSha256: sha(bytes), status: result.status, disposition,
    ...(disposition === 'verified' ? { metrics: result.metrics, frameworkVersion: result.metadata.frameworkVersion, workloadContract: result.metadata.workloadContract } : {}) });
}
await writeFile(`${root}/VERIFICATION.json`, JSON.stringify({
  kind: 'development-verification', notForPublication: true,
  scope: 'Six implemented cases pass full workload validation. These development runs were not a predeclared campaign: other checks and builds could overlap. Timing samples are diagnostic, not replacement publication numbers. Rejected attempts remain unchanged. No source-at-start or campaign provenance is claimed.',
  verifiedCases: receipts.filter(r => r.disposition === 'verified').length, receipts,
}, null, 2) + '\n');
console.log(`Packaged ${receipts.length} development receipts; ${receipts.filter(r => r.disposition === 'verified').length} verified cases.`);
