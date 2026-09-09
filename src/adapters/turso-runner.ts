import { captureScreenPlans } from '../contracts/screen-indexes.ts';
import { measureCollaboration, collaborationSeed, pollUntil } from '../contracts/collaboration.ts';
import { measureScreens, screenSeed, screenQueries, type ScreenCase, type Row } from '../contracts/screens.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, type Database } from '@tursodatabase/sync';
import { createHttpMeter } from '../http-meter.ts';
import {
  average,
  CpuSampler,
  MemorySampler,
  percentile,
  round,
} from '../metrics.ts';
import { tempRoot } from '../paths.ts';
import {
  ensureStackUp,
  getFixtures,
  seedStack,
} from '../stack-manager.ts';
import { getClientStack as getStack } from '../stacks.ts';
import type {
  BenchmarkStatus,
  BootstrapScaleResult,
  JsonValue,
  OnlinePropagationSample,
} from '../types.ts';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

interface TursoSession {
  db: Database;
  dir: string;
  close(): Promise<void>;
}

const stack = getStack('turso');
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

const result = scenario === 'online-propagation' ? await runOnlinePropagation()
  : scenario === 'local-query' ? await runLocalQuery() : await runDeepRelationshipQuery();

process.stdout.write(`${JSON.stringify(result)}\n`);

async function createSession(
  name: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<TursoSession> {
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, `turso-${name}-`));
  const db = await connect({
    path: join(dir, 'replica.db'),
    url: stack.syncBaseUrl,
    clientName: `${name}-${randomUUID()}`,
    fetch: fetchImpl,
    pushOperationsThreshold: 2_000,
  });

  return {
    db,
    dir,
    async close() {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function getCount(db: Database, table: string): Promise<number> {
  const statement = await db.prepare(`select count(*) as count from ${table}`);
  const row = (await statement.get()) as
    | { count?: number | bigint }
    | undefined;
  return Number(row?.count ?? 0);
}

async function pullUntilCount(
  db: Database,
  table: string,
  expected: number,
  timeoutMs = 180_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await db.pull();
    if ((await getCount(db, table)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Turso did not reach ${expected} ${table} rows before timeout`);
}

async function getTaskTitle(db: Database, taskId: string): Promise<string | null> {
  const statement = await db.prepare('select title from tasks where id = ?');
  const row = (await statement.get(taskId)) as { title?: string } | undefined;
  return row?.title ?? null;
}

async function pullUntilTitle(
  db: Database,
  taskId: string,
  expectedTitle: string,
  timeoutMs = 60_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await db.pull();
    if ((await getTaskTitle(db, taskId)) === expectedTitle) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Turso reader did not observe ${taskId}=${expectedTitle}`);
}

async function runOnlinePropagation(): Promise<RunnerResult> {
  await ensureStackUp('turso'); await seedStack('turso', collaborationSeed);
  const fixtures = await getFixtures('turso');
  if (!fixtures.sampleTaskId) throw new Error('Turso task fixture missing');
  const taskId = fixtures.sampleTaskId;
  const writer = await createSession('writer'), reader = await createSession('reader');
  try {
    await pullUntilCount(writer.db, 'tasks', 200); await pullUntilCount(reader.db, 'tasks', 200);
    const result = await measureCollaboration({
      readData: async () => await (await reader.db.prepare('SELECT * FROM tasks')).all() as Row[],
      localCommit: true,
      write: async (title, milestones) => {
        await (await writer.db.prepare('UPDATE tasks SET title = ? WHERE id = ?')).run(title, taskId); milestones.localCommitted();
        await writer.db.push(); milestones.serverAccepted();
      },
      observe: (title, signal) => pollUntil(async () => { await reader.db.pull(); return await getTaskTitle(reader.db, taskId) === title; }, signal),
      diagnostics: { localCommit: 'local SQL run completion', serverAccepted: 'native push completion', reader: 'explicit continuous pull with 1ms interval between rounds', localStorage: 'turso-sqlite-file' },
    });
    return { status: 'completed', ...result, metadata: { ...result.metadata, implementation: 'turso-collaboration-v2' } };
  } finally { await writer.close(); await reader.close(); }
}

async function runLocalQuery(): Promise<RunnerResult> { return runScreens('local-query'); }
async function runDeepRelationshipQuery(): Promise<RunnerResult> { return runScreens('deep-relationship-query'); }
async function runScreens(scenario: ScreenCase): Promise<RunnerResult> {
  await ensureStackUp('turso');
  await seedStack('turso', screenSeed(scenario));
  const session = await createSession(scenario);
  const query = async (sql: string) => (await (await session.db.prepare(sql)).all()) as Row[];
  try {
    await pullUntilCount(session.db, 'tasks', 100_000, 300_000);
    const result = await measureScreens(scenario, {
      execution: 'native-sql',
      readData: async () => ({ tasks: await query('SELECT * FROM tasks'), projects: await query('SELECT * FROM projects'), organizations: await query('SELECT * FROM organizations') }),
      query: name => query(screenQueries[name]),
      diagnostics: { queries: screenQueries, localStorage: 'turso-sqlite-file', queryPlans: await captureScreenPlans(scenario, query) },
    });
    return { status: 'completed', ...result, metadata: { ...result.metadata, implementation: 'turso-screens-v2' } };
  } finally { await session.close(); }
}
