import { ACCESS_CONTRACT, ACCESS_REFRESH_CONTRACT, validateAccessResult } from './contracts/access.ts';
import { ATTACHMENT_CONTRACT, validateAttachmentResult } from './contracts/attachments.ts';
import { validateSeedIsolation } from './contracts/seeding-isolation.ts';
import { FANOUT_CONTRACT, validateFanoutResult } from './contracts/fanout.ts';
import { contractScenarios, hasScenarioContract } from './contracts/registry.ts';
import { STARTUP_CONTRACT, validateStartupResult } from './contracts/startup.ts';
import { validateReopenResult } from './contracts/reopen.ts';
import { validateConflictResult } from './contracts/conflicts.ts';
import { validateRecoveryResult } from './contracts/recovery-validation.ts';
import { createUnsupportedScenarioResult } from './unsupported.ts';
import { validateCollaborationResult, validateScreenResult } from './contracts/result-validation.ts';
import { validateBrowserResult } from './browser/validation.ts';
import { parseClientRouting, routingVariable } from './network/routing.ts';
import { randomUUID } from 'node:crypto';
import { takePowerSyncPreparations } from './powersync-preparation.ts';
import { ContractError } from './contracts/screens.ts';
import type { BenchmarkAdapter, BenchmarkResult, BenchmarkRunContext, BenchmarkStatus, ScenarioId } from './types.ts';

export const adapterMethods = {
  'connected-fanout': 'runConnectedFanout',
  'replica-reopen': 'runReplicaReopen', bootstrap: 'runBootstrap', 'online-propagation': 'runOnlinePropagation',
  'offline-replay': 'runOfflineReplay', 'offline-restart': 'runOfflineRestart', 'reconnect-storm': 'runReconnectStorm',
  'large-offline-queue': 'runLargeOfflineQueue', 'local-query': 'runLocalQuery',
  'deep-relationship-query': 'runDeepRelationshipQuery', 'permission-change': 'runPermissionChange',
  'blob-flow': 'runBlobFlow',
  'conflict-update-update': 'runConflictUpdateUpdate', 'conflict-update-delete': 'runConflictUpdateDelete',
} as const satisfies Record<ScenarioId, keyof BenchmarkAdapter>;

export function failureStatus(error: unknown): BenchmarkStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ContractError || message.includes('Invalid measurement:')) return 'invalid';
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(message)) return 'timed-out';
  return 'failed';
}

export function validateResult(result: Pick<BenchmarkResult, 'scenarioId' | 'status' | 'metrics' | 'metadata'> & Partial<Pick<BenchmarkResult, 'stackId'>>): void {
  if (result.status !== 'completed') return;
  const contract = result.metadata.workloadContract;
  if (typeof contract === 'string' && Object.hasOwn(contractScenarios, contract) && !hasScenarioContract(contract, result.scenarioId)) throw new ContractError('Workload contract does not match scenario');
  if (Object.values(result.metrics).some(value => value !== null && !Number.isFinite(value))) throw new ContractError('non-finite metric');
  if (result.metadata.clientRuntime === 'chromium') { validateBrowserResult(result); return; }
  if (contract === ATTACHMENT_CONTRACT) { validateAttachmentResult(result); return; }
  if ((result.metadata.workloadContract === ACCESS_CONTRACT || result.metadata.workloadContract === ACCESS_REFRESH_CONTRACT)) { validateAccessResult(result); return; }
  if (result.metadata.workloadContract === FANOUT_CONTRACT) { validateFanoutResult(result); return; }
  if (result.metadata.workloadContract === STARTUP_CONTRACT) { validateStartupResult(result); return; }
  if (result.scenarioId === 'replica-reopen') { validateReopenResult(result); return; }
  if (result.scenarioId.startsWith('conflict-')) {
    if (!result.stackId) throw new ContractError('Missing conflict stack identity');
    validateConflictResult({ ...result, stackId: result.stackId }); return;
  }
  if (result.metadata.workloadContract === 'offline-recovery-v2' || result.scenarioId === 'offline-restart') { validateRecoveryResult(result); return; }
  if (result.scenarioId === 'online-propagation') { validateCollaborationResult(result); return; }
  if (result.scenarioId === 'local-query' || result.scenarioId === 'deep-relationship-query') {
    validateScreenResult({ ...result, scenarioId: result.scenarioId });
    if (result.stackId === 'jazz-v2') validateSeedIsolation(result.metadata);
  }
}

/** One measurement boundary for success and failure, including adapter setup. */
export async function executeBenchmark(context: BenchmarkRunContext, adapter: BenchmarkAdapter, scenarioId: ScenarioId): Promise<BenchmarkResult> {
  if (adapter.stack.id === 'powersync') takePowerSyncPreparations();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const identity = { runId: context.runId, resultId: randomUUID(), stackId: adapter.stack.id, scenarioId, startedAt };
  const routing = parseClientRouting(process.env[routingVariable] ?? '');
  const routingMetadata: import('./types.ts').JsonObject = routing ? { clientRouting: routing as unknown as import('./types.ts').JsonObject } : {};
  try {
    const method = adapter[adapterMethods[scenarioId]];
    const outcome = method ? await method.call(adapter) : createUnsupportedScenarioResult({ implementation: 'missing-adapter-case', notes: [`${scenarioId} is not implemented for this adapter; no product capability conclusion is implied.`] });
    Object.assign(outcome.metadata, routingMetadata);
    if (adapter.stack.id === 'powersync') outcome.metadata.fixturePreparation ??= takePowerSyncPreparations();
    outcome.metadata.coverage ??= { status: outcome.status === 'unsupported' ? 'not-implemented' : 'implemented', reason: outcome.status === 'unsupported' ? outcome.notes.join(' ') : 'Adapter executed this case.' };
    const result = { ...identity, ...outcome, finishedAt: new Date().toISOString(), durationMs: performance.now() - started };
    try { validateResult(result); }
    catch (error) {
      // Preserve the adapter evidence when the harness rejects its success.
      // Invalid results remain ineligible, but investigators can inspect the
      // exact metrics, configuration and observations that failed validation.
      return { ...result, status: 'invalid' as const,
        notes: [...result.notes, error instanceof Error ? error.message : String(error)],
        metadata: { ...result.metadata, validationFailure: { reportedStatus: result.status, reason: error instanceof Error ? error.message : String(error) } } };
    }
    return result;
  } catch (error) {
    return { ...identity, status: failureStatus(error), finishedAt: new Date().toISOString(), durationMs: performance.now() - started,
      metrics: {}, notes: [error instanceof Error ? error.message : String(error)], metadata: { ...routingMetadata, ...(adapter.stack.id === 'powersync' ? { fixturePreparation: takePowerSyncPreparations() } : {}), implementation: 'benchmark-runner-error', ...(error instanceof Error && 'evidence' in error ? { evidence: error.evidence as import('./types.ts').JsonObject } : {}) } };
  }
}

export const isFailed = (status: BenchmarkStatus): boolean => ['failed', 'timed-out', 'invalid'].includes(status);
