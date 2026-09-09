import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export interface ProcessIdentity { pid: number; ppid: number; pgid: number; started: string }
export async function browserProcessTable(): Promise<ProcessIdentity[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error('Cannot parse browser process ownership inventory');
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4] };
  });
}
export function browserDescendants(rows: ProcessIdentity[], root: number): ProcessIdentity[] {
  const included = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (included.has(row.ppid) && !included.has(row.pid)) { included.add(row.pid); changed = true; }
  }
  return rows.filter(row => included.has(row.pid));
}
const sameProcess = (a: ProcessIdentity, b: ProcessIdentity) => a.pid === b.pid && a.started === b.started && a.pgid === b.pgid;

/** A fresh Chromium process. It inherits the trial group so the campaign's
 * timeout kills its helpers along with the controller. Normal cleanup uses
 * only identities observed beneath this browser, never a shared process group.
 */
export class BrowserProcess {
  #child: ChildProcessWithoutNullStreams;
  #socket?: WebSocket;
  #sequence = 0;
  #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  #session?: string;
  #exit: Promise<{ code: number | null; signal: string | null }>;
  #stderr = '';
  #fault?: Error;
  #events: Array<(event: string, data: any) => void> = [];
  #owned = new Map<number, ProcessIdentity>();
  #closing?: Promise<unknown>;
  readonly pid: number;

