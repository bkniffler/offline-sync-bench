import { startupSeed } from './contracts/startup.ts';
import type { BenchmarkResult } from './types.ts';
import { expect, test } from 'bun:test';
import { planCampaign, validateCampaign, validateConfiguredParameters, type CampaignConfig } from './campaign.ts';
import { groupAttempts, summarizeCase } from './campaign-report.ts';
import { trialSummary } from './statistics.ts';
import type { CampaignAttempt } from './campaign.ts';
const config: CampaignConfig = { version: 1, purpose: 'publication', seed: 99, trials: 5, trialTimeoutMs: 1000, stacks: ['syncular', 'electric'], scenarios: ['local-query', 'deep-relationship-query'], network: { id: 'local-loopback', injectedLatencyMs: 0, injectedLossPct: 0 }, stoppingRule: 'Run five independent trials' };
test('campaign plan is reproducible, complete, and shuffled within independent blocks', () => {
  const plan = planCampaign(config);
  expect(plan).toEqual(planCampaign(config)); expect(plan).toHaveLength(20);
  expect(plan).not.toEqual(planCampaign({ ...config, seed: 100 }));
  for (let trial = 1; trial <= 5; trial++) expect(new Set(plan.filter(p => p.trial === trial).map(p => `${p.stackId}/${p.scenarioId}`)).size).toBe(4);
});
test('publication rejects insufficient replication, duplicate cases and imaginary network shaping', () => {
  expect(() => validateCampaign({ ...config, trials: 3 })).not.toThrow();
  expect(() => validateCampaign({ ...config, trials: 2 })).toThrow('three');
  expect(() => validateCampaign({ ...config, trials: 1 })).toThrow('three');
  expect(() => validateCampaign({ ...config, stacks: ['syncular', 'syncular'] })).toThrow('duplicate');
  expect(() => validateCampaign({ ...config, network: { id: 'wan' } })).toThrow('implemented');
});
function attempt(trial: number, status: string, key = 'profile'): CampaignAttempt {
  return { trial, stackId: 'syncular', scenarioId: 'local-query', resultFile: `${trial}.json`, result: { status, metrics: { latency: 10 }, metadata: { profile: { comparisonKey: key, eligible: status === 'completed' } } } } as unknown as CampaignAttempt;
}
test('latest failure is never replaced by an older success', () => {
  const group = [attempt(1, 'completed'), attempt(2, 'failed')];
  expect(summarizeCase(group, 'latency')).toEqual({ status: 'failed', failures: 1, summary: null });
});
test('incompatible attempts cannot enter the same aggregate', () => {
  expect(() => groupAttempts([attempt(1, 'completed'), attempt(2, 'completed', 'changed-hardware-or-contract')])).toThrow('incompatible');
});
test('uncertainty uses independent trials and stays unavailable for too few trials', () => {
  expect(trialSummary([1, 2, 3]).confidence95).toBeNull();
  expect(trialSummary([2, 2, 2, 2, 2]).confidence95).toEqual([2, 2]);
  expect(trialSummary([1, 2, 3, 4, 5]).trials).toBe(5);
});


test('client-count parameters reject malformed values instead of falling back silently', () => {
  for (const clientCounts of [null, false, [], [1], [2, 2], [1001], [2.5], '5,25']) {
    expect(() => validateCampaign({ ...config, parameters: { clientCounts } } as unknown as CampaignConfig)).toThrow('client-count');
  }
  expect(() => validateCampaign({ ...config, parameters: { clientCounts: [5, 25] } })).not.toThrow();
});


test('startup campaign scales are declared, ordered and checked against actual results', () => {
  for (const startupSizes of [null, false, [], [1000, 1000], [100000, 1000], [2000], [1000001], [1000.5], '1000,500000']) {
    expect(() => validateCampaign({ ...config, parameters: { startupSizes } } as unknown as CampaignConfig)).toThrow('Startup sizes');
  }
  const sizes = [1000, 500000, 1000000];
  expect(() => validateCampaign({ ...config, parameters: { startupSizes: sizes } })).not.toThrow();
  const result = { metadata: { workloadContract: 'initial-startup-v1', startupSizes: sizes, fixture: sizes.map(startupSeed) } } as unknown as BenchmarkResult;
  expect(() => validateConfiguredParameters(result, { startupSizes: sizes })).not.toThrow();
  expect(() => validateConfiguredParameters(result)).toThrow('startup sizes');
  expect(() => validateConfiguredParameters({ ...result, metadata: { ...result.metadata, startupSizes: [1000] } }, { startupSizes: sizes })).toThrow('startup sizes');
});
