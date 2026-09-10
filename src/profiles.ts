import type { BrowserIdentity } from './browser/provenance.ts';
import type { ConfigurationIdentity } from './configuration.ts';
import type { DependencyIdentity } from './dependencies.ts';
import { hasScenarioContract } from './contracts/registry.ts';
import { hash } from './contracts/screens.ts';
import type { BenchmarkResult, JsonObject } from './types.ts';

/** Profiles describe the tested path. They do not infer missing product capabilities. */
export function resultProfile(result: BenchmarkResult, campaign: { source: JsonObject; machine: JsonObject; network: JsonObject; images: JsonObject; executables?: JsonObject; browser?: BrowserIdentity; dependencies?: DependencyIdentity; configuration?: ConfigurationIdentity }): JsonObject {
  const storage = (result.metadata.diagnostics as JsonObject | undefined)?.localStorage ?? 'unspecified';
  const execution = result.metadata.queryExecution ?? 'unspecified';
  const contract = result.metadata.workloadContract ?? null;
  const knownContract = hasScenarioContract(contract, result.scenarioId);
  const browserBound = result.metadata.clientRuntime !== 'chromium' || Boolean(campaign.browser && (result.metadata.browserBinding as JsonObject)?.fingerprint === campaign.browser.fingerprint && (result.metadata.browserBinding as JsonObject)?.bundleSha256 === campaign.browser.bundleSha256);
  const executableProfile = campaign.executables ? structuredClone(campaign.executables) : undefined;
  const rustInputs = ((executableProfile?.rustDriver as JsonObject)?.build as JsonObject)?.inputs as JsonObject | undefined;
  if (rustInputs) delete rustInputs.path; // Artifact relocation does not change measured executable/build identity.
  const comparison = { ...((result.metadata.serverStorage as JsonObject)?.policy ? { serverStoragePolicy: (result.metadata.serverStorage as JsonObject).policy } : {}), ...(contract === 'offline-recovery-v2' ? { outagePolicy: result.metadata.outagePolicy ?? null } : {}), contract, fixture: result.metadata.fixture ?? null, network: campaign.network,
    machine: campaign.machine, ...(campaign.configuration ? { configurationHash: campaign.configuration.fingerprint } : {}), ...(campaign.dependencies ? { dependenciesHash: campaign.dependencies.fingerprint } : {}), ...(executableProfile ? { executablesHash: hash(executableProfile) } : {}), sourceHash: campaign.source.sourceHash, lane: `${result.stackId === 'jazz-v2' ? 'experimental' : 'stable'}-${result.metadata.clientRuntime === 'chromium' ? 'browser-chromium' : 'native-host'}`,
    ...(result.metadata.clientRuntime === 'chromium' ? { browser: campaign.browser ? { fingerprint: campaign.browser.fingerprint, version: campaign.browser.browserVersion, bundleSha256: campaign.browser.bundleSha256 } : null, timingBoundary: 'controller-monotonic-including-cdp-v1' } : {}),
    guarantee: contract === 'attachments-v1' ? result.metadata.attachmentProfile ?? 'unspecified' : ['access-revocation-v1', 'access-refresh-v1'].includes(String(contract)) ? result.metadata.accessProfile ?? 'unspecified' : contract === 'client-fanout-recovery-v1' ? result.metadata.deliveryProfile ?? 'unspecified' : contract === 'initial-startup-v1' ? result.metadata.startupProfile ?? 'unspecified' : contract === 'screens-v2' ? 'materialized-local-screen-output' : contract === 'collaboration-v2' ? 'local-commit/server-acceptance/independent-reader-visibility' : contract === 'offline-recovery-v2' ? result.metadata.guarantees ?? 'unspecified' : contract === 'conflicting-edits-v1' ? { policy: result.metadata.policy ?? 'unspecified', clientStorage: result.metadata.clientStorage ?? 'unspecified' } : contract === 'persisted-replica-reopen-v1' ? result.metadata.reopenProfile ?? 'unspecified' : 'legacy-unverified', sampling: { operations: result.metrics.iterations ?? null, warmup: result.metrics.warmup_iterations ?? null },
    ...(result.metadata.fixturePreparation ? { fixturePreparationPolicy: [...new Set((result.metadata.fixturePreparation as JsonObject[]).map(record => record.policy))] } : {}),
    measurement: (result.metadata.resources as JsonObject | undefined)?.method ?? null };
  return { ...comparison, comparisonKey: hash(comparison), storage, execution, observation: (result.metadata.diagnostics as JsonObject | undefined)?.reader ?? null,
    images: campaign.images[result.stackId] ?? null,
    eligible: result.status === 'completed' && knownContract && browserBound && comparison.measurement === 'external-ps-process-tree-v1',
    ineligibleReason: !knownContract ? 'Scenario has not yet passed the RFC measurement-contract migration.' : !browserBound ? 'Browser campaign provenance missing or mismatched.' : comparison.measurement !== 'external-ps-process-tree-v1' ? 'External resource measurement missing.' : result.status !== 'completed' ? 'Attempt did not pass.' : null };
}
