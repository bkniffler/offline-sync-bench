import { expect, test } from 'bun:test';
import { assertRows } from './screens.ts';
import { recoverySeed } from './recovery.ts';
import { FANOUT_CONTRACT, fanoutRows, fanoutMutations, fanoutProfile, fanoutReady, validateFanoutResult } from './fanout.ts';
import { validateConfiguredParameters } from '../campaign.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

function fixture() {
  const digest = (rows: ReturnType<typeof fanoutRows>) => assertRows('expected', rows, rows);
  const initial = digest(fanoutRows([])), ready = digest(fanoutRows(fanoutReady)), final = digest(fanoutRows([...fanoutReady, ...fanoutMutations('reconnect-storm')]));
  const blocked = { blocked: true, rejectedConnections: 0, forwardedConnections: 2, requestBytes: 100, responseBytes: 200 };
  return { scenarioId: 'reconnect-storm' as const, metrics: { clients_2_all_converged_ms: 20, clients_2_p50_ms: 10, clients_2_p95_ms: 20 }, metadata: {
    workloadContract: FANOUT_CONTRACT, fixture: { seed: recoverySeed, clientCounts: [2] }, deliveryProfile: fanoutProfile('reconnect-storm'),
    cases: [{ clientCount: 2, status: 'completed', writerPid: 2, initialWriterDigest: initial, readinessWriterDigest: ready, finalWriterDigest: final, backlogCount: 100, healthyWitnessDigest: final,
      readers: [10, 20].map((completedMs, i) => ({ pid: 10 + i, store: `reader-${i}.sqlite`, clientId: `client-${i}`,  initialDigest: initial, readyDigest: ready, offlineDigest: ready, finalDigest: final, completedMs,
        initialState: { protocolCalls: { init: 1, sync: 1 } },
        readyState: { protocolCalls: { init: 1, sync: 1, connectDelivery: 1, observeDelivery: 1 } },
        offlineState: { protocolCalls: { init: 1, sync: 1, connectDelivery: 1, observeDelivery: 1, pauseDelivery: 1 } },
        finalState: { protocolCalls: { init: 1, sync: 1, connectDelivery: 1, observeDelivery: 1, pauseDelivery: 1, resumeDelivery: 1 } },
        outage: { before: blocked, after: { ...blocked, rejectedConnections: 1 } } })),
      resources: { method: 'external-ps-process-tree-v1', includeRoot: false, samples: [{}, {}] }, serverResources: { method: 'docker-engine-stats-v1', samples: [{}, {}] }, serviceIdentitiesBefore: [{ id: 'sync-container', label: 'sync', running: true, startedAt: '2026-09-06T09:00:00Z' }], serviceIdentitiesAfter: [{ id: 'sync-container', label: 'sync', running: true, startedAt: '2026-09-06T09:00:00Z' }], serverBefore: { containerId: 'sync-container', running: true, health: 'healthy', startedAt: '2026-09-06T09:00:00Z' }, serverAfter: { containerId: 'sync-container', running: true, health: 'healthy', startedAt: '2026-09-06T09:00:00Z' },
    }],
  } };
}
test('reconnect requires a real stale backlog, all readers and matching per-client summaries', () => {
  const good = fixture(); expect(() => validateFanoutResult(good)).not.toThrow();
  for (const corrupt of [
    (c: JsonObject) => { c.backlogCount = 1; },
    (c: JsonObject) => { c.healthyWitnessDigest = 'unconfirmed-server-write'; },
    (c: JsonObject) => { (c.readers as JsonObject[])[0].offlineDigest = c.finalWriterDigest; },
    (c: JsonObject) => { (c.readers as JsonObject[]).pop(); },
    (c: JsonObject) => { (c.readers as JsonObject[])[1].pid = 10; },
    (c: JsonObject) => { (c.readers as JsonObject[])[0].finalDigest = 'only-last-row-checked'; },
    (c: JsonObject) => { (c.resources as JsonObject).includeRoot = true; },
    (c: JsonObject) => { (((c.readers as JsonObject[])[0].finalState as JsonObject).protocolCalls as JsonObject).sync = 2; },
  ]) {
    const bad = structuredClone(good); corrupt(bad.metadata.cases[0]);
    expect(() => validateFanoutResult(bad)).toThrow('Invalid measurement');
  }
  const bad = structuredClone(good); bad.metrics.clients_2_all_converged_ms = 1;
  expect(() => validateFanoutResult(bad)).toThrow('summaries');
  expect(() => validateConfiguredParameters(good as unknown as BenchmarkResult, { clientCounts: [5] })).toThrow('campaign parameters');
});
