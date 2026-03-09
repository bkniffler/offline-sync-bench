import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { createAdapter } from './adapters';
import { runBootstrapScenario } from './runners/bootstrap';
import { runBlobFlowScenario } from './runners/blob-flow';
import { runLargeOfflineQueueScenario } from './runners/large-offline-queue';
import { runLocalQueryScenario } from './runners/local-query';
import { runOfflineReplayScenario } from './runners/offline-replay';
import { runOnlinePropagationScenario } from './runners/online-propagation';
import { runPermissionChangeScenario } from './runners/permission-change';
import { runReconnectStormScenario } from './runners/reconnect-storm';
import { catalogPath } from './paths';
import { scenarios } from './scenarios';
import { stacks } from './stacks';
import { createRunContext, saveResult, writeSummary } from './store';
import type {
  BenchmarkAdapter,
  BenchmarkResult,
  BenchmarkRunContext,
  JsonObject,
  ScenarioId,
  StackId,
} from './types';
import {
  getBenchmarkEnvironmentMetadata,
  getStackVersionMetadata,
} from './version-metadata';

const command = Bun.argv[2] ?? 'plan';

switch (command) {
  case 'list-scenarios':
    printScenarios();
    break;
  case 'list-stacks':
    printStacks();
    break;
  case 'plan':
    printPlan();
    break;
  case 'run':
    await runSingleCommand();
    break;
  case 'run-all':
    await runAllCommand();
    break;
  case 'report':
    printCatalog();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
}

function printScenarios(): void {
  for (const scenario of scenarios) {
    console.log(`${scenario.id}: ${scenario.title}`);
    console.log(`  ${scenario.summary}`);
    console.log(`  metrics: ${scenario.primaryMetrics.join(', ')}`);
  }
}

function printStacks(): void {
  for (const stack of stacks) {
    console.log(`${stack.id}: ${stack.title}`);
    console.log(`  compose: ${stack.composeFile}`);
    console.log(
      `  support: bootstrap=${stack.capabilities.bootstrap}, online=${stack.capabilities.onlinePropagation}, offline=${stack.capabilities.offlineReplay}, reconnect=${stack.capabilities.reconnectStorm}, queue=${stack.capabilities.largeOfflineQueue}, query=${stack.capabilities.localQuery}, permission=${stack.capabilities.permissionChange}, blob=${stack.capabilities.blobFlow}`
    );
  }
}

function printPlan(): void {
  console.log('Benchmark scaffold');
  console.log('');
  printScenarios();
  console.log('');
  printStacks();
}

function parseFlag(flag: string): string | null {
  const index = Bun.argv.indexOf(flag);
  if (index === -1) return null;
  return Bun.argv[index + 1] ?? null;
}

function parseStackFlag(): StackId {
  const stackId = parseFlag('--stack');
  if (
    stackId !== 'syncular' &&
    stackId !== 'electric' &&
    stackId !== 'zero' &&
    stackId !== 'powersync' &&
    stackId !== 'replicache' &&
    stackId !== 'livestore'
  ) {
    throw new Error(
      '--stack must be one of: syncular, electric, zero, powersync, replicache, livestore'
    );
  }
  return stackId;
}

function parseScenarioFlag(): ScenarioId {
  const scenarioId = parseFlag('--scenario');
  if (
    scenarioId !== 'bootstrap' &&
    scenarioId !== 'online-propagation' &&
    scenarioId !== 'offline-replay' &&
    scenarioId !== 'reconnect-storm' &&
    scenarioId !== 'large-offline-queue' &&
    scenarioId !== 'local-query' &&
    scenarioId !== 'permission-change' &&
    scenarioId !== 'blob-flow'
  ) {
    throw new Error(
      '--scenario must be one of: bootstrap, online-propagation, offline-replay, reconnect-storm, large-offline-queue, local-query, permission-change, blob-flow'
    );
  }
  return scenarioId;
}

async function executeScenario(args: {
  context: BenchmarkRunContext;
  adapter: BenchmarkAdapter;
  scenarioId: ScenarioId;
}): Promise<BenchmarkResult> {
  try {
    const partialResult =
      args.scenarioId === 'bootstrap'
        ? await runBootstrapScenario(args.context, args.adapter)
        : args.scenarioId === 'online-propagation'
          ? await runOnlinePropagationScenario(args.context, args.adapter)
          : args.scenarioId === 'offline-replay'
            ? await runOfflineReplayScenario(args.context, args.adapter)
            : args.scenarioId === 'reconnect-storm'
              ? await runReconnectStormScenario(args.context, args.adapter)
              : args.scenarioId === 'large-offline-queue'
                ? await runLargeOfflineQueueScenario(args.context, args.adapter)
                : args.scenarioId === 'local-query'
                  ? await runLocalQueryScenario(args.context, args.adapter)
                  : args.scenarioId === 'permission-change'
                    ? await runPermissionChangeScenario(
                        args.context,
                        args.adapter
                      )
                    : await runBlobFlowScenario(args.context, args.adapter);

    return {
      ...partialResult,
      metadata: enrichResultMetadata(
        args.adapter.stack,
        args.scenarioId,
        partialResult.metadata
      ),
    };
  } catch (error) {
    const startedAt = new Date();
    const finishedAt = new Date();
    switch (args.scenarioId) {
      case 'bootstrap':
      case 'online-propagation':
      case 'offline-replay':
      case 'reconnect-storm':
      case 'large-offline-queue':
      case 'local-query':
      case 'permission-change':
      case 'blob-flow':
        return {
          runId: args.context.runId,
          resultId: randomUUID(),
          stackId: args.adapter.stack.id,
          scenarioId: args.scenarioId,
          status: 'failed',
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: 0,
          metrics: {},
          notes: [error instanceof Error ? error.message : String(error)],
          metadata: enrichResultMetadata(args.adapter.stack, args.scenarioId, {
            implementation: 'benchmark-runner-error',
          }),
        };
      default:
        throw new Error(`Unsupported scenario: ${args.scenarioId}`);
    }
  }
}

