import { runConflicts } from '../recovery/conflicts.ts';
import { runJazzAccess } from '../access/jazz-run.ts';
import { runFanout } from '../fanout/run.ts';
import { runRecovery } from '../recovery/run.ts';
import { runReopen } from '../recovery/reopen.ts';
import { runStartup } from '../startup/run.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { benchmarkRoot, tempRoot } from '../paths';
import { ensureStackUp } from '../stack-manager';
import { getClientStack as getStack } from '../stacks';
import { createUnsupportedScenarioResult } from '../unsupported';
import type { BenchmarkAdapter, BenchmarkStatus, JsonValue } from '../types';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

type JazzScenario =
  | 'online-propagation'
  | 'offline-replay'
  | 'large-offline-queue'
  | 'local-query';

async function runJazzScenario(scenario: JazzScenario): Promise<RunnerResult> {
  await ensureStackUp('jazz-v2');
  mkdirSync(tempRoot, { recursive: true });
  const scenarioDir = mkdtempSync(join(tempRoot, `jazz-v2-${scenario}-`));
  try {
    if (scenario === 'local-query') {
      const datasetId = `local-${randomUUID()}`;
      const seed = runProcess('seed-local-query', [datasetId, scenarioDir]);
      const receipt = seed.result.metadata.seedReceipt as Record<string, JsonValue>;
      if (seed.result.status !== 'completed' || receipt?.pid !== seed.pid) throw new Error('Jazz seeder completion identity mismatch');
      // spawnSync has observed process exit before the query client can start.
      const seeding = { ...receipt, exitCode: seed.exitCode, exitSignal: seed.exitSignal, exitedAt: new Date().toISOString(), exitObservedBeforeReaderSpawn: true };
      return runProcess(scenario, [datasetId, scenarioDir, JSON.stringify(seeding)]).result;
    }
    return runProcess(scenario, ['', scenarioDir]).result;
  } finally { rmSync(scenarioDir, { recursive: true, force: true }); }
}

function runProcess(scenario: JazzScenario | 'seed-local-query', args: string[]) {
  const result = spawnSync('node', ['src/adapters/jazz-v2-runner.ts', scenario, ...args], {
    cwd: benchmarkRoot,
    encoding: 'utf8',
    timeout: 1_800_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Jazz v2 runner failed for ${scenario}\n${result.stdout}\n${result.stderr}`
    );
  }
  const lastLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) throw new Error(`Jazz v2 runner produced no output for ${scenario}`);
  return { result: JSON.parse(lastLine) as RunnerResult, pid: result.pid, exitCode: result.status, exitSignal: result.signal };
}

export class JazzV2BenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('jazz-v2');

  async runConflictUpdateUpdate() { return runConflicts('jazz-v2', 'conflict-update-update'); }
  async runConflictUpdateDelete() { return runConflicts('jazz-v2', 'conflict-update-delete'); }

  async runReplicaReopen() { return runReopen('jazz-v2'); }

  async runBootstrap() {
    return runStartup('jazz-v2');
  }
  async runOnlinePropagation() {
    return runJazzScenario('online-propagation');
  }
  async runOfflineRestart() { return runRecovery('jazz-v2', 'offline-restart'); }
  async runOfflineReplay() {
    return runRecovery('jazz-v2', 'offline-replay');
  }
  async runConnectedFanout() { return runFanout('jazz-v2', 'connected-fanout'); }

  async runReconnectStorm() { return runFanout('jazz-v2', 'reconnect-storm'); }

  async runLargeOfflineQueue() {
    return runRecovery('jazz-v2', 'large-offline-queue');
  }
  async runLocalQuery() {
    return runJazzScenario('local-query');
  }
  async runDeepRelationshipQuery() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Deep relationship queries are not implemented for the Jazz v2 alpha adapter.'],
    });
  }
  async runPermissionChange() {
    return runJazzAccess();
  }
  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Jazz v2 file storage exists, but the benchmark blob-flow adapter is not implemented.'],
    });
  }
}
