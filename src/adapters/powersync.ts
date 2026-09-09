import { ensureStackUp } from '../stack-manager.ts';
import { runAccess } from '../access/run.ts';
import { runFanout } from '../fanout/run.ts';
import { runStartup } from '../startup/run.ts';
import { runReopen } from '../recovery/reopen.ts';
import { runConflicts } from '../recovery/conflicts.ts';
import { runRecovery } from '../recovery/run.ts';
import { spawnSync } from 'node:child_process';
import { benchmarkRoot } from '../paths';
import { getClientStack as getStack } from '../stacks';
import type { BenchmarkAdapter, BenchmarkStatus, JsonValue } from '../types';
import { createUnsupportedScenarioResult } from '../unsupported';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

async function runPowerSyncScenario(
  scenario:
    | 'online-propagation'
    | 'local-query'
    | 'deep-relationship-query'
) {
  await ensureStackUp('powersync');
  const result = spawnSync(
    'node',
    ['--experimental-strip-types', 'src/adapters/powersync-runner.ts', scenario],
    {
      cwd: benchmarkRoot,
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (result.status !== 0 && result.signal !== 'SIGTERM') {
    throw new Error(
      `PowerSync runner failed for ${scenario}\n${result.stdout}\n${result.stderr}`
    );
  }

  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`PowerSync runner produced no output for ${scenario}`);
  }

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error(`PowerSync runner produced no JSON line for ${scenario}`);
  }

  return JSON.parse(lastLine) as RunnerResult;
}

export class PowerSyncBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('powersync');

  async runBootstrap() { return runStartup('powersync'); }

  async runOnlinePropagation() {
    return runPowerSyncScenario('online-propagation');
  }

  async runReplicaReopen() { return runReopen('powersync'); }

  async runConflictUpdateUpdate() { return runConflicts('powersync', 'conflict-update-update'); }
  async runConflictUpdateDelete() { return runConflicts('powersync', 'conflict-update-delete'); }

  async runOfflineRestart() { return runRecovery('powersync', 'offline-restart'); }

  async runOfflineReplay() {
    return runRecovery('powersync', 'offline-replay');
  }

  async runConnectedFanout() { return runFanout('powersync', 'connected-fanout'); }

  async runReconnectStorm() { return runFanout('powersync', 'reconnect-storm'); }

  async runLargeOfflineQueue() {
    return runRecovery('powersync', 'large-offline-queue');
  }

  async runLocalQuery() {
    return runPowerSyncScenario('local-query');
  }

  async runDeepRelationshipQuery() {
    return runPowerSyncScenario('deep-relationship-query');
  }

  async runPermissionChange() {
    return runAccess('powersync');
  }

  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Blob flow benchmarking is not implemented for PowerSync in this harness yet.'],
    });
  }
}
