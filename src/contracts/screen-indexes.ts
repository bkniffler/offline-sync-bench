import { schema as generatedSchema } from '../../stacks/syncular/syncular-app/src/syncular.generated.ts';
import { queryNames, screenQueries, type Row, type ScreenCase } from './screens.ts';
import type { JsonObject } from '../types.ts';

// Equality prefix supports the list's filter and reverse ID traversal; the same
// prefix covers owner/completion grouping. Project/ID supports prefix search and
// ordered relationship detail. Install before ingest, so writes pay maintenance.
export const taskScreenIndexes = {
  bench_tasks_list: ['project_id', 'owner_id', 'completed', 'id'],
  bench_tasks_project_id: ['project_id', 'id'],
} as const;

// Client-side tuning is explicit; generated server schema remains generated.
export const indexedSyncularSchema = {
  ...generatedSchema,
  tables: generatedSchema.tables.map(table => table.name === 'tasks' ? {
    ...table,
    indexes: [...table.indexes, ...Object.entries(taskScreenIndexes).map(([name, columns]) => ({ name, columns: [...columns], unique: false }))],
  } : table),
};

/** Captured from the actual replica, outside query timing. Never infer use from DDL. */
export async function captureScreenPlans(scenario: ScreenCase, query: (sql: string) => Row[] | Promise<Row[]>): Promise<JsonObject> {
  const plans: JsonObject = {};
  for (const name of queryNames(scenario)) {
    const rows = await query(`EXPLAIN QUERY PLAN ${screenQueries[name]}`);
    if (!rows.length) throw new Error(`Missing query plan for ${name}`);
    const details = rows.map(row => String(row.detail));
    if (['list', 'search', 'detail_join'].includes(name) && details.some(detail => /USE (?:TEMP B-TREE|SORTER) FOR ORDER BY/i.test(detail))) {
      throw new Error(`${name} unexpectedly sorts instead of traversing an ordered index: ${details.join('; ')}`);
    }
    const expectedIndex = ['list', 'aggregate'].includes(name) ? 'bench_tasks_list' : 'bench_tasks_project_id';
    if (['list', 'search', 'aggregate', 'detail_join'].includes(name) && !details.some(detail => /USING (?:COVERING )?INDEX/i.test(detail) && detail.includes(expectedIndex))) {
      throw new Error(`${name} has no indexed access: ${details.join('; ')}`);
    }
    plans[name] = rows as JsonObject[];
  }
  return { policy: 'screen-indexes-v1', declaredTaskIndexes: taskScreenIndexes as unknown as JsonObject, plans };
}
