import { runFanout } from '../fanout/run.ts';
import { runAccess } from '../access/run.ts';
import { runConflicts } from '../recovery/conflicts.ts';
import { spawnSync } from 'node:child_process';
import { runRecovery } from '../recovery/run.ts';
import { runStartup } from '../startup/run.ts';
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

function runZeroScenario(
  scenario:
    | 'online-propagation'
    | 'local-query'
    | 'deep-relationship-query'
) {
  const result = spawnSync(
    'bun',
    ['src/adapters/zero-runner.mjs', scenario],
    {
      cwd: benchmarkRoot,
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (result.status !== 0 && result.signal !== 'SIGTERM') {
    throw new Error(
      `Zero runner failed for ${scenario}\n${result.stdout}\n${result.stderr}`
    );
  }

  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`Zero runner produced no output for ${scenario}`);
  }

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error(`Zero runner produced no JSON line for ${scenario}`);
  }

  return JSON.parse(lastLine) as RunnerResult;
}

export class ZeroBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('zero');

  async runBootstrap() {
    return runStartup('zero');
  }

  async runOnlinePropagation() {
    return runZeroScenario('online-propagation');
  }

  async runOfflineRestart() {
    return createUnsupportedScenarioResult({ implementation: 'zero-node-restart', coverage: 'unsupported-tested-configuration', notes: ['This Node adapter selects kvStore: mem, which cannot preserve queued writes after process termination. This says nothing about other Zero storage configurations.'] });
  }

  async runOfflineReplay() {
    return runRecovery('zero', 'offline-replay');
  }

  async runConnectedFanout() { return runFanout('zero', 'connected-fanout'); }

  async runConflictUpdateUpdate() { return runConflicts('zero', 'conflict-update-update'); }

  async runConflictUpdateDelete() { return runConflicts('zero', 'conflict-update-delete'); }

  async runReconnectStorm() { return runFanout('zero', 'reconnect-storm'); }

  async runLargeOfflineQueue() {
    return runRecovery('zero', 'large-offline-queue');
  }

  async runLocalQuery() {
    return runZeroScenario('local-query');
  }

  async runDeepRelationshipQuery() {
    return runZeroScenario('deep-relationship-query');
  }

  async runPermissionChange() {
    return runAccess('zero');
  }

  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Blob flow benchmarking is not implemented for Zero in this harness yet.'],
    });
  }
}
