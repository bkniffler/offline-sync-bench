import { spawnSync } from 'node:child_process';
import { benchmarkRoot } from '../paths';
import { getStack } from '../stacks';
import type { BenchmarkAdapter, BenchmarkStatus, JsonValue } from '../types';
import { createUnsupportedScenarioResult } from '../unsupported';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

function runReplicacheScenario(
  scenario:
    | 'bootstrap'
    | 'online-propagation'
    | 'offline-replay'
    | 'reconnect-storm'
    | 'large-offline-queue'
    | 'local-query'
    | 'permission-change'
) {
  const result = spawnSync('bun', ['src/adapters/replicache-runner.ts', scenario], {
    cwd: benchmarkRoot,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0 && result.signal !== 'SIGTERM') {
    throw new Error(
      `Replicache runner failed for ${scenario}\n${result.stdout}\n${result.stderr}`
    );
  }

  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`Replicache runner produced no output for ${scenario}`);
  }

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error(`Replicache runner produced no JSON line for ${scenario}`);
  }

  return JSON.parse(lastLine) as RunnerResult;
}

export class ReplicacheBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('replicache');

  async runBootstrap() {
    return runReplicacheScenario('bootstrap');
  }

  async runOnlinePropagation() {
    return runReplicacheScenario('online-propagation');
  }

  async runOfflineReplay() {
    return runReplicacheScenario('offline-replay');
  }

  async runReconnectStorm() {
    return runReplicacheScenario('reconnect-storm');
  }

  async runLargeOfflineQueue() {
    return runReplicacheScenario('large-offline-queue');
  }

  async runLocalQuery() {
    return runReplicacheScenario('local-query');
  }

  async runDeepRelationshipQuery() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: [
        'Deep relationship querying is not implemented for Replicache in this harness yet.',
      ],
    });
  }

  async runPermissionChange() {
    return runReplicacheScenario('permission-change');
  }

  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Blob flow benchmarking is not implemented for Replicache in this harness yet.'],
    });
  }
}
