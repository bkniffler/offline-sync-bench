/**
 * Sync responsiveness: how much a syncing client slows down the page that
 * hosts it. One fresh Chromium profile per trial runs the shared page app
 * (page/app.ts) while the controller types into it every 100 ms, through a
 * cold bootstrap of the full dataset and an idle window. The client then
 * closes, the server commits a large change, and the reloaded page reopens the
 * same store and catches up.
 */
import { build, transform } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { SignJWT } from 'jose';
import { BrowserProcess } from '../browser/process.ts';
import { ensureStackUp, seedStack } from '../stack-manager.ts';
import { startupSeed } from '../contracts/startup.ts';
import { getStack } from '../stacks.ts';
import type { StackId } from '../types.ts';
import { arrayScreen, screenProjectId, screenOwnerId } from './page/screen.ts';
import type { TaskRow } from './page/app.ts';
import { assertInputsDelivered, summarizeWindow, type PageRecords, type PhaseWindow } from './metrics.ts';

export const responsivenessStacks = ['syncular', 'powersync', 'zero', 'electric', 'electric-tanstack'] as const;
export type ResponsivenessStack = typeof responsivenessStacks[number];
export const RESPONSIVENESS_CONTRACT = 'sync-responsiveness-v1';
export const plan = {
  bootstrapRows: 100_000, catchUpRows: 20_000, inputIntervalMs: 100, settleMs: 2_000, idleMs: 5_000, tailMs: 2_000,
  phaseTimeoutMs: 240_000, processSampleMs: 250,
  chromiumArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
};
/** DevTools CPU throttling slows only the page's main thread ("only
 * supported for pages, not workers"), which would favor worker-based clients,
 * and a background QoS clamp on the whole browser caps frames at ~5 fps. The
 * slow-device condition instead lowers every Chromium process except the GPU
 * process to PRIO_DARWIN_BG (low CPU and I/O priority), so the main thread,
 * workers, storage and network services slow together while frames stay at
 * 60 Hz. Each trial calibrates the main thread and a worker. */
export const conditions = {
  default: { clamp: false, description: 'Default process priority' },
  'low-priority': { clamp: true, description: 'taskpolicy -b -p on every Chromium process except GPU (PRIO_DARWIN_BG), re-applied to new processes' },
} as const;
export type ConditionId = keyof typeof conditions;

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const pkg = (name: string) => { let path = dirname(require.resolve(name)); while (!existsSync(join(path, 'package.json'))) path = dirname(path); return path; };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sortRows = (rows: TaskRow[]) => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const digestRows = (rows: TaskRow[]) => sha(JSON.stringify(sortRows(rows).map(row => [row.id, row.title, Number(row.completed)])));

/** Bundle the page app for one stack the way an application would ship it. */
export async function buildStack(stack: ResponsivenessStack, folder: string) {
  await rm(folder, { recursive: true, force: true }); await mkdir(folder, { recursive: true });
  const entries: Record<string, string> = { entry: `src/responsiveness/page/${stack}.ts` };
  if (stack === 'syncular') { entries['syncular-worker'] = 'src/responsiveness/page/syncular-worker.ts'; entries['sqlite-runtime'] = 'src/client-footprint/sqlite-runtime.ts'; }
  if (stack === 'powersync') entries['powersync-worker'] = join(pkg('@powersync/web'), 'lib/worker/worker.js');
  const built = await build({ entryPoints: entries, outdir: folder, bundle: true, platform: 'browser', format: 'esm', splitting: true, minify: true, sourcemap: false, metafile: true, target: ['es2022'], logLevel: 'silent' });
  if (stack === 'syncular') {
    await copyFile(join(pkg('@sqlite.org/sqlite-wasm'), 'dist/sqlite3.wasm'), join(folder, 'sqlite3.wasm'));
    const proxy = await readFile(join(pkg('@sqlite.org/sqlite-wasm'), 'dist/sqlite3-opfs-async-proxy.js'), 'utf8');
    await writeFile(join(folder, 'sqlite3-opfs-async-proxy.js'), (await transform(proxy, { minify: true, target: 'es2022' })).code);
  }
  if (stack === 'powersync') {
    const wa = dirname(createRequire(require.resolve('@powersync/web')).resolve('@journeyapps/wa-sqlite/dist/wa-sqlite.mjs'));
    for (const name of ['wa-sqlite', 'wa-sqlite-async', 'mc-wa-sqlite', 'mc-wa-sqlite-async']) await copyFile(join(wa, `${name}.wasm`), join(folder, `${name}.wasm`));
  }
  if (stack === 'electric-tanstack') {
    const assets = join(pkg('@tanstack/browser-db-sqlite-persistence'), 'dist/assets');
    await mkdir(join(folder, 'assets'));
    for (const name of (await readdir(assets)).filter(n => n.endsWith('.js'))) await writeFile(join(folder, 'assets', name), (await transform(await readFile(join(assets, name), 'utf8'), { minify: true, target: 'es2022' })).code);
  }
  return { outputs: Object.keys(built.metafile.outputs).length, inputs: Object.keys(built.metafile.inputs).length };
}

