import { expect, test } from 'bun:test';
import { assertRows, arrayScreenQuery, fixtureTasks } from './screens.ts';
import { STARTUP_CONTRACT, startupConditions, startupObservationPolicy, startupFixture, startupKey, startupMemoryProfile, startupProfile, startupScreen, startupSeed, startupSizes, startupTaskRows, validateStartupSizes, validateStartupResult, validateStartupSnapshot } from './startup.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

function fixture(): Pick<BenchmarkResult, 'scenarioId' | 'metrics' | 'metadata'> {
  const metrics: Record<string, number> = {};
  const cases: JsonObject[] = [];
  for (const count of startupSizes) {
    const rows = fixtureTasks(startupSeed(count)), screen = startupScreen(count);
    expect(screen).toEqual(arrayScreenQuery('list', { tasks: rows }));
    for (const condition of startupConditions) {
      const key = startupKey(condition, count);
      for (const [i, milestone] of ['initialized', 'first_screen', 'full_data'].entries()) metrics[`${key}_${milestone}_ms`] = (i + 1) * 10;
      const state = { containerId: 'container', startedAt: '2026-09-06T10:00:00Z', running: true, health: 'healthy' };
      cases.push({ count, condition, pid: 10 + cases.length, store: key, storeAbsentBeforeLaunch: true,
        service: { before: { ...state, startedAt: condition === 'warm' ? state.startedAt : '2026-09-06T09:00:00Z' }, ready: state, after: state },
        resources: { method: 'external-ps-process-tree-v1', includeRoot: false, samples: [{ atMs: 0 }] },
        observation: { policy: startupObservationPolicy, polls: 2, syncFinished: true, syncCompletedAtMs: 5, screenQueries: 2, countQueries: [], candidateSnapshots: [{ startMs: 6, durationMs: 4, rows: count, trigger: 'sync-complete' }], fullSnapshot: { startMs: 6, durationMs: 4, rows: count, trigger: 'sync-complete' }, observations: [{ atMs: 10, rows: count, screenCorrect: true, kind: 'complete' }] },
        validation: { dataDigest: assertRows('expected', rows, rows), screenDigest: assertRows('screen', screen, screen), taskCount: count, pending: 0, rejected: null, conflicts: null },
      });
    }
  }
  return { scenarioId: 'bootstrap', metrics, metadata: { workloadContract: STARTUP_CONTRACT, fixture: startupFixture, startupProfile, cases, resources: { method: 'external-ps-process-tree-v1', includeRoot: false } } };
}

test('startup requires full data, fresh stores/processes and verified cold/warm service sequence', () => {
  const good = fixture(); expect(() => validateStartupResult(good)).not.toThrow();
  for (const corrupt of [
    (cases: JsonObject[]) => { (cases[0].validation as JsonObject).dataDigest = 'count-only'; },
    (cases: JsonObject[]) => { cases[1].pid = cases[0].pid; },
    (cases: JsonObject[]) => { cases[1].store = cases[0].store; },
    (cases: JsonObject[]) => { cases[0].storeAbsentBeforeLaunch = false; },
    (cases: JsonObject[]) => { ((cases[0].service as JsonObject).before as JsonObject).startedAt = '2026-09-06T10:00:00Z'; },
    (cases: JsonObject[]) => { ((cases[1].service as JsonObject).after as JsonObject).startedAt = '2026-09-06T10:01:00Z'; },
    (cases: JsonObject[]) => { (cases[0].observation as JsonObject).observations = []; },
    (cases: JsonObject[]) => { (cases[0].observation as JsonObject).policy = null; },
    (cases: JsonObject[]) => { (cases[0].observation as JsonObject).fullSnapshot = null; },
    (cases: JsonObject[]) => { (cases[0].observation as JsonObject).countQueries = [{ startMs: 0, durationMs: 1, rows: 0 }, { startMs: 5, durationMs: 1, rows: 0 }]; },
    (cases: JsonObject[]) => { (cases[0].observation as JsonObject).syncCompletedAtMs = 11; },
    (cases: JsonObject[]) => { cases.pop(); },
  ]) {
    const bad = structuredClone(good); corrupt(bad.metadata.cases as JsonObject[]);
    expect(() => validateStartupResult(bad)).toThrow('Invalid measurement');
  }
  const bad = structuredClone(good); bad.metrics.startup_warm_1000_first_screen_ms = 1;
  expect(() => validateStartupResult(bad)).toThrow('precedes initialization');
});

