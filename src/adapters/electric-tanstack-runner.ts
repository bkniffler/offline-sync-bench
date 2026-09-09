import { getClientStack } from '../stacks.ts';
import { measureCollaboration, collaborationSeed, pollUntil } from '../contracts/collaboration.ts';
import { measureScreens, screenSeed, screenProjectId, screenOwnerId, screenOrgId, type ScreenCase } from '../contracts/screens.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  BasicIndex,
  caseWhen,
  count,
  createCollection,
  eq,
  like,
  queryOnce,
  sum,
  type Collection,
} from '@tanstack/db';
import {
  electricCollectionOptions,
  type ElectricCollectionConfig,
  type ElectricCollectionUtils,
} from '@tanstack/electric-db-collection';
import {
  createNodeSQLitePersistence,
  persistedCollectionOptions,
} from '@tanstack/node-db-sqlite-persistence';
import { createHttpMeter } from '../http-meter.ts';
import {
  average,
  CpuSampler,
  MemorySampler,
  percentile,
  round,
} from '../metrics.ts';
import { tempRoot } from '../paths.ts';

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface RunnerResult {
  status: 'completed';
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: boolean;
  server_version: number;
  updated_at: string;
}

interface OrganizationRow extends Record<string, unknown> {
  id: string;
  name: string;
}

interface ProjectRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  name: string;
}

interface StackFixtures {
  sampleProjectId: string | null;
  sampleProjectIds: string[];
  sampleOrgId: string | null;
  sampleUserIds: string[];
  sampleTaskId: string | null;
}

interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
}



interface OnlineSample {
  iteration: number;
  writeAckMs: number;
  mirrorVisibleMs: number;
}

type TableCollection<T extends Record<string, unknown>> = Collection<
  T,
  string | number,
  ElectricCollectionUtils<T>,
  never,
  T
>;

type SQLiteDatabase = InstanceType<typeof Database>;
type SQLitePersistence = ReturnType<typeof createNodeSQLitePersistence>;

interface TaskSession {
  database: SQLiteDatabase;
  dir: string;
  tasks: TableCollection<TaskRow>;
  close(): Promise<void>;
}

interface RelationshipSession extends TaskSession {
  organizations: TableCollection<OrganizationRow>;
  projects: TableCollection<ProjectRow>;
}

const stack = getClientStack('electric-tanstack');
const ADMIN_BASE_URL = stack.adminBaseUrl;
const SYNC_BASE_URL = stack.syncBaseUrl;
const APP_BASE_URL = stack.appBaseUrl!;
const ELECTRIC_SHAPE_URL = `${SYNC_BASE_URL}/v1/shape`;
const installedPackage = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')));
const PRODUCT_VERSIONS = { electricClient: installedPackage.dependencies['@electric-sql/client'], tanstackDb: installedPackage.dependencies['@tanstack/db'],
  electricCollection: installedPackage.dependencies['@tanstack/electric-db-collection'], sqlitePersistence: installedPackage.dependencies['@tanstack/node-db-sqlite-persistence'] };

const scenario = process.argv[2];
const supportedScenarios = new Set([
  'online-propagation',
  'local-query',
  'deep-relationship-query',
]);

if (!scenario || !supportedScenarios.has(scenario)) {
  throw new Error(
    'Expected scenario argument: online-propagation | local-query | deep-relationship-query'
  );
}

function createElectricTableCollection<T extends Record<string, unknown>>(args: {
  id: string;
  table: string;
  persistence: SQLitePersistence;
  fetchImpl: typeof fetch;
  shapeUrl?: string;
  params?: Record<string, string>;
  onUpdate?: ElectricCollectionConfig<T>['onUpdate'];
}): TableCollection<T> {
  return createCollection<
    T,
    string | number,
    ElectricCollectionUtils<T>
  >(
    persistedCollectionOptions<
      T,
      string | number,
      never,
      ElectricCollectionUtils<T>
    >({
      ...electricCollectionOptions<T>({
        id: args.id,
        shapeOptions: {
          url: args.shapeUrl ?? ELECTRIC_SHAPE_URL,
          params: {
            table: args.table,
            ...args.params,
          },
          fetchClient: args.fetchImpl,
          parser: {
            int8: (value) => Number(value),
          },
        },
        getKey: (row) => String(row.id),
        ...(args.onUpdate ? { onUpdate: args.onUpdate } : {}),
      }),
      persistence: args.persistence,
      schemaVersion: 1,
    })
  );
}

