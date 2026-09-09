import { expect, test } from 'bun:test';
import { validateFanoutDelivery, validateFanoutNativeCase } from './fanout-native.ts';
import { fanoutMutations, fanoutReady, fanoutRows } from './fanout.ts';
import { assertRows } from './screens.ts';
import type { JsonObject } from '../types.ts';

function delivery(reconnect: boolean, method = 'zero-native-materialized-stream'): JsonObject {
  const state = (phase: number) => {
    const final = phase === 3, paused = reconnect && phase >= 2 ? 1 : 0, resumed = reconnect && final ? 1 : 0;
    const observes = phase === 0 ? 0 : final && !reconnect ? 2 : 1;
    return { protocolCalls: { init: 1, sync: 2, connectDelivery: phase ? 1 : 0, observeDelivery: observes, pauseDelivery: paused, resumeDelivery: resumed },
      delivery: { method, connects: phase ? 1 + resumed : 0, observations: observes + resumed, pauses: paused } };
  };
  return { initialState: state(0), readyState: state(1), ...(reconnect ? { offlineState: state(2) } : {}), finalState: state(3) };
}
test('fanout rejects controller catch-up hidden inside a connected or restored delivery', () => {
  for (const reconnect of [false, true]) {
    const good = delivery(reconnect);
    expect(() => validateFanoutDelivery(good, reconnect, 'zero')).not.toThrow();
    for (const key of ['sync', 'observe', 'write', 'connectDelivery', 'resumeDelivery']) {
      const bad = structuredClone(good), calls = (bad.finalState as JsonObject).protocolCalls as JsonObject;
      calls[key] = Number(calls[key] ?? 0) + 1;
      expect(() => validateFanoutDelivery(bad, reconnect, 'zero')).toThrow('protocol');
    }
    const bad = structuredClone(good); ((bad.finalState as JsonObject).delivery as JsonObject).observations = 1;
    expect(() => validateFanoutDelivery(bad, reconnect, 'zero')).toThrow('native delivery');
  }
});

test('Electric fanout validates fresh isolated caches and complete native auxiliary snapshots', () => {
  const finalChanges = [...fanoutReady, ...fanoutMutations('connected-fanout')];
  const digest = (changes: typeof fanoutReady) => { const rows = fanoutRows(changes); return assertRows('fixture', rows, rows); };
  const digests = { initial: digest([]), ready: digest(fanoutReady), final: digest(finalChanges) };
  const cache = (id: string) => ({ id, store: `${id}.sqlite`, rows: 0, pending: 0, reopened: false });
  const native = (id: string, changes: typeof fanoutReady, reader: boolean) => ({ method: 'application-sqlite-outbox-electric-shape-v1', cacheId: id, store: `${id}.sqlite`, queue: [], failure: null,
    auxiliaryRows: 2_000, auxiliaryDigest: digest(changes), attempts: reader ? [] : changes.map((m,i) => ({ taskId: m.id, status: 'success', txid: i + 1, serverAcceptedMs: 1, appliedMs: 2 })) });
  const phases = delivery(false, 'electric-shape-application-sqlite');
  const reader: JsonObject = { pid: 2, clientId: 'reader', store: 'reader.sqlite', cacheKind: 'benchmark-owned-persistent-file', diagnostics: { initialCache: cache('reader') },
    initialState: { ...native('reader', [], true), ...phases.initialState as JsonObject },
    readyState: { ...native('reader', fanoutReady, true), ...phases.readyState as JsonObject },
    finalState: { ...native('reader', finalChanges, true), ...phases.finalState as JsonObject } };
  const item: JsonObject = { writerPid: 1, writerDiagnostics: { initialCache: cache('writer') }, writerInitialState: native('writer', [], false), writerFinalState: native('writer', finalChanges, false), readers: [reader] };
  const check = (value: JsonObject) => validateFanoutNativeCase('electric', value, fanoutReady, finalChanges, digests, false);
  expect(() => check(item)).not.toThrow();
  for (const corrupt of [
    (r: JsonObject) => { (r.finalState as JsonObject).auxiliaryDigest = digests.ready; },
    (r: JsonObject) => { (r.finalState as JsonObject).cacheId = 'different-client'; },
    (r: JsonObject) => { ((r.diagnostics as JsonObject).initialCache as JsonObject).rows = 2_000; },
    (r: JsonObject) => { ((r.diagnostics as JsonObject).initialCache as JsonObject).store = 'writer.sqlite'; },
    (r: JsonObject) => { r.cacheKind = 'memory'; },
  ]) { const bad = structuredClone(item); corrupt((bad.readers as JsonObject[])[0]); expect(() => check(bad)).toThrow('Invalid measurement'); }
  const bad = structuredClone(item); (bad.writerFinalState as JsonObject).attempts = [];
  expect(() => check(bad)).toThrow('receipts incomplete');
});
