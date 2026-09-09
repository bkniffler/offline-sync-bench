import { Database } from 'bun:sqlite';
import { executeBenchmark, isFailed } from './execution';
import { createAdapter } from './adapters';
import { cleanupBenchmarkArtifacts } from './cleanup';
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
  case 'cleanup':
    await runCleanupCommand();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
}

// Adapters hold real product clients (WebSocket reconnect timers, keep-alive
// sockets, samplers); a stray handle must never zombie the CLI after the run
// finished and all results are on disk.
process.exit(process.exitCode ?? 0);

async function runCleanupCommand(): Promise<void> {
  const summary = await cleanupBenchmarkArtifacts();
  console.log(`removed_failed_runs=${summary.removedRunIds.length}`);
  for (const runId of summary.removedRunIds) {
    console.log(`run=${runId}`);
  }
  console.log(`removed_tmp_entries=${summary.removedTmpEntries.length}`);
  for (const entry of summary.removedTmpEntries) {
    console.log(`tmp=${entry}`);
  }
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
    console.log(
      `  support+: deep-query=${stack.capabilities.deepRelationshipQuery}`
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
  const stackId = parseOptionalStackFlag();
  if (!stackId) {
    throw new Error(
      `--stack must be one of: ${stacks.map((stack) => stack.id).join(', ')}`
    );
  }
  return stackId;
}

function parseOptionalStackFlag(): StackId | null {
  const stackId = parseFlag('--stack');
  if (stackId == null) {
    return null;
  }
  if (!stacks.some((stack) => stack.id === stackId)) {
    throw new Error(
      `--stack must be one of: ${stacks.map((stack) => stack.id).join(', ')}`
    );
  }
  return stackId as StackId;
}

function parseScenarioFlag(): ScenarioId {
  const scenarioId = parseFlag('--scenario');
  if (!scenarios.some(scenario => scenario.id === scenarioId)) throw new Error(`--scenario must be one of: ${scenarios.map(s => s.id).join(', ')}`);
  return scenarioId as ScenarioId;
}

async function executeScenario(args: {
  context: BenchmarkRunContext;
  adapter: BenchmarkAdapter;
  scenarioId: ScenarioId;
}): Promise<BenchmarkResult> {
  const result = await executeBenchmark(args.context, args.adapter, args.scenarioId);
  return { ...result, metadata: enrichResultMetadata(args.adapter.stack, args.scenarioId, result.metadata) };
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
    case 'offline-restart':
      return stack.capabilities.offlineRestart ?? 'not-implemented';
    case 'offline-replay':
      return stack.capabilities.offlineReplay;
    case 'reconnect-storm':
      return stack.capabilities.reconnectStorm;
    case 'large-offline-queue':
      return stack.capabilities.largeOfflineQueue;
    case 'local-query':
      return stack.capabilities.localQuery;
    case 'deep-relationship-query':
      return stack.capabilities.deepRelationshipQuery;
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
  if (isFailed(result.status)) process.exitCode = 1;
}

async function runAllCommand(): Promise<void> {
  const context = await createRunContext();
  const requestedStackId = parseOptionalStackFlag();
  const scenarioIds = scenarios.map(scenario => scenario.id);
  const targetStacks = requestedStackId
    ? stacks.filter((stack) => stack.id === requestedStackId)
    : stacks;
  const results: BenchmarkResult[] = [];

  for (const stack of targetStacks) {
    const adapter = createAdapter(stack.id);
    for (const scenarioId of scenarioIds) {
      console.log(`[run-all] ${stack.id} ${scenarioId}`);
      const result = await executeScenario({ context, adapter, scenarioId });
      results.push(result);
      if (isFailed(result.status)) process.exitCode = 1;
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