test('full startup validation accepts SDK enumeration order but still rejects missing, duplicate or corrupted records', () => {
  const original = fixtureTasks(startupSeed(1000)), shuffled = [...original].reverse();
  expect(validateStartupSnapshot(shuffled, 1000)).toBe(assertRows('expected', original, original));
  expect(shuffled[0].id).toBe(original.at(-1)!.id); // Validation did not mutate the captured snapshot.
  const missing = shuffled.slice(1); expect(() => validateStartupSnapshot(missing, 1000)).toThrow('Invalid measurement');
  const duplicate = [...shuffled]; duplicate[0] = duplicate[1];
  expect(() => validateStartupSnapshot(duplicate, 1000)).toThrow('Invalid measurement');
  const corrupt = structuredClone(shuffled); corrupt[0].title = 'wrong title';
  expect(() => validateStartupSnapshot(corrupt, 1000)).toThrow('Invalid measurement');
  const screen = startupScreen(1000);
  expect(() => assertRows('startup screen', [...screen].reverse(), screen)).toThrow('Invalid measurement');
});

test('memory startup validates the same outputs without inventing persistent store evidence', () => {
  const good = fixture();
  good.metadata.startupProfile = startupMemoryProfile;
  for (const [i, item] of (good.metadata.cases as JsonObject[]).entries()) {
    item.store = null; item.storeAbsentBeforeLaunch = null;
    item.cache = { id: `cache-${i}`, kind: 'memory', rows: 0, clientConstructed: true, syncStarted: true };
    item.diagnostics = { localStorage: 'electric-shape-memory', persistence: startupMemoryProfile.persistence, initialCache: item.cache };
  }
  expect(() => validateStartupResult(good)).not.toThrow();
  for (const corrupt of [
    (cases: JsonObject[]) => { cases[0].store = 'invented.sqlite'; },
    (cases: JsonObject[]) => { cases[0].storeAbsentBeforeLaunch = true; },
    (cases: JsonObject[]) => { (cases[0].cache as JsonObject).rows = 1; },
    (cases: JsonObject[]) => { (cases[0].cache as JsonObject).syncStarted = false; },
    (cases: JsonObject[]) => { cases[1].cache = cases[0].cache; },
    (cases: JsonObject[]) => { (cases[0].diagnostics as JsonObject).persistence = 'durable'; },
    (cases: JsonObject[]) => { (cases[0].validation as JsonObject).dataDigest = 'count-only'; },
  ]) {
    const bad = structuredClone(good); corrupt(bad.metadata.cases as JsonObject[]);
    expect(() => validateStartupResult(bad)).toThrow('Invalid measurement');
  }
  const bad = structuredClone(good); bad.metadata.startupProfile = startupProfile;
  expect(() => validateStartupResult(bad)).toThrow('fresh product store');
});

