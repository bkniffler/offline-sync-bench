import { ExternalResources } from '../resources.ts';
import { createHash } from 'node:crypto';
import { percentile } from '../metrics.ts';
import type { JsonObject, JsonValue, SeedOptions } from '../types.ts';
import { ContractError, taskRecord, type Row } from './task-record.ts';
export { ContractError, taskRecord, type Row } from './task-record.ts';

export type ScreenCase = 'local-query' | 'deep-relationship-query';
export type ScreenQuery = 'list' | 'search' | 'aggregate' | 'dashboard' | 'detail_join';
export interface ScreenData { tasks: Row[]; projects?: Row[]; organizations?: Row[] }
export const SCREEN_CONTRACT = 'screens-v2';
export const screenOrgId = 'org-1';
export const screenProjectId = 'org-1-project-1';
export const screenOwnerId = 'org-1-user-2';
export const screenWarmup = 5;
export const screenIterations = 25;

export function screenSeed(scenario: ScreenCase): Required<SeedOptions> {
  return {
    resetFirst: true, orgCount: 1,
    projectsPerOrg: scenario === 'local-query' ? 1 : 4,
    usersPerOrg: scenario === 'local-query' ? 2 : 10,
    tasksPerProject: scenario === 'local-query' ? 100_000 : 25_000,
    membershipsPerProject: scenario === 'local-query' ? 2 : 4,
  };
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function canonicalTasks(scenario: ScreenCase): Row[] { return fixtureTasks(screenSeed(scenario)); }
export function fixtureTask(seed: SeedOptions, projectIndex: number, taskIndex: number): Row {
  const projectId = `${screenOrgId}-project-${projectIndex + 1}`;
  return {
    id: `${projectId}-task-${String(taskIndex + 1).padStart(6, '0')}`,
    org_id: screenOrgId, project_id: projectId,
    owner_id: `${screenOrgId}-user-${taskIndex % seed.membershipsPerProject + 1}`,
    title: `Task ${taskIndex + 1} in ${projectId}`, completed: Number(taskIndex % 3 === 0), server_version: 1,
  };
}
export function fixtureTasks(seed: SeedOptions): Row[] {
  return Array.from({ length: seed.projectsPerOrg }, (_, p) =>
    Array.from({ length: seed.tasksPerProject }, (_, i) => fixtureTask(seed, p, i))).flat();
}
export function canonicalData(scenario: ScreenCase): ScreenData {
  return {
    tasks: canonicalTasks(scenario),
    projects: Array.from({ length: screenSeed(scenario).projectsPerOrg }, (_, p) => ({
      id: `${screenOrgId}-project-${p + 1}`, org_id: screenOrgId, name: `Project ${p + 1}`,
    })),
    organizations: [{ id: screenOrgId, name: 'Organization 1' }],
  };
}

function ordered(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => compare(String(a.id), String(b.id)));
}
export function assertRows(label: string, actual: Row[], expected: Row[]): string {
  if (actual.length !== expected.length) throw new ContractError(`${label}: expected ${expected.length} rows, got ${actual.length}`);
  for (let i = 0; i < expected.length; i++) {
    const keys = Object.keys(expected[i]).sort();
    if (keys.length !== Object.keys(actual[i]).length || keys.some(k => actual[i][k] !== expected[i][k])) {
      throw new ContractError(`${label} row ${i}: expected ${JSON.stringify(expected[i])}, got ${JSON.stringify(actual[i])}`);
    }
  }
  return hash(actual.map(row => Object.fromEntries(Object.entries(row).sort(([a], [b]) => compare(a, b)))));
}

export function validateScreenData(scenario: ScreenCase, data: ScreenData): JsonObject {
  const expected = canonicalData(scenario);
  const tasksDigest = assertRows('tasks', ordered(data.tasks.map(taskRecord)), ordered(expected.tasks));
  const evidence: JsonObject = { contract: SCREEN_CONTRACT, taskCount: data.tasks.length, tasksDigest };
  if (scenario === 'deep-relationship-query') {
    evidence.projectsDigest = assertRows('projects', ordered((data.projects ?? []).map(r => ({ id: r.id, org_id: r.org_id ?? r.orgId, name: r.name }))), ordered(expected.projects!));
    evidence.organizationsDigest = assertRows('organizations', ordered((data.organizations ?? []).map(r => ({ id: r.id, name: r.name }))), expected.organizations!);
    evidence.projectCount = data.projects!.length;
    evidence.organizationCount = data.organizations!.length;
  }
  return evidence;
}

