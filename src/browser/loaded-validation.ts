import { collaborationIterations, collaborationSeed, collaborationWarmup } from '../contracts/collaboration.ts';
import { validateElectricCollaborationReceipts } from '../contracts/electric-collaboration.ts';
import { assertRows, fixtureTasks, hash, taskRecord } from '../contracts/screens.ts';
import { validateBrowserClients } from './validation.ts';

const requireEvidence = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`Loaded browser ${message}`);
};
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const sorted = (rows: any[]) => rows.map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** Checks one condition's complete native evidence. This does not verify the
 * outer paired campaign's fixed plan or source/configuration provenance. */
export function validateLoadedBrowserCondition(e: any): void {
  requireEvidence(e?.stage === 'complete' && e.method === 'browser-milestone-forwarding-v1'
    && ['buffered', 'forwarded'].includes(e.mode), 'condition did not complete');
  requireEvidence(e.completion === 'controller-reader-arm-and-independent-writer-reader-RPC-v1'
    && e.clock === 'separate-controller-writer-reader-monotonic-clocks', 'completion or clock contract differs');
  requireEvidence(hash(e.fixture) === hash(collaborationSeed) && e.warmups === collaborationWarmup
    && e.iterations === collaborationIterations, 'workload declaration differs');
  validateBrowserClients(e);
  requireEvidence(e.clients.every((c: any) => c.initialized.diagnosticForwarding === e.mode
    && c.connection.version.product === `Chrome/${e.binding?.browserVersion}`), 'native mode or browser binding differs');
  requireEvidence(e.clients.every((c: any) => c.initialized.role === 'writer' || c.initialized.role === 'reader'), 'client role missing');
  const count = collaborationWarmup + collaborationIterations;
  const initial = sorted(fixtureTasks(collaborationSeed));
  const initialTask = initial.find(row => row.id === e.taskId);
  requireEvidence(initialTask, 'target task is outside the canonical fixture');
  requireEvidence(Array.isArray(e.operations) && e.operations.length === count
    && new Set(e.operations.map((s: any) => s.title)).size === count, 'operation coverage missing or duplicated');
  const receipts = e.finalWriter?.receipts;
  requireEvidence(Array.isArray(receipts) && receipts.length === count, 'native writer receipts missing');
  requireEvidence(Array.isArray(e.finalReader?.receipts) && e.finalReader.receipts.length === 0, 'reader performed writes');
  if (e.stackId === 'electric') validateElectricCollaborationReceipts({
    mutationReceipts: receipts, samples: e.operations.filter((s: any) => s.iteration >= 0),
  });
  const buffered: Array<{ role: string; event: string; data: any }> = [];
  for (const role of ['writer', 'reader']) {
    requireEvidence(e.buffered?.[role]?.mode === e.mode && Array.isArray(e.buffered[role].events), 'native buffered mode or events missing');
    buffered.push(...e.buffered[role].events.map((event: any) => ({ role, ...event })));
  }
  const eventsPerWrite = e.stackId === 'zero' ? 3 : 2;
  requireEvidence(buffered.length === count * eventsPerWrite, 'buffered event coverage differs');
  requireEvidence(Array.isArray(e.forwardedEvents), 'forwarded event inventory missing');
  requireEvidence(e.forwardedEvents.length === (e.mode === 'forwarded' ? buffered.length : 0), 'forwarding mode leaked, dropped or duplicated events');
  let lastForwardedAt = 0;
  for (const item of e.forwardedEvents) {
    requireEvidence(duration(item.controllerAtMs) && item.controllerAtMs >= lastForwardedAt, 'forwarded controller clock differs');
    lastForwardedAt = item.controllerAtMs;
  }
  const reencodedBytes = e.forwardedEvents.reduce((sum: number, item: any) => sum + Buffer.byteLength(JSON.stringify({ event: item.event, data: item.data })), 0);
  requireEvidence(e.forwardedPayloadJsonBytes === reencodedBytes, 'derived JSON byte accounting differs');
  let lastController = 0, lastWriter = 0, lastReader = 0;
  for (const [i, sample] of e.operations.entries()) {
    requireEvidence(sample.iteration === i - collaborationWarmup && sample.taskId === e.taskId
      && typeof sample.title === 'string' && sample.title.startsWith('collaboration-'), 'operation identity or order differs');
    const c = sample.controller, w = sample.writer, r = sample.reader;
    requireEvidence(c && w && r && [c.startedAtMs, c.finishedAtMs, c.armMs, c.writerMs, c.readerMs, c.totalMs,
      w.startedAtMs, w.finishedAtMs, r.browserAtMs].every(duration), 'operation clock missing');
    requireEvidence(c.startedAtMs >= lastController && c.finishedAtMs >= c.startedAtMs
      && Math.abs((c.finishedAtMs - c.startedAtMs) - c.totalMs) < 1e-6
      && c.armMs <= c.writerMs && c.armMs <= c.readerMs
      && c.writerMs <= c.totalMs && c.readerMs <= c.totalMs, 'controller completion timing or sequencing differs');
    requireEvidence(w.startedAtMs >= lastWriter && w.finishedAtMs >= w.startedAtMs && r.browserAtMs >= lastReader,
      'native clock or serial operation order differs');
    lastController = c.finishedAtMs; lastWriter = w.finishedAtMs; lastReader = r.browserAtMs;
    const receipt = receipts[i];
    requireEvidence(receipt.iteration === sample.iteration, 'mutation receipt iteration differs');
    if (e.stackId === 'zero') requireEvidence(receipt.taskId === e.taskId && receipt.title === sample.title
      && receipt.local?.type === 'success' && receipt.server?.type === 'success', 'Zero mutation did not settle');
    const expectedTask = { ...initialTask!, title: sample.title, server_version: e.stackId === 'electric' ? i + 2 : 1 };
    assertRows('loaded native completion task', [taskRecord(r.row)], [expectedTask]);
    const expectedEvents = [['writer', 'accepted'], ['reader', 'visible'], ...(e.stackId === 'zero' ? [['writer', 'local']] : [])];
    for (const [role, eventName] of expectedEvents) {
      const matches = buffered.filter(item => item.role === role && item.event === eventName && item.data?.title === sample.title);
      requireEvidence(matches.length === 1, 'native receipt event missing or duplicated');
      const item = matches[0], data = item.data;
      requireEvidence(data.taskId === e.taskId && duration(data.browserAtMs), 'native receipt identity or clock missing');
      if (role === 'writer') {
        requireEvidence(data.browserAtMs >= w.startedAtMs && data.browserAtMs <= w.finishedAtMs, 'writer event lies outside its local operation');
        if (e.stackId === 'electric') requireEvidence(hash(data.receipt) === hash(receipt), 'Electric acceptance differs from native response');
        else requireEvidence(data.receipt?.iteration === sample.iteration && data.receipt.taskId === e.taskId
          && data.receipt.title === sample.title && data.receipt[eventName === 'local' ? 'local' : 'server']?.type === 'success', 'Zero buffered native receipt differs');
      } else {
        requireEvidence(data.browserAtMs === r.browserAtMs && hash(data.row) === hash(r.row), 'reader completion differs from its native subscription record');
      }
      if (e.mode === 'forwarded') {
        const forwarded = e.forwardedEvents.filter((candidate: any) => candidate.role === role && candidate.event === eventName && candidate.data?.title === sample.title);
        requireEvidence(forwarded.length === 1 && hash(forwarded[0].data) === hash(data), 'forwarded receipt differs from buffered native record');
      }
    }
  }
  const finalTitle = e.operations.at(-1).title;
  const expected = initial.map(row => row.id === e.taskId ? { ...row, title: finalTitle, server_version: e.stackId === 'electric' ? count + 1 : 1 } : row);
  for (const role of ['writer', 'reader']) {
    const state = e[role === 'writer' ? 'finalWriter' : 'finalReader'];
    const digest = assertRows(`loaded ${role} final`, sorted(state.rows), expected);
    requireEvidence(e.finalDigests?.[role] === digest, 'final complete dataset digest differs');
  }
  const resources = e.resources?.metadata;
  requireEvidence(resources?.includeRoot === true && Array.isArray(resources.samples) && resources.samples.length > 0
    && e.clients.every((client: any) => client.connection.parent.pid === resources.rootPid)
    && resources.samples.every((sample: any) => [resources.rootPid, ...e.clients.map((client: any) => client.connection.pid)]
      .every((pid: number) => sample.processes.some((row: any) => row.pid === pid))), 'resources omit controller or browser scope');
  requireEvidence(e.resources.metrics?.resource_sample_count === resources.samples.length, 'resource sample count differs');
}
