/** Controlled SQLite reduction, separate from product measurements.
 * Run only with publication timing stopped (after collection or a verified between-trial pause): bun scripts/diagnose-screen-index-effect.ts OUTPUT_DIR
 */
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { canonicalData, arrayScreenQuery, assertRows, hash, queryNames, screenQueries,
  screenWarmup, screenIterations, type Row } from '../src/contracts/screens.ts';
import { taskScreenIndexes, captureScreenPlans } from '../src/contracts/screen-indexes.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const scope = 'Controlled reduction using Bun SQLite in memory and the canonical 100,000-task local-screen fixture. Only the two tuned indexes differ. Both conditions retain the original project/completion/time and owner indexes. updated_at_ms is fixed at zero; it is not a screen input. This measures synchronous SQL reads and row materialization, excluding Syncular APIs, replication, setup, index construction and validation. It does not isolate the SDK upgrade, explain other engines, or reproduce an archived product trial.';

if (process.argv[2] === '--worker') {
  const condition = process.argv[3];
  assert(condition === 'original-indexes' || condition === 'tuned-indexes');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, org_id TEXT, project_id TEXT, owner_id TEXT, title TEXT, completed INTEGER, server_version INTEGER, updated_at_ms INTEGER); CREATE INDEX idx_tasks_project_completed ON tasks(project_id, completed, updated_at_ms); CREATE INDEX idx_tasks_owner ON tasks(owner_id)');
    if (condition === 'tuned-indexes') for (const [name, columns] of Object.entries(taskScreenIndexes)) {
      db.exec(`CREATE INDEX ${name} ON tasks(${columns.join(',')})`);
    }
    const data = canonicalData('local-query');
    const expected = Object.fromEntries(queryNames('local-query').map(name => [name, arrayScreenQuery(name, data)]));
    const fixtureDigest = hash(data.tasks);
    const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
    db.transaction(() => {
      for (const row of data.tasks) insert.run(row.id, row.org_id, row.project_id, row.owner_id, row.title, row.completed, row.server_version);
    })();
    const actual = db.query('SELECT id, org_id, project_id, owner_id, title, completed, server_version FROM tasks ORDER BY id').all() as Row[];
    assertRows('complete fixture', actual, data.tasks);
    actual.length = 0; data.tasks.length = 0;
    const plans = Object.fromEntries(queryNames('local-query').map(name => [name, db.query(`EXPLAIN QUERY PLAN ${screenQueries[name]}`).all()]));
    if (condition === 'tuned-indexes') await captureScreenPlans('local-query', sql => db.query(sql).all() as Row[]);
    Bun.gc(true);
    const samples: Record<string, number[]> = {}, outputDigests: Record<string, string> = {};
    for (const name of queryNames('local-query')) {
      samples[name] = [];
      for (let i = -screenWarmup; i < screenIterations; i++) {
        const start = performance.now();
        const rows = db.query(screenQueries[name]).all() as Row[];
        const ms = performance.now() - start;
        outputDigests[name] = assertRows(name, rows, expected[name]);
        if (i >= 0) samples[name].push(ms);
      }
    }
    console.log(JSON.stringify({ condition, pid: process.pid, fixtureDigest, outputDigests, plans, samples,
      operationP50Ms: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values)])),
      sqliteVersion: db.query('SELECT sqlite_version() AS version').get(), compileOptions: db.query('PRAGMA compile_options').all() }));
  } finally { db.close(); }
} else {
  const output = resolve(process.argv[2] ?? ''); assert(process.argv[2], 'Supply a new output directory');
  await mkdir(output); // Refuse overwrite or implicit retry.
  const inputPaths = ['scripts/diagnose-screen-index-effect.ts', 'src/contracts/screens.ts', 'src/contracts/task-record.ts',
    'src/contracts/screen-indexes.ts', 'stacks/syncular/syncular-app/src/syncular.generated.ts'];
  const inputs = [];
  await mkdir(join(output, 'inputs'));
  for (const [i, path] of inputPaths.entries()) {
    const bytes = await readFile(path), copy = `inputs/${i}.txt`;
    await writeFile(join(output, copy), bytes); inputs.push({ path, copy, sha256: sha(bytes) });
  }
  let seed = 0x1701;
  const plan = Array.from({ length: 3 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const conditions = ['original-indexes', 'tuned-indexes'];
    if (seed & 0x80000000) conditions.reverse();
    return conditions.map(condition => ({ trial: i + 1, condition }));
  }).flat();
  await writeFile(join(output, 'PLAN.json'), JSON.stringify({ scope, seed: 0x1701, plan, inputs,
    stoppingRule: 'Exactly three attempts per condition in fresh sequential processes; failures retained without replacement.',
    timing: { warmups: screenWarmup, operations: screenIterations, clock: 'process monotonic performance.now' },
    machine: { cpu: cpus()[0]?.model, platform: platform(), arch: arch(), bunVersion: Bun.version },
    executable: { path: process.execPath, sha256: sha(await readFile(process.execPath)) } }, null, 2) + '\n');
  const attempts = [];
  for (const [index, entry] of plan.entries()) {
    for (const input of inputs) assert.equal(sha(await readFile(input.path)), input.sha256, 'Diagnostic inputs changed');
    const start = new Date().toISOString();
    const child = Bun.spawn([process.execPath, import.meta.path, '--worker', entry.condition], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    let result = null, error = null;
    try { assert.equal(exitCode, 0); result = JSON.parse(stdout); assert.equal(result.condition, entry.condition); }
    catch (e) { error = String(e); }
    const attempt = { ...entry, start, finishedAt: new Date().toISOString(), exitCode, error, stdout, stderr, result };
    attempts.push(attempt);
    await writeFile(join(output, `${index + 1}.json`), JSON.stringify(attempt, null, 2) + '\n');
  }
  for (const input of inputs) assert.equal(sha(await readFile(input.path)), input.sha256, 'Diagnostic inputs changed');
  const passed = attempts.filter(a => a.result);
  for (const a of passed) {
    assert.equal(a.result.fixtureDigest, passed[0].result.fixtureDigest);
    assert.deepEqual(a.result.outputDigests, passed[0].result.outputDigests);
    assert.deepEqual(a.result.sqliteVersion, passed[0].result.sqliteVersion);
    assert.deepEqual(a.result.compileOptions, passed[0].result.compileOptions);
  }
  await writeFile(join(output, 'RESULTS.json'), JSON.stringify({ scope, attempts, complete: true,
    successfulAttempts: passed.length, interpretation: 'Compare the three per-condition operation-p50 values with observed ranges only. No confidence interval; no product ranking or SDK upgrade attribution.' }, null, 2) + '\n');
  if (passed.length !== plan.length) process.exitCode = 1;
}