/** Fixture preparation only: a previous fixture can have the same row count. */
export async function waitForScreenFixture(
  scenario: ScreenCase,
  readData: () => Promise<ScreenData>,
  { timeoutMs = 120_000, pollMs = 250 } = {},
): Promise<JsonObject> {
  const started = performance.now();
  let checks = 0, firstMismatch: string | null = null, lastMismatch: string | null = null;
  do {
    const data = await readData();
    checks++;
    try {
      const validation = validateScreenData(scenario, data);
      return { checks, elapsedMs: performance.now() - started, timeoutMs, pollMs, firstMismatch, lastMismatch, validation };
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      lastMismatch = error.message;
      firstMismatch ??= lastMismatch;
    }
    if (performance.now() - started >= timeoutMs) break;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  } while (performance.now() - started < timeoutMs);
  throw new Error(`Timed out preparing ${scenario} fixture after ${checks} checks: ${lastMismatch}`);
}

export const screenQueries: Record<ScreenQuery, string> = {
  list: `SELECT id, title, completed FROM tasks WHERE project_id = '${screenProjectId}' AND owner_id = '${screenOwnerId}' AND completed = 0 ORDER BY id DESC LIMIT 50`,
  search: `SELECT id, title FROM tasks WHERE project_id = '${screenProjectId}' AND id >= '${screenProjectId}-task-00' AND id < '${screenProjectId}-task-01' ORDER BY id LIMIT 100`,
  aggregate: `SELECT owner_id, completed, count(*) AS task_count FROM tasks WHERE project_id = '${screenProjectId}' GROUP BY owner_id, completed ORDER BY owner_id, completed`,
  dashboard: `SELECT o.name AS org_name, p.id AS project_id, p.name AS project_name, coalesce(c.task_count, 0) AS task_count, coalesce(c.completed_task_count, 0) AS completed_task_count, coalesce(c.open_task_count, 0) AS open_task_count FROM organizations o JOIN projects p ON p.org_id = o.id LEFT JOIN (SELECT project_id, count(*) AS task_count, sum(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completed_task_count, sum(CASE WHEN completed = 0 THEN 1 ELSE 0 END) AS open_task_count FROM tasks GROUP BY project_id) c ON c.project_id = p.id WHERE o.id = '${screenOrgId}' ORDER BY open_task_count DESC, p.id LIMIT 20`,
  detail_join: `SELECT t.id, t.title, p.name AS project_name, o.name AS org_name FROM tasks t JOIN projects p ON p.id = t.project_id JOIN organizations o ON o.id = p.org_id WHERE t.project_id = '${screenProjectId}' ORDER BY t.id LIMIT 100`,
};
export function queryNames(scenario: ScreenCase): ScreenQuery[] {
  return scenario === 'local-query' ? ['list', 'search', 'aggregate'] : ['dashboard', 'detail_join'];
}

