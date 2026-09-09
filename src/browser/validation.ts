import { collaborationIterations, collaborationSeed, collaborationWarmup } from '../contracts/collaboration.ts';
import { validateElectricCollaborationReceipts } from '../contracts/electric-collaboration.ts';
import { validateCollaborationMeasurement } from '../contracts/result-validation.ts';
import { assertRows, ContractError, fixtureTasks, hash, taskRecord } from '../contracts/screens.ts';
import { getStack } from '../stacks.ts';
import type { BenchmarkResult } from '../types.ts';

export const BROWSER_IMPLEMENTATION = 'browser-collaboration-v1';
export function validateBrowserResult(result: Pick<BenchmarkResult, 'scenarioId' | 'metrics' | 'metadata'> & Partial<Pick<BenchmarkResult, 'stackId'>>): void {
  const metadata = result.metadata, evidence = metadata.browserEvidence as any;
  requireEvidence(result.scenarioId === 'online-propagation' && metadata.clientRuntime === 'chromium' && metadata.implementation === BROWSER_IMPLEMENTATION && result.stackId === evidence?.stackId, 'runtime, implementation or scenario admission mismatch');
  requireEvidence(hash(metadata.browserBinding) === hash(evidence.binding) && hash(result.metrics) === hash(evidence.result.metrics), 'outer result differs from native browser evidence');
  for (const key of ['workloadContract', 'fixture', 'validation', 'samples', 'resources', 'diagnostics', 'localCommitAvailable']) requireEvidence(hash(metadata[key]) === hash(evidence.result.metadata[key]), `outer ${key} differs from browser evidence`);
  validateBrowserProbe(evidence);
}

const requireEvidence = (condition: unknown, message: string): void => { if (!condition) throw new ContractError(`Browser ${message}`); };
const duration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const sorted = (rows: any[]) => rows.map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id)));

export function validateBrowserCalibration(value: any): void {
  requireEvidence(value?.method === 'cdp-idle-two-call-binding-v1' && value.clock === 'controller-monotonic' && value.iterations === 100 && value.warmups === 5 && value.samples?.length === 100, 'calibration contract missing');
  for (const [index, sample] of value.samples.entries()) requireEvidence(sample.iteration === index && duration(sample.armMs) && duration(sample.twoCallsMs) && duration(sample.bindingMs) && sample.armMs <= sample.twoCallsMs && sample.armMs <= sample.bindingMs, 'calibration timing or order invalid');
}

