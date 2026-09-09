import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { JsonObject } from './types.ts';
export interface ResourceResult { metrics: Record<string, number>; metadata: JsonObject }
/** Sampling continues while the benchmark's JS thread is blocked. */
export class ExternalResources {
  #includeRoot: boolean;
  #rootPid: number;
  constructor(includeRoot = true, rootPid = process.pid) {
    if (!Number.isSafeInteger(rootPid) || rootPid < 2) throw new Error('Resource sampling requires a positive process identity');
    this.#includeRoot = includeRoot; this.#rootPid = rootPid;
  }
  #child: ChildProcessWithoutNullStreams | undefined;
  #result: Promise<ResourceResult> | undefined;
  async start(): Promise<void> {
    if (this.#child) throw new Error('Resource sampler already started');
    const child = spawn('node', [fileURLToPath(new URL('./resource-worker.mjs', import.meta.url)), String(this.#rootPid), '25', ...(this.#includeRoot ? [] : ['--descendants-only'])], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    let ready!: () => void;
    let rejectReady!: (error: Error) => void;
    const readiness = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    let resolveResult!: (value: ResourceResult) => void;
    let rejectResult!: (error: Error) => void;
    this.#result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    void this.#result.catch(() => {});
    let received = false;
    const fail = (error: Error) => { rejectReady(error); rejectResult(error); child.kill(); };
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) fail(new Error(`Resource sampling failed: ${message.error}`));
          if (message.ready) ready();
          if (message.result) { received = true; resolveResult(message.result); }
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', fail);
    child.on('exit', code => { if (!received) fail(new Error(`Resource sampler exited ${code}: ${stderr}`)); });
    const timeout = setTimeout(() => fail(new Error('Resource sampler startup timed out')), 10_000);
    try { await readiness; } finally { clearTimeout(timeout); }
  }
  async stop(): Promise<ResourceResult> {
    if (!this.#child || !this.#result) throw new Error('Resource sampler has not started');
    const child = this.#child;
    child.stdin.write('stop\n');
    const timeout = setTimeout(() => child.kill(), 10_000);
    try { return await this.#result; } finally { clearTimeout(timeout); child.stdin.end(); this.#child = undefined; }
  }
  abort(): void { this.#child?.kill(); this.#child = undefined; }
}
