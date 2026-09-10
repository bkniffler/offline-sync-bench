import { electricWriteUnsupported } from '../electric-support.ts';
import { indexRelatedScreens } from '../contracts/related-screen-index.ts';
import { runReopen } from '../recovery/reopen.ts';
import { Shape, ShapeStream } from '@electric-sql/client';
import { runStartup } from '../startup/run.ts';
import { runAccess } from '../access/run.ts';
import { measureScreens, screenSeed, arrayScreenQuery, taskRecord, type Row } from '../contracts/screens.ts';
import {
  ensureStackUp,
  seedStack,
} from '../stack-manager';
import { getClientStack as getStack } from '../stacks';
import type {
  BenchmarkAdapter,
  TaskRecord,
} from '../types';

interface ElectricShapeMessage {
  key?: string;
  value?: {
    completed?: string | boolean;
    id?: string;
    org_id?: string;
    owner_id?: string;
    project_id?: string;
    server_version?: string | number;
    title?: string;
    updated_at?: string;
  };
  headers?: {
    control?: string;
    operation?: 'insert' | 'update' | 'delete';
  };
}

interface ElectricShapeState {
  handle: string;
  offset: string;
  rows: Map<string, TaskRecord>;
  serverVersion: string | null;
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function coerceBoolean(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value;
  return value === 'true';
}

function coerceNumber(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  return Number(value ?? '0');
}

function applyShapeMessages(
  rows: Map<string, TaskRecord>,
  messages: ElectricShapeMessage[]
): {
  snapshotComplete: boolean;
  sawUpToDate: boolean;
} {
  let snapshotComplete = false;
  let sawUpToDate = false;

  for (const message of messages) {
    const control = message.headers?.control;
    if (control === 'snapshot-end') {
      snapshotComplete = true;
      continue;
    }
    if (control === 'up-to-date') {
      sawUpToDate = true;
      continue;
    }

    const taskId = message.value?.id;
    if (!taskId) continue;

    if (message.headers?.operation === 'delete') {
      rows.delete(taskId);
      continue;
    }

    rows.set(taskId, {
      id: taskId,
      orgId: message.value?.org_id ?? '',
      projectId: message.value?.project_id ?? '',
      ownerId: message.value?.owner_id ?? '',
      title: message.value?.title ?? '',
      completed: coerceBoolean(message.value?.completed),
      serverVersion: coerceNumber(message.value?.server_version),
      updatedAt: message.value?.updated_at ?? '',
    });
  }

  return {
    snapshotComplete,
    sawUpToDate,
  };
}

async function fetchShapePage(args: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  path?: string;
  headers?: HeadersInit;
  handle?: string;
  offset: string;
  live?: boolean;
}): Promise<{
  handle: string;
  offset: string;
  serverVersion: string | null;
  messages: ElectricShapeMessage[];
}> {
  const url = new URL(args.path ?? '/v1/shape', args.baseUrl);
  if (!args.path) {
    url.searchParams.set('table', 'tasks');
  }
  url.searchParams.set('offset', args.offset);
  if (args.handle) {
    url.searchParams.set('handle', args.handle);
  }
  if (args.live) {
    url.searchParams.set('live', 'true');
  }

  const response = await args.fetchImpl(url.toString(), {
    headers: args.headers,
  });
  if (!response.ok) {
    throw new Error(
      `Electric shape request failed: ${response.status} ${response.statusText}`
    );
  }

  const handle = response.headers.get('electric-handle');
  const offset = response.headers.get('electric-offset');
  if (!handle || !offset) {
    throw new Error('Electric shape response missing handle/offset headers');
  }

  const body = await response.text();
  return {
    handle,
    offset,
    serverVersion: response.headers.get('electric-server'),
    messages: parseJson<ElectricShapeMessage[]>(body),
  };
}