async function createTaskSession(args: {
  name: string;
  fetchImpl: typeof fetch;
  actorId?: string;
}): Promise<TaskSession> {
  const context = await createDatabaseContext(args.name);
  const tasks = createElectricTableCollection<TaskRow>({
    id: `${args.name}-tasks`,
    table: 'tasks',
    persistence: context.persistence,
    fetchImpl: args.fetchImpl,
    ...(args.actorId
      ? {
          shapeUrl: `${APP_BASE_URL}/benchmark/shape/tasks`,
          params: { userId: args.actorId },
        }
      : {}),
    onUpdate: async ({ transaction }) => {
      const txid = await postTaskUpdates(
        transaction.mutations.map((mutation) => {
          const modified = mutation.modified as TaskRow;
          return {
            taskId: String(mutation.key),
            title: modified.title,
            completed: modified.completed,
          };
        }),
        randomUUID(),
        args.fetchImpl
      );
      return { txid, timeout: 60_000 };
    },
  });

  return {
    ...context,
    tasks,
    close: () => closeDatabaseContext(context, [tasks]),
  };
}

async function createRelationshipSession(args: {
  name: string;
  fetchImpl: typeof fetch;
}): Promise<RelationshipSession> {
  const context = await createDatabaseContext(args.name);
  const tasks = createElectricTableCollection<TaskRow>({
    id: `${args.name}-tasks`,
    table: 'tasks',
    persistence: context.persistence,
    fetchImpl: args.fetchImpl,
  });
  const projects = createElectricTableCollection<ProjectRow>({
    id: `${args.name}-projects`,
    table: 'projects',
    persistence: context.persistence,
    fetchImpl: args.fetchImpl,
  });
  const organizations = createElectricTableCollection<OrganizationRow>({
    id: `${args.name}-organizations`,
    table: 'organizations',
    persistence: context.persistence,
    fetchImpl: args.fetchImpl,
  });

  return {
    ...context,
    tasks,
    projects,
    organizations,
    close: () =>
      closeDatabaseContext(context, [tasks, projects, organizations]),
  };
}

async function createDatabaseContext(name: string): Promise<{
  database: SQLiteDatabase;
  persistence: SQLitePersistence;
  dir: string;
}> {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `electric-tanstack-${name}-`));
  const database = new Database(join(dir, 'tanstack.sqlite'));
  const persistence = createNodeSQLitePersistence({ database });
  return { database, persistence, dir };
}

async function closeDatabaseContext(
  context: { database: SQLiteDatabase; dir: string },
  collections: Array<{ cleanup(): Promise<void> }>
): Promise<void> {
  await Promise.all(
    collections.map((collection) => collection.cleanup().catch(() => undefined))
  );
  await sleep(100);
  if (context.database.open) context.database.close();
  await rm(context.dir, { recursive: true, force: true });
}

const acceptedWrites = new Map<string, () => void>();

async function postTaskUpdates(
  updates: Array<{
    taskId: string;
    title?: string;
    completed?: boolean;
  }>,
  idempotencyKey: string,
  fetchImpl: typeof fetch
): Promise<number> {
  const response = await fetchImpl(`${APP_BASE_URL}/benchmark/tasks/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ updates }),
  });
  if (!response.ok) {
    throw new Error(
      `TanStack mutation backend failed: ${response.status} ${await response.text()}`
    );
  }
  const body = (await response.json()) as { txid?: number };
  if (!Number.isFinite(body.txid)) {
    throw new Error('TanStack mutation backend did not return a txid');
  }
  for (const update of updates) if (update.title) acceptedWrites.get(update.title)?.();
  return Number(body.txid);
}

async function seedStack(options: {
  resetFirst: boolean;
  orgCount: number;
  projectsPerOrg: number;
  usersPerOrg: number;
  tasksPerProject: number;
  membershipsPerProject: number;
}): Promise<void> {
  await fetchJson(`${ADMIN_BASE_URL}/admin/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options),
  });
}

