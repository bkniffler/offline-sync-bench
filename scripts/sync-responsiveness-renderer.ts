import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { aggregate } from '../src/responsiveness/report.ts';

export const responsivenessRows = [
  ['Syncular JS', 'syncular'], ['Syncular Rust', null], ['PowerSync', 'powersync'], ['Turso', null],
  ['Zero', 'zero'], ['Electric', 'electric'], ['Electric + TanStack DB', 'electric-tanstack'], ['Jazz v2 (experimental)', 'jazz'],
] as const;

const ms = (value: number | null) => value === null ? 'n/a' : `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ms`;
const pct = (value: number | null) => value === null ? 'n/a' : `${value.toFixed(value >= 10 ? 0 : 1)}%`;

export async function renderSyncResponsiveness(binding: { path: string; sha256: string; rendererSha256: string }, base: string): Promise<string[]> {
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha(await readFile(import.meta.path)), binding.rendererSha256, 'Stale sync-responsiveness renderer');
  const bytes = await readFile(resolve(base, binding.path)); assert.equal(sha(bytes), binding.sha256, 'Stale sync-responsiveness binding');
  const data = JSON.parse(bytes.toString());
  assert.equal(data.kind, 'sync-responsiveness'); assert.equal(data.sourceUnchanged, true);
  const rows = aggregate(data);
  const find = (id: string, condition: string) => rows.find(row => row.stack === id && row.condition === condition);
  const sample = (row: any) => row.n === data.plan.trials && !row.failed ? '' : ` (n=${row.n}${row.failed ? `, ${row.failed} failed` : ''})`;
  const unavailable = (label: string, id: string | null, columns: number) => {
    const text = id === 'jazz' ? 'Not measured \\*\\*' : 'Not applicable \\*';
    return `| ${label} | ${Array(columns).fill(text).join(' | ')} |`;
  };
  const primary = responsivenessRows.map(([label, id]) => {
    const row = id ? find(id, 'default') : undefined;
    if (!row) return unavailable(label, id, 7);
    return `| ${label}${sample(row)} | ${ms(row.bootstrapMs)} | ${ms(row.bootstrapInputP95)} | ${pct(row.bootstrapBlockingPct)} | ${ms(row.bootstrapLongestFrame)} | ${ms(row.catchUpMs)} | ${ms(row.catchUpInputP95)} | ${pct(row.catchUpBlockingPct)} |`;
  });
  const slow = responsivenessRows.map(([label, id]) => {
    const row = id ? find(id, 'low-priority') : undefined, base = id ? find(id, 'default') : undefined;
    if (!row || !base) return unavailable(label, id, 5);
    const slowdown = `${(row.calibrationMainMs! / base.calibrationMainMs!).toFixed(1)}×/${(row.calibrationWorkerMs! / base.calibrationWorkerMs!).toFixed(1)}×`;
    return `| ${label}${sample(row)} | ${slowdown} | ${ms(row.bootstrapMs)} | ${ms(row.bootstrapInputP95)} | ${ms(row.catchUpMs)} | ${ms(row.catchUpInputP95)} |`;
  });
  const bootstrap = data.plan.bootstrapRows.toLocaleString('en-US'), catchUp = data.plan.catchUpRows.toLocaleString('en-US');
  return ['### Staying responsive while syncing', '',
    `A browser page keeps working while its client syncs. The controller types a key every ${data.plan.inputIntervalMs} ms and the page refreshes a 50-row task list four times a second. The client first downloads ${bootstrap} tasks into an empty store (**initial sync**). The page then closes, the server commits ${catchUp} task updates, and the reloaded page reopens the same store and catches up (**catch-up**). Plain Electric keeps no local store, so its catch-up downloads every task again. **Keystroke p95** is the 95th-percentile time from a key event to the next frame; a responsive page stays under one frame (16.7 ms). **Main thread blocked** is the long-animation-frame blocking time as a share of the phase. Medians of ${data.plan.trials} trials per client, each in a fresh Chromium profile.`, '',
    '| Client | Initial sync | Keystroke p95 | Main thread blocked | Longest frame | Catch-up | Keystroke p95 | Main thread blocked |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...primary, '',
    '\\* Syncular Rust and Turso use native-host clients in this harness; there is no browser client to measure.', '',
    '\\*\\* Jazz has no browser adapter for this case yet; its native 100,000-task startup did not complete within 90 seconds.', '',
    `**On a slower device.** The same trials with every Chromium process except the GPU at background CPU priority. DevTools CPU throttling is not used because it does not slow workers. The slowdown column is the measured cost of a fixed loop on the main thread and in a worker, relative to default priority.`, '',
    '| Client | Slowdown (main/worker) | Initial sync | Keystroke p95 | Catch-up | Keystroke p95 |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...slow, '',
    '[Workload, conditions and raw trials](./results/sync-responsiveness/README.md) · [Definition](./docs/benchmarks.md#sync-responsiveness)', ''];
}