async function bootstrapShape(args: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  path?: string;
  headers?: HeadersInit;
}): Promise<ElectricShapeState> {
  const rows = new Map<string, TaskRecord>();
  let handle: string | undefined;
  let offset = '-1';
  let serverVersion: string | null = null;

  while (true) {
    const page = await fetchShapePage({
      baseUrl: args.baseUrl,
      fetchImpl: args.fetchImpl,
      path: args.path,
      headers: args.headers,
      handle,
      offset,
    });

    const applyResult = applyShapeMessages(rows, page.messages);
    handle = page.handle;
    offset = page.offset;
    serverVersion = page.serverVersion;

    if (applyResult.snapshotComplete || applyResult.sawUpToDate) {
      break;
    }
  }

  if (!handle) {
    throw new Error('Electric bootstrap did not produce a shape handle');
  }

  return {
    handle,
    offset,
    rows,
    serverVersion,
  };
}

export class ElectricBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('electric');

  async runConflictUpdateUpdate() { return electricWriteUnsupported(); }
  async runConflictUpdateDelete() { return electricWriteUnsupported(); }

  async runBootstrap() { return runStartup('electric'); }

  async runOnlinePropagation() { return electricWriteUnsupported(); }
  async runOfflineReplay() { return electricWriteUnsupported(); }
  async runOfflineRestart() { return electricWriteUnsupported(); }
  async runConnectedFanout() { return electricWriteUnsupported(); }
  async runReconnectStorm() { return electricWriteUnsupported(); }
  async runLargeOfflineQueue() { return electricWriteUnsupported(); }

  async runLocalQuery() {
    await ensureStackUp('electric');
    await seedStack('electric', screenSeed('local-query'));
    const snapshot = await bootstrapShape({ baseUrl: this.stack.syncBaseUrl, fetchImpl: fetch });
    const data = { tasks: [...snapshot.rows.values()].map(row => taskRecord(row as unknown as Row)) };
    const result = await measureScreens('local-query', {
      execution: 'application-processing', readData: () => data,
      query: name => arrayScreenQuery(name, data),
      diagnostics: { localStorage: 'javascript-map', queryEngine: 'benchmark-array-operations' },
    });
    return { status: 'completed' as const, ...result, metadata: { ...result.metadata, implementation: 'electric-array-screens-v2' } };
  }

  async runDeepRelationshipQuery() {
    await ensureStackUp('electric');
    await seedStack('electric', screenSeed('deep-relationship-query'));
    const abort = new AbortController();
    const streams = ['tasks', 'projects', 'organizations'].map(table => new ShapeStream({
      url: `${this.stack.syncBaseUrl}/v1/shape`, params: { table }, subscribe: false,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      parser: { int8: (value: string) => Number(value) },
    }));
    const shapes = streams.map(stream => new Shape(stream));
    try {
      const [tasks, projects, organizations] = await Promise.all(shapes.map(shape => shape.rows));
      const data = { tasks: tasks!.map(taskRecord), projects: projects!, organizations: organizations! };
      const result = await measureScreens('deep-relationship-query', {
        execution: 'application-processing', readData: () => data,
        query: indexRelatedScreens(data),
        diagnostics: { localStorage: 'javascript-map', queryEngine: 'benchmark-array-operations',
          delivery: 'native Electric Shape snapshots for tasks, projects and organizations',
          joins: 'application joins with project/org lookup maps and task ID order index; aggregation computed per query',
          indexBuild: 'before timing, alongside snapshot preparation' },
      });
      return { status: 'completed' as const, ...result, metadata: { ...result.metadata, implementation: 'electric-related-screens-v2' } };
    } finally {
      abort.abort();
      shapes.forEach(shape => shape.unsubscribeAll());
      streams.forEach(stream => stream.unsubscribeAll());
    }
  }

  async runReplicaReopen() { return runReopen('electric'); }

  async runPermissionChange() { return runAccess('electric'); }

  async runBlobFlow() { return electricWriteUnsupported(); }
}
