import { runConflicts } from '../recovery/conflicts.ts';
import { runFanout } from '../fanout/run.ts';
import { runRecovery } from '../recovery/run.ts';
import { runReopen } from '../recovery/reopen.ts';
import { runAccess } from '../access/run.ts';
import { runStartup } from '../startup/run.ts';
import { spawnSync } from 'node:child_process';
import { benchmarkRoot } from '../paths';
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

type TanStackScenario =
  | 'online-propagation'
  | 'local-query'
  | 'deep-relationship-query';

async function runTanStackScenario(
  scenario: TanStackScenario
): Promise<RunnerResult> {
  await ensureStackUp('electric-tanstack');
  const result = spawnSync(
    'node',
    ['src/adapters/electric-tanstack-runner.ts', scenario],
    {
      cwd: benchmarkRoot,
      encoding: 'utf8',
      timeout: 1_800_000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (result.status !== 0 && result.signal !== 'SIGTERM') {
    throw new Error(
      `Electric + TanStack DB runner failed for ${scenario}\n${result.stdout}\n${result.stderr}`
    );
  }

  const lastLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) {
    throw new Error(
      `Electric + TanStack DB runner produced no output for ${scenario}`
    );
  }

  return JSON.parse(lastLine) as RunnerResult;
}

export class ElectricTanStackBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('electric-tanstack');

  async runConflictUpdateUpdate() { return runConflicts('electric-tanstack', 'conflict-update-update'); }
  async runConflictUpdateDelete() { return runConflicts('electric-tanstack', 'conflict-update-delete'); }

  async runReplicaReopen() { return runReopen('electric-tanstack'); }

  async runBootstrap() {
    return runStartup('electric-tanstack');
  }

  async runOnlinePropagation() {
    return runTanStackScenario('online-propagation');
  }

  async runOfflineRestart() {
    return createUnsupportedScenarioResult({ implementation: 'electric-tanstack-node-restart', coverage: 'unsupported-tested-configuration', notes: ['The current Node offline executor uses fake-indexeddb, whose queue is in process memory. SQLite collection persistence does not make that executor queue survive process termination. A browser IndexedDB profile remains to be implemented.'] });
  }

  async runOfflineReplay() {
    return runRecovery('electric-tanstack', 'offline-replay');
  }

  async runConnectedFanout() { return runFanout('electric-tanstack', 'connected-fanout'); }

  async runReconnectStorm() { return runFanout('electric-tanstack', 'reconnect-storm'); }

  async runLargeOfflineQueue() {
    return runRecovery('electric-tanstack', 'large-offline-queue');
  }

  async runLocalQuery() {
    return runTanStackScenario('local-query');
  }

  async runDeepRelationshipQuery() {
    return runTanStackScenario('deep-relationship-query');
  }

  async runPermissionChange() { return runAccess('electric-tanstack'); }

  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: [
        'Electric + TanStack DB does not provide a native blob transport in this stack.',
      ],
    });
  }
}
