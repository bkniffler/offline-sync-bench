import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateLargeFileResult } from './large-run.ts';

export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
export const singleRunSampling = { trials: 1, statistic: 'single observation', design: 'retained single run' };

/** Recompute medians from every validated candidate attempt; never select a representative run. */
export function summarizeLargeFilePairs(report: any) {
  assert.equal(report.kind, 'syncular-blob-client-release-pairs');
  assert.equal(report.sourceUnchanged, true);
  assert(report.finishedAt);
  assert.equal(report.baseline, '0.18.0');
  assert.equal(report.candidate, '0.19.0');
  assert.equal(report.serverVersion, '0.19.0');
  assert.deepEqual(report.server, { core: '0.19.0', server: '0.19.0' });
  assert.equal(report.fixture.bytes, 500_000_000);
  const expected = [];
  for (let pair = 1; pair <= 3; pair++) {
    const clients = pair % 2 ? ['syncular', 'syncular-rust'] : ['syncular-rust', 'syncular'];
    for (const client of clients) {
      const reverse = (pair - 1 + Number(client === 'syncular-rust')) % 2;
      for (const version of reverse ? [report.candidate, report.baseline] : [report.baseline, report.candidate]) expected.push({ pair, client, version });
    }
  }
  assert.deepEqual(report.plan, expected, 'Expected three alternating pairs per client');
  assert.deepEqual(report.rows.map(({ pair, client, version }: any) => ({ pair, client, version })), expected, 'Missing, reordered or duplicated attempt');
  const stores = new Set<string>();
  for (const row of report.rows) {
    assert.equal(row.client, row.result.stackId);
    validateLargeFileResult(row.result, report.fixture);
    for (const phase of row.result.phases) {
      assert(!stores.has(phase.store), 'Client store reused across attempts');
      stores.add(phase.store);
    }
  }
  for (const version of [report.baseline, report.candidate]) {
    const runtime = report.runtime.filter((r: any) => r.version === version);
    assert.equal(runtime.length, 1);
    assert.equal(runtime[0].package.version, version);
    assert.equal(runtime[0].core, version);
    for (const key of ['lockSha256', 'cargoLockSha256', 'binarySha256']) assert.match(runtime[0][key], /^[0-9a-f]{64}$/);
  }
  const sampling: Record<string, any> = {};
  const rows = ['syncular', 'syncular-rust'].map(stackId => {
    const attempts = report.rows.filter((r: any) => r.client === stackId && r.version === report.candidate);
    assert.equal(attempts.length, 3);
    sampling[stackId] = { trials: 3, statistic: 'median', design: 'controlled alternating pairs', clientVersion: report.candidate, baselineVersion: report.baseline, pairs: [1, 2, 3] };
    return { stackId, status: 'completed', uploadMs: median(attempts.map((r: any) => r.result.uploadMs)), downloadMs: median(attempts.map((r: any) => r.result.downloadMs)) };
  });
  return { rows, sampling };
}

/** Bind derived rows to raw receipts and their captured source archive. */
export async function validateLargeFilePublication(data: any, folder: string) {
  assert.equal(data.kind, 'large-native-attachments');
  assert.equal(data.sourceUnchanged, true);
  assert.equal(data.fixture.bytes, 500_000_000);
  if (data.version === 3) {
    assert(!('trials' in data), 'Mixed sampling must not claim one global n');
    assert.equal(data.aggregation.path, 'src/attachments/large-publication.ts');
    assert.equal(data.aggregation.sha256, digest(await readFile(import.meta.path)), 'Aggregation code digest mismatch');
  }
  else assert.equal(data.trials, 1);
  const selected = new Set<string>();
  for (const collection of data.collections) {
    const path = resolve(folder, collection.path);
    const raw = await readFile(path);
    assert.equal(digest(raw), collection.sha256, 'Collection digest mismatch');
    const report = JSON.parse(raw.toString());
    assert.equal(report.fixture.bytes, data.fixture.bytes);
    assert.equal(report.fixture.sha256, data.fixture.sha256);
    assert.equal(report.sourceUnchanged, true);
    const sourcePath = resolve(dirname(path), report.source.path);
    const sourceRaw = await readFile(sourcePath);
    assert.equal(digest(sourceRaw), report.source.sha256, 'Source manifest digest mismatch');
    const source = JSON.parse(sourceRaw.toString());
    assert.equal(digest(await readFile(resolve(dirname(sourcePath), source.archive))), source.sha256, 'Source archive digest mismatch');
    let rows: any[], sampling: Record<string, any>;
    if (collection.kind === 'controlled-client-release-pairs') {
      ({ rows, sampling } = summarizeLargeFilePairs(report));
      assert.deepEqual([...collection.selectedStacks].sort(), ['syncular', 'syncular-rust']);
    } else {
      assert.equal(report.kind, 'large-native-attachments');
      assert.equal(report.trials, 1);
      rows = report.rows;
      sampling = Object.fromEntries(collection.selectedStacks.map((id: string) => [id, singleRunSampling]));
    }
    for (const id of collection.selectedStacks) {
      assert(!selected.has(id), 'Duplicate selected client');
      selected.add(id);
      const original = rows.find((r: any) => r.stackId === id);
      assert(original, 'Missing source result');
      if (collection.kind !== 'controlled-client-release-pairs' && original.status === 'completed') validateLargeFileResult(original, data.fixture);
      assert.deepEqual(data.rows.find((r: any) => r.stackId === id), original, 'Published result differs from source or recomputed median');
      if (data.version === 3) assert.deepEqual(data.sampling[id], sampling[id], 'Sampling design mismatch');
    }
  }
  assert.deepEqual([...selected].sort(), ['jazz-v2', 'powersync', 'syncular', 'syncular-rust']);
  assert.deepEqual(data.rows.map((r: any) => r.stackId).sort(), [...selected].sort());
  assert.deepEqual([...data.plan.stacks].sort(), [...selected].sort());
  if (data.version === 3) assert.deepEqual(Object.keys(data.sampling).sort(), [...selected].sort());
}
