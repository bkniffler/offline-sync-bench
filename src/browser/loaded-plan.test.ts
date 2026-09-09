import { expect, test } from 'bun:test';
import { planLoadedCampaign, type LoadedConfig } from './loaded-plan.ts';
import { analyzeLoadedManifest } from './loaded-analysis.ts';

const config: LoadedConfig = { version: 1, purpose: 'diagnostic', method: 'browser-milestone-forwarding-v1',
  seed: 20260924, pairs: 5, trialTimeoutMs: 300000, stacks: ['electric', 'zero'],
  runtime: { kind: 'chromium', executable: '/Applications/Fixture.app/Contents/MacOS/Fixture', installationRoot: '/Applications/Fixture.app' },
  network: { id: 'local-loopback', injectedLatencyMs: 0, injectedLossPct: 0 }, stoppingRule: 'Five fixed pairs; no favorable retries.' };

test('loaded plan preserves adjacent pairs and covers both modes exactly once per pair', () => {
  const plan = planLoadedCampaign(config);
  expect(plan).toHaveLength(20);
  expect(plan).toEqual(planLoadedCampaign(config));
  expect(plan).not.toEqual(planLoadedCampaign({ ...config, seed: 20260925 }));
  const pairs = new Set<string>();
  for (let i = 0; i < plan.length; i += 2) {
    const [a, b] = plan.slice(i, i + 2);
    expect(a.stackId).toBe(b.stackId); expect(a.pair).toBe(b.pair);
    expect([a.order, b.order]).toEqual([1, 2]);
    expect([a.mode, b.mode].sort()).toEqual(['buffered', 'forwarded']);
    pairs.add(`${a.stackId}/${a.pair}`);
  }
  expect(pairs.size).toBe(10);
});

test('loaded diagnostic design rejects an expanded count, missing adapter or network change', () => {
  expect(() => planLoadedCampaign({ ...config, pairs: 6 })).toThrow('five pairs');
  expect(() => planLoadedCampaign({ ...config, stacks: ['electric'] })).toThrow('both browser');
  expect(() => planLoadedCampaign({ ...config, network: { ...config.network, injectedLatencyMs: 50 } } as any)).toThrow('controlled local');
  expect(() => planLoadedCampaign({ ...config, purpose: 'publication' } as any)).toThrow('purpose');
});

function failedFixture() {
  const plan = planLoadedCampaign(config), declared = Date.parse('2026-09-07T00:00:00Z');
  return { version: 1, method: config.method, id: 'synthetic-loaded-failures', status: 'complete', config, plan,
    startedAt: new Date(declared - 1000).toISOString(), declaredAt: new Date(declared).toISOString(),
    controller: { pid: 100, ppid: 1, pgid: 100, started: 'synthetic-controller' },
    finishedAt: new Date(declared + plan.length * 2000).toISOString(),
    attempts: plan.map((entry, i) => ({ ...entry, result: {
      version: 1, entry, runId: 'synthetic-loaded-failures', resultId: `failure-${i}`, status: 'failed', error: 'Synthetic condition failure', workerEntrypoint: 'src/browser/loaded-trial.ts',
      startedAt: new Date(declared + i * 2000).toISOString(), finishedAt: new Date(declared + i * 2000 + 1000).toISOString(), durationMs: 1000,
      processGroup: { pid: 20000 + i, emptyVerified: true, remaining: [], beforeTermination: [], signals: [],
        initial: [{ pid: 20000 + i, ppid: 100, pgid: 20000 + i, started: `synthetic-trial-${i}` }] }, evidence: null,
    } })),
  };
}

test('paired analysis retains all failed conditions without inventing zero overhead', () => {
  const analysis = analyzeLoadedManifest(failedFixture());
  for (const stack of analysis.summaries) {
    expect(stack.plannedPairs).toBe(5); expect(stack.completePairs).toBe(0);
    expect(stack.pairs.flatMap((p: any) => p.outcomes)).toHaveLength(10);
    for (const metric of Object.values(stack.metrics) as any[]) {
      expect(metric.pairs).toEqual([]); expect(metric.pairedDifferenceMs).toBeNull();
    }
  }
});

test('paired analysis rejects a missing attempt, reordered plan or unverified cleanup', () => {
  let m: any = failedFixture(); m.attempts.pop(); expect(() => analyzeLoadedManifest(m)).toThrow('incomplete');
  m = failedFixture(); [m.attempts[0], m.attempts[1]] = [m.attempts[1], m.attempts[0]];
  expect(() => analyzeLoadedManifest(m)).toThrow('declared order');
  m = failedFixture(); m.attempts[0].result.processGroup.emptyVerified = false;
  expect(() => analyzeLoadedManifest(m)).toThrow('cleanup');
  m = failedFixture(); m.finishedAt = m.declaredAt;
  expect(() => analyzeLoadedManifest(m)).toThrow('final attempt');
  m = failedFixture(); m.attempts[1].result.processGroup = structuredClone(m.attempts[0].result.processGroup);
  expect(() => analyzeLoadedManifest(m)).toThrow('process identity reused');
  m = failedFixture(); m.attempts[0].result.workerEntrypoint = 'fixture-worker.ts';
  expect(() => analyzeLoadedManifest(m)).toThrow('worker entrypoint');
});