test('TanStack startup requires full persisted data as well as the active collection', () => {
  const good = { ...fixture(), stackId: 'electric-tanstack' as const };
  for (const [i, item] of (good.metadata.cases as JsonObject[]).entries()) {
    const initial = { collectionId: `collection-${i}`, store: item.store, activeRows: 0, persistedRows: 0 };
    item.diagnostics = { localStorage: 'tanstack-node-sqlite-cache', initialCache: initial };
    item.persistence = { initial, snapshot: { method: 'native-sqlite-adapter-scanRows', collectionId: initial.collectionId,
      store: item.store, activeRows: item.count, persistedRows: item.count, scans: 1 }, storeExists: true, storeBytes: 4096 };
    const validation = item.validation as JsonObject;
    validation.activeDataDigest = validation.dataDigest; validation.persistedDataDigest = validation.dataDigest;
  }
  expect(() => validateStartupResult(good)).not.toThrow();
  for (const corrupt of [
    (item: JsonObject) => { ((item.persistence as JsonObject).snapshot as JsonObject).persistedRows = 0; },
    (item: JsonObject) => { (item.validation as JsonObject).activeDataDigest = 'incorrect'; },
    (item: JsonObject) => { (item.validation as JsonObject).persistedDataDigest = 'incorrect'; },
    (item: JsonObject) => { ((item.persistence as JsonObject).initial as JsonObject).persistedRows = 1; },
    (item: JsonObject) => { (item.persistence as JsonObject).storeExists = false; },
    (item: JsonObject) => { ((item.persistence as JsonObject).snapshot as JsonObject).store = 'other.sqlite'; },
    (item: JsonObject) => { item.persistence = null; item.diagnostics = {}; },
  ]) {
    const bad = structuredClone(good); corrupt((bad.metadata.cases as JsonObject[])[0]);
    expect(() => validateStartupResult(bad)).toThrow('Invalid measurement');
  }
});


test('Zero startup requires empty native views and complete query receipts with matching identities', () => {
  const good = { ...fixture(), stackId: 'zero' as const };
  good.metadata.startupProfile = startupMemoryProfile;
  for (const [i, item] of (good.metadata.cases as JsonObject[]).entries()) {
    item.store = null; item.storeAbsentBeforeLaunch = null;
    item.cache = { id: `cache-${i}`, kind: 'memory', rows: 0, screenRows: 0, clientConstructed: true,
      kvStore: 'mem', storageKey: `cache-${i}`, nativeClientId: `native-${i}` };
    item.diagnostics = { localStorage: 'zero-memory', persistence: startupMemoryProfile.persistence, initialCache: item.cache };
    item.views = { all: 'complete', screen: 'complete', nativeClientId: `native-${i}` };
  }
  expect(() => validateStartupResult(good)).not.toThrow();
  for (const corrupt of [
    (cases: JsonObject[]) => { cases[0].store = 'invented.sqlite'; },
    (cases: JsonObject[]) => { (cases[0].cache as JsonObject).screenRows = 1; },
    (cases: JsonObject[]) => { (cases[0].cache as JsonObject).kvStore = 'idb'; },
    (cases: JsonObject[]) => { (cases[0].cache as JsonObject).storageKey = 'other'; },
    (cases: JsonObject[]) => { (cases[0].cache as JsonObject).clientConstructed = false; },
    (cases: JsonObject[]) => { (cases[0].views as JsonObject).all = 'unknown'; },
    (cases: JsonObject[]) => { (cases[0].views as JsonObject).screen = 'error'; },
    (cases: JsonObject[]) => { (cases[0].views as JsonObject).nativeClientId = 'other'; },
    (cases: JsonObject[]) => { cases[1].cache = cases[0].cache; },
    (cases: JsonObject[]) => { (cases[1].cache as JsonObject).nativeClientId = 'native-0'; (cases[1].views as JsonObject).nativeClientId = 'native-0'; },
    (cases: JsonObject[]) => { (cases[0].diagnostics as JsonObject).localStorage = 'electric-shape-memory'; (cases[0].cache as JsonObject).syncStarted = true; },
  ]) {
    const bad = structuredClone(good); corrupt(bad.metadata.cases as JsonObject[]);
    expect(() => validateStartupResult(bad)).toThrow('Invalid measurement');
  }
});

