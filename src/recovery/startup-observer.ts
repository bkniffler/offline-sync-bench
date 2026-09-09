import { assertRows, ContractError, type Row } from '../contracts/screens.ts';
import { startupObservationPolicy } from '../contracts/startup.ts';
import type { RecoveryDriver } from './protocol.ts';

/** Observe actual usable outputs. Native completion prompts a full snapshot;
 * sparse progress counts also allow local materialization to precede that signal.
 * Every reported complete snapshot still requires controller record validation. */
export async function observeBootstrap(
  driver: Pick<RecoveryDriver, 'sync' | 'firstScreen' | 'count' | 'rows'>,
  expectedScreen: Row[], count: number,
  emit: (event: string, data: unknown) => void,
  timeoutMs: number = startupObservationPolicy.timeoutMs,
) {
  const started = performance.now(), at = () => performance.now() - started;
  let syncError: unknown, syncFailed = false, syncFinished = false, syncCompletedAtMs: number | null = null;
  const sync = Promise.resolve().then(() => driver.sync()).then(() => { syncFinished = true; syncCompletedAtMs = at(); }, error => { syncFailed = true; syncError = error; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Startup observation timed out')), timeoutMs); });
  // A synchronous native call can outlast the timer's scheduled time; check the
  // monotonic deadline after each operation as well as racing asynchronous work.
  const check = () => { if (syncFailed) throw syncError; if (at() >= timeoutMs) throw new Error('Startup observation timed out'); };
  let snapshot: Row[] = [], firstScreen = false, fullData = false, polls = 0, screenQueries = 0;
  let lastScreenMismatch: string | null = null, nextCountAtMs = 0;
  let pendingQuery: { kind: string; startMs: number } | null = null;
  const countQueries: Array<{ startMs: number; durationMs: number; rows: number }> = [];
  type Trigger = 'sync-complete' | 'first-screen' | 'progress-count';
  type SnapshotReceipt = { startMs: number; durationMs: number; rows: number; trigger: Trigger };
  const candidateSnapshots: SnapshotReceipt[] = [];
  const usedHints = new Set<Trigger>();
  let fullSnapshot: SnapshotReceipt | null = null;
  const observations: Array<{ atMs: number; rows: number | null; screenCorrect: boolean; kind: string }> = [];
  const remember = (kind: string, rows: number | null) => observations.push({ atMs: at(), rows, screenCorrect: firstScreen, kind });
  const query = async <T>(kind: string, operation: () => Promise<T>) => {
    check(); pendingQuery = { kind, startMs: at() };
    const value = await Promise.race([Promise.resolve().then(operation), deadline]);
    const receipt = { startMs: pendingQuery.startMs, durationMs: at() - pendingQuery.startMs };
    pendingQuery = null; check(); return { value, ...receipt };
  };
  const capture = async (trigger: Trigger) => {
    usedHints.add(trigger);
    const result = await query('full-snapshot', () => driver.rows());
    const candidate = { startMs: result.startMs, durationMs: result.durationMs, rows: result.value.length, trigger };
    candidateSnapshots.push(candidate);
    if (candidate.rows > count || trigger === 'progress-count' && candidate.rows !== count) throw new ContractError(`Startup full snapshot contains ${candidate.rows} rows, expected ${count}`);
    if (candidate.rows < count) { remember('partial-snapshot', candidate.rows); return; }
    snapshot = result.value;
    fullSnapshot = candidate;
    fullData = true; remember('full-snapshot', snapshot.length); emit('full-data', { rows: snapshot.length });
  };
  const pause = async () => {
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([deadline, ...(syncFinished ? [] : [sync]), new Promise(resolve => { sleepTimer = setTimeout(resolve, startupObservationPolicy.screenPollDelayMs); })]);
    } finally { clearTimeout(sleepTimer); }
  };
  const receipt = () => ({ policy: { ...startupObservationPolicy, timeoutMs }, polls, observations, screenQueries, countQueries, candidateSnapshots, fullSnapshot, syncCompletedAtMs, syncFinished });
  try {
    if (!Number.isSafeInteger(count) || count < 1) throw new ContractError(`Startup row count must be a positive fixture size, received ${count}`);
    while (!firstScreen || !fullData || !syncFinished) {
      check(); polls++;
      const finishedBeforeScreen = syncFinished;
      if (!firstScreen) {
        const { value: screen } = await query('screen', () => driver.firstScreen()); screenQueries++;
        let screenDigest: string | null = null;
        try { screenDigest = assertRows('startup screen', screen, expectedScreen); lastScreenMismatch = null; }
        catch (error) { if (!(error instanceof ContractError)) throw error; lastScreenMismatch = error.message; }
        if (screenDigest) { firstScreen = true; remember('first-screen', null); emit('first-screen', { screen, screenDigest }); }
      }
      if (!fullData) {
        if (syncFinished && !usedHints.has('sync-complete')) await capture('sync-complete');
        if (!fullData && firstScreen && !usedHints.has('first-screen')) await capture('first-screen');
        if (!fullData && at() >= nextCountAtMs) {
          const measured = await query('progress-count', () => driver.count());
          const rows = measured.value;
          if (!Number.isSafeInteger(rows) || rows < 0 || rows > count) throw new ContractError(`Startup row count ${rows} exceeds fixture ${count}`);
          countQueries.push({ startMs: measured.startMs, durationMs: measured.durationMs, rows }); remember('progress-count', rows);
          nextCountAtMs = at() + startupObservationPolicy.progressCountDelayMs;
          if (rows === count) await capture('progress-count');
          else if (syncFinished && !usedHints.has('sync-complete')) await capture('sync-complete');
        }
      }
      if (finishedBeforeScreen && fullData && !firstScreen) throw new ContractError('Complete startup replica returns the wrong screen');
      if (firstScreen && fullData) {
        if (!syncFinished) await Promise.race([sync, deadline]);
      } else await pause();
    }
    check(); remember('complete', snapshot.length);
    return { ...receipt(), snapshot };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    Object.assign(failure, { evidence: { ...(failure as Error & { evidence?: Record<string, unknown> }).evidence,
      startupObservation: { ...receipt(), expectedRows: count, timeoutMs, elapsedMs: at(), firstScreen, fullData, pendingQuery, lastScreenMismatch } } });
    throw failure;
  } finally { clearTimeout(timer); }
}
