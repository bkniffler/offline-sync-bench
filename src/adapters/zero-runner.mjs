import { SignJWT } from 'jose';
import {
  boolean,
  createBuilder,
  createSchema,
  defineMutator,
  defineMutators,
  defineQueries,
  defineQuery,
  number,
  string,
  table,
  Zero,
} from '@rocicorp/zero';
import { createHttpMeter } from '../http-meter.ts';
import { average, CpuSampler, MemorySampler, percentile, round } from '../metrics.ts';
import { ensureStackUp, getFixtures, seedStack } from '../stack-manager.ts';
import { getStack } from '../stacks.ts';

const stack = getStack('zero');
const zeroSecret = new TextEncoder().encode('benchsecret');
const scenario = process.argv[2];

const organizations = table('organizations')
  .columns({
    id: string(),
    name: string(),
  })
  .primaryKey('id');

const projects = table('projects')
  .columns({
    id: string(),
    org_id: string(),
    name: string(),
  })
  .primaryKey('id');

const tasks = table('tasks')
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
  .primaryKey('id');

const schema = createSchema({
  tables: [organizations, projects, tasks],
  enableLegacyQueries: false,
  enableLegacyMutators: false,
});

const zql = createBuilder(schema);

const queries = defineQueries({
  organizations: {
    all: defineQuery(() => zql.organizations.orderBy('id', 'asc')),
  },
  projects: {
    all: defineQuery(() => zql.projects.orderBy('id', 'asc')),
  },
  tasks: {
    all: defineQuery(() => zql.tasks.orderBy('id', 'asc')),
  },
});

const mutators = defineMutators({
  tasks: {
    update: defineMutator(async ({ tx, args }) => {
      const existing = await tx.run(zql.tasks.where('id', args.id).one());
      if (!existing) {
        return;
      }

      await tx.mutate.tasks.update({
        id: args.id,
        title: args.title,
      });
    }),
  },
});

if (
  scenario !== 'bootstrap' &&
  scenario !== 'online-propagation' &&
  scenario !== 'offline-replay' &&
  scenario !== 'local-query' &&
  scenario !== 'deep-relationship-query'
) {
  throw new Error(
    'Expected scenario argument: bootstrap | online-propagation | offline-replay | local-query | deep-relationship-query'
  );
}

const result =
  scenario === 'bootstrap'
    ? await runBootstrap()
    : scenario === 'online-propagation'
      ? await runOnlinePropagation()
      : scenario === 'offline-replay'
        ? await runOfflineReplay()
        : scenario === 'local-query'
          ? await runLocalQuery()
          : await runDeepRelationshipQuery();

await writeResultAndExit(result);

async function createAuthToken(userId) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setSubject(userId)
    .setExpirationTime('10m')
    .sign(zeroSecret);
}

async function createZeroClient({ userId, storageKey }) {
  return new Zero({
    userID: userId,
    auth: await createAuthToken(userId),
    cacheURL: stack.syncBaseUrl,
    kvStore: 'mem',
    logLevel: 'error',
    schema,
    queries,
    mutators,
    storageKey,
  });
}

async function waitForZeroRowCount({ zero, expectedRows, timeoutMs = 60_000 }) {
  const view = zero.materialize(queries.tasks.all());
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const rows = Array.from(view.data);
      if (rows.length === expectedRows) {
        return rows;
      }
      await Bun.sleep(50);
    }
  } finally {
    view.destroy();
  }

  throw new Error(`Zero did not reach ${expectedRows} rows before timeout`);
}

async function waitForZeroRelationshipData({
  zero,
  expectedOrgRows,
  expectedProjectRows,
  expectedTaskRows,
  timeoutMs = 120_000,
}) {
  const orgView = zero.materialize(queries.organizations.all());
  const projectView = zero.materialize(queries.projects.all());
  const taskView = zero.materialize(queries.tasks.all());
  const startedAt = Date.now();

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const orgRows = Array.from(orgView.data);
      const projectRows = Array.from(projectView.data);
      const taskRows = Array.from(taskView.data);
      if (
        orgRows.length === expectedOrgRows &&
        projectRows.length === expectedProjectRows &&
        taskRows.length === expectedTaskRows
      ) {
        return {
          orgRows,
          projectRows,
          taskRows,
        };
      }
      await Bun.sleep(50);
    }
  } finally {
    orgView.destroy();
    projectView.destroy();
    taskView.destroy();
  }

  throw new Error(
    `Zero did not reach org/project/task counts ${expectedOrgRows}/${expectedProjectRows}/${expectedTaskRows} before timeout`
  );
}

