/** Read saved results only. No SDK, service or measured query is run.
 * bun scripts/review-tuned-screens.ts SQL_MANIFEST OUTPUT [ZERO_MANIFEST] [--partial]
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalData, validateScreenData, arrayScreenQuery, assertRows, queryNames, screenSeed, screenQueries, type ScreenCase } from '../src/contracts/screens.ts';
import { percentile } from '../src/metrics.ts';
import { validateManifest } from '../src/campaign-report.ts';

const partial = process.argv.includes('--partial');
const [sqlPath, output, zeroPath] = process.argv.slice(2).filter(v => v !== '--partial');
assert(sqlPath && output, 'Supply SQL_MANIFEST OUTPUT [ZERO_MANIFEST] [--partial]');
if (!partial) assert(zeroPath, 'Final review requires both completed campaigns');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const expected = new Map<string, any>();
const sources: any[] = [], results: any[] = [];
const sourceFiles = ['src/contracts/screens.ts', 'src/contracts/task-record.ts', 'src/metrics.ts'];

for (const [kind, path] of [['sql', sqlPath], ['zero', zeroPath]] as const) {
  if (!path) continue;
  const bytes = await readFile(path), manifest = JSON.parse(bytes.toString());
  assert.equal(manifest.config.trials, 3);
  assert.equal(manifest.config.purpose, 'publication');
  assert.deepEqual([...manifest.config.stacks].sort(), kind === 'sql' ? ['powersync', 'syncular', 'syncular-rust', 'turso'] : ['zero']);
  if (!partial) validateManifest(manifest);
  else assert(['running', 'complete'].includes(manifest.status));
  const bindings: Record<string, string> = {};
  for (const file of sourceFiles) {
    bindings[file] = sha(await readFile(file));
    assert.equal(bindings[file], manifest.source.files[file].sha256, `Reference code changed: ${file}`);
  }
  if (!expected.size) for (const scenario of ['local-query', 'deep-relationship-query'] as ScreenCase[]) {
    const data = canonicalData(scenario);
    const validation = validateScreenData(scenario, data);
    const outputs = Object.fromEntries(queryNames(scenario).map(name => {
      const rows = arrayScreenQuery(name, data);
      return [name, { digest: assertRows(name, rows, rows), count: rows.length }];
    }));
    expected.set(scenario, { validation, outputs });
  }
  const attempts = manifest.attempts.filter((a: any) => expected.has(a.scenarioId));
  const seen = new Set<string>();
  for (const a of attempts) {
    const identity = `${a.stackId}/${a.scenarioId}/${a.trial}`;
    assert(!seen.has(identity), 'Duplicate screen attempt'); seen.add(identity);
    assert([1, 2, 3].includes(a.trial));
    const index = manifest.attempts.indexOf(a), planned = manifest.plan[index];
    assert.deepEqual({ stackId: a.stackId, scenarioId: a.scenarioId, trial: a.trial }, planned);
    const rawPath = resolve(dirname(path), a.resultFile);
    assert(rawPath.startsWith(resolve(dirname(path)) + '/'));
    const raw = await readFile(rawPath), r = JSON.parse(raw.toString());
    assert.deepEqual(r, a.result);
    assert.equal(r.runId, manifest.id); assert.equal(r.stackId, a.stackId); assert.equal(r.scenarioId, a.scenarioId);
    assert.equal(r.metadata.profile.sourceHash, manifest.source.sourceHash);
    const record: any = { campaignId: manifest.id, index: index + 1, stack: a.stackId, scenario: a.scenarioId, trial: a.trial,
      resultId: r.resultId, rawSha256: sha(raw), status: r.status };
    results.push(record);
    if (r.status !== 'completed') { record.check = 'Failure retained; no successful screen claim'; continue; }
    const m = r.metadata, reference = expected.get(a.scenarioId);
    assert.equal(m.workloadContract, 'screens-v2');
    assert.deepEqual(m.fixture, screenSeed(a.scenarioId));
    assert.deepEqual(m.validation, reference.validation);
    assert.deepEqual(m.outputDigests, Object.fromEntries(Object.entries<any>(reference.outputs).map(([name, x]) => [name, x.digest])));
    assert.equal(r.metrics.row_count, 100000); assert.equal(r.metrics.iterations, 25); assert.equal(r.metrics.warmup_iterations, 5);
    const names = queryNames(a.scenarioId);
    assert.deepEqual(Object.keys(m.samples).sort(), [...names].sort());
    for (const name of names) {
      const samples = m.samples[name];
      assert.equal(samples.length, 25);
      assert(samples.every((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0));
      assert.equal(r.metrics[`${name}_query_p50_ms`], percentile(samples, 50));
      assert.equal(r.metrics[`${name}_query_p95_ms`], percentile(samples, 95));
      assert.equal(r.metrics[`${name}_result_count`], reference.outputs[name].count);
    }
    if (a.stackId.startsWith('syncular')) assert.equal(m.frameworkVersion, '0.17.0');
    record.queryExecution = m.queryExecution;
    record.localStorage = m.diagnostics.localStorage;
    if (kind === 'sql') {
      assert.equal(m.queryExecution, 'native-sql');
      assert.deepEqual(m.diagnostics.queries, screenQueries);
      const captured = m.diagnostics.queryPlans;
      assert.equal(captured.policy, 'screen-indexes-v1');
      assert.deepEqual(captured.declaredTaskIndexes, { bench_tasks_list: ['project_id', 'owner_id', 'completed', 'id'], bench_tasks_project_id: ['project_id', 'id'] });
      assert.deepEqual(Object.keys(captured.plans).sort(), [...names].sort());
      for (const name of names) {
        const details = captured.plans[name].map((row: any) => row.detail);
        assert(details.length > 0 && details.every((x: unknown) => typeof x === 'string'));
        if (name === 'dashboard') continue; // Ordering project aggregates can legitimately require a small sort.
        const index = ['list', 'aggregate'].includes(name) ? 'bench_tasks_list' : 'bench_tasks_project_id';
        assert(details.some((d: string) => new RegExp(`USING (?:COVERING )?INDEX ${index}\\b`, 'i').test(d)));
        if (name !== 'aggregate') assert(!details.some((d: string) => /USE (?:TEMP B-TREE|SORTER) FOR ORDER BY/i.test(d)));
      }
      record.plans = captured.plans;
    } else {
      assert.equal(m.queryExecution, 'mixed-native-and-application');
      assert.equal(m.implementation, 'zero-native-screens-v3');
      assert.equal(m.diagnostics.localStorage, 'zero-memory');
      assert.deepEqual(m.diagnostics.queryExecutionByName, {
        list: 'native filter/order/limit plus projection', search: 'native range/order/limit plus projection',
        aggregate: 'native project filter plus JavaScript grouping/sort', detail_join: 'native relationships/order/limit plus projection',
        dashboard: 'native project filter and relationships plus JavaScript aggregate/sort/limit',
      });
      record.diagnostics = m.diagnostics;
    }
    record.check = 'Canonical fixture/output, samples and reported percentiles verified';
  }
  if (!partial) assert.equal(attempts.length, kind === 'sql' ? 24 : 6);
  sources.push({ kind, campaignId: manifest.id, manifestSha256: sha(bytes), sourceHash: manifest.source.sourceHash,
    status: manifest.status, screenAttempts: attempts.length, referenceSourceBindings: bindings });
}
const report = { reviewedAt: new Date().toISOString(), status: partial ? 'partial-screen-review' : 'complete-screen-review',
  scope: 'Saved screen results checked against the canonical contract. Recorded SQL plans establish observed index access, not optimality or the cause of cross-product timing gaps. Failures remain visible. This does not replace full publication, annotation, packaging or chart review.',
  reviewerSha256: sha(await readFile(import.meta.path)), sources, canonical: Object.fromEntries(expected), results };
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`${report.status}: ${results.length} screen attempts; ${results.filter(r => r.status === 'completed').length} successful outputs verified`);
