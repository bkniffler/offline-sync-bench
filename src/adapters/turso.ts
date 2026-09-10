import { noNativeAttachmentsReason } from '../native-support.ts';
import { runFanout } from '../fanout/run.ts';
import { runStartup } from '../startup/run.ts';
import { runReopen } from '../recovery/reopen.ts';
import { runConflicts } from '../recovery/conflicts.ts';
import { runRecovery } from '../recovery/run.ts';
import { spawnSync } from 'node:child_process';
import { benchmarkRoot } from '../paths';
import { getClientStack as getStack } from '../stacks';
import { createUnsupportedScenarioResult } from '../unsupported';
import type { BenchmarkAdapter, BenchmarkStatus, JsonValue } from '../types';

interface RunnerResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

type TursoScenario =
  | 'online-propagation'
  | 'local-query'
  | 'deep-relationship-query';

function runTursoScenario(scenario: TursoScenario): RunnerResult {
  const result = spawnSync(
    'bun',
    ['run', 'src/adapters/turso-runner.ts', scenario],
    {
      cwd: benchmarkRoot,
      encoding: 'utf8',
      timeout: 1_800_000,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (result.status !== 0 && result.signal !== 'SIGTERM') {
    throw new Error(
      `Turso runner failed for ${scenario}\n${result.stdout}\n${result.stderr}`
    );
  }

  const lastLine = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) {
    throw new Error(`Turso runner produced no output for ${scenario}`);
  }

  return JSON.parse(lastLine) as RunnerResult;
}

export class TursoBenchmarkAdapter implements BenchmarkAdapter {
  readonly stack = getStack('turso');

  async runBootstrap() { return runStartup('turso'); }

  async runOnlinePropagation() {
    return runTursoScenario('online-propagation');
  }

  async runReplicaReopen() { return runReopen('turso'); }

  async runConflictUpdateUpdate() { return runConflicts('turso', 'conflict-update-update'); }
  async runConflictUpdateDelete() { return runConflicts('turso', 'conflict-update-delete'); }

  async runOfflineRestart() { return runRecovery('turso', 'offline-restart'); }

  async runOfflineReplay() {
    return runRecovery('turso', 'offline-replay');
  }

  async runConnectedFanout() { return runFanout('turso', 'connected-fanout'); }

  async runReconnectStorm() { return runFanout('turso', 'reconnect-storm'); }

  async runLargeOfflineQueue() {
    return runRecovery('turso', 'large-offline-queue');
  }

  async runLocalQuery() {
    return runTursoScenario('local-query');
  }

  async runDeepRelationshipQuery() {
    return runTursoScenario('deep-relationship-query');
  }

  async runPermissionChange() {
    return createUnsupportedScenarioResult({
      implementation: 'unsupported',
      notes: [
        'The local Turso Sync server replicates a whole database and does not expose benchmark-equivalent row-level revocation.',
      ],
    });
  }

  async runBlobFlow() {
    return createUnsupportedScenarioResult({
      implementation: 'no-native-attachment-storage',
      coverage: 'unsupported-tested-configuration',
      notes: [noNativeAttachmentsReason],
    });
  }
}