async function getFixtures(): Promise<StackFixtures> {
  return fetchJson<StackFixtures>(`${ADMIN_BASE_URL}/admin/fixtures`);
}

async function listTasks(args: {
  projectId: string;
  limit: number;
}): Promise<TaskRecord[]> {
  const url = new URL('/admin/tasks', ADMIN_BASE_URL);
  url.searchParams.set('projectId', args.projectId);
  url.searchParams.set('limit', String(args.limit));
  const result = await fetchJson<{
    tasks: Array<{ id: string; projectId: string; title: string }>;
  }>(url.toString());
  return result.tasks;
}

async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function waitForTaskTitle(
  collection: TableCollection<TaskRow>,
  taskId: string,
  expectedTitle: string,
  timeoutMs = 60_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collection.get(taskId)?.title === expectedTitle) return;
    await sleep(5);
  }
  throw new Error(`Task ${taskId} did not converge to ${expectedTitle}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function productMetadata(): { [key: string]: JsonValue } {
  return { ...PRODUCT_VERSIONS };
}

async function runOnlinePropagation(): Promise<RunnerResult> {
  await seedStack(collaborationSeed);
  const fixtures = await getFixtures();
  if (!fixtures.sampleTaskId) throw new Error('TanStack task fixture missing');
  const taskId = fixtures.sampleTaskId;
  const writer = await createTaskSession({ name: `writer-${randomUUID()}`, fetchImpl: fetch });
  const reader = await createTaskSession({ name: `reader-${randomUUID()}`, fetchImpl: fetch });
  try {
    await Promise.all([writer.tasks.preload(), reader.tasks.preload()]);
    const result = await measureCollaboration({
      readData: () => reader.tasks.toArray,
      localCommit: false,
      write: async (title, milestones) => {
        acceptedWrites.set(title, () => milestones.serverAccepted());
        try { const transaction = writer.tasks.update(taskId, draft => { draft.title = title; }); await transaction.isPersisted.promise; }
        finally { acceptedWrites.delete(title); }
      },
      observe: (title, signal) => pollUntil(() => reader.tasks.get(taskId)?.title === title, signal),
      diagnostics: { localCommit: 'not exposed separately; optimistic collection update is not labelled as durable local commit', serverAccepted: 'backend transaction response before stream reconciliation', reader: 'live Electric collection, 1ms local polling', localStorage: 'tanstack-sqlite-persistence' },
    });
    return { status: 'completed', ...result, metadata: { ...productMetadata(), ...result.metadata, implementation: 'electric-tanstack-collaboration-v2' } };
  } finally { acceptedWrites.clear(); await writer.close(); await reader.close(); }
}

async function runLocalQuery(): Promise<RunnerResult> { return runScreens('local-query'); }
async function runDeepRelationshipQuery(): Promise<RunnerResult> { return runScreens('deep-relationship-query'); }
async function runScreens(scenario: ScreenCase): Promise<RunnerResult> {
  await seedStack(screenSeed(scenario));
  const session = scenario === 'local-query'
    ? await createTaskSession({ name: `screens-${randomUUID()}`, fetchImpl: fetch })
    : await createRelationshipSession({ name: `screens-${randomUUID()}`, fetchImpl: fetch });
  const related = 'projects' in session ? session as RelationshipSession : null;
  try {
    await session.tasks.preload();
    if (related) await Promise.all([related.projects.preload(), related.organizations.preload()]);
    session.tasks.createIndex(task => task.project_id, { indexType: BasicIndex });
    session.tasks.createIndex(task => task.owner_id, { indexType: BasicIndex });
    session.tasks.createIndex(task => task.completed, { indexType: BasicIndex });
    session.tasks.createIndex(task => task.id, { indexType: BasicIndex });
    if (related) {
      related.projects.createIndex(project => project.id, { indexType: BasicIndex });
      related.projects.createIndex(project => project.org_id, { indexType: BasicIndex });
      related.organizations.createIndex(org => org.id, { indexType: BasicIndex });
    }
    const result = await measureScreens(scenario, {
      execution: 'native-reactive-query',
      normalizeResult: rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['$synced', '$origin', '$key', '$collectionId'].includes(key)))),
      readData: () => ({ tasks: session.tasks.toArray, projects: related?.projects.toArray, organizations: related?.organizations.toArray }),
      query: async name => {
        if (name === 'list') return (await queryOnce(q => q.from({ task: session.tasks })
          .where(({ task }) => eq(task.project_id, screenProjectId))
          .where(({ task }) => eq(task.owner_id, screenOwnerId))
          .where(({ task }) => eq(task.completed, false))
          .select(({ task }) => ({ id: task.id, title: task.title, completed: task.completed }))
          .orderBy(({ task }) => task.id, 'desc').limit(50)))
          .map(row => ({ ...row, completed: Number(row.completed) }));
        if (name === 'search') return await queryOnce(q => q.from({ task: session.tasks })
          .where(({ task }) => eq(task.project_id, screenProjectId))
          .where(({ task }) => like(task.id, `${screenProjectId}-task-00%`))
          .select(({ task }) => ({ id: task.id, title: task.title }))
          .orderBy(({ task }) => task.id, 'asc').limit(100));
        if (name === 'aggregate') return (await queryOnce(q => q.from({ task: session.tasks })
          .where(({ task }) => eq(task.project_id, screenProjectId))
          .groupBy(({ task }) => [task.owner_id, task.completed])
          .select(({ task }) => ({ owner_id: task.owner_id, completed: task.completed, task_count: count(task.id) }))
          .orderBy(({ task }) => task.owner_id, 'asc').orderBy(({ task }) => task.completed, 'asc')))
          .map(row => ({ ...row, completed: Number(row.completed) }));
        if (!related) throw new Error('Relationship query requires related collections');
        if (name === 'dashboard') return await queryOnce(q => q.from({ org: related.organizations })
          .innerJoin({ project: related.projects }, ({ org, project }) => eq(org.id, project.org_id))
          .leftJoin({ task: session.tasks }, ({ project, task }) => eq(project.id, task.project_id))
          .where(({ org }) => eq(org.id, screenOrgId))
          .groupBy(({ org, project }) => [org.name, project.id, project.name])
          .select(({ org, project, task }) => ({ org_name: org.name, project_id: project.id, project_name: project.name,
            task_count: count(task.id), completed_task_count: sum(caseWhen(eq(task.completed, true), 1, 0)), open_task_count: sum(caseWhen(eq(task.completed, false), 1, 0)) }))
          .orderBy(({ $selected }) => $selected.open_task_count, 'desc')
          .orderBy(({ project }) => project.id, 'asc').limit(20));
        return await queryOnce(q => q.from({ task: session.tasks })
          .innerJoin({ project: related.projects }, ({ task, project }) => eq(task.project_id, project.id))
          .innerJoin({ org: related.organizations }, ({ project, org }) => eq(project.org_id, org.id))
          .where(({ project }) => eq(project.id, screenProjectId))
          .select(({ task, project, org }) => ({ id: task.id, title: task.title, project_name: project.name, org_name: org.name }))
          .orderBy(({ task }) => task.id, 'asc').limit(100));
      },
      diagnostics: { indexes: ['tasks.project_id', 'tasks.owner_id', 'tasks.completed', 'tasks.id', ...(related ? ['projects.id', 'projects.org_id', 'organizations.id'] : [])], localStorage: 'tanstack-sqlite-persistence' },
    });
    return { status: 'completed', ...result, metadata: { ...productMetadata(), ...result.metadata, implementation: 'electric-tanstack-screens-v2' } };
  } finally { await session.close(); }
}

function diffMeter(
  after: { requestCount: number; requestBytes: number; responseBytes: number },
  before: { requestCount: number; requestBytes: number; responseBytes: number }
): { requestCount: number; requestBytes: number; responseBytes: number } {
  return {
    requestCount: Math.max(0, after.requestCount - before.requestCount),
    requestBytes: Math.max(0, after.requestBytes - before.requestBytes),
    responseBytes: Math.max(0, after.responseBytes - before.responseBytes),
  };
}

const result =
  scenario === 'online-propagation'
      ? await runOnlinePropagation()
      : scenario === 'local-query'
            ? await runLocalQuery()
            : await runDeepRelationshipQuery();

process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