  constructor(readonly executable: string, readonly profileDirectory: string) {
    if (!lstatSync(profileDirectory).isDirectory() || readdirSync(profileDirectory).length) throw new Error('Browser launch requires an empty fresh profile directory');
    this.#child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDirectory}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--enable-automation', 'about:blank'], { stdio: ['pipe', 'pipe', 'pipe'], detached: false });
    this.pid = this.#child.pid ?? 0;
    this.#child.stdout.resume();
    this.#child.stderr.on('data', data => { this.#stderr = (this.#stderr + String(data)).slice(-6000); });
    this.#child.stdin.on('error', error => this.#fail(error));
    this.#exit = new Promise(resolve => {
      this.#child.once('error', error => { this.#fail(error); resolve({ code: null, signal: null }); });
      this.#child.once('close', (code, signal) => { this.#fail(new Error(`Browser exited ${code}/${signal}: ${this.#stderr}`)); resolve({ code, signal }); });
    });
  }
  #fail(error: Error) {
    this.#fault = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
  onEvent(callback: (event: string, data: any) => void) {
    this.#events.push(callback);
    return () => { this.#events = this.#events.filter(value => value !== callback); };
  }
  async inventory() {
    const table = await browserProcessTable();
    const root = table.find(row => row.pid === this.pid);
    const original = this.#owned.get(this.pid);
    if (root && original && !sameProcess(root, original)) throw new Error('Browser PID identity changed');
    const members = root ? browserDescendants(table, this.pid) : [];
    for (const member of members) this.#owned.set(member.pid, member);
    return { root, members, table };
  }
  async connect(origin: string, bundle: string) {
    const deadline = performance.now() + 20_000;
    let endpoint = '';
    while (performance.now() < deadline) {
      if (this.#fault) throw this.#fault;
      try {
        const [port, path] = String(await readFile(join(this.profileDirectory, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        // Chromium can still be writing this owned file. Do not attach until
        // both fields form a complete loopback endpoint.
        if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path ?? '')) { endpoint = `ws://127.0.0.1:${port}${path}`; break; }
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await delay(10);
    }
    if (!endpoint) throw new Error('Browser DevTools startup timed out');
    const socket = new WebSocket(endpoint); this.#socket = socket;
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id) {
          const pending = this.#pending.get(message.id); if (!pending) return;
          this.#pending.delete(message.id);
          message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
        } else if (message.method === 'Runtime.bindingCalled' && message.params.name === 'benchReport' && message.sessionId === this.#session) {
          const payload = JSON.parse(message.params.payload);
          for (const listener of this.#events) listener(payload.event, payload.data);
        }
      } catch (error) {
        const fault = error instanceof Error ? error : new Error(String(error)); this.#fail(fault);
        for (const listener of this.#events) { try { listener('fatal', { error: fault.message }); } catch {} }
      }
    });
    socket.addEventListener('close', () => this.#fail(new Error('Browser DevTools connection closed')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser DevTools connection timed out')), 20_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser DevTools connection failed')); }, { once: true });
      socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Browser DevTools closed before connection')); }, { once: true });
    });
    const version = await this.command('Browser.getVersion');
    const commandLine = await this.command('Browser.getBrowserCommandLine');
    if (!commandLine.arguments.includes(`--user-data-dir=${this.profileDirectory}`)) throw new Error('Browser profile ownership mismatch');
    const targets = await this.command('Target.getTargets');
    const initial = targets.targetInfos.filter((target: any) => target.type === 'page');
    if (initial.length !== 1) throw new Error('Fresh browser must contain exactly one page');
    const target = initial[0];
    this.#session = (await this.command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await this.command('Runtime.enable', {}, true); await this.command('Page.enable', {}, true);
    await this.command('Runtime.addBinding', { name: 'benchReport' }, true);
    const destination = new URL('/health', origin).toString();
    const navigation = await this.command('Page.navigate', { url: destination }, true);
    if (navigation.errorText) throw new Error(`Browser navigation failed: ${navigation.errorText}`);
    let location = '';
    const navigationDeadline = performance.now() + 20_000;
    while (performance.now() < navigationDeadline) {
      const state = await this.evaluate('({origin:location.origin, ready:document.readyState})');
      if (state.origin === new URL(origin).origin && state.ready === 'complete') { location = state.origin; break; }
      await delay(10);
    }
    if (!location) throw new Error('Browser execution origin or load completion mismatch');
    await this.evaluate(bundle);
    const processes = await this.command('SystemInfo.getProcessInfo');
    const owned = await this.inventory();
    const parent = owned.table.find(row => row.pid === process.pid);
    if (!owned.root || !parent || owned.root.ppid !== process.pid || owned.root.pgid !== parent.pgid
      || owned.members.some(row => row.pgid !== parent.pgid)
      || !processes.processInfo.some((p: any) => p.type === 'browser' && p.id === this.pid)
      || processes.processInfo.some((p: any) => !owned.members.some(row => row.pid === p.id))) throw new Error('Browser process ownership or inherited trial group mismatch');
    return { processes, osProcesses: owned.members, pid: this.pid, parent, profileDirectory: this.profileDirectory, origin: location, version, commandLine, targetId: target.targetId };
  }
  command(method: string, params: any = {}, page = false): Promise<any> {
    if (this.#fault) return Promise.reject(this.#fault);
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser connection is unavailable'));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Browser ${method} timed out`)); }, 120_000);
      this.#pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { this.#socket!.send(JSON.stringify({ id, method, params, ...(page ? { sessionId: this.#session } : {}) })); }
      catch (error) { this.#pending.get(id)!.reject(error as Error); this.#pending.delete(id); }
    });
  }
  async evaluate(expression: string) {
    const response = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, true);
    if (response.exceptionDetails) throw new Error(`Browser evaluation failed: ${JSON.stringify(response.exceptionDetails)}`);
    return response.result?.value;
  }
  async call(method: string, params: any = null) {
    const value = await this.evaluate(`(async()=>JSON.stringify(await globalThis.benchmarkDispatch(${JSON.stringify(method)},${JSON.stringify(params)}),(_key,value)=>typeof value==='bigint'?value.toString():value))()`);
    return JSON.parse(value);
  }
  close(): Promise<any> { return this.#closing ??= this.#close(); }
  async #close() {
    await this.inventory();
    const before = [...this.#owned.values()];
    const signaled: ProcessIdentity[] = [];
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      // Do not let a stuck CDP command extend the shutdown deadline.
      void this.command('Browser.close').catch(() => {});
    }
    const graceDeadline = performance.now() + 5_000;
    let remaining: ProcessIdentity[] = [];
    do {
      const { table } = await this.inventory();
      remaining = table.filter(row => [...this.#owned.values()].some(owned => sameProcess(row, owned)));
      if (!remaining.length) break;
      if (performance.now() >= graceDeadline) {
        for (const row of remaining.reverse()) {
          if (row.pid <= 1) throw new Error('Invalid browser process identity');
          try { process.kill(row.pid, 'SIGKILL'); signaled.push(row); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
        }
        break;
      }
      await delay(25);
    } while (true);
    const finalDeadline = performance.now() + 5_000;
    do {
      const table = await browserProcessTable();
      remaining = table.filter(row => [...this.#owned.values()].some(owned => sameProcess(row, owned)));
      if (!remaining.length) break;
      await delay(25);
    } while (performance.now() < finalDeadline);
    this.#socket?.close();
    this.#fail(new Error('Browser closed'));
    if (remaining.length) throw Object.assign(new Error('Owned browser processes survived cleanup'), { evidence: { before, remaining, signaled } });
    return { pid: this.pid, before, observed: [...this.#owned.values()], signaled, remaining, allObservedAbsent: true, exit: await this.#exit };
  }
}
