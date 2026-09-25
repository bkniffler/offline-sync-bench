/**
 * The page side of the sync-responsiveness benchmark. Every stack runs the
 * same application: a 50-row list screen queried and rendered four times per
 * second, a progress check, and a text input that the controller types into.
 * Main-thread instrumentation (frames, long animation frames, input-to-frame
 * latency) is identical for every stack and never calls the SDK.
 */
export interface TaskRow { id: string; title: string; completed: number }
export interface Progress { rows: number; updated: number }
export interface PageConfig {
  origin: string; clientId: string; actorId: string; projectId: string; ownerId: string;
  urls: Record<string, string>; auth?: string;
}
export interface PageClient {
  /** Where sync apply and local storage run, as configured. */
  diagnostics: Record<string, unknown>;
  screen(): Promise<TaskRow[]>;
  /** Total task rows plus rows whose title starts with `prefix`. */
  progress(prefix: string | null): Promise<Progress>;
  rows(): Promise<TaskRow[]>;
  close(): Promise<void>;
}
export type ClientFactory = (config: PageConfig) => Promise<PageClient>;
interface Expectation { rows: number; prefix: string | null; updated: number; screen: TaskRow[]; label: string }

declare global {
  var benchmarkDispatch: (method: string, params: any) => Promise<unknown>;
  var benchReport: (payload: string) => void;
}

export const APP_POLL_MS = 250;
const frames: number[] = [];
const loaf: Array<{ start: number; duration: number; blocking: number }> = [];
const longTasks: Array<{ start: number; duration: number }> = [];
const inputs: Array<{ sequence: number; at: number; handlerAt: number; frameAt: number }> = [];
const eventTimings: Array<{ start: number; processingStart: number; duration: number }> = [];
const iterations: Array<{ at: number; screenMs: number; progressMs: number; rows: number; updated: number }> = [];
const milestones: Array<{ label: string; kind: 'screen' | 'complete'; at: number }> = [];
let client: PageClient | undefined, expectation: Expectation | undefined, fatal: string | undefined;
let running = false, keystrokes = 0, loopDone: Promise<void> | undefined;

const emit = (event: string, data: unknown) => globalThis.benchReport(JSON.stringify({ event, data }));
const sameScreen = (a: TaskRow[], b: TaskRow[]) => a.length === b.length && a.every((row, i) => row.id === b[i]!.id && row.title === b[i]!.title && Number(row.completed) === Number(b[i]!.completed));

function mountUi() {
  document.body.innerHTML = '<textarea id="probe" rows="2" cols="40"></textarea><p id="status">idle</p><p id="typed">0</p><ul id="screen"></ul>';
  const probe = document.getElementById('probe') as HTMLTextAreaElement, typed = document.getElementById('typed')!;
  probe.addEventListener('keydown', event => {
    const handlerAt = performance.now();
    const sequence = ++keystrokes;
    typed.textContent = String(sequence);
    requestAnimationFrame(frameAt => { inputs.push({ sequence, at: event.timeStamp, handlerAt, frameAt: Math.max(frameAt, handlerAt) }); });
  });
  probe.focus();
  const frame = (at: number) => { frames.push(at); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const observe = (type: string, callback: (entry: any) => void, options: Record<string, unknown> = {}) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return false;
    new PerformanceObserver(list => { for (const entry of list.getEntries()) callback(entry); }).observe({ type, buffered: true, ...options } as PerformanceObserverInit);
    return true;
  };
  return {
    longAnimationFrames: observe('long-animation-frame', entry => loaf.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration })),
    longTasks: observe('longtask', entry => longTasks.push({ start: entry.startTime, duration: entry.duration })),
    eventTiming: observe('event', entry => { if (entry.name === 'keydown') eventTimings.push({ start: entry.startTime, processingStart: entry.processingStart, duration: entry.duration }); }, { durationThreshold: 16 }),
  };
}

function render(rows: TaskRow[], progress: Progress) {
  const list = document.getElementById('screen')!;
  list.replaceChildren(...rows.map(row => { const item = document.createElement('li'); item.textContent = `${row.id} · ${row.title}${row.completed ? ' ✓' : ''}`; return item; }));
  document.getElementById('status')!.textContent = `${progress.rows} tasks · ${progress.updated} updated`;
}

async function loop() {
  while (running && client) {
    const started = performance.now();
    try {
      const screen = await client.screen();
      const queried = performance.now();
      const progress = await client.progress(expectation?.prefix ?? null);
      const finished = performance.now();
      render(screen, progress);
      iterations.push({ at: started, screenMs: queried - started, progressMs: finished - queried, rows: progress.rows, updated: progress.updated });
      if (expectation) {
        const label = expectation.label;
        if (!milestones.some(m => m.label === label && m.kind === 'screen') && sameScreen(screen, expectation.screen)) { milestones.push({ label, kind: 'screen', at: finished }); emit('milestone', { label, kind: 'screen', at: finished }); }
        if (!milestones.some(m => m.label === label && m.kind === 'complete') && progress.rows === expectation.rows && progress.updated === expectation.updated && sameScreen(screen, expectation.screen)) {
          milestones.push({ label, kind: 'complete', at: finished }); emit('milestone', { label, kind: 'complete', at: finished });
        }
      }
    } catch (error) { fatal = String((error as Error)?.stack ?? error); emit('fatal', { error: fatal }); running = false; return; }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, APP_POLL_MS - (performance.now() - started))));
  }
}

/** Fixed integer work, run once on the main thread and once in a worker, so
 * the record shows whether CPU throttling reached worker threads. */
function calibrationWork() { let x = 0; for (let i = 0; i < 30_000_000; i++) x = (x + Math.imul(i, 2654435761)) | 0; return x; }
async function calibrate() {
  const started = performance.now(); calibrationWork(); const mainMs = performance.now() - started;
  const source = `const work=(${calibrationWork.toString()});onmessage=()=>{const s=performance.now();work();postMessage(performance.now()-s)}`;
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  const workerMs = await new Promise<number>((resolve, reject) => { worker.onmessage = event => resolve(event.data); worker.onerror = event => reject(new Error(event.message)); worker.postMessage(null); });
  worker.terminate();
  return { mainMs, workerMs, iterations: 30_000_000 };
}

export function installApp(factory: ClientFactory, stack: string) {
  let observers: ReturnType<typeof mountUi> | undefined;
  globalThis.benchmarkDispatch = async (method, params) => {
    if (fatal) throw new Error(fatal);
    if (method === 'mount') { observers = mountUi(); return { stack, observers, visibility: document.visibilityState, focused: document.hasFocus(), activeElement: document.activeElement?.id ?? null, userAgent: navigator.userAgent, crossOriginIsolated }; }
    if (method === 'calibrate') return calibrate();
    if (method === 'now') return performance.now();
    if (method === 'expect') { expectation = params; return performance.now(); }
    if (method === 'start') {
      const at = performance.now();
      client = await factory(params);
      const constructed = performance.now();
      running = true; loopDone = loop();
      return { at, constructed, diagnostics: client.diagnostics };
    }
    if (method === 'rows') return client!.rows();
    if (method === 'records') return { frames, loaf, longTasks, inputs, eventTimings, iterations, milestones, now: performance.now() };
    if (method === 'stop') { running = false; await loopDone; await client?.close(); return null; }
    throw new Error(`Unknown responsiveness operation ${method}`);
  };
}
