import { expect, test } from 'bun:test';
import { measureCollaboration, collaborationSeed, pollUntil } from './collaboration.ts';
import { fixtureTasks } from './screens.ts';

test('reader visibility is recorded independently of later server acknowledgment', async () => {
  let visibleTitle = '';
  const result = await measureCollaboration({ localCommit: true, diagnostics: { fixture: 'test' }, readData: () => fixtureTasks(collaborationSeed),
    write: async (title, milestones) => { milestones.localCommitted(); visibleTitle = title; await Bun.sleep(4); milestones.serverAccepted(); },
    observe: (title, signal) => pollUntil(() => visibleTitle === title, signal),
  });
  expect(result.metadata.samples).toHaveLength(50);
  expect(result.metrics.local_commit_p50_ms).not.toBeNull();
  expect(result.metrics.mirror_visible_p50_ms!).toBeLessThan(result.metrics.server_accepted_p50_ms!);
  expect(result.metrics.mirror_visible_p99_ms).toBeUndefined();
});
test('local commit stays unavailable when the path exposes no local commit receipt', async () => {
  let titleSeen = '';
  const result = await measureCollaboration({ localCommit: false, diagnostics: {}, readData: () => fixtureTasks(collaborationSeed),
    write: async (title, milestones) => { titleSeen = title; milestones.serverAccepted(); },
    observe: (title, signal) => pollUntil(() => title === titleSeen, signal),
  });
  expect(result.metrics.local_commit_p50_ms).toBeNull();
  expect(result.metrics.server_accepted_p50_ms).toBeGreaterThanOrEqual(0);
});
test('incorrect bootstrap records cannot enter collaboration timings', async () => {
  await expect(measureCollaboration({ localCommit: false, diagnostics: {}, readData: () => [], write: async () => {}, observe: async () => {} })).rejects.toThrow('expected 200 rows');
});
