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

type TriplitScenario =
  | 'bootstrap'
  | 'online-propagation'
  | 'offline-replay'
  | 'large-offline-queue'
  | 'local-query'
  | 'deep-relationship-query';

async function runTriplitScenario(scenario: TriplitScenario): Promise<RunnerResult> {
  await ensureStackUp('triplit');
  const result = spawnSync('node', ['src/adapters/triplit-runner.ts', scenario], {
    cwd: benchmarkRoot,
    encoding: 'utf8',
    timeout: 1_800_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Triplit runner failed for ${scenario}\n${result.stdout}\n${result.stderr}`
    );
  }
  const lastLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) throw new Error(`Triplit runner produced no output for ${scenario}`);
  return JSON.parse(lastLine) as RunnerResult;
}

export class TriplitBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('triplit');

  async runBootstrap() {
    return runTriplitScenario('bootstrap');
  }
  async runOnlinePropagation() {
    return runTriplitScenario('online-propagation');
  }
  async runOfflineReplay() {
    return runTriplitScenario('offline-replay');
  }
  async runReconnectStorm() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Reconnect storm is not implemented for Triplit yet.'],
    });
  }
  async runLargeOfflineQueue() {
    return runTriplitScenario('large-offline-queue');
  }
  async runLocalQuery() {
    return runTriplitScenario('local-query');
  }
  async runDeepRelationshipQuery() {
    return runTriplitScenario('deep-relationship-query');
  }
  async runPermissionChange() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Permission-change convergence is not implemented for Triplit yet.'],
    });
  }
  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Triplit does not provide a benchmark-equivalent native blob transport.'],
    });
  }
}
