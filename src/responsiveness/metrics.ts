import { percentile } from '../metrics.ts';

export interface PageRecords {
  frames: number[];
  loaf: Array<{ start: number; duration: number; blocking: number }>;
  longTasks: Array<{ start: number; duration: number }>;
  inputs: Array<{ sequence: number; at: number; handlerAt: number; frameAt: number }>;
  eventTimings: Array<{ start: number; processingStart: number; duration: number }>;
  iterations: Array<{ at: number; screenMs: number; progressMs: number; rows: number; updated: number }>;
  milestones: Array<{ label: string; kind: 'screen' | 'complete'; at: number }>;
  now: number;
}
export interface PhaseWindow { label: string; start: number; end: number }

export const FRAME_MS = 1000 / 60;
const round = (value: number) => Math.round(value * 100) / 100;
const max = (values: number[]) => values.length ? round(Math.max(...values)) : 0;
const inside = (at: number, window: PhaseWindow) => at >= window.start && at < window.end;

/** All times are page-monotonic milliseconds from the same document. */
export function summarizeWindow(records: PageRecords, window: PhaseWindow): Record<string, number> {
  const durationMs = window.end - window.start;
  const inputs = records.inputs.filter(input => inside(input.at, window));
  const latency = inputs.map(input => input.frameAt - input.at), delay = inputs.map(input => input.handlerAt - input.at);
  // Include the frame straddling each edge so a blocked start or end counts.
  let first = -1; for (let i = 0; i < records.frames.length && records.frames[i]! <= window.start; i++) first = i;
  const last = records.frames.findIndex(at => at >= window.end);
  const frames = records.frames.slice(Math.max(0, first), last === -1 ? undefined : last + 1);
  const gaps = frames.slice(1).map((at, i) => at - frames[i]!);
  const dropped = gaps.reduce((sum, gap) => sum + Math.max(0, Math.round(gap / FRAME_MS) - 1), 0);
  const loaf = records.loaf.filter(entry => inside(entry.start, window));
  const iterations = records.iterations.filter(iteration => inside(iteration.at, window));
  return {
    duration_ms: round(durationMs),
    input_count: inputs.length,
    input_latency_p50_ms: percentile(latency, 50), input_latency_p95_ms: percentile(latency, 95), input_latency_max_ms: max(latency),
    input_delay_p95_ms: percentile(delay, 95),
    frame_count: frames.length, max_frame_gap_ms: max(gaps),
    dropped_frame_pct: gaps.length ? round(100 * dropped / (dropped + gaps.length)) : 0,
    blocking_ms: round(loaf.reduce((sum, entry) => sum + entry.blocking, 0)),
    blocking_pct: durationMs > 0 ? round(100 * loaf.reduce((sum, entry) => sum + entry.blocking, 0) / durationMs) : 0,
    long_frame_count: loaf.length, longest_frame_ms: max(loaf.map(entry => entry.duration)),
    screen_query_count: iterations.length,
    screen_query_p50_ms: percentile(iterations.map(i => i.screenMs), 50), screen_query_p95_ms: percentile(iterations.map(i => i.screenMs), 95), screen_query_max_ms: max(iterations.map(i => i.screenMs)),
    progress_query_p95_ms: percentile(iterations.map(i => i.progressMs), 95),
  };
}

/** Sent keystrokes must all reach the page; a missing receipt invalidates the trial. */
export function assertInputsDelivered(records: PageRecords, sent: number) {
  if (records.inputs.length !== sent) throw new Error(`Input probe delivered ${records.inputs.length} of ${sent} keystrokes`);
  const invalid = records.inputs.findIndex((input, i) => input.sequence !== i + 1 || !(input.frameAt >= input.handlerAt) || !(input.handlerAt >= input.at - 1));
  if (invalid !== -1) throw new Error(`Input probe receipt ${invalid + 1} is out of order or precedes its event: ${JSON.stringify(records.inputs.slice(Math.max(0, invalid - 2), invalid + 2))}`);
}