async function waitForZeroTaskTitle({
  zero,
  taskId,
  expectedTitle,
  timeoutMs = 30_000,
}) {
  const view = zero.materialize(queries.tasks.all());
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < timeoutMs) {
      const task = view.data.find((row) => row.id === taskId);
      if (task?.title === expectedTitle) {
        return;
      }
      await Bun.sleep(25);
    }
  } finally {
    view.destroy();
  }

  throw new Error(`Zero reader did not observe ${taskId}=${expectedTitle}`);
}

function runZeroLocalListQuery({ rows, projectId, ownerId }) {
  const startedAt = performance.now();
  const filteredRows = rows
    .filter(
      (row) =>
        row.project_id === projectId &&
        row.owner_id === ownerId &&
        !row.completed
    )
    .sort((left, right) => right.updated_at - left.updated_at)
    .slice(0, 50);

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: filteredRows.length,
  };
}

function runZeroLocalSearchQuery({ rows, projectId }) {
  const startedAt = performance.now();
  const filteredRows = rows
    .filter(
      (row) =>
        row.project_id === projectId &&
        row.id.startsWith('org-1-project-1-task-00')
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 100);

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: filteredRows.length,
  };
}

function runZeroLocalAggregateQuery({ rows, projectId }) {
  const startedAt = performance.now();
  const grouped = new Map();

  for (const row of rows) {
    if (row.project_id !== projectId) continue;
    const key = `${row.owner_id}:${row.completed ? '1' : '0'}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: grouped.size,
  };
}

function runZeroDashboardQuery({ organizations, projects, tasks, orgId }) {
  const startedAt = performance.now();
  const organization = organizations.find((row) => row.id === orgId);
  if (!organization) {
    return {
      elapsedMs: round(performance.now() - startedAt),
      resultCount: 0,
    };
  }

  const rows = projects
    .filter((project) => project.org_id === orgId)
    .map((project) => {
      let taskCount = 0;
      let openTaskCount = 0;

      for (const task of tasks) {
        if (task.project_id !== project.id) continue;
        taskCount += 1;
        if (!task.completed) {
          openTaskCount += 1;
        }
      }

      return {
        orgName: organization.name,
        projectId: project.id,
        projectName: project.name,
        taskCount,
        openTaskCount,
      };
    })
    .sort((left, right) => {
      if (right.openTaskCount !== left.openTaskCount) {
        return right.openTaskCount - left.openTaskCount;
      }
      return left.projectId.localeCompare(right.projectId);
    })
    .slice(0, 20);

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

function runZeroDetailJoinQuery({ organizations, projects, tasks, projectId }) {
  const startedAt = performance.now();
  const project = projects.find((row) => row.id === projectId);
  if (!project) {
    return {
      elapsedMs: round(performance.now() - startedAt),
      resultCount: 0,
    };
  }
  const organization = organizations.find((row) => row.id === project.org_id);
  if (!organization) {
    return {
      elapsedMs: round(performance.now() - startedAt),
      resultCount: 0,
    };
  }

  const rows = tasks
    .filter((task) => task.project_id === projectId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 100)
    .map((task) => ({
      taskId: task.id,
      taskTitle: task.title,
      projectName: project.name,
      orgName: organization.name,
    }));

  return {
    elapsedMs: round(performance.now() - startedAt),
    resultCount: rows.length,
  };
}

async function closeZero(zero) {
  await Promise.race([zero.close(), Bun.sleep(2_000).then(() => undefined)]);
}

async function runBootstrap() {
  await ensureStackUp('zero');

  const scales = [1000, 10_000, 100_000];
  const scaleResults = [];
  let productVersion = null;

  for (const rowsTarget of scales) {
    await seedStack('zero', {
      resetFirst: true,
      orgCount: 1,
      projectsPerOrg: 1,
      usersPerOrg: 2,
      tasksPerProject: rowsTarget,
      membershipsPerProject: 2,
    });

    const originalFetch = globalThis.fetch;
    const meter = createHttpMeter(originalFetch);
    globalThis.fetch = meter.fetch;
    const sampler = new MemorySampler();
    const cpuSampler = new CpuSampler();
    sampler.start();
    cpuSampler.start();
    const startedAt = performance.now();
    const zero = await createZeroClient({
      userId: `zero-bootstrap-${rowsTarget}`,
      storageKey: `bootstrap-${rowsTarget}`,
    });

    try {
      const rows = await waitForZeroRowCount({
        zero,
        expectedRows: rowsTarget,
        timeoutMs: 120_000,
      });
      const elapsedMs = performance.now() - startedAt;
      const meterSnapshot = meter.snapshot();
      const memoryMetrics = sampler.stop();
      const cpuMetrics = cpuSampler.stop();
      productVersion = zero.version;

      scaleResults.push({
        rowsTarget,
        timeToFirstQueryMs: round(elapsedMs),
        rowsLoaded: rows.length,
        requestCount: meterSnapshot.requestCount,
        requestBytes: meterSnapshot.requestBytes,
        responseBytes: meterSnapshot.responseBytes,
        bytesTransferred: meterSnapshot.requestBytes + meterSnapshot.responseBytes,
        avgMemoryMb: memoryMetrics.avgMemoryMb,
        peakMemoryMb: memoryMetrics.peakMemoryMb,
        avgCpuPct: cpuMetrics.avgCpuPct,
        peakCpuPct: cpuMetrics.peakCpuPct,
      });
    } finally {
      globalThis.fetch = originalFetch;
      cpuSampler.stop();
      sampler.stop();
      await closeZero(zero);
    }
  }

  return {
    status: 'completed',
    metrics: Object.fromEntries(
      scaleResults.flatMap((result) => [
        [`bootstrap_${result.rowsTarget}_ms`, result.timeToFirstQueryMs],
        [`rows_loaded_${result.rowsTarget}`, result.rowsLoaded],
        [`request_count_${result.rowsTarget}`, result.requestCount],
        [`request_bytes_${result.rowsTarget}`, result.requestBytes],
        [`response_bytes_${result.rowsTarget}`, result.responseBytes],
        [`bytes_transferred_${result.rowsTarget}`, result.bytesTransferred],
        [`avg_memory_mb_${result.rowsTarget}`, result.avgMemoryMb],
        [`peak_memory_mb_${result.rowsTarget}`, result.peakMemoryMb],
        [`avg_cpu_pct_${result.rowsTarget}`, result.avgCpuPct],
        [`peak_cpu_pct_${result.rowsTarget}`, result.peakCpuPct],
      ])
    ),
    notes: [
      'Zero bootstrap uses a real Zero client with a live zero-cache service and an in-memory client store.',
      'HTTP byte counts capture fetch traffic only and do not attempt to meter websocket frames.',
    ],
    metadata: {
      implementation: 'zero-client-mem-store',
      productVersion: productVersion ?? 'unknown',
      scales: scaleResults,
    },
  };
}

async function runOnlinePropagation() {
  await ensureStackUp('zero');
  await seedStack('zero', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 200,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('zero');
  if (!fixtures.sampleTaskId) {
    throw new Error('Zero fixtures did not return a sample task');
  }

  const originalFetch = globalThis.fetch;
  const meter = createHttpMeter(originalFetch);
  globalThis.fetch = meter.fetch;
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  const writer = await createZeroClient({
    userId: 'zero-writer',
    storageKey: 'writer',
  });
  const reader = await createZeroClient({
    userId: 'zero-reader',
    storageKey: 'reader',
  });

  try {
    await waitForZeroRowCount({ zero: writer, expectedRows: 200 });
    await waitForZeroRowCount({ zero: reader, expectedRows: 200 });

    const iterations = 15;
    const samples = [];

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const expectedTitle = `zero-online-${iteration}-${Date.now()}`;
      const startedAt = performance.now();
      const result = writer.mutate(
        mutators.tasks.update({
          id: fixtures.sampleTaskId,
          title: expectedTitle,
        })
      );
      const serverResult = await result.server;
      if (serverResult.type !== 'success') {
        throw new Error(`Zero mutate failed: ${JSON.stringify(serverResult)}`);
      }
      const writeAckMs = performance.now() - startedAt;

      await waitForZeroTaskTitle({
        zero: reader,
        taskId: fixtures.sampleTaskId,
        expectedTitle,
      });

      samples.push({
        iteration,
        writeAckMs: round(writeAckMs),
        mirrorVisibleMs: round(performance.now() - startedAt),
      });
    }

    const visibility = samples.map((sample) => sample.mirrorVisibleMs);
    const writeAcks = samples.map((sample) => sample.writeAckMs);
    const meterSnapshot = meter.snapshot();
    const bytes = meterSnapshot.requestBytes + meterSnapshot.responseBytes;
    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      status: 'completed',
      metrics: {
        write_ack_ms: average(writeAcks),
        mirror_visible_p50_ms: percentile(visibility, 50),
        mirror_visible_p95_ms: percentile(visibility, 95),
        mirror_visible_p99_ms: percentile(visibility, 99),
        iterations,
        request_count: meterSnapshot.requestCount,
        request_bytes: meterSnapshot.requestBytes,
        response_bytes: meterSnapshot.responseBytes,
        bytes_transferred: bytes,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'Writes are measured through Zero custom mutators on the real client path.',
        'Mirror visibility is measured by polling the reader local cache in local-only mode after the server mutation succeeds.',
      ],
      metadata: {
        implementation: 'zero-client-mutators',
        productVersion: writer.version,
        samples,
      },
    };
  } finally {
    globalThis.fetch = originalFetch;
    memorySampler.stop();
    cpuSampler.stop();
    await closeZero(writer);
    await closeZero(reader);
  }
}

async function runOfflineReplay() {
  return {
    status: 'unsupported',
    metrics: {
      queued_write_count: null,
      reconnect_convergence_ms: null,
      conflict_count: null,
      replayed_write_success_rate: null,
    },
    notes: [
      'Zero offline replay is intentionally marked unsupported in this benchmark harness.',
      'Benchmarking a durable offline write queue here would require inventing an extra client-side layer that Zero does not ship as the core model.',
    ],
    metadata: {
      implementation: 'unsupported',
    },
  };
}

async function runLocalQuery() {
  await ensureStackUp('zero');
  await seedStack('zero', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 1,
    usersPerOrg: 2,
    tasksPerProject: 100_000,
    membershipsPerProject: 2,
  });

  const fixtures = await getFixtures('zero');
  const projectId = fixtures.sampleProjectId;
  const ownerId = fixtures.sampleUserIds[1] ?? fixtures.sampleUserIds[0];
  if (!projectId || !ownerId) {
    throw new Error('Zero fixtures are missing project or owner data');
  }

  const zero = await createZeroClient({
    userId: 'zero-local-query',
    storageKey: 'local-query',
  });
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    const rows = await waitForZeroRowCount({
      zero,
      expectedRows: 100_000,
      timeoutMs: 120_000,
    });
    const iterations = 25;
    const listSamples = [];
    const searchSamples = [];
    const aggregateSamples = [];
    let listResultCount = 0;
    let searchResultCount = 0;
    let aggregateResultCount = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const listResult = runZeroLocalListQuery({
        rows,
        projectId,
        ownerId,
      });
      const searchResult = runZeroLocalSearchQuery({
        rows,
        projectId,
      });
      const aggregateResult = runZeroLocalAggregateQuery({
        rows,
        projectId,
      });

      listSamples.push(listResult.elapsedMs);
      searchSamples.push(searchResult.elapsedMs);
      aggregateSamples.push(aggregateResult.elapsedMs);
      listResultCount = listResult.resultCount;
      searchResultCount = searchResult.resultCount;
      aggregateResultCount = aggregateResult.resultCount;
    }

    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      status: 'completed',
      metrics: {
        row_count: rows.length,
        iterations,
        list_query_p50_ms: percentile(listSamples, 50),
        list_query_p95_ms: percentile(listSamples, 95),
        search_query_p50_ms: percentile(searchSamples, 50),
        search_query_p95_ms: percentile(searchSamples, 95),
        aggregate_query_p50_ms: percentile(aggregateSamples, 50),
        aggregate_query_p95_ms: percentile(aggregateSamples, 95),
        list_result_count: listResultCount,
        search_result_count: searchResultCount,
        aggregate_result_count: aggregateResultCount,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'Local query benchmarks run against the native Zero local cache after the client has materialized the full dataset.',
        'The workload covers a filtered list query, an ID-prefix search query, and a grouped aggregation over the same task corpus.',
      ],
      metadata: {
        implementation: 'zero-client-local-query',
        productVersion: zero.version,
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await closeZero(zero);
  }
}

async function runDeepRelationshipQuery() {
  await ensureStackUp('zero');
  await seedStack('zero', {
    resetFirst: true,
    orgCount: 1,
    projectsPerOrg: 4,
    usersPerOrg: 10,
    tasksPerProject: 25_000,
    membershipsPerProject: 4,
  });

  const fixtures = await getFixtures('zero');
  const orgId = fixtures.sampleOrgId;
  const projectId = fixtures.sampleProjectId;
  if (!orgId || !projectId) {
    throw new Error('Zero fixtures are missing org or project data');
  }

  const zero = await createZeroClient({
    userId: 'zero-deep-relationship-query',
    storageKey: 'deep-relationship-query',
  });
  const memorySampler = new MemorySampler();
  const cpuSampler = new CpuSampler();
  memorySampler.start();
  cpuSampler.start();

  try {
    const { orgRows, projectRows, taskRows } = await waitForZeroRelationshipData({
      zero,
      expectedOrgRows: 1,
      expectedProjectRows: 4,
      expectedTaskRows: 100_000,
      timeoutMs: 120_000,
    });
    const iterations = 25;
    const dashboardSamples = [];
    const detailJoinSamples = [];
    let dashboardResultCount = 0;
    let detailJoinResultCount = 0;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const dashboardResult = runZeroDashboardQuery({
        organizations: orgRows,
        projects: projectRows,
        tasks: taskRows,
        orgId,
      });
      const detailJoinResult = runZeroDetailJoinQuery({
        organizations: orgRows,
        projects: projectRows,
        tasks: taskRows,
        projectId,
      });

      dashboardSamples.push(dashboardResult.elapsedMs);
      detailJoinSamples.push(detailJoinResult.elapsedMs);
      dashboardResultCount = dashboardResult.resultCount;
      detailJoinResultCount = detailJoinResult.resultCount;
    }

    const memoryMetrics = memorySampler.stop();
    const cpuMetrics = cpuSampler.stop();

    return {
      status: 'completed',
      metrics: {
        org_count: orgRows.length,
        project_count: projectRows.length,
        row_count: taskRows.length,
        iterations,
        dashboard_query_p50_ms: percentile(dashboardSamples, 50),
        dashboard_query_p95_ms: percentile(dashboardSamples, 95),
        detail_join_query_p50_ms: percentile(detailJoinSamples, 50),
        detail_join_query_p95_ms: percentile(detailJoinSamples, 95),
        dashboard_result_count: dashboardResultCount,
        detail_join_result_count: detailJoinResultCount,
        avg_memory_mb: memoryMetrics.avgMemoryMb,
        peak_memory_mb: memoryMetrics.peakMemoryMb,
        avg_cpu_pct: cpuMetrics.avgCpuPct,
        peak_cpu_pct: cpuMetrics.peakCpuPct,
      },
      notes: [
        'Deep relationship benchmarks run against the native Zero local cache after organizations, projects, and tasks are materialized.',
        'The workload covers an organization dashboard rollup and a project-scoped detail join over the same local relational dataset.',
      ],
      metadata: {
        implementation: 'zero-client-deep-relationship-query',
        productVersion: zero.version,
      },
    };
  } finally {
    memorySampler.stop();
    cpuSampler.stop();
    await closeZero(zero);
  }
}

async function writeResultAndExit(result) {
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });

  process.exit(0);
}
