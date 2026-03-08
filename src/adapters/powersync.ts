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

function runPowerSyncScenario(scenario: 'bootstrap' | 'online-propagation' | 'offline-replay') {
  const result = spawnSync(
    'node',
    ['--experimental-strip-types', 'src/adapters/powersync-runner.ts', scenario],
    {
      cwd: benchmarkRoot,
      encoding: 'utf8',
      timeout: 300_000,
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

  async runBootstrap() {
    return runPowerSyncScenario('bootstrap');
  }

  async runOnlinePropagation() {
    return runPowerSyncScenario('online-propagation');
  }

  async runOfflineReplay() {
    return runPowerSyncScenario('offline-replay');
  }

  async runReconnectStorm() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Reconnect storm is not implemented for PowerSync in this harness yet.'],
    });
  }

  async runLargeOfflineQueue() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Large offline queue replay is not implemented for PowerSync in this harness yet.'],
    });
  }

  async runLocalQuery() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Local query benchmarking is not implemented for PowerSync in this harness yet.'],
    });
  }

  async runPermissionChange() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: ['Permission-change convergence is not implemented for PowerSync in this harness yet.'],
    });
  }
}
