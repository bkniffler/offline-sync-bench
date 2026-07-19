import { spawnSync } from 'node:child_process';
import { benchmarkRoot } from '../paths';
import { ensureStackUp } from '../stack-manager';
import { getStack } from '../stacks';
import { createUnsupportedScenarioResult } from '../unsupported';
import type { BenchmarkAdapter, BenchmarkStatus, JsonValue } from '../types';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

type TanStackScenario =
  | 'bootstrap'
  | 'online-propagation'
  | 'offline-replay'
  | 'large-offline-queue'
  | 'local-query'
  | 'deep-relationship-query'
  | 'permission-change';

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

  async runBootstrap() {
    return runTanStackScenario('bootstrap');
  }

  async runOnlinePropagation() {
    return runTanStackScenario('online-propagation');
  }

  async runOfflineReplay() {
    return runTanStackScenario('offline-replay');
  }

  async runReconnectStorm() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: [
        'The Electric + TanStack DB reconnect-storm workload is not implemented yet; the raw Electric adapter covers the shared transport path.',
      ],
    });
  }

  async runLargeOfflineQueue() {
    return runTanStackScenario('large-offline-queue');
  }

  async runLocalQuery() {
    return runTanStackScenario('local-query');
  }

  async runDeepRelationshipQuery() {
    return runTanStackScenario('deep-relationship-query');
  }

  async runPermissionChange() {
    return runTanStackScenario('permission-change');
  }

  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: [
        'Electric + TanStack DB does not provide a native blob transport in this stack.',
      ],
    });
  }
}