/** Same-origin page server. HTTP sync routes are proxied so the page needs no
 * CORS; WebSockets (Zero, Syncular realtime) and PowerSync's stream connect directly. */
function servePage(stack: ResponsivenessStack, folder: string, actorId: string) {
  const headers = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };
  const routes: Record<string, { target: string; headers?: Record<string, string> }> = {
    '/syncular/': { target: 'http://localhost:3210/api/', headers: { 'x-actor-id': actorId } },
    '/electric-app/': { target: `${getStack('electric').appBaseUrl}/` },
    '/powersync-app/': { target: `${getStack('powersync').appBaseUrl}/` },
  };
  return Bun.serve({ port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url), path = decodeURIComponent(url.pathname);
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/health') return new Response('<!doctype html><meta charset="utf-8"><title>Sync responsiveness</title><body></body>', { headers: { ...headers, 'content-type': 'text/html' } });
    for (const [prefix, route] of Object.entries(routes)) if (path.startsWith(prefix)) {
      const forwarded = new Headers(request.headers); forwarded.delete('host'); forwarded.delete('origin');
      for (const [key, value] of Object.entries(route.headers ?? {})) forwarded.set(key, value);
      const upstream = await fetch(`${route.target}${url.pathname.slice(prefix.length)}${url.search}`, { method: request.method, headers: forwarded, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(), decompress: false, redirect: 'manual' } as RequestInit);
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    }
    if (!/^\/(?:assets\/)?[\w-]+(?:\.[\w-]+)*\.(js|wasm)$/.test(path)) return new Response('Missing', { status: 404 });
    const file = Bun.file(join(folder, path.slice(1)));
    if (!await file.exists()) return new Response('Missing asset', { status: 404 });
    return new Response(file, { headers: { ...headers, 'content-type': path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' } });
  } });
}

/** Server truth, read from each stack's Postgres, never from a client. */
async function serverRows(stack: ResponsivenessStack): Promise<TaskRow[]> {
  const sql = postgres(getStack(stack).databaseUrl!, { max: 1 });
  try {
    const rows = stack === 'syncular'
      ? await sql`select id, title, completed from tasks where _sync_partition = 'bench' order by id`
      : await sql`select id, title, completed from tasks order by id`;
    return rows.map(row => ({ id: row.id, title: row.title, completed: Number(Boolean(row.completed)) }));
  } finally { await sql.end(); }
}

/** One large server change: retitle the highest-id tasks. Postgres-backed
 * stacks commit one UPDATE (replicated by the sync service); Syncular's
 * server tables are engine-owned, so its admin commits through the engine. */
