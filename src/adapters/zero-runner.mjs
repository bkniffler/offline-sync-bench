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
  tables: [tasks],
  enableLegacyQueries: false,
  enableLegacyMutators: false,
});

const zql = createBuilder(schema);

const queries = defineQueries({
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
  scenario !== 'offline-replay'
) {
  throw new Error('Expected scenario argument: bootstrap | online-propagation | offline-replay');
}

const result =
  scenario === 'bootstrap'
    ? await runBootstrap()
    : scenario === 'online-propagation'
      ? await runOnlinePropagation()
      : await runOfflineReplay();

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
