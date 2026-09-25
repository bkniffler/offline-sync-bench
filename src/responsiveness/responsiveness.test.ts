import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { arrayScreenQuery, fixtureTasks, screenQueries } from '../contracts/screens.ts';
import { startupSeed } from '../contracts/startup.ts';
import { taskScreenIndexes as contractIndexes } from '../contracts/screen-indexes.ts';
import { LIST_SQL, arrayScreen, countUpdated, powerSyncScreenIndexes, progressQuery, taskScreenIndexes } from './page/screen.ts';
import { assertInputsDelivered, summarizeWindow, type PageRecords } from './metrics.ts';
import { expectedScreen, ownerOf, ProcessSampler } from './run.ts';
import { aggregate } from './report.ts';

const empty = (): PageRecords => ({ frames: [], loaf: [], longTasks: [], inputs: [], eventTimings: [], iterations: [], milestones: [], now: 0 });

describe('browser-safe contract copies', () => {
  test('list screen, indexes and fixture owners match the shared contracts', () => {
    expect(LIST_SQL).toBe(screenQueries.list);
    expect(taskScreenIndexes).toEqual(contractIndexes);
    const runner = readFileSync('src/adapters/powersync-runner.ts', 'utf8');
    for (const statement of powerSyncScreenIndexes) expect(runner).toContain(statement);
    const tasks = fixtureTasks(startupSeed(1_000));
    for (const task of tasks) expect(ownerOf(String(task.id))).toBe(String(task.owner_id));
    expect(arrayScreen(tasks)).toEqual(arrayScreenQuery('list', { tasks }) as any);
    const rows = tasks.map(task => ({ id: String(task.id), title: String(task.title), completed: Number(task.completed) }));
    expect(expectedScreen(rows)).toEqual(arrayScreenQuery('list', { tasks }) as any);
  });

  test('progress counts prefixed titles only', () => {
    expect(countUpdated([{ title: 'catchup-1-a' }, { title: 'Task 1' }, { title: 'catchup-2-a' }], 'catchup-1-')).toBe(1);
    expect(countUpdated([{ title: 'catchup-1-a' }], null)).toBe(0);
    expect(progressQuery('catchup-1-')[1]).toEqual([10, 'catchup-1-']);
  });
});

describe('window metrics', () => {
  test('frame gaps, blocking and input latency use only the window', () => {
    const records = empty();
    records.frames = [0, 16.7, 33.3, 150, 166.7, 183.3, 400];
    records.loaf = [{ start: 40, duration: 110, blocking: 60 }, { start: 250, duration: 150, blocking: 100 }];
    records.inputs = [{ sequence: 1, at: 10, handlerAt: 11, frameAt: 16.7 }, { sequence: 2, at: 60, handlerAt: 145, frameAt: 150 }, { sequence: 3, at: 210, handlerAt: 395, frameAt: 400 }];
    records.iterations = [{ at: 20, screenMs: 2, progressMs: 1, rows: 1, updated: 0 }];
    const window = summarizeWindow(records, { label: 'test', start: 0, end: 200 });
    expect(window.input_count).toBe(2);
    expect(window.input_latency_max_ms).toBe(90);
    expect(window.input_delay_p95_ms).toBe(85);
    expect(window.max_frame_gap_ms).toBe(216.7);
    expect(window.blocking_ms).toBe(60);
    expect(window.blocking_pct).toBe(30);
    expect(window.screen_query_count).toBe(1);
    expect(window.dropped_frame_pct).toBeGreaterThan(0);
  });

  test('every sent keystroke must be received in order', () => {
    const records = empty();
    records.inputs = [{ sequence: 1, at: 1, handlerAt: 2, frameAt: 3 }];
    expect(() => assertInputsDelivered(records, 1)).not.toThrow();
    expect(() => assertInputsDelivered(records, 2)).toThrow();
  });

  test('ps cputime parses minutes and hours', () => {
    expect(ProcessSampler.parseCpu('0:01.50')).toBe(1.5);
    expect(ProcessSampler.parseCpu('1:02:03.00')).toBe(3723);
  });

  test('report aggregates completed measured trials, excluding warm-ups', () => {
    const trial = (label: string, status: string, ms: number) => ({ stack: 'electric', condition: 'low-priority', label, status, milestones: { bootstrapCompleteMs: ms }, windows: {}, process: {}, calibration: {} });
    const [row] = aggregate({ trials: [trial('warmup', 'completed', 1), trial('trial-1', 'completed', 10), trial('trial-2', 'completed', 30), trial('trial-3', 'failed', 0)] });
    expect(row).toMatchObject({ stack: 'electric', condition: 'low-priority', n: 2, failed: 1, bootstrapMs: 20 });
  });
});
