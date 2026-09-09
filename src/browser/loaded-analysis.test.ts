import { expect, test } from 'bun:test';
import { loadedConditionFixture } from '../test-fixtures/browser-loaded.ts';
import { planLoadedCampaign, type LoadedConfig } from './loaded-plan.ts';
import { analyzeLoadedManifest } from './loaded-analysis.ts';
import { browserBinding } from './provenance.ts';

const config: LoadedConfig = { version: 1, purpose: 'diagnostic', method: 'browser-milestone-forwarding-v1',
  seed: 20260924, pairs: 5, trialTimeoutMs: 300000, stacks: ['electric', 'zero'],
  runtime: { kind: 'chromium', executable: '/Applications/Fixture.app/Contents/MacOS/Fixture', installationRoot: '/Applications/Fixture.app' },
  network: { id: 'local-loopback', injectedLatencyMs: 0, injectedLossPct: 0 }, stoppingRule: 'Five fixed pairs; no favorable retries.' };

// No campaign provenance is claimed here. The pure statistics function is fed
// synthetic condition clocks atop native correctness fixtures; live artifacts
// must additionally pass verifyAndAnalyzeLoadedCampaign.
function fixture(effect = 1): any {
  const plan = planLoadedCampaign(config), declared = Date.parse('2026-09-07T00:00:00Z');
  const browser: any = { fingerprint: 'a'.repeat(64), installationFingerprint: 'b'.repeat(64), bundleSha256: 'c'.repeat(64), browserVersion: '' };
  const m: any = { version: 1, method: config.method, id: 'synthetic-loaded-successes', status: 'complete', config, plan,
    controller: { pid: 100, ppid: 1, pgid: 100, started: 'synthetic-controller' }, browser,
    startedAt: new Date(declared - 1000).toISOString(), declaredAt: new Date(declared).toISOString(),
    finishedAt: new Date(declared + plan.length * 2000).toISOString(), attempts: [] };
  for (const [index, entry] of plan.entries()) {
    const e = loadedConditionFixture(entry.stackId, entry.mode, index);
    browser.browserVersion ||= e.binding.browserVersion;
    e.binding = browserBinding(browser);
    if (entry.mode === 'forwarded') {
      for (const sample of e.operations) {
        sample.controller.totalMs += entry.pair * effect;
        sample.controller.finishedAtMs += entry.pair * effect;
      }
      for (const event of [...e.buffered.writer.events, ...e.forwardedEvents.filter((event: any) => event.role === 'writer')]) {
        event.data.browserAtMs += entry.pair * effect * (event.event === 'local' ? 0.25 : 0.5);
      }
      e.forwardedPayloadJsonBytes = e.forwardedEvents.reduce((sum: number, { event, data }: any) => sum + Buffer.byteLength(JSON.stringify({ event, data })), 0);
    }
    const root = structuredClone(e.clients[0].connection.parent);
    m.attempts.push({ ...entry, result: { version: 1, runId: m.id, resultId: `result-${index}`, entry, status: 'completed', error: null, exitCode: 0, workerEntrypoint: 'src/browser/loaded-trial.ts',
      startedAt: new Date(declared + index * 2000).toISOString(), finishedAt: new Date(declared + index * 2000 + 1000).toISOString(), durationMs: 1000,
      evidence: e, processGroup: { pid: root.pid, initial: [root], beforeTermination: [], signals: [], remaining: [], emptyVerified: true } } });
  }
  return m;
}

test('loaded analysis uses independent paired differences and preserves absent local acknowledgment', () => {
  const analysis = analyzeLoadedManifest(fixture());
  for (const stack of analysis.summaries) {
    expect(stack.completePairs).toBe(5);
    const controller = stack.metrics.controller_completion_p50_ms;
    expect(controller.pairs.map((p: any) => p.differenceMs)).toEqual([1, 2, 3, 4, 5]);
    expect(controller.pairedDifferenceMs.median).toBe(3);
    expect(controller.pairedDifferenceMs.trials).toBe(5);
    expect(controller.pairedDifferenceMs.confidence95).not.toBeNull();
    expect(stack.metrics.writer_acceptance_p50_ms.pairedDifferenceMs.median).toBe(1.5);
    if (stack.stackId === 'zero') expect(stack.metrics.writer_local_p50_ms.pairedDifferenceMs.median).toBe(0.75);
    else expect(stack.metrics.writer_local_p50_ms.pairedDifferenceMs).toBeNull();
  }
});

test('one failed condition removes its whole pair from timing estimates and retains its outcome', () => {
  const m = fixture();
  const failed = m.attempts.find((a: any) => a.stackId === 'electric' && a.pair === 3 && a.mode === 'forwarded').result;
  failed.status = 'failed'; failed.exitCode = 1; failed.error = 'Synthetic native failure'; failed.evidence = null;
  const electric = analyzeLoadedManifest(m).summaries.find((s: any) => s.stackId === 'electric');
  expect(electric.completePairs).toBe(4);
  expect(electric.metrics.controller_completion_p50_ms.pairs.map((p: any) => p.pair)).toEqual([1, 2, 4, 5]);
  expect(electric.metrics.controller_completion_p50_ms.pairedDifferenceMs.confidence95).toBeNull();
  expect(electric.pairs[2].outcomes.find((o: any) => o.mode === 'forwarded').status).toBe('failed');
});

test('a measured zero difference and a negative difference remain numeric', () => {
  for (const effect of [0, -1]) {
    const analysis = analyzeLoadedManifest(fixture(effect));
    for (const stack of analysis.summaries) {
      expect(stack.metrics.controller_completion_p50_ms.pairedDifferenceMs.median).toBe(3 * effect);
      expect(stack.metrics.controller_completion_p50_ms.pairedDifferenceMs.confidence95).not.toBeNull();
    }
  }
});

test('browser evidence cannot be moved to a different trial group', () => {
  const m = fixture(); m.attempts[0].result.evidence.clients[0].connection.parent.pid += 1;
  expect(() => analyzeLoadedManifest(m)).toThrow('browser parent');
});