/** Application-side query path. Used only by adapters explicitly labelled as such. */
export function arrayScreenQuery(name: ScreenQuery, data: ScreenData): Row[] {
  const tasks = data.tasks;
  if (name === 'list') return tasks.filter(r => r.project_id === screenProjectId && r.owner_id === screenOwnerId && !r.completed)
    .sort((a, b) => compare(String(b.id), String(a.id))).slice(0, 50).map(r => ({ id: r.id, title: r.title, completed: Number(r.completed) }));
  if (name === 'search') return tasks.filter(r => r.project_id === screenProjectId && String(r.id).startsWith(`${screenProjectId}-task-00`))
    .sort((a, b) => compare(String(a.id), String(b.id))).slice(0, 100).map(r => ({ id: r.id, title: r.title }));
  if (name === 'aggregate') {
    const groups = new Map<string, Row>();
    for (const r of tasks) {
      if (r.project_id !== screenProjectId) continue;
      const key = `${r.owner_id}:${Number(r.completed)}`;
      const group = groups.get(key) ?? { owner_id: r.owner_id, completed: Number(r.completed), task_count: 0 };
      group.task_count = Number(group.task_count) + 1; groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => compare(String(a.owner_id), String(b.owner_id)) || Number(a.completed) - Number(b.completed));
  }
  const organizations = data.organizations ?? [];
  const projects = data.projects ?? [];
  if (name === 'dashboard') return projects.filter(p => p.org_id === screenOrgId).map(p => {
    const rows = tasks.filter(t => t.project_id === p.id);
    const completed = rows.filter(t => Boolean(t.completed)).length;
    return { org_name: organizations.find(o => o.id === p.org_id)?.name, project_id: p.id, project_name: p.name, task_count: rows.length, completed_task_count: completed, open_task_count: rows.length - completed };
  }).sort((a, b) => b.open_task_count - a.open_task_count || compare(String(a.project_id), String(b.project_id))).slice(0, 20);
  const project = projects.find(p => p.id === screenProjectId);
  const org = organizations.find(o => o.id === project?.org_id);
  if (!project || !org) return [];
  return tasks.filter(t => t.project_id === screenProjectId).sort((a, b) => compare(String(a.id), String(b.id))).slice(0, 100)
    .map(t => ({ id: t.id, title: t.title, project_name: project.name, org_name: org.name }));
}

export interface ScreenDriver {
  readData(): Promise<ScreenData> | ScreenData;
  query(name: ScreenQuery): Promise<Row[]> | Row[];
  /** Native child drivers measure inside the child and return the actual result for validation. */
  timedQuery?(name: ScreenQuery): Promise<{ elapsedMs: number; rows: Row[] }>;
  execution: 'native-sql' | 'native-reactive-query' | 'application-processing' | 'mixed-native-and-application';
  diagnostics?: JsonObject;
  normalizeResult?(rows: Row[]): Row[];
}

export async function measureScreens(scenario: ScreenCase, driver: ScreenDriver): Promise<{
  metrics: Record<string, number>; metadata: JsonObject; notes: string[];
}> {
  const validation = validateScreenData(scenario, await driver.readData());
  const reference = canonicalData(scenario);
  const expected = Object.fromEntries(queryNames(scenario).map(name => [name, arrayScreenQuery(name, reference)]));
  // Release the reference corpus before timing; retain only the small expected screen outputs.
  reference.tasks.length = 0;
  const samples: Record<string, number[]> = {};
  const outputs: JsonObject = {};
  const metrics: Record<string, number> = { row_count: Number(validation.taskCount), iterations: screenIterations, warmup_iterations: screenWarmup };
  if (scenario === 'deep-relationship-query') { metrics.project_count = Number(validation.projectCount); metrics.org_count = Number(validation.organizationCount); }
  const resources = new ExternalResources();
  await resources.start();
  try {
  for (const name of queryNames(scenario)) {
    samples[name] = [];
    for (let iteration = -screenWarmup; iteration < screenIterations; iteration++) {
      let rows: Row[]; let elapsedMs: number;
      if (driver.timedQuery) ({ rows, elapsedMs } = await driver.timedQuery(name));
      else { const started = performance.now(); rows = await driver.query(name); elapsedMs = performance.now() - started; }
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new ContractError(`${name}: invalid duration`);
      // Validation and hashing are excluded from the timed operation.
      outputs[name] = assertRows(name, driver.normalizeResult ? driver.normalizeResult(rows) : rows, expected[name]);
      if (iteration >= 0) samples[name].push(elapsedMs);
    }
    metrics[`${name}_query_p50_ms`] = percentile(samples[name], 50);
    metrics[`${name}_query_p95_ms`] = percentile(samples[name], 95);
    metrics[`${name}_result_count`] = expected[name].length;
  }
  const usage = await resources.stop();
  return {
    metrics: { ...metrics, ...usage.metrics },
    metadata: { resources: usage.metadata, workloadContract: SCREEN_CONTRACT, fixture: screenSeed(scenario) as unknown as JsonValue, validation, outputDigests: outputs, samples, queryExecution: driver.execution, diagnostics: driver.diagnostics ?? {} },
    notes: ['Shared screens-v2 contract: 100,000 validated tasks, exact screen outputs, five warmups and 25 measured operations. List ordering uses descending task ID; timestamps are not part of this screen contract.'],
  };
  } finally { resources.abort(); }
}
