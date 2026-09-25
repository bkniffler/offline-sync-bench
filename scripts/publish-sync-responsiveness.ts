/** Publish one complete sync-responsiveness collection and render its README table.
 * bun scripts/publish-sync-responsiveness.ts .results/sync-responsiveness-<run>
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSyncResponsiveness } from './sync-responsiveness-renderer.ts';
import { renderResponsiveness } from '../src/responsiveness/report.ts';

const source = process.argv[2];
assert(source, 'Pass the collection directory');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const raw = await readFile(join(source, 'RESULTS.json'));
const report = JSON.parse(raw.toString());
assert.equal(report.kind, 'sync-responsiveness');
assert.equal(report.sourceUnchanged, true, 'Collection source changed during the run');
for (const input of report.source) assert.equal(sha(await readFile(input.path)), input.sha256, `Source differs from the collection: ${input.path}`);
const measured = report.trials.filter((t: any) => t.label !== 'warmup' && t.condition);
assert.equal(measured.length, report.plan.stacks.length * Object.keys(report.plan.conditions).length * report.plan.trials, 'Every planned trial must be retained');
for (const trial of measured.filter((t: any) => t.status === 'completed')) {
  assert.equal(trial.validation.serverDigest, trial.validation.clientDigest, `${trial.stack} ${trial.label}: replica differs from server`);
  assert.equal(trial.validation.rows, report.plan.bootstrapRows);
  assert(trial.cleanup?.allObservedAbsent, `${trial.stack} ${trial.label}: browser cleanup incomplete`);
}

const root = 'results/sync-responsiveness';
await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
await copyFile(join(source, 'RESULTS.json'), join(root, 'RESULTS.json'));
await writeFile(join(root, 'source-files.txt'), report.source.map((s: any) => s.path).join('\n') + '\n');
execFileSync('tar', ['--no-xattrs', '-czf', join(root, 'SOURCE.tar.gz'), '-T', join(root, 'source-files.txt')], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
await rm(join(root, 'source-files.txt'));
await writeFile(join(root, 'SUMMARY.md'), renderResponsiveness(report));
const conditions = Object.entries(report.plan.conditions).map(([id, c]: [string, any]) => `- \`${id}\`: ${c.description}.`).join('\n');
await writeFile(join(root, 'README.md'), `# Staying responsive while syncing

A browser page must stay usable while its sync client downloads and applies data. This benchmark measures how much a client slows the page that hosts it.

[Numbers in the main README](../../README.md#staying-responsive-while-syncing) · [All medians, including idle and longest frames](SUMMARY.md) · [Raw trials](RESULTS.json) · [Captured source](SOURCE.tar.gz) · [Definition](../../docs/benchmarks.md#sync-responsiveness)

## Workload

Every client runs the same page (\`src/responsiveness/page/app.ts\`). A text area has focus; the controller sends one real key event through DevTools every ${report.plan.inputIntervalMs} ms from before sync starts until the end. Every ${250} ms the page queries the shared 50-row task screen, renders it as a list and checks progress.

1. **Initial sync.** A fresh Chromium profile and an empty client store download ${report.plan.bootstrapRows.toLocaleString('en-US')} tasks (the \`bootstrap\` fixture). The phase ends when the page sees every task and the correct screen.
2. **Idle.** After ${report.plan.settleMs / 1000} s, ${report.plan.idleMs / 1000} s with the complete, connected replica. This is each client's own baseline.
3. **Catch-up.** The client closes. With no client running, the server retitles the ${report.plan.catchUpRows.toLocaleString('en-US')} highest-id tasks. Postgres-backed services replicate one \`UPDATE\` transaction. Syncular's server tables are engine-owned, so its admin commits the same rows through the engine in 2,000-row commits. The page then reloads in the same profile, reopens the same local store and catches up. The phase starts when the reopened client is constructed and ends when the page sees all updated titles and the updated screen. The whole server change is committed before timing, so server write speed is excluded. Plain Electric keeps only a memory cache, so its catch-up downloads every task again.

After each sync phase, the complete client replica is compared with the server's Postgres rows. Every sent key event must arrive in order. Each client uses its documented browser storage and default threading:

| Client | Storage | Sync and apply | Screen query |
| --- | --- | --- | --- |
| Syncular JS | SQLite WASM on OPFS | Dedicated worker (\`createSyncClientHandle\`) | SQL in the worker |
| PowerSync | wa-sqlite, SDK default VFS | SDK default workers | SQL in the database worker |
| Zero | IndexedDB | Main thread | Native materialized view |
| Electric | SDK memory; no persistence | Main thread | Application filter over the shape |
| Electric + TanStack DB | wa-sqlite on OPFS (persistence worker) | Main thread collection; persistence worker | Native live query, four indexes |

Zero, Electric and TanStack count updated titles by scanning their in-memory rows at the same four-times-a-second cadence, since they have no count query. That scan is part of their main-thread cost.

## Metrics

- **Keystroke latency**: key event timestamp to the next \`requestAnimationFrame\`. One frame (up to 16.7 ms) is the floor. The event timestamp is set when the controller sends the key, so time spent queued behind a busy main thread counts.
- **Main thread blocked**: the sum of \`long-animation-frame\` \`blockingDuration\` in the phase, divided by its length.
- **Longest frame**: the longest long animation frame in the phase.
- Also recorded: frame gaps and dropped frames, screen-query latency (including worker round trips), Event Timing entries, and the browser process tree's CPU seconds and peak RSS sampled by \`ps\`.

Phase times are observed at the page's 250 ms refresh, so milestones have up to 250 ms of resolution.

## Conditions

${conditions}

Default priority runs on all cores of the collection machine (${report.machine.cpu}). The slower-device condition exists because DevTools CPU throttling slows only the page's main thread; workers stay at full speed, which would favour worker-based clients. Clamping the whole browser to background QoS instead drops frame production to about 5 fps. Background priority on every process except the GPU slows the main thread and workers alike and keeps 60 Hz frames. Each trial measures a fixed loop on the main thread and in a worker to show the actual slowdown. It varies by run and with other load on the machine, so treat that condition as a sensitivity check, not a device model.

## Sampling and reproduction

Per client: one discarded warm-up at default priority, then ${report.plan.trials} trials per condition in seeded random order. Failures are retained, with no retries. Medians use completed trials only.

\`\`\`sh
bun run bench:responsiveness                  # all browser clients, both conditions
bun run bench:responsiveness -- --stack zero --trials 1 --conditions default
bun scripts/publish-sync-responsiveness.ts .results/sync-responsiveness-<run>
\`\`\`

Collected ${report.measuredAt.slice(0, 10)} with ${Object.entries(report.versions).map(([name, version]) => `${name} ${version}`).join(', ')}.
`);
const binding = { path: `${root}/RESULTS.json`, sha256: sha(await readFile(`${root}/RESULTS.json`)), rendererSha256: sha(await readFile('scripts/sync-responsiveness-renderer.ts')) };
await renderSyncResponsiveness(binding, process.cwd());
const summary = JSON.parse(await readFile('SUMMARY.json', 'utf8')); summary.syncResponsiveness = binding;
await writeFile('SUMMARY.json', JSON.stringify(summary, null, 2) + '\n');
const results = JSON.parse(await readFile('RESULTS.json', 'utf8')); results.syncResponsiveness = binding;
results.summarySha256 = sha(await readFile('SUMMARY.json'));
results.rendererSha256 = sha(await readFile('scripts/render-publication-summary.ts'));
await writeFile('RESULTS.json', JSON.stringify(results, null, 2) + '\n');
execFileSync(process.execPath, ['scripts/render-publication-summary.ts', 'SUMMARY.json', 'README.md'], { stdio: 'inherit' });
console.log(`Published ${root} (${sha(raw).slice(0, 16)})`);
