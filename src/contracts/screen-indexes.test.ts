import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { arrayScreenQuery, assertRows, canonicalData, queryNames, screenQueries, type Row, type ScreenCase } from './screens.ts';
import { captureScreenPlans, taskScreenIndexes } from './screen-indexes.ts';

for (const scenario of ['local-query', 'deep-relationship-query'] as ScreenCase[]) {
  test(`${scenario}: real SQLite plans use tuned indexes and preserve exact outputs`, async () => {
    const db = new Database(':memory:');
    const data = canonicalData(scenario);
    try {
      db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, org_id TEXT, project_id TEXT, owner_id TEXT, title TEXT, completed INTEGER, server_version INTEGER); CREATE TABLE projects(id TEXT PRIMARY KEY, org_id TEXT, name TEXT); CREATE TABLE organizations(id TEXT PRIMARY KEY, name TEXT); CREATE INDEX projects_org ON projects(org_id)');
      for (const [name, columns] of Object.entries(taskScreenIndexes)) db.exec(`CREATE INDEX ${name} ON tasks(${columns.join(',')})`);
      const insert = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)');
      db.transaction(() => {
        for (const row of data.tasks) insert.run(...Object.values(row) as (string | number)[]);
        for (const row of data.projects!) db.run('INSERT INTO projects VALUES (?, ?, ?)', Object.values(row) as string[]);
        for (const row of data.organizations!) db.run('INSERT INTO organizations VALUES (?, ?)', Object.values(row) as string[]);
      })();
      const query = (sql: string) => db.query(sql).all() as Row[];
      const evidence = await captureScreenPlans(scenario, query);
      for (const name of queryNames(scenario)) assertRows(name, query(screenQueries[name]), arrayScreenQuery(name, data));
      const plans = evidence.plans as Record<string, Row[]>;
      if (scenario === 'local-query') {
        expect(JSON.stringify(plans.list)).toContain('bench_tasks_list');
        expect(JSON.stringify(plans.search)).toContain('bench_tasks_project_id');
        expect(JSON.stringify(plans.aggregate)).toContain('COVERING INDEX bench_tasks_list');
        expect(JSON.stringify(plans.aggregate)).not.toContain('TEMP B-TREE');
      }
      if (scenario === 'local-query') {
        const missing = new Database(':memory:');
        try {
          missing.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, owner_id TEXT, title TEXT, completed INTEGER)');
          await expect(captureScreenPlans(scenario, sql => missing.query(sql).all() as Row[])).rejects.toThrow();
        } finally { missing.close(); }
      }
    } finally { db.close(); }
  });
}