async function bulkRetitle(stack: ResponsivenessStack, prefix: string, count: number) {
  if (stack === 'syncular') {
    const response = await fetch(`${getStack('syncular').adminBaseUrl}/admin/bulk-retitle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, count }) });
    const body = await response.json() as { ok: boolean; updated: number; commits: number };
    if (!response.ok || body.updated !== count) throw new Error(`Syncular bulk retitle failed: ${JSON.stringify(body)}`);
    return { method: 'engine commits', commits: body.commits };
  }
  const sql = postgres(getStack(stack).databaseUrl!, { max: 1 });
  try {
    const updated = await sql`update tasks set title = ${prefix} || id, server_version = server_version + 1, updated_at = now() where id in (select id from tasks order by id desc limit ${count})`;
    if (updated.count !== count) throw new Error(`Bulk retitle updated ${updated.count} rows`);
    return { method: 'single Postgres transaction', commits: 1 };
  } finally { await sql.end(); }
}

export const expectedScreen = (rows: TaskRow[]) => arrayScreen(rows.map(row => ({ ...row, project_id: screenProjectId, owner_id: ownerOf(row.id) })));
// Fixture owners alternate by task index (contracts/screens.ts fixtureTask).
export const ownerOf = (id: string) => `org-1-user-${(Number(id.slice(id.lastIndexOf('-') + 1)) - 1) % 2 + 1}`;

/** Browser tree CPU and memory from the OS, so sampling never touches the renderer. */
/** Lower Chromium processes (except GPU) to background priority; idempotent. */
export class PriorityClamp {
  clamped = new Map<number, string>();
  constructor(readonly browser: BrowserProcess) {}
  async apply() {
    const { processInfo } = await this.browser.command('SystemInfo.getProcessInfo');
    for (const process of processInfo as Array<{ id: number; type: string }>) {
      if (process.type === 'GPU' || this.clamped.has(process.id)) continue;
      await exec('/usr/sbin/taskpolicy', ['-b', '-p', String(process.id)]);
      this.clamped.set(process.id, process.type);
    }
  }
}

export class ProcessSampler {
  samples: Array<{ at: number; rssKb: number; cpuSeconds: number; processes: number }> = [];
  #timer?: ReturnType<typeof setInterval>;
  #busy = false;
  constructor(readonly browser: BrowserProcess, readonly onTick?: () => Promise<void>) {}
  static parseCpu(value: string) { const parts = value.split(':').map(Number); return parts.reduce((total, part) => total * 60 + part, 0); }
  async sample() {
    if (this.#busy) return; this.#busy = true;
    try {
      await this.onTick?.();
      const { members } = await this.browser.inventory();
      if (!members.length) return;
      const { stdout } = await exec('ps', ['-o', 'rss=,time=', '-p', members.map(m => m.pid).join(',')]);
      let rssKb = 0, cpuSeconds = 0, processes = 0;
      for (const line of stdout.trim().split('\n')) { const [rss, time] = line.trim().split(/\s+/); rssKb += Number(rss); cpuSeconds += ProcessSampler.parseCpu(time!); processes++; }
      this.samples.push({ at: performance.now(), rssKb, cpuSeconds, processes });
    } finally { this.#busy = false; }
  }
  start() { this.#timer = setInterval(() => { void this.sample().catch(() => {}); }, plan.processSampleMs); }
  async stop() { clearInterval(this.#timer); await this.sample(); }
  window(start: number, end: number) {
    const inside = this.samples.filter(s => s.at >= start && s.at <= end);
    const before = [...this.samples].reverse().find(s => s.at <= start) ?? inside[0], after = inside.at(-1);
    return { peak_rss_mb: inside.length ? Math.round(Math.max(...inside.map(s => s.rssKb)) / 1024) : null,
      cpu_seconds: before && after ? Math.round((after.cpuSeconds - before.cpuSeconds) * 100) / 100 : null, samples: inside.length };
  }
}

export interface TrialOptions { stack: ResponsivenessStack; condition: ConditionId; executable: string; folder: string; workDir: string; generation: number; label: string }

export async function runTrial(options: TrialOptions) {
  const { stack, condition } = options, actorId = 'org-1-user-1', clientId = randomUUID();
  const result: any = { stack, condition, conditionDescription: conditions[condition].description, label: options.label, contract: RESPONSIVENESS_CONTRACT, startedAt: new Date().toISOString(), stage: 'launch' };
  const profile = await mkdtemp(join(options.workDir, `${stack}-profile-`));
  const server = servePage(stack, options.folder, actorId);
  const browser = new BrowserProcess(options.executable, profile, { extraArgs: plan.chromiumArgs });
  const clamp = conditions[condition].clamp ? new PriorityClamp(browser) : undefined;
  const sampler = new ProcessSampler(browser, clamp ? () => clamp.apply() : undefined);
  const milestones = new Map<string, { at: number; controllerAt: number }>();
  let fatal: string | undefined;
  // Typing runs throughout each document; receipts are checked per document.
  const typing = { sent: 0, timer: undefined as ReturnType<typeof setInterval> | undefined, pending: [] as Promise<unknown>[] };
  const startTyping = () => {
    typing.sent = 0; typing.pending = [];
    typing.timer = setInterval(() => {
      const timestamp = Date.now() / 1000; typing.sent++;
      typing.pending.push(browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, timestamp }, true)
        .then(() => browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, timestamp }, true)));
    }, plan.inputIntervalMs);
  };
  const stopTyping = async () => {
    clearInterval(typing.timer); typing.timer = undefined;
    await Promise.all(typing.pending); await delay(500);
    const records = await browser.call('records') as PageRecords;
    assertInputsDelivered(records, typing.sent);
    return records;
  };
  const waitFor = async (key: string) => {
    const deadline = performance.now() + plan.phaseTimeoutMs;
    while (!milestones.has(key)) {
      if (fatal) throw new Error(`Page failed: ${fatal}`);
      if (performance.now() > deadline) throw new Error(`Timed out waiting for ${key}`);
      await delay(20);
    }
    return milestones.get(key)!;
  };
  const mount = async () => {
    await browser.evaluate("import('/entry.js')");
    const page = await browser.call('mount');
    await clamp?.apply();
    if (page.activeElement !== 'probe' || page.visibility !== 'visible') throw new Error(`Input probe is not focused in a visible page: ${JSON.stringify(page)}`);
    return page;
  };
  try {
    result.connection = await browser.connect(server.url.origin, '');
    browser.onEvent((event, data) => {
      if (event === 'fatal') fatal = data.error;
      if (event === 'milestone') milestones.set(`${data.label}:${data.kind}`, { at: data.at, controllerAt: performance.now() });
    });
    await browser.command('Emulation.setFocusEmulationEnabled', { enabled: true }, true);
    result.page = await mount();
    result.calibration = await browser.call('calibrate');
    const before = await serverRows(stack);
    if (before.length !== plan.bootstrapRows) throw new Error(`Server holds ${before.length} tasks`);
    result.serverBefore = { rows: before.length, digest: digestRows(before) };
    sampler.start();
    const auth = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setSubject(actorId).setExpirationTime('30m').sign(new TextEncoder().encode('benchsecret'));
    const startConfig = { origin: server.url.origin, clientId, actorId, projectId: screenProjectId, ownerId: screenOwnerId, auth,
      urls: { zero: getStack('zero').syncBaseUrl, powersync: getStack('powersync').syncBaseUrl, realtime: getStack('syncular').syncRealtimeBaseUrl } };
    startTyping(); await delay(1_000);
    const first: PhaseWindow[] = [];
    result.stage = 'bootstrap';
    const preStart = await browser.call('now'); first.push({ label: 'before_sync', start: preStart - 900, end: preStart });
    await browser.call('expect', { label: 'bootstrap', rows: before.length, prefix: null, updated: 0, screen: expectedScreen(before) });
    const controllerBootstrap = performance.now();
    result.start = await browser.call('start', startConfig);
    const bootstrapScreen = await waitFor('bootstrap:screen'), bootstrapDone = await waitFor('bootstrap:complete');
    first.push({ label: 'bootstrap', start: result.start.at, end: bootstrapDone.at });
    result.stage = 'idle';
    await delay(plan.settleMs);
    const idleStart = await browser.call('now'); await delay(plan.idleMs); const idleEnd = await browser.call('now');
    first.push({ label: 'idle', start: idleStart, end: idleEnd });
    const firstRecords = await stopTyping(), firstSent = typing.sent;
    const bootstrapRows = await browser.call('rows') as TaskRow[];
    if (digestRows(bootstrapRows) !== digestRows(before)) throw new Error(`Bootstrapped replica (${bootstrapRows.length} rows) differs from server truth`);
    await browser.call('stop');
    // The whole server change commits while no client runs, so every stack's
    // server holds it before timing; server write speed is outside the window.
    result.stage = 'server-write';
    const prefix = `catchup-${options.generation}-`;
    const expected = before.map((row, i) => i >= before.length - plan.catchUpRows ? { ...row, title: `${prefix}${row.id}` } : row);
    const writeStarted = performance.now();
    result.serverWrite = { ...(await bulkRetitle(stack, prefix, plan.catchUpRows)), ms: Math.round(performance.now() - writeStarted) };
    const after = await serverRows(stack);
    if (digestRows(after) !== digestRows(expected)) throw new Error('Server state differs from the planned update');
    result.stage = 'reopen';
    const navigation = await browser.command('Page.navigate', { url: `${server.url.origin}/health?reopen` }, true);
    if (navigation.errorText) throw new Error(`Reopen navigation failed: ${navigation.errorText}`);
    const loadDeadline = performance.now() + 20_000;
    while ((await browser.evaluate("document.readyState + ':' + typeof globalThis.benchmarkDispatch")) !== 'complete:undefined') {
      if (performance.now() > loadDeadline) throw new Error('Reopened document did not load'); await delay(10);
    }
    result.reopenPage = await mount();
    startTyping(); await delay(1_000);
    const second: PhaseWindow[] = [];
    result.stage = 'catchup';
    const preReopen = await browser.call('now'); second.push({ label: 'before_reopen', start: preReopen - 900, end: preReopen });
    await browser.call('expect', { label: 'catchup', rows: expected.length, prefix, updated: plan.catchUpRows, screen: expectedScreen(expected) });
    const controllerCatchUp = performance.now();
    result.reopen = await browser.call('start', startConfig);
    const catchUpScreen = await waitFor('catchup:screen'), catchUpDone = await waitFor('catchup:complete');
    second.push({ label: 'catchup', start: result.reopen.at, end: catchUpDone.at });
    await delay(plan.tailMs);
    second.push({ label: 'catchup_tail', start: catchUpDone.at, end: await browser.call('now') });
    const secondRecords = await stopTyping();
    await sampler.stop();
    result.stage = 'validate';
    const clientRows = await browser.call('rows') as TaskRow[];
    if (digestRows(clientRows) !== digestRows(after)) throw new Error(`Client replica (${clientRows.length} rows) differs from server truth`);
    result.validation = { serverDigest: digestRows(after), clientDigest: digestRows(clientRows), bootstrapDigest: digestRows(bootstrapRows), rows: clientRows.length, keystrokes: firstSent + typing.sent };
    result.milestones = { bootstrapScreenMs: bootstrapScreen.at - result.start.at, bootstrapCompleteMs: bootstrapDone.at - result.start.at, catchUpScreenMs: catchUpScreen.at - result.reopen.at, catchUpCompleteMs: catchUpDone.at - result.reopen.at };
    result.windows = Object.fromEntries([...first.map(window => [window.label, { ...window, document: 1, ...summarizeWindow(firstRecords, window) }]),
      ...second.map(window => [window.label, { ...window, document: 2, ...summarizeWindow(secondRecords, window) }])]);
    result.process = { bootstrap: sampler.window(controllerBootstrap, bootstrapDone.controllerAt), catchup: sampler.window(controllerCatchUp, catchUpDone.controllerAt) };
    result.records = [firstRecords, secondRecords].map(records => ({ frames: records.frames.length, inputs: records.inputs.length, longAnimationFrames: records.loaf.length, iterations: records.iterations.length, eventTimings: records.eventTimings }));
    result.clampedProcesses = clamp ? [...clamp.clamped.entries()].map(([pid, type]) => ({ pid, type })) : [];
    result.stage = 'complete'; result.status = 'completed';
    await browser.call('stop');
  } catch (error) {
    result.status = 'failed'; result.error = String((error as Error)?.stack ?? error); result.pageFatal = fatal ?? null;
  } finally {
    clearInterval(typing.timer);
    await sampler.stop().catch(() => {});
    try { result.cleanup = { allObservedAbsent: (await browser.close()).allObservedAbsent }; } catch (error) { result.cleanup = { error: String(error) }; }
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
    result.finishedAt = new Date().toISOString();
  }
  return result;
}

export async function prepareStack(stack: ResponsivenessStack) {
  await ensureStackUp(stack);
  await seedStack(stack, startupSeed(plan.bootstrapRows));
  const rows = await serverRows(stack);
  if (rows.length !== plan.bootstrapRows) throw new Error(`${stack} seeded ${rows.length} tasks`);
}

export type { StackId };
