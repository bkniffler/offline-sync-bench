import { expect, test } from 'bun:test';
import { arrayScreenQuery, canonicalData, measureScreens, type ScreenCase } from './screens.ts';
import { collaborationSeed, measureCollaboration, pollUntil } from './collaboration.ts';
import { fixtureTasks } from './screens.ts';
import { validateCollaborationResult, validateScreenResult } from './result-validation.ts';
import type { JsonObject } from '../types.ts';

for (const scenarioId of ['local-query', 'deep-relationship-query'] as ScreenCase[]) test(`${scenarioId}: publication rejects altered fixture/output digests and invented summaries`, async () => {
  const data = canonicalData(scenarioId);
  const measured = await measureScreens(scenarioId, { readData: () => data, query: name => arrayScreenQuery(name, data), execution: 'application-processing' });
  const result = { scenarioId, ...measured };
  expect(() => validateScreenResult(result)).not.toThrow();
  const query = scenarioId === 'local-query' ? 'list' : 'dashboard';
  for (const corrupt of [
    (m: JsonObject) => { (m.validation as JsonObject).tasksDigest = 'plausible-but-not-the-fixture'; },
    (m: JsonObject) => { (m.fixture as JsonObject).tasksPerProject = 10_000; },
    (m: JsonObject) => { (m.outputDigests as JsonObject)[query] = 'wrong-order-or-values'; },
    (m: JsonObject) => { ((m.samples as JsonObject)[query] as number[])[0] = -1; },
    (m: JsonObject) => { m.resources = {}; },
  ]) {
    const bad = structuredClone(result); corrupt(bad.metadata);
    expect(() => validateScreenResult(bad)).toThrow('Invalid measurement');
  }
  const bad = structuredClone(result); bad.metrics[`${query}_query_p50_ms`] += 1;
  expect(() => validateScreenResult(bad)).toThrow('recorded samples');
  if (scenarioId === 'deep-relationship-query') {
    const bad = structuredClone(result); (bad.metadata.validation as JsonObject).projectsDigest = 'missing-project';
    expect(() => validateScreenResult(bad)).toThrow('materialization');
  }
});

test('collaboration verifies digests, receipt availability, sample identities and reported percentiles', async () => {
  let titleSeen = '';
  const measured = await measureCollaboration({ localCommit: false, diagnostics: {}, readData: () => fixtureTasks(collaborationSeed),
    write: async (title, milestones) => { titleSeen = title; await Bun.sleep(1); milestones.serverAccepted(); },
    observe: (title, signal) => pollUntil(() => titleSeen === title, signal),
  });
  const result = { scenarioId: 'online-propagation' as const, ...measured };
  expect(() => validateCollaborationResult(result)).not.toThrow();
  for (const corrupt of [
    (m: JsonObject) => { (m.validation as JsonObject).tasksDigest = 'unverified'; },
    (m: JsonObject) => { (m.fixture as JsonObject).projectsPerOrg = 2; },
    (m: JsonObject) => { (m.samples as JsonObject[])[1].iteration = 0; },
    (m: JsonObject) => { (m.samples as JsonObject[])[0].localCommitMs = 0; },
    (m: JsonObject) => { m.localCommitAvailable = true; },
  ]) {
    const bad = structuredClone(result); corrupt(bad.metadata);
    expect(() => validateCollaborationResult(bad)).toThrow('Invalid measurement');
  }
  const bad = structuredClone(result); bad.metrics.local_commit_p50_ms = 0;
  expect(() => validateCollaborationResult(bad)).toThrow('recorded samples');
  const badP99 = structuredClone(result); badP99.metrics.mirror_visible_p99_ms = 1;
  expect(() => validateCollaborationResult(badP99)).toThrow('p99');
});
