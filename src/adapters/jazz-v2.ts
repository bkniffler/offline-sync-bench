import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { benchmarkRoot, tempRoot } from '../paths';
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

type JazzScenario =
  | 'bootstrap'
  | 'online-propagation'
  | 'offline-replay'
  | 'large-offline-queue'
  | 'local-query';

async function runJazzScenario(scenario: JazzScenario): Promise<RunnerResult> {
  await ensureStackUp('jazz-v2');
  const scenarioDir = join(tempRoot, `jazz-v2-${scenario}`);
  rmSync(scenarioDir, { recursive: true, force: true });

  const result = spawnSync('node', ['src/adapters/jazz-v2-runner.ts', scenario], {
    cwd: benchmarkRoot,
    encoding: 'utf8',
    timeout: 1_800_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  rmSync(scenarioDir, { recursive: true, force: true });

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
  return JSON.parse(lastLine) as RunnerResult;
}

export class JazzV2BenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('jazz-v2');

  async runBootstrap() {
    return runJazzScenario('bootstrap');
  }
  async runOnlinePropagation() {
    return runJazzScenario('online-propagation');
  }
  async runOfflineReplay() {
    return runJazzScenario('offline-replay');
  }
  async runReconnectStorm() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Reconnect storm is not implemented for the Jazz v2 alpha adapter.'],
    });
  }
  async runLargeOfflineQueue() {
    return runJazzScenario('large-offline-queue');
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
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Row-policy revocation is not implemented for the Jazz v2 alpha adapter.'],
    });
  }
  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Jazz v2 file storage exists, but the benchmark blob-flow adapter is not implemented.'],
    });
  }
}
