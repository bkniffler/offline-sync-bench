import { expect, test } from 'bun:test';
import { validateSeedIsolation } from './seeding-isolation.ts';
import type { JsonObject } from '../types.ts';

function proof(): JsonObject {
  return { productVersion: '2.0.0-alpha.53', validation: { taskCount: 100_000, tasksDigest: 'fixture-digest' },
    seedingIsolation: { method: 'separate-seed-process-v1',
      seeding: { pid: 101, parentPid: 100, store: '/tmp/seed.db', datasetId: 'local-fixture', exitCode: 0, exitSignal: null, edgeDurable: true, exitObservedBeforeReaderSpawn: true, taskCount: 100_000, tasksDigest: 'fixture-digest', productVersion: '2.0.0-alpha.53', completedAt: '2026-09-06T10:00:00Z', exitedAt: '2026-09-06T10:00:01Z' },
      reader: { pid: 102, parentPid: 100, store: '/tmp/reader.db', datasetId: 'local-fixture', startedAt: '2026-09-06T10:00:02Z' } },
    resources: { method: 'external-ps-process-tree-v1', rootPid: 102, includeRoot: true, samples: [0, 1].map(() => ({ processes: [{ pid: 102 }] })) },
  };
}
test('screen resource proof rejects retained seed processes, reused stores and unconfirmed remote seed data', () => {
  expect(() => validateSeedIsolation(proof())).not.toThrow();
  const edits: Array<(m: JsonObject, seed: JsonObject, reader: JsonObject) => void> = [
    (m, seed, reader) => { seed.pid = reader.pid; },
    (m, seed, reader) => { seed.store = reader.store; },
    (m, seed) => { seed.exitCode = null; },
    (m, seed) => { seed.exitObservedBeforeReaderSpawn = false; },
    (m, seed) => { seed.edgeDurable = false; },
    (m, seed) => { seed.tasksDigest = 'wrong-fixture'; },
    (m, seed, reader) => { reader.startedAt = '2026-09-06T09:59:59Z'; },
    (m, seed) => { seed.datasetId = 'different-dataset'; },
    m => { (m.resources as JsonObject).includeRoot = false; },
    m => { (((m.resources as JsonObject).samples as JsonObject[])[0].processes as JsonObject[]).push({ pid: 101 }); },
    m => { (((m.resources as JsonObject).samples as JsonObject[])[0].processes as JsonObject[]).push({ pid: 100 }); },
  ];
  for (const edit of edits) { const m = proof(), isolation = m.seedingIsolation as JsonObject; edit(m, isolation.seeding as JsonObject, isolation.reader as JsonObject); expect(() => validateSeedIsolation(m)).toThrow(); }
});