test('Jazz startup requires a separate durable seeder and native local reads in fresh files', () => {
  const good = { ...fixture(), stackId: 'jazz-v2' as const };
  const cases = good.metadata.cases as JsonObject[];
  for (const [i, item] of cases.entries()) {
    const datasetId = `startup-${item.count}-unique`, seedPid = 1000 + Math.floor(i / 2);
    item.seeding = { pid: seedPid, parentPid: 9, store: `seed-${datasetId}.db`, datasetId, taskCount: item.count,
      tasksDigest: (item.validation as JsonObject).dataDigest, edgeDurable: true, productVersion: 'alpha',
      completedAt: '2026-09-06T09:00:00Z', exitedAt: '2026-09-06T09:00:01Z', exitCode: 0, exitSignal: null, exitObservedBeforeReaderSpawn: true };
    item.diagnostics = { localStorage: 'jazz-napi-sqlite-file', productVersion: 'alpha', reader: { pid: item.pid, parentPid: 9, store: item.store,
      datasetId, startedAt: '2026-09-06T09:00:02Z', initialRows: 0, transportConnected: false } };
    const screenObservation = { method: 'native-sdk-subscription-manager-v1', initialScreenRows: 0, initialQueries: 1, subscriptions: 1 };
    (item.diagnostics as JsonObject).screenObservation = screenObservation;
    item.screenSubscription = { ...screenObservation, updates: 1, screenReads: 2, rows: 50, managerRows: 50 };
    item.nativeQuery = { edgeComplete: true, edgeRows: item.count }; item.file = { exists: true, bytes: 4096 };
    item.resources = { method: 'external-ps-process-tree-v1', includeRoot: false, rootPid: 9, samples: [{ atMs: 0, processes: [{ pid: item.pid }] }] };
  }
  expect(() => validateStartupResult(good)).not.toThrow();
  for (const corrupt of [
    (item: JsonObject) => { item.seeding = null; },
    (item: JsonObject) => { (item.seeding as JsonObject).tasksDigest = 'count-only'; },
    (item: JsonObject) => { (item.seeding as JsonObject).edgeDurable = false; },
    (item: JsonObject) => { (item.seeding as JsonObject).pid = item.pid; },
    (item: JsonObject) => { (item.seeding as JsonObject).exitCode = null; },
    (item: JsonObject) => { (item.seeding as JsonObject).exitedAt = '2026-09-06T10:00:00Z'; },
    (item: JsonObject) => { ((item.diagnostics as JsonObject).reader as JsonObject).initialRows = item.count; },
    (item: JsonObject) => { ((item.diagnostics as JsonObject).reader as JsonObject).datasetId = 'other'; },
    (item: JsonObject) => { item.screenSubscription = null; },
    (item: JsonObject) => { (item.screenSubscription as JsonObject).initialScreenRows = 50; },
    (item: JsonObject) => { (item.screenSubscription as JsonObject).initialQueries = 0; },
    (item: JsonObject) => { (item.screenSubscription as JsonObject).subscriptions = 0; },
    (item: JsonObject) => { (item.screenSubscription as JsonObject).updates = 0; },
    (item: JsonObject) => { (item.screenSubscription as JsonObject).screenReads = 1; },
    (item: JsonObject) => { (item.screenSubscription as JsonObject).rows = 49; },
    (item: JsonObject) => { (item.screenSubscription as JsonObject).managerRows = 0; },
    (item: JsonObject) => { ((item.diagnostics as JsonObject).screenObservation as JsonObject).method = 'fixture-cache'; },
    (item: JsonObject) => { (item.nativeQuery as JsonObject).edgeRows = 1; },
    (item: JsonObject) => { (item.nativeQuery as JsonObject).edgeComplete = false; },
    (item: JsonObject) => { (item.file as JsonObject).bytes = 0; },
    (item: JsonObject) => { (item.resources as JsonObject).samples = [{ processes: [{ pid: item.pid }, { pid: (item.seeding as JsonObject).pid }] }]; },
  ]) {
    const bad = structuredClone(good); corrupt((bad.metadata.cases as JsonObject[])[0]);
    expect(() => validateStartupResult(bad)).toThrow('Invalid measurement');
  }
});

