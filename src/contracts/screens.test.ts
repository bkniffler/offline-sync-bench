import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { arrayScreenQuery, assertRows, canonicalData, ContractError, measureScreens, queryNames, screenQueries, validateScreenData, waitForScreenFixture, type ScreenCase } from './screens.ts';

for (const scenario of ['local-query', 'deep-relationship-query'] as ScreenCase[]) {
  test(`${scenario}: SQL and application queries return the exact canonical outputs`, async () => {
    const data = canonicalData(scenario);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, org_id TEXT, project_id TEXT, owner_id TEXT, title TEXT, completed INTEGER, server_version INTEGER); CREATE TABLE projects(id TEXT, org_id TEXT, name TEXT); CREATE TABLE organizations(id TEXT, name TEXT)');
    const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (const row of data.tasks) insert.run(...Object.values(row) as (string | number)[]);
      for (const row of data.projects!) db.run('INSERT INTO projects VALUES (?, ?, ?)', Object.values(row) as string[]);
      for (const row of data.organizations!) db.run('INSERT INTO organizations VALUES (?, ?)', Object.values(row) as string[]);
    })();
    try {
      for (const name of queryNames(scenario)) {
        assertRows(name, db.query(screenQueries[name]).all() as Record<string, unknown>[], arrayScreenQuery(name, data));
      }
      const result = await measureScreens(scenario, { execution: 'native-sql', readData: () => data, query: name => db.query(screenQueries[name]).all() as Record<string, unknown>[] });
      expect(result.metrics.row_count).toBe(100_000);
      expect(result.metrics.iterations).toBe(25);
      expect(result.metadata.samples).toBeDefined();
      for (const samples of Object.values(result.metadata.samples as Record<string, number[]>)) expect(samples).toHaveLength(25);
    } finally { db.close(); }
  });
}

test('rejects the historical 10k workload and a missing project subscription', () => {
  const data = canonicalData('local-query');
  data.tasks = data.tasks.slice(0, 10_000);
  expect(() => validateScreenData('local-query', data)).toThrow('expected 100000 rows, got 10000');
  const deep = canonicalData('deep-relationship-query');
  deep.tasks = deep.tasks.filter(row => row.project_id !== 'org-1-project-4');
  expect(() => validateScreenData('deep-relationship-query', deep)).toThrow('expected 100000 rows, got 75000');
});

test('rejects substituted rows and corrupted values despite correct totals', () => {
  const data = canonicalData('local-query');
  data.tasks[999].title = 'incorrect title';
  expect(() => validateScreenData('local-query', data)).toThrow(ContractError);
  data.tasks[999] = { ...data.tasks[998] };
  expect(() => validateScreenData('local-query', data)).toThrow(ContractError);
});

test('rejects different list limits, ordering, aggregate values, and missing related tables', () => {
  expect(() => assertRows('list', [{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toThrow(ContractError);
  expect(() => assertRows('list', [{ id: 'b' }, { id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toThrow(ContractError);
  expect(() => assertRows('aggregate', [{ count: 5 }], [{ count: 6 }])).toThrow(ContractError);
  const data = canonicalData('deep-relationship-query');
  data.projects!.pop();
  expect(() => validateScreenData('deep-relationship-query', data)).toThrow('projects: expected 4 rows, got 3');
});


test('fixture readiness waits for replacement data despite equal row counts', async () => {
  const old = canonicalData('deep-relationship-query');
  const current = canonicalData('local-query');
  let reads = 0;
  const result = await waitForScreenFixture('local-query', async () => ++reads === 1 ? old : current, { pollMs: 0 });
  expect(reads).toBe(2);
  expect(result.firstMismatch).toContain('owner_id');
  expect(result.validation).toEqual(validateScreenData('local-query', current));
});

test('fixture readiness times out on stale data and preserves read failures', async () => {
  const stale = canonicalData('deep-relationship-query');
  await expect(waitForScreenFixture('local-query', async () => stale, { timeoutMs: 0 })).rejects.toThrow('Timed out preparing local-query fixture');
  const failure = new Error('SQLite unavailable');
  await expect(waitForScreenFixture('local-query', async () => { throw failure; })).rejects.toBe(failure);
});