export function validateBrowserClients(evidence: any): void {
  requireEvidence(["electric", "zero"].includes(evidence?.stackId), "unsupported client profile");
  const stackId = evidence.stackId as 'electric' | 'zero', stack = getStack(stackId);
  requireEvidence(evidence.clients?.length === 2 && evidence.profiles?.length === 2 && evidence.cleanup?.length === 2, 'independent clients or cleanup missing');
  const expectedOrigin = new URL(stackId === 'electric' ? stack.mutationBaseUrl! : stack.syncBaseUrl).origin;
  const initial = sorted(fixtureTasks(collaborationSeed));
  const identities = ['pid', 'profileDirectory', 'targetId'];
  for (const key of identities) requireEvidence(new Set(evidence.clients.map((client: any) => client.connection?.[key])).size === 2, `independent ${key} missing`);
  requireEvidence(new Set(evidence.clients.map((client: any) => client.initialized?.clientId)).size === 2, 'native client IDs reused');
  requireEvidence(hash(evidence.clients[0].connection.version) === hash(evidence.clients[1].connection.version), 'client browser versions differ');
  for (const [i, client] of evidence.clients.entries()) {
    const connection = client.connection, init = client.initialized, cleanup = evidence.cleanup[i];
    requireEvidence(init?.role === ['writer', 'reader'][i] && init.stackId === stackId && init.origin === expectedOrigin && connection.origin === expectedOrigin && init.secureContext === true, 'client role, origin or secure context mismatch');
    requireEvidence(/^Chrome\/\d+\.\d+\.\d+\.\d+$/.test(connection.version?.product) && typeof connection.version.revision === 'string' && typeof connection.version.jsVersion === 'string', 'actual Chromium runtime identity missing');
    requireEvidence(connection.profileDirectory === evidence.profiles[i] && connection.commandLine?.arguments?.includes(`--user-data-dir=${evidence.profiles[i]}`), 'owned profile command line mismatch');
    requireEvidence(connection.commandLine.arguments.includes('--headless=new') && connection.commandLine.arguments.includes('--enable-automation') && !connection.commandLine.arguments.some((arg: string) => /disable-web-security|ignore-certificate-errors|allow-insecure-localhost/.test(arg)), 'browser launch boundary changed');
    const os = connection.osProcesses;
    requireEvidence(Array.isArray(os) && os.length > 1 && os.every((row: any) => Number.isSafeInteger(row.pid) && row.pid > 1 && row.pgid === connection.parent.pgid && typeof row.started === 'string'), 'OS helper identity or inherited group missing');
    requireEvidence(os.some((row: any) => row.pid === connection.pid && row.ppid === connection.parent.pid), 'browser parent ownership missing');
    requireEvidence(connection.processes?.processInfo?.some((row: any) => row.id === connection.pid && row.type === 'browser') && connection.processes.processInfo.every((row: any) => os.some((member: any) => member.pid === row.id)), 'CDP processes differ from owned OS processes');
    requireEvidence(cleanup?.pid === connection.pid && cleanup.allObservedAbsent === true && Array.isArray(cleanup.remaining) && cleanup.remaining.length === 0 && Array.isArray(cleanup.observed) && Array.isArray(cleanup.before)
      && new Set(cleanup.observed.map((row: any) => row.pid)).size === cleanup.observed.length
      && [...os, ...cleanup.before].every((row: any) => cleanup.observed.some((member: any) => member.pid === row.pid && member.started === row.started && member.pgid === row.pgid)), 'helper cleanup proof missing');
    const digest = assertRows(`browser ${init.role} initial`, sorted(init.rows), initial);
    requireEvidence(client.initialDigest === digest, 'initial full-record digest differs');
    if (stackId === 'zero') requireEvidence(init.storage === 'native-indexeddb' && init.databases?.some((db: any) => db.name?.startsWith('rep:zero-') && db.version > 0), 'native IndexedDB cache missing');
    else requireEvidence(init.storage === 'sdk-memory-shape' && init.nativeRowTypes?.server_version === 'bigint', 'native Electric Shape metadata differs');
  }
  if (stackId === 'zero') {
    const databaseNames = evidence.clients.map((client: any) => client.initialized.databases.filter((db: any) => db.name.startsWith('rep:zero-')).map((db: any) => db.name));
    requireEvidence(databaseNames[0].every((name: string) => !databaseNames[1].includes(name)), 'Zero native cache identities overlap');
  }
}

/** Audits native browser probe evidence. Passing this does not establish campaign
 * provenance, publication eligibility, or support for any other browser case. */