function enrichResultMetadata(
  stack: BenchmarkAdapter['stack'],
  scenarioId: ScenarioId,
  metadata: JsonObject
): JsonObject {
  const supportLevel = getScenarioSupportLevel(stack.id, scenarioId);
  const stackVersionMetadata = getStackVersionMetadata(stack);
  const benchmarkEnvironment = getBenchmarkEnvironmentMetadata();
  const enriched: JsonObject = {
    stackTitle: stack.title,
    supportLevel,
    benchmarkEnvironment,
    ...stackVersionMetadata,
    ...metadata,
  };

  if (
    typeof enriched.productVersion !== 'string' &&
    typeof stackVersionMetadata.frameworkVersion === 'string'
  ) {
    enriched.productVersion = stackVersionMetadata.frameworkVersion;
  }

  return enriched;
}

function getScenarioSupportLevel(stackId: StackId, scenarioId: ScenarioId): string {
  const stack = stacks.find((candidate) => candidate.id === stackId);
  if (!stack) {
    return 'unknown';
  }

  switch (scenarioId) {
    case 'bootstrap':
      return stack.capabilities.bootstrap;
    case 'online-propagation':
      return stack.capabilities.onlinePropagation;
    case 'offline-replay':
      return stack.capabilities.offlineReplay;
    case 'reconnect-storm':
      return stack.capabilities.reconnectStorm;
    case 'large-offline-queue':
      return stack.capabilities.largeOfflineQueue;
    case 'local-query':
      return stack.capabilities.localQuery;
    case 'permission-change':
      return stack.capabilities.permissionChange;
    case 'blob-flow':
      return stack.capabilities.blobFlow;
    default:
      return 'unknown';
  }
}

async function runSingleCommand(): Promise<void> {
  const stackId = parseStackFlag();
  const scenarioId = parseScenarioFlag();
  const adapter = createAdapter(stackId);
  const context = await createRunContext();
  const result = await executeScenario({ context, adapter, scenarioId });
  const filePath = await saveResult(context, result);
  await writeSummary(context, [result]);

  console.log(`runId=${context.runId}`);
  console.log(`result=${filePath}`);
  console.log(`status=${result.status}`);
}

async function runAllCommand(): Promise<void> {
  const context = await createRunContext();
  const scenarioIds: ScenarioId[] = [
    'bootstrap',
    'online-propagation',
    'offline-replay',
    'reconnect-storm',
    'large-offline-queue',
    'local-query',
    'permission-change',
    'blob-flow',
  ];
  const results: BenchmarkResult[] = [];

  for (const stack of stacks) {
    const adapter = createAdapter(stack.id);
    for (const scenarioId of scenarioIds) {
      console.log(`[run-all] ${stack.id} ${scenarioId}`);
      const result = await executeScenario({ context, adapter, scenarioId });
      results.push(result);
      await saveResult(context, result);
    }
  }

  const summaryPath = await writeSummary(context, results);
  console.log(`runId=${context.runId}`);
  console.log(`summary=${summaryPath}`);
  for (const result of results) {
    console.log(
      `${result.stackId} ${result.scenarioId} ${result.status} duration=${result.durationMs}ms`
    );
  }
}

function printCatalog(): void {
  const db = new Database(catalogPath, { create: true });
  const rows = db
    .query(
      `
        select
          run_id,
          stack_id,
          scenario_id,
          status,
          file_path,
          duration_ms,
          finished_at
        from results
        order by finished_at desc
      `
    )
    .all() as Array<{
    run_id: string;
    stack_id: string;
    scenario_id: string;
    status: string;
    file_path: string;
    duration_ms: number;
    finished_at: string;
  }>;
  db.close();

  for (const row of rows) {
    console.log(
      `${row.run_id} ${row.stack_id} ${row.scenario_id} ${row.status} duration=${row.duration_ms} file=${row.file_path} finished=${row.finished_at}`
    );
  }
}
