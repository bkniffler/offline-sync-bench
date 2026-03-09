import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  ANYONE_CAN_DO_ANYTHING,
  boolean,
  createSchema,
  definePermissions,
  number,
  string,
  table,
} from '@rocicorp/zero';
import { toTableName as toLiveStoreEventlogTableName } from '@livestore/sync-electric';
import postgres from 'postgres';
import { benchmarkRoot, tempRoot } from './paths';
import { getStack } from './stacks';
import type {
  SeedOptions,
  StackFixtures,
  StackId,
  StackSpec,
  StackStats,
  TaskRecord,
} from './types';

const dockerFingerprintRoot = join(tempRoot, 'docker-fingerprints');
const ignoredDockerContextEntries = new Set([
  '.DS_Store',
  '.git',
  '.next',
  '.tmp',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

const zeroPermissions = definePermissions(
  createSchema({
    tables: [
      table('tasks')
        .columns({
          id: string(),
          org_id: string(),
          project_id: string(),
          owner_id: string(),
          title: string(),
          completed: boolean(),
          server_version: number(),
          updated_at: number(),
        })
        .primaryKey('id'),
    ],
    enableLegacyQueries: false,
    enableLegacyMutators: false,
  }),
  () => ({
    tasks: ANYONE_CAN_DO_ANYTHING,
  })
);

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function runDockerCompose(stack: StackSpec, args: string[]): string {
  const result = Bun.spawnSync(
    ['docker', 'compose', '-f', stack.composeFile, ...args],
    {
      cwd: benchmarkRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} failed for ${stack.id}\n${stdout}\n${stderr}`
    );
  }

  return stdout.trim();
}

function runDocker(args: string[]): string {
  const result = Bun.spawnSync(['docker', ...args], {
    cwd: benchmarkRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args.join(' ')} failed\n${stdout}\n${stderr}`);
  }

  return stdout.trim();
}

function runDockerBestEffort(args: string[]): void {
  try {
    runDocker(args);
  } catch {
    // Best-effort cleanup should not break benchmark runs.
  }
}

function shouldRetryComposeUpAfterCleanup(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('is already in use by container') ||
    error.message.includes('Container') && error.message.includes('Conflict')
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return parseJson<T>(await response.text());
}

export async function waitForUrl(
  url: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    acceptResponse?: (response: Response) => boolean;
  } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const acceptResponse = options.acceptResponse ?? ((response: Response) => response.ok);
  const startedAt = Date.now();
  let lastError = 'unreachable';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (acceptResponse(response)) {
        return;
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function isUrlHealthy(
  url: string,
  options: { acceptResponse?: (response: Response) => boolean } = {}
): Promise<boolean> {
  const acceptResponse = options.acceptResponse ?? ((response: Response) => response.ok);

  try {
    const response = await fetch(url);
    return acceptResponse(response);
  } catch {
    return false;
  }
}

async function isStackHealthy(stack: StackSpec): Promise<boolean> {
  if (!(await isUrlHealthy(`${stack.adminBaseUrl}/health`))) {
    return false;
  }

  switch (stack.id) {
    case 'syncular':
      return isUrlHealthy(`${stack.syncBaseUrl.replace(/\/api$/, '')}/health`);
    case 'electric':
      if (
        !(await isUrlHealthy(`${stack.syncBaseUrl}/v1/shape?table=tasks&offset=-1`, {
          acceptResponse: (response) => response.status < 500,
        }))
      ) {
        return false;
      }
      return stack.appBaseUrl ? isUrlHealthy(`${stack.appBaseUrl}/health`) : true;
    case 'zero':
      if (
        !(await isUrlHealthy(`${stack.syncBaseUrl}/statz`, {
          acceptResponse: (response) =>
            response.ok || response.status === 401 || response.status === 403,
        }))
      ) {
        return false;
      }
      return stack.appBaseUrl ? isUrlHealthy(`${stack.appBaseUrl}/health`) : true;
    case 'powersync':
      if (!(await isUrlHealthy(`${stack.syncBaseUrl}/probes/liveness`))) {
        return false;
      }
      return stack.appBaseUrl ? isUrlHealthy(`${stack.appBaseUrl}/health`) : true;
    case 'replicache':
      return stack.appBaseUrl ? isUrlHealthy(`${stack.appBaseUrl}/health`) : true;
    case 'livestore':
      if (stack.appBaseUrl && !(await isUrlHealthy(`${stack.appBaseUrl}/health`))) {
        return false;
      }
      return isUrlHealthy(
        `${stack.syncBaseUrl}/v1/shape?table=${encodeURIComponent(
          toLiveStoreEventlogTableName('benchmark')
        )}&offset=-1`,
        {
          acceptResponse: (response) => response.status < 500,
        }
      );
  }
}

async function walkFingerprintPath(
  rootPath: string,
  hash: ReturnType<typeof createHash>
): Promise<void> {
  const rootStats = await stat(rootPath);
  if (rootStats.isFile()) {
    hash.update(relative(benchmarkRoot, rootPath));
    hash.update(String(rootStats.size));
    hash.update(String(rootStats.mtimeMs));
    return;
  }

  const entries = (await readdir(rootPath, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  for (const entry of entries) {
    if (ignoredDockerContextEntries.has(entry.name)) {
      continue;
    }

    const entryPath = join(rootPath, entry.name);
    const entryStats = await stat(entryPath);

    if (entry.isDirectory()) {
      await walkFingerprintPath(entryPath, hash);
      continue;
    }

    hash.update(relative(benchmarkRoot, entryPath));
    hash.update(String(entryStats.size));
    hash.update(String(entryStats.mtimeMs));
  }
}

function getBuildFingerprintFile(stack: StackSpec): string {
  return join(dockerFingerprintRoot, `${stack.id}.sha256`);
}

function getBuildFingerprintPaths(stack: StackSpec): string[] {
  const fingerprintPaths = new Set<string>([
    dirname(stack.composeFile),
    join(benchmarkRoot, 'services', 'bench-admin'),
  ]);

  for (const path of stack.buildFingerprintPaths ?? []) {
    fingerprintPaths.add(path);
  }

  return [...fingerprintPaths];
}

async function computeBuildFingerprint(stack: StackSpec): Promise<string | null> {
  const fingerprintPaths = getBuildFingerprintPaths(stack);
  if (fingerprintPaths.length === 0) {
    return null;
  }

  const hash = createHash('sha256');
  hash.update(stack.composeProjectName);

  for (const fingerprintPath of fingerprintPaths.sort((left, right) =>
    left.localeCompare(right)
  )) {
    await walkFingerprintPath(fingerprintPath, hash);
  }

  return hash.digest('hex');
}

async function hasBuildFingerprintChanged(stack: StackSpec): Promise<{
  changed: boolean;
  fingerprint: string | null;
}> {
  const fingerprint = await computeBuildFingerprint(stack);
  if (!fingerprint) {
    return { changed: false, fingerprint: null };
  }

  try {
    const previousFingerprint = (await readFile(getBuildFingerprintFile(stack), 'utf8')).trim();
    return { changed: previousFingerprint !== fingerprint, fingerprint };
  } catch {
    return { changed: true, fingerprint };
  }
}

async function persistBuildFingerprint(stack: StackSpec, fingerprint: string | null): Promise<void> {
  if (!fingerprint) {
    return;
  }

  await mkdir(dockerFingerprintRoot, { recursive: true });
  await writeFile(getBuildFingerprintFile(stack), `${fingerprint}\n`, 'utf8');
}

function pruneComposeImages(stack: StackSpec): void {
  runDockerBestEffort([
    'image',
    'prune',
    '-f',
    '--filter',
    `label=com.docker.compose.project=${stack.composeProjectName}`,
  ]);
}

export async function ensureStackUp(stackId: StackId): Promise<StackSpec> {
  const stack = getStack(stackId);
  const fingerprintState = await hasBuildFingerprintChanged(stack);

  if (!fingerprintState.changed && (await isStackHealthy(stack))) {
    return stack;
  }

  const upArgs = fingerprintState.changed ? ['up', '--build', '-d'] : ['up', '-d'];
  try {
    runDockerCompose(stack, upArgs);
  } catch (error) {
    if (!shouldRetryComposeUpAfterCleanup(error)) {
      throw error;
    }
    runDockerCompose(stack, ['down', '-v', '--remove-orphans']);
    runDockerCompose(stack, upArgs);
  }
  await waitForUrl(`${stack.adminBaseUrl}/health`);

  switch (stack.id) {
    case 'syncular':
      await waitForUrl(`${stack.syncBaseUrl.replace(/\/api$/, '')}/health`);
      break;
    case 'electric':
      await waitForUrl(`${stack.syncBaseUrl}/v1/shape?table=tasks&offset=-1`, {
        acceptResponse: (response) => response.status < 500,
      });
      if (stack.appBaseUrl) {
        await waitForUrl(`${stack.appBaseUrl}/health`);
      }
      break;
    case 'zero':
      await waitForUrl(`${stack.syncBaseUrl}/statz`, {
        acceptResponse: (response) =>
          response.ok || response.status === 401 || response.status === 403,
      });
      await ensureZeroPermissions(stack);
      if (stack.appBaseUrl) {
        await waitForUrl(`${stack.appBaseUrl}/health`);
      }
      break;
    case 'powersync':
      await waitForUrl(`${stack.syncBaseUrl}/probes/liveness`);
      if (stack.appBaseUrl) {
        await waitForUrl(`${stack.appBaseUrl}/health`);
      }
      break;
    case 'replicache':
      if (stack.appBaseUrl) {
        await waitForUrl(`${stack.appBaseUrl}/health`);
      }
      break;
    case 'livestore':
      if (stack.appBaseUrl) {
        await waitForUrl(`${stack.appBaseUrl}/health`);
      }
      await waitForUrl(
        `${stack.syncBaseUrl}/v1/shape?table=${encodeURIComponent(
          toLiveStoreEventlogTableName('benchmark')
        )}&offset=-1`,
        {
          acceptResponse: (response) => response.status < 500,
        }
      );
      break;
  }

  await persistBuildFingerprint(stack, fingerprintState.fingerprint);
  pruneComposeImages(stack);

  return stack;
}

async function ensureZeroPermissions(stack: StackSpec): Promise<void> {
  if (stack.id !== 'zero' || !stack.databaseUrl) {
    return;
  }

  const permissions = await zeroPermissions;
  if (!permissions) {
    return;
  }

  const sql = postgres(stack.databaseUrl, { max: 1 });

  try {
    await sql`
      update "zero_bench".permissions
      set permissions = ${sql.json(permissions)}
    `;
  } finally {
    await sql.end();
  }
}

export function downStack(stackId: StackId): void {
  const stack = getStack(stackId);
  runDockerCompose(stack, ['down', '-v', '--remove-orphans']);
  pruneComposeImages(stack);
}

export function stopService(stackId: StackId, service: keyof StackSpec['services']): void {
  const stack = getStack(stackId);
  const serviceName = stack.services[service];
  if (!serviceName) {
    throw new Error(`Stack ${stackId} does not expose service ${service}`);
  }
  runDockerCompose(stack, ['stop', serviceName]);
}

export function startService(stackId: StackId, service: keyof StackSpec['services']): void {
  const stack = getStack(stackId);
  const serviceName = stack.services[service];
  if (!serviceName) {
    throw new Error(`Stack ${stackId} does not expose service ${service}`);
  }
  runDockerCompose(stack, ['start', serviceName]);
}

export function resolveServiceContainerId(
  stackId: StackId,
  service: keyof StackSpec['services']
): string {
  const stack = getStack(stackId);
  const serviceName = stack.services[service];
  if (!serviceName) {
    throw new Error(`Stack ${stackId} does not expose service ${service}`);
  }

  const output = runDockerCompose(stack, ['ps', '-q', serviceName]);
  const containerId = output.split('\n')[0]?.trim() ?? '';
  if (!containerId) {
    throw new Error(
      `Could not resolve container id for ${stackId} service ${serviceName}`
    );
  }

  return containerId;
}

export async function resetStack(stackId: StackId): Promise<void> {
  const stack = getStack(stackId);
  await fetchJson<{ ok: boolean }>(`${stack.adminBaseUrl}/admin/reset`, {
    method: 'POST',
  });
}

export async function seedStack(
  stackId: StackId,
  seedOptions: SeedOptions
): Promise<StackStats> {
  const stack = getStack(stackId);
  const response = await fetchJson<{ stats: StackStats }>(
    `${stack.adminBaseUrl}/admin/seed`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(seedOptions),
    }
  );
  return response.stats;
}

export async function getFixtures(stackId: StackId): Promise<StackFixtures> {
  const stack = getStack(stackId);
  return fetchJson<StackFixtures>(`${stack.adminBaseUrl}/admin/fixtures`);
}

export async function listTasks(
  stackId: StackId,
  args: { projectId?: string; limit?: number } = {}
): Promise<TaskRecord[]> {
  const stack = getStack(stackId);
  const url = new URL('/admin/tasks', stack.adminBaseUrl);
  if (args.projectId) {
    url.searchParams.set('projectId', args.projectId);
  }
  if (args.limit) {
    url.searchParams.set('limit', String(args.limit));
  }
  const response = await fetchJson<{ tasks: TaskRecord[] }>(url.toString());
  return response.tasks;
}

export async function getTask(stackId: StackId, taskId: string): Promise<TaskRecord> {
  const stack = getStack(stackId);
  const response = await fetchJson<{ ok: boolean; task: TaskRecord }>(
    `${stack.adminBaseUrl}/admin/tasks/${encodeURIComponent(taskId)}`
  );
  return response.task;
}

export async function writeTask(
  stackId: StackId,
  args: { taskId: string; title?: string; completed?: boolean }
): Promise<TaskRecord> {
  const stack = getStack(stackId);
  const response = await fetchJson<{
    ok: boolean;
    row: {
      id: string;
      title: string;
      completed: boolean;
      server_version: number;
      updated_at?: string;
      org_id?: string;
      project_id?: string;
      owner_id?: string;
    };
  }>(`${stack.adminBaseUrl}/admin/write`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  const task = await getTask(stackId, response.row.id);
  return task;
}

export async function waitForTaskTitle(
  stackId: StackId,
  taskId: string,
  expectedTitle: string,
  timeoutMs = 30_000
): Promise<TaskRecord> {
  const startedAt = Date.now();
  const pollIntervalMs = 10;
  while (Date.now() - startedAt < timeoutMs) {
    const task = await getTask(stackId, taskId);
    if (task.title === expectedTitle) {
      return task;
    }
    await Bun.sleep(pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for ${stackId} task ${taskId} title ${expectedTitle}`
  );
}