export function validateBrowserProbe(evidence: any): void {
  requireEvidence(evidence?.stage === 'complete' && ['electric', 'zero'].includes(evidence.stackId), 'probe did not complete a supported native collaboration path');
  validateBrowserClients(evidence);
  const stackId = evidence.stackId as "electric" | "zero";
  const initial = sorted(fixtureTasks(collaborationSeed));
  const result = evidence.result;
  validateCollaborationMeasurement({ scenarioId: 'online-propagation', metrics: result.metrics, metadata: result.metadata });
  const resources = result.metadata.resources;
  requireEvidence(resources.includeRoot === true && evidence.clients.every((client: any) => client.connection.parent.pid === resources.rootPid)
    && resources.samples.every((sample: any) => [resources.rootPid, ...evidence.clients.map((client: any) => client.connection.pid)].every((pid: number) => sample.processes.some((row: any) => row.pid === pid))), 'resource scope omits the controller or either browser');
  requireEvidence(result.metadata.localCommitAvailable === (stackId === 'zero'), 'local receipt availability changed');
  const receipts = evidence.finalWriter?.receipts;
  requireEvidence(Array.isArray(receipts) && receipts.length === collaborationIterations + collaborationWarmup, 'native mutation receipts missing');
  const samples = result.metadata.samples;
  if (stackId === 'electric') validateElectricCollaborationReceipts({ mutationReceipts: receipts, samples });
  const taskId = stackId === 'electric' ? receipts[0].request.taskId : receipts[0].taskId;
  requireEvidence(initial.some(row => row.id === taskId), 'changed task is outside fixture');
  const titles = receipts.map((receipt: any) => stackId === 'electric' ? receipt.request.title : receipt.title);
  requireEvidence(new Set(titles).size === receipts.length && titles.every((title: any) => typeof title === 'string' && title.startsWith('collaboration-')), 'operation titles missing or duplicated');
  for (const [i, receipt] of receipts.entries()) {
    requireEvidence(receipt.iteration === i - collaborationWarmup && (i < collaborationWarmup || samples[i - collaborationWarmup].title === titles[i]), 'operation receipt is not bound to its measured sample');
    if (stackId === 'zero') requireEvidence(receipt.taskId === taskId && receipt.local?.type === 'success' && receipt.server?.type === 'success', 'native Zero mutation did not settle successfully');
  }
  const events = evidence.events;
  requireEvidence(Array.isArray(events) && events.length === receipts.length * (stackId === 'zero' ? 3 : 2), 'native event coverage differs');
  let lastAt = 0;
  for (const event of events) {
    requireEvidence(duration(event.controllerAtMs) && event.controllerAtMs >= lastAt && duration(event.data?.browserAtMs) && event.data.taskId === taskId && titles.includes(event.data.title), 'native event identity or clock invalid');
    lastAt = event.controllerAtMs;
  }
  for (const [i, title] of titles.entries()) {
    const expectedEvents = [['writer', 'accepted'], ['reader', 'visible'], ...(stackId === 'zero' ? [['writer', 'local']] : [])];
    for (const [role, eventName] of expectedEvents) {
      const matches = events.filter((event: any) => event.role === role && event.event === eventName && event.data.title === title);
      requireEvidence(matches.length === 1, 'native receipt event missing or duplicated');
      const data = matches[0].data;
      if (eventName === 'visible') {
        const expected = { ...initial.find(row => row.id === taskId)!, title, server_version: stackId === 'electric' ? i + 2 : 1 };
        assertRows('browser native visible task', [taskRecord(data.row)], [expected]);
      } else if (stackId === 'electric') requireEvidence(hash(data.receipt) === hash(receipts[i]), 'Electric acceptance event differs from mutation response');
      else requireEvidence(data.receipt?.iteration === i - collaborationWarmup && data.receipt.taskId === taskId && data.receipt.title === title && data.receipt[eventName === 'local' ? 'local' : 'server']?.type === 'success', 'Zero native receipt event differs from mutation');
    }
  }
  const expected = initial.map(row => row.id === taskId ? { ...row, title: titles.at(-1), server_version: stackId === 'electric' ? receipts.length + 1 : 1 } : row);
  for (const role of ['writer', 'reader']) {
    const state = evidence[role === 'writer' ? 'finalWriter' : 'finalReader'];
    const digest = assertRows(`browser ${role} final`, sorted(state.rows), expected);
    requireEvidence(evidence.finalDigests?.[role] === digest, 'final full-record digest differs');
  }
  validateBrowserCalibration(evidence.calibrationBefore); validateBrowserCalibration(evidence.calibrationAfter);
}
