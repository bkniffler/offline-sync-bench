import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { BrowserProcess } from './process.ts';
import { browserBinding, type BrowserIdentity, type ChromiumRuntime } from './provenance.ts';
import { measureLoadedOperation } from './loaded-operation.ts';
import { validateLoadedBrowserCondition } from './loaded-validation.ts';
import { collaborationIterations, collaborationSeed, collaborationWarmup } from '../contracts/collaboration.ts';
import { assertRows, taskRecord, fixtureTasks } from '../contracts/screens.ts';
import { getStack } from '../stacks.ts';
import { seedStack, getFixtures } from '../stack-manager.ts';
import { tempRoot } from '../paths.ts';
import { sha256 } from '../source-snapshot.ts';
import { ExternalResources } from '../resources.ts';

export const LOADED_BROWSER_METHOD = 'browser-milestone-forwarding-v1';
export type ForwardingMode = 'buffered' | 'forwarded';
const sorted = (rows: any[]) => rows.map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** Diagnostic only. The paired runner must supply per-attempt isolation,
 * configuration/storage receipts, a whole-attempt deadline and provenance.
 * These completion spans are not canonical browser collaboration metrics. */
export async function runLoadedBrowserCondition(
  stackId: 'electric' | 'zero', mode: ForwardingMode,
  runtime: ChromiumRuntime, identity: BrowserIdentity, bundlePath: string,
) {
  if (!['buffered', 'forwarded'].includes(mode)) throw new Error('Unknown browser forwarding condition');
  const bundle = await readFile(bundlePath, 'utf8');
  if (sha256(bundle) !== identity.bundleSha256) throw new Error('Loaded browser bundle differs from declared identity');
  const evidence: any = {
    method: LOADED_BROWSER_METHOD, mode, stackId, stage: 'seed', binding: browserBinding(identity),
    clients: [], forwardedEvents: [], operations: [], fixture: collaborationSeed,
    warmups: collaborationWarmup, iterations: collaborationIterations,
    completion: 'controller-reader-arm-and-independent-writer-reader-RPC-v1',
    clock: 'separate-controller-writer-reader-monotonic-clocks',
  };
  const browsers: BrowserProcess[] = [];
  const resources = new ExternalResources();
  let sampling = false, failure: unknown;
  try {
    await seedStack(stackId, collaborationSeed);
    const fixture = await getFixtures(stackId), stack = getStack(stackId);
    if (!fixture.sampleTaskId) throw new Error('Missing loaded collaboration task');
    evidence.taskId = fixture.sampleTaskId;
    await mkdir(tempRoot, { recursive: true });
    evidence.dir = await mkdtemp(join(tempRoot, 'browser-loaded-'));
    evidence.profiles = await Promise.all(['writer', 'reader'].map(role => mkdtemp(join(evidence.dir, `${role}-`))));
    evidence.stage = 'launch';
    const origin = stackId === 'electric' ? stack.mutationBaseUrl! : stack.syncBaseUrl;
    for (const [i, role] of ['writer', 'reader'].entries()) {
      const browser = new BrowserProcess(runtime.executable, evidence.profiles[i]);
      browsers.push(browser);
      const client: any = {}; evidence.clients.push(client);
      client.connection = await browser.connect(origin, bundle);
      if (client.connection.version.product !== `Chrome/${identity.browserVersion}`) throw new Error('Loaded browser version changed');
      browser.onEvent((event, data) => {
        evidence.forwardedEvents.push({ role, event, data, controllerAtMs: performance.now() });
        if (event === 'fatal') throw new Error(`Loaded browser failed: ${data.error}`);
        if (!['local', 'accepted', 'visible'].includes(event) || mode !== 'forwarded') throw new Error('Unexpected loaded browser binding event');
        // Recording only. This callback never settles a workload promise.
      });
      const auth = stackId === 'zero' ? await new SignJWT({}).setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt().setSubject('org-1-user-1').setExpirationTime('10m')
        .sign(new TextEncoder().encode('benchsecret')) : undefined;
      client.initialized = await browser.call('init', {
        stackId, role, clientId: randomUUID(), actorId: 'org-1-user-1',
        syncBaseUrl: stack.syncBaseUrl, mutationBaseUrl: stack.mutationBaseUrl,
        auth, expectedRows: fixtureTasks(collaborationSeed), diagnosticForwarding: mode,
      });
      client.initialDigest = assertRows(`loaded ${role} initial`, sorted(client.initialized.rows), sorted(fixtureTasks(collaborationSeed)));
    }
    const [writer, reader] = browsers;
    evidence.stage = 'workload';
    await resources.start(); sampling = true;
    for (let iteration = -collaborationWarmup; iteration < collaborationIterations; iteration++) {
      evidence.operations.push(await measureLoadedOperation(writer, reader, {
        iteration, taskId: fixture.sampleTaskId, title: `collaboration-${randomUUID()}`,
      }));
    }
    evidence.resources = await resources.stop(); sampling = false;
    evidence.stage = 'validation';
    evidence.finalWriter = await writer.call('read');
    evidence.finalReader = await reader.call('read');
    evidence.buffered = { writer: await writer.call('diagnostic-read'), reader: await reader.call('diagnostic-read') };
    const expected = fixtureTasks(collaborationSeed).map(row => row.id === fixture.sampleTaskId
      ? { ...row, title: evidence.operations.at(-1).title, server_version: stackId === 'electric' ? collaborationWarmup + collaborationIterations + 1 : 1 } : row);
    evidence.finalDigests = {
      writer: assertRows('loaded writer final', sorted(evidence.finalWriter.rows), sorted(expected)),
      reader: assertRows('loaded reader final', sorted(evidence.finalReader.rows), sorted(expected)),
    };
    // Derived after measurement. Re-encoding records is not a wire-byte meter.
    evidence.forwardedPayloadJsonBytes = evidence.forwardedEvents.reduce((sum: number, item: any) => sum + Buffer.byteLength(JSON.stringify({ event: item.event, data: item.data })), 0);
  } catch (error) {
    failure = error; evidence.error = String(error); evidence.failedStage = evidence.stage;
  } finally {
    if (sampling) {
      try { evidence.resources = await resources.stop(); }
      catch (error) { evidence.resourceError = String(error); failure ??= error; }
    }
    resources.abort();
    evidence.cleanup = await Promise.all(browsers.map(async browser => {
      try { return await browser.close(); }
      catch (error) { failure ??= error; return { error: String(error), evidence: (error as any).evidence ?? null }; }
    }));
  }
  evidence.stage = failure ? 'failed' : 'complete';
  if (!failure) {
    try { validateLoadedBrowserCondition(evidence); }
    catch (error) { failure = error; evidence.stage = 'failed'; evidence.error = String(error); }
  }
  if (failure) throw Object.assign(failure instanceof Error ? failure : new Error(String(failure)), { evidence });
  return evidence;
}