test('startup accepts partial native hints but rejects unsupported or repeated snapshot claims', () => {
  const good = fixture(), item = (good.metadata.cases as JsonObject[])[0], count = Number(item.count);
  const observation = item.observation as JsonObject;
  observation.observations = [{ atMs: 8, rows: null, screenCorrect: true, kind: 'first-screen' }, { atMs: 10, rows: count, screenCorrect: true, kind: 'complete' }];
  observation.candidateSnapshots = [{ startMs: 6, durationMs: 1, rows: count - 1, trigger: 'sync-complete' }, { startMs: 8, durationMs: 2, rows: count, trigger: 'first-screen' }];
  observation.fullSnapshot = (observation.candidateSnapshots as JsonObject[])[1];
  expect(() => validateStartupResult(good)).not.toThrow();
  for (const corrupt of [
    (o: JsonObject) => { o.candidateSnapshots = []; },
    (o: JsonObject) => { (o.candidateSnapshots as JsonObject[])[0].rows = count; },
    (o: JsonObject) => { (o.candidateSnapshots as JsonObject[])[0].rows = count + 1; },
    (o: JsonObject) => { (o.candidateSnapshots as JsonObject[])[0].durationMs = 4; },
    (o: JsonObject) => { (o.observations as JsonObject[])[0].atMs = 9; },
    (o: JsonObject) => { (o.candidateSnapshots as JsonObject[])[1].trigger = 'sync-complete'; },
    (o: JsonObject) => { (o.candidateSnapshots as JsonObject[])[1].trigger = 'progress-count'; },
    (o: JsonObject) => { o.fullSnapshot = { ...(o.fullSnapshot as JsonObject), rows: count - 1 }; },
  ]) {
    const bad = structuredClone(good); corrupt(((bad.metadata.cases as JsonObject[])[0].observation as JsonObject));
    expect(() => validateStartupResult(bad)).toThrow('Invalid measurement');
  }
  const counted = structuredClone(good), o = (counted.metadata.cases as JsonObject[])[0].observation as JsonObject;
  (o.candidateSnapshots as JsonObject[])[1].trigger = 'progress-count';
  o.countQueries = [{ startMs: 7, durationMs: 1, rows: count }];
  expect(() => validateStartupResult(counted)).not.toThrow();
});


test('one-million startup validation handles the task ID width boundary without weakening output checks', () => {
  const count = 1_000_000, original = fixtureTasks(startupSeed(count));
  const sorted = startupTaskRows(count);
  expect(sorted.findIndex(row => row.id === 'org-1-project-1-task-1000000')).toBe(100000);
  expect(startupScreen(count)).toEqual(arrayScreenQuery('list', { tasks: original }));
  expect(validateStartupSnapshot(original, count)).toBe(assertRows('expected million tasks', sorted, sorted));
  original[999999].title = 'wrong millionth task';
  expect(() => validateStartupSnapshot(original, count)).toThrow('row 100000');
});

test('startup result validation binds custom scales to both ordered cases and fixture parameters', () => {
  const base = fixture(), cases = base.metadata.cases as JsonObject[];
  const custom = { ...base, metadata: { ...base.metadata, startupSizes: [1000], fixture: [startupSeed(1000)], cases: cases.slice(0, 2) } };
  expect(() => validateStartupResult(custom)).not.toThrow();
  expect(() => validateStartupResult({ ...custom, metadata: { ...custom.metadata, startupSizes: [500000] } })).toThrow('mismatch');
  expect(() => validateStartupResult({ ...custom, metadata: { ...custom.metadata, cases: cases.slice(0, 1) } })).toThrow('cases missing');
  expect(() => validateStartupSizes([1000, 1000000, 500000])).toThrow('ascending');
});
