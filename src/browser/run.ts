import { electricWriteUnsupported } from '../electric-support.ts';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { BrowserProcess } from './process.ts';
import { calibrateBrowserBridge } from './calibration.ts';
import { browserBinding, type BrowserIdentity, type ChromiumRuntime } from './provenance.ts';
import { BROWSER_IMPLEMENTATION, validateBrowserProbe } from './validation.ts';
import { measureCollaboration, collaborationSeed, collaborationWarmup } from '../contracts/collaboration.ts';
import { assertRows, taskRecord, fixtureTasks } from '../contracts/screens.ts';
import { getStack } from '../stacks.ts';
import { seedStack, getFixtures } from '../stack-manager.ts';
import { tempRoot } from '../paths.ts';
import { sha256 } from '../source-snapshot.ts';
import type { JsonObject } from '../types.ts';

export async function runBrowserCollaboration(stackId: 'electric' | 'zero', runtime: ChromiumRuntime, identity: BrowserIdentity, bundlePath: string) {
  if(stackId==='electric')return electricWriteUnsupported();
  const bundle = await readFile(bundlePath, 'utf8');
  if (sha256(bundle) !== identity.bundleSha256) throw new Error('Injected browser bundle differs from campaign');
  await seedStack(stackId, collaborationSeed);
  const fixture = await getFixtures(stackId), stack = getStack(stackId);
  if (!fixture.sampleTaskId) throw new Error('Missing collaboration task');
  await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, 'browser-trial-'));
  const profiles = await Promise.all(['writer', 'reader'].map(role => mkdtemp(join(dir, `${role}-`))));
  const browsers: BrowserProcess[] = [];
  const evidence: any = { stage: 'launch', stackId, dir, profiles, clients: [], events: [], binding: browserBinding(identity) };
  let failure: unknown;
  let current: { title: string; localCommitted(): void; serverAccepted(): void } | undefined;
  let resolveVisible: (() => void) | undefined, rejectVisible: ((error: Error) => void) | undefined;
  let arming: Promise<any> = Promise.resolve(), iteration = -collaborationWarmup;
  const sorted = (rows: any[]) => rows.map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  try {
    const origin = stack.syncBaseUrl;
    for (const [i, role] of ['writer', 'reader'].entries()) {
      const browser = new BrowserProcess(runtime.executable, profiles[i]); browsers.push(browser);
      const client: any = {}; evidence.clients.push(client);
      client.connection = await browser.connect(origin, bundle);
      if (client.connection.version.product !== `Chrome/${identity.browserVersion}`) throw new Error('Running browser version differs from inventoried executable');
      browser.onEvent((event, data) => {
        if (event === 'calibration') return;
        evidence.events.push({ role, event, data, controllerAtMs: performance.now() });
        if (event === 'fatal') { rejectVisible?.(new Error(data.error)); return; }
        if (data.taskId !== fixture.sampleTaskId) throw new Error('Browser event task mismatch');
        if (role === 'reader' && event === 'visible') {
          if (data.title !== current?.title) throw new Error('Browser observer title mismatch');
          resolveVisible?.();
        }
        if (role === 'writer' && current && current.title === data.title) {
          if (event === 'local') current.localCommitted();
          if (event === 'accepted') { current.serverAccepted(); }
        }
      });
      const auth = stackId === 'zero' ? await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setSubject('org-1-user-1').setExpirationTime('10m').sign(new TextEncoder().encode('benchsecret')) : undefined;
      client.initialized = await browser.call('init', { stackId, role, clientId: randomUUID(), actorId: 'org-1-user-1', syncBaseUrl: stack.syncBaseUrl, mutationBaseUrl: stack.mutationBaseUrl, auth, expectedRows: fixtureTasks(collaborationSeed) });
      client.initialDigest = assertRows(`browser ${role} initial`, sorted(client.initialized.rows), sorted(fixtureTasks(collaborationSeed)));
    }
    const [writer, reader] = browsers;
    evidence.stage = 'collaboration'; evidence.calibrationBefore = await calibrateBrowserBridge(writer, reader);
    const result = await measureCollaboration({ localCommit: stackId === 'zero', readData: async () => (await reader.call('read')).rows,
      observe: (title, signal) => {
        const waiting = new Promise<void>((resolve, reject) => { resolveVisible = resolve; rejectVisible = reject; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
        arming = reader.call('arm', { taskId: fixture.sampleTaskId, title }); void arming.catch(error => rejectVisible?.(error)); return waiting;
      },
      write: async (title, milestones) => { current = { title, ...milestones }; await arming; await writer.call('write', { taskId: fixture.sampleTaskId, title, iteration: iteration++ }); },
      diagnostics: { runtime: 'Chromium; independent browser processes and fresh user-data directories', localStorage: stackId === 'zero' ? 'native-indexeddb' : 'sdk-memory-shape',
        clock: 'controller-monotonic; includes CDP observation arming, write dispatch and receipt delivery', reader: 'native SDK subscription in a separate browser process',
        implementationScope: 'SDK collaboration; no rendered UI or process-durability claim' },
    });
    result.notes[1] = 'The controller observes native browser subscription and mutation receipts through CDP. Timings include arming, dispatch and binding delivery. Idle bridge calibration is retained separately and is not subtracted.';
    evidence.result = result; evidence.finalWriter = await writer.call('read'); evidence.finalReader = await reader.call('read');
    const expected = fixtureTasks(collaborationSeed).map(row => row.id === fixture.sampleTaskId ? { ...row, title: result.metadata.samples.at(-1)!.title, server_version: 1 } : row);
    evidence.finalDigests = { writer: assertRows('browser writer final', sorted(evidence.finalWriter.rows), sorted(expected)), reader: assertRows('browser reader final', sorted(evidence.finalReader.rows), sorted(expected)) };
    evidence.calibrationAfter = await calibrateBrowserBridge(writer, reader); evidence.stage = 'complete';
  } catch (error) { evidence.stage = 'failed'; evidence.error = String(error); failure = error; }
  finally {
    evidence.cleanup = await Promise.all(browsers.map(async browser => {
      try { return await browser.close(); }
      catch (error) { failure ??= error; evidence.stage = 'failed'; return { error: String(error), evidence: (error as any).evidence ?? null }; }
    }));
  }
  if (failure) throw Object.assign(failure instanceof Error ? failure : new Error(String(failure)), { evidence });
  try { validateBrowserProbe(evidence); } catch (error) { throw Object.assign(error as Error, { evidence }); }
  return { status: 'completed' as const, metrics: evidence.result.metrics as Record<string, number | null>, notes: evidence.result.notes as string[],
    metadata: { ...evidence.result.metadata, implementation: BROWSER_IMPLEMENTATION, clientRuntime: 'chromium', browserBinding: browserBinding(identity), browserEvidence: evidence } as JsonObject };
}
