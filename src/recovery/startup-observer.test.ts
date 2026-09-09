import { expect, test } from 'bun:test';
import { observeBootstrap } from './startup-observer.ts';

test('startup exposes a correct screen before full sync and waits for complete data', async () => {
  const expected = [{ id: 'task-2', title: 'second' }];
  const events: string[] = [];
  let count = 0;
  const driver = {
    sync: async () => { await new Promise(r => setTimeout(r, 10)); count = 1; await new Promise(r => setTimeout(r, 25)); count = 2; },
    firstScreen: async () => count ? expected : [], count: async () => count, rows: async () => count === 2 ? [{ id: 'task-1' }, ...expected] : expected.slice(0, count),
  };
  const result = await observeBootstrap(driver, expected, 2, (event) => { events.push(event); if (event === 'first-screen') expect(count).toBe(1); });
  expect(events).toEqual(['first-screen', 'full-data']);
  expect(result.countQueries).toHaveLength(1);
  expect(result.fullSnapshot?.trigger).toBe('sync-complete');
  expect(result.observations.at(-1)).toMatchObject({ rows: 2, screenCorrect: true });
});

test('a full count cannot certify an incorrect startup screen; sync errors remain failures', async () => {
  await expect(observeBootstrap({ sync: async () => {}, count: async () => 1, rows: async () => [{ id: 'wrong' }], firstScreen: async () => [{ id: 'wrong' }] }, [{ id: 'right' }], 1, () => {})).rejects.toThrow('wrong screen');
  await expect(observeBootstrap({ sync: async () => { throw new Error('download failed'); }, count: async () => 0, rows: async () => [], firstScreen: async () => [] }, [{ id: 'right' }], 1, () => {})).rejects.toThrow('download failed');
});

test('startup timeouts retain partial progress and the last incorrect screen without reporting success', async () => {
  let calls = 0;
  try {
    await observeBootstrap({ sync: () => new Promise<void>(() => {}), count: async () => Math.min(++calls, 1),
      firstScreen: async () => [{ id: 'wrong' }], rows: async () => [] }, [{ id: 'correct' }], 2, () => {}, 15);
    throw new Error('Expected timeout');
  } catch (error) {
    expect(String(error)).toContain('Startup observation timed out');
    const { startupObservation: receipt } = (error as Error & { evidence: { startupObservation: Record<string, any> } }).evidence;
    expect(receipt.expectedRows).toBe(2); expect(receipt.timeoutMs).toBe(15);
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(15); expect(receipt.polls).toBeGreaterThan(0);
    expect(receipt.observations.at(-1)).toMatchObject({ rows: 1, screenCorrect: false });
    expect(receipt.firstScreen).toBe(false); expect(receipt.fullData).toBe(false); expect(receipt.syncFinished).toBe(false);
    expect(receipt.lastScreenMismatch).toContain('Invalid measurement');
  }
});


test('native completion prompts a snapshot without waiting for the next progress-count interval', async () => {
  let ready = false, counts = 0, screens = 0;
  const expected = [{ id: 'task' }];
  const result = await observeBootstrap({ sync: async () => { await new Promise(r => setTimeout(r, 25)); ready = true; },
    firstScreen: async () => { screens++; return expected; }, count: async () => { counts++; return 0; }, rows: async () => ready ? expected : [] }, expected, 1, () => {}, 1000);
  expect(counts).toBe(1); expect(screens).toBe(1);
  expect(result.fullSnapshot?.trigger).toBe('sync-complete');
  expect(result.fullSnapshot!.startMs).toBeGreaterThanOrEqual(result.syncCompletedAtMs!);
});

test('a complete local snapshot can precede the native sync-completion signal', async () => {
  let resolveSync!: () => void, fullBeforeSync = false;
  const expected = [{ id: 'task' }];
  const result = await observeBootstrap({ sync: () => new Promise<void>(r => { resolveSync = r; }), firstScreen: async () => expected,
    count: async () => 1, rows: async () => expected }, expected, 1, event => {
      if (event === 'full-data') { fullBeforeSync = true; resolveSync(); }
    });
  expect(fullBeforeSync).toBe(true); expect(result.fullSnapshot?.trigger).toBe('first-screen');
  expect(result.syncCompletedAtMs!).toBeGreaterThanOrEqual(result.fullSnapshot!.startMs + result.fullSnapshot!.durationMs);
});

test('native completion and full counts cannot certify a missing snapshot', async () => {
  await expect(observeBootstrap({ sync: async () => {}, firstScreen: async () => [{ id: 'task' }], count: async () => 1,
    rows: async () => [] }, [{ id: 'task' }], 1, () => {})).rejects.toThrow('full snapshot contains 0');
});

test('deadline bounds a stalled native query and a stalled final sync promise', async () => {
  const expected = [{ id: 'task' }];
  for (const mode of ['count', 'sync']) {
    const events: string[] = [];
    try {
      await observeBootstrap({ sync: () => new Promise<void>(() => {}), firstScreen: async () => expected,
        count: () => mode === 'count' ? new Promise<number>(() => {}) : Promise.resolve(1), rows: async () => mode === 'count' ? [] : expected },
        expected, 1, event => { events.push(event); }, 20);
      throw new Error('Expected bounded timeout');
    } catch (error) {
      expect(String(error)).toContain('Startup observation timed out');
      const receipt = (error as any).evidence.startupObservation;
      expect(receipt.syncFinished).toBe(false);
      expect(receipt.fullData).toBe(mode === 'sync');
      expect(receipt.pendingQuery?.kind ?? null).toBe(mode === 'count' ? 'progress-count' : null);
      expect(events).toEqual(mode === 'count' ? ['first-screen'] : ['first-screen', 'full-data']);
    }
  }
});


test('an early native marker with partial data waits for the correct screen and complete snapshot', async () => {
  let screenCalls = 0, snapshotCalls = 0;
  const expected = [{ id: 'task-2' }], events: string[] = [];
  const result = await observeBootstrap({ sync: async () => {},
    firstScreen: async () => ++screenCalls >= 4 ? expected : [],
    count: async () => 1, rows: async () => { snapshotCalls++; return screenCalls >= 4 ? [{ id: 'task-1' }, ...expected] : [{ id: 'task-1' }]; }
  }, expected, 2, event => events.push(event), 1000);
  expect(snapshotCalls).toBe(2);
  expect(result.countQueries).toHaveLength(1);
  expect(result.candidateSnapshots.map(c => [c.trigger, c.rows])).toEqual([['sync-complete', 1], ['first-screen', 2]]);
  expect(events).toEqual(['first-screen', 'full-data']);
  expect(result.fullSnapshot?.trigger).toBe('first-screen');
});

test('partial native and screen hints are captured once and cannot report full data', async () => {
  let snapshots = 0;
  try {
    await observeBootstrap({ sync: async () => {}, firstScreen: async () => [{ id: 'task' }],
      count: async () => 1, rows: async () => { snapshots++; return [{ id: 'task' }]; } },
      [{ id: 'task' }], 2, event => { expect(event).not.toBe('full-data'); }, 25);
    throw new Error('Expected timeout');
  } catch (error) {
    expect(String(error)).toContain('Startup observation timed out');
    expect(snapshots).toBe(2);
    expect((error as any).evidence.startupObservation.fullSnapshot).toBeNull();
  }
});

test('falsy native rejection reasons still fail immediately', async () => {
  await expect(observeBootstrap({ sync: async () => { throw null; }, count: async () => 0,
    firstScreen: async () => [], rows: async () => [] }, [{ id: 'task' }], 1, () => {}, 1000)).rejects.toThrow('null');
});
