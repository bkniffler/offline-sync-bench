import type { TaskRow } from './app.ts';

// Browser-safe copies of the shared list screen (contracts/screens.ts pulls in
// Node modules). responsiveness.test.ts keeps them identical to the contract.
export const screenProjectId = 'org-1-project-1';
export const screenOwnerId = 'org-1-user-2';
export const LIST_SQL = `SELECT id, title, completed FROM tasks WHERE project_id = '${screenProjectId}' AND owner_id = '${screenOwnerId}' AND completed = 0 ORDER BY id DESC LIMIT 50`;
// The same client indexes as contracts/screen-indexes.ts and
// adapters/powersync-runner.ts (checked by test).
export const taskScreenIndexes = { bench_tasks_list: ['project_id', 'owner_id', 'completed', 'id'], bench_tasks_project_id: ['project_id', 'id'] } as const;
export const powerSyncScreenIndexes = [
  "CREATE INDEX IF NOT EXISTS bench_tasks_list ON ps_data__tasks(CAST(json_extract(data, '$.project_id') AS TEXT), CAST(json_extract(data, '$.owner_id') AS TEXT), CAST(json_extract(data, '$.completed') AS INTEGER), id)",
  "CREATE INDEX IF NOT EXISTS bench_tasks_project_id ON ps_data__tasks(CAST(json_extract(data, '$.project_id') AS TEXT), id)",
];

export function progressQuery(prefix: string | null): [string, Array<string | number>] {
  return prefix
    ? ['SELECT count(*) AS n, coalesce(sum(substr(title, 1, ?) = ?), 0) AS updated FROM tasks', [prefix.length, prefix]]
    : ['SELECT count(*) AS n, 0 AS updated FROM tasks', []];
}

/** Application-side list screen for SDKs that expose rows, not queries. */
export function arrayScreen(rows: Iterable<Record<string, unknown>>): TaskRow[] {
  const matches: TaskRow[] = [];
  for (const row of rows) if (row.project_id === screenProjectId && row.owner_id === screenOwnerId && !row.completed) matches.push({ id: String(row.id), title: String(row.title), completed: 0 });
  return matches.sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0).slice(0, 50);
}

export function countUpdated(rows: Iterable<Record<string, unknown>>, prefix: string | null): number {
  if (!prefix) return 0;
  let updated = 0;
  for (const row of rows) if (String(row.title).startsWith(prefix)) updated++;
  return updated;
}

export const toTask = (row: Record<string, unknown>): TaskRow => ({ id: String(row.id), title: String(row.title), completed: Number(Boolean(row.completed)) });
