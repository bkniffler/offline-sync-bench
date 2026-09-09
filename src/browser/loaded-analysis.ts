import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { hash } from '../contracts/screens.ts';
import { median, trialSummary } from '../statistics.ts';
import { readCampaignSource, sha256 } from '../source-snapshot.ts';
import { readCampaignDependencies } from '../dependencies.ts';
import { readCampaignConfiguration } from '../configuration.ts';
import { readCampaignBrowser, browserBinding } from './provenance.ts';
import { validateServerStoragePair, serverStoragePolicy } from '../server-storage.ts';
import { planLoadedCampaign, LOADED_WORKER_ENTRYPOINT } from './loaded-plan.ts';
import { validateLoadedBrowserCondition } from './loaded-validation.ts';
import { validateLoadedProcessGroup, processIdentityKey } from './loaded-process.ts';
import { sourceIdentity } from '../provenance.ts';

export const LOADED_ANALYSIS_METHOD = 'browser-forwarding-paired-median-v1';
const requireEvidence = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`Loaded experiment ${message}`);
};
const entryOnly = (a: any) => ({ stackId: a.stackId, pair: a.pair, mode: a.mode, order: a.order });
const metricKeys = ['controller_completion_p50_ms', 'writer_acceptance_p50_ms', 'writer_local_p50_ms'] as const;

function conditionValues(e: any) {
  const samples = e.operations.filter((s: any) => s.iteration >= 0);
  const eventDuration = (sample: any, name: string) => {
    const item = e.buffered.writer.events.find((event: any) => event.event === name && event.data.title === sample.title);
    return item.data.browserAtMs - sample.writer.startedAtMs;
  };
  return {
    controller_completion_p50_ms: median(samples.map((s: any) => s.controller.totalMs)),
    writer_acceptance_p50_ms: median(samples.map((s: any) => eventDuration(s, 'accepted'))),
    writer_local_p50_ms: e.stackId === 'zero' ? median(samples.map((s: any) => eventDuration(s, 'local'))) : null,
  };
}

/** Pure analysis, also used by tests. Artifact verification is a separate gate
 * in verifyAndAnalyzeLoadedCampaign; this function alone proves no provenance. */
export function analyzeLoadedManifest(m: any) {
  requireEvidence(m?.version === 1 && m.method === 'browser-milestone-forwarding-v1' && m.status === 'complete', 'collection is incomplete');
  const plan = planLoadedCampaign(m.config);
  requireEvidence(hash(plan) === hash(m.plan) && m.attempts?.length === plan.length, 'fixed plan is incomplete or changed');
  const ids = new Set<string>(), stores = new Set<string>(), processes = new Set<string>();
  let previousFinished = Date.parse(m.declaredAt);
  requireEvidence(Number.isFinite(previousFinished) && Number.isFinite(Date.parse(m.startedAt))
    && Date.parse(m.startedAt) <= previousFinished, 'declaration time missing or precedes preparation');
  for (const [index, attempt] of m.attempts.entries()) {
    const r = attempt.result;
    requireEvidence(r?.version === 1 && hash(entryOnly(attempt)) === hash(plan[index]) && hash(r.entry) === hash(plan[index]) && r.runId === m.id, 'attempt differs from declared order');
    requireEvidence(typeof r.resultId === 'string' && r.resultId && !ids.has(r.resultId), 'result identity missing or repeated');
    ids.add(r.resultId);
    requireEvidence(['completed', 'failed', 'invalid', 'timed-out'].includes(r.status), 'attempt outcome missing');
    requireEvidence(r.workerEntrypoint === LOADED_WORKER_ENTRYPOINT, 'worker entrypoint differs from the declared implementation');
    const started = Date.parse(r.startedAt), finished = Date.parse(r.finishedAt);
    requireEvidence(Number.isFinite(started) && Number.isFinite(finished) && started >= previousFinished && finished >= started
      && Number.isFinite(r.durationMs) && r.durationMs >= 0, 'trial wall window or serial order differs');
    previousFinished = finished;
    requireEvidence(r.processGroup?.emptyVerified === true && Array.isArray(r.processGroup.remaining) && !r.processGroup.remaining.length,
      'trial process group cleanup is unverified');
    for (const identity of validateLoadedProcessGroup(m.controller, r)) {
      const key = processIdentityKey(identity);
      requireEvidence(!processes.has(key), 'process identity reused across conditions'); processes.add(key);
    }
    if (r.status !== 'completed') requireEvidence(typeof r.error === 'string' && r.error, 'failed condition has no explanation');
    if (r.status === 'completed') {
      requireEvidence(r.exitCode === 0 && r.evidence?.stackId === attempt.stackId && r.evidence?.mode === attempt.mode
        && hash(r.evidence.binding) === hash(browserBinding(m.browser)), 'successful condition differs from declared runtime');
      validateLoadedBrowserCondition(r.evidence);
    }
    for (const store of r.evidence?.profiles ?? []) {
      requireEvidence(typeof store === 'string' && store && !stores.has(store), 'browser profile directory reused across conditions');
      stores.add(store);
    }
  }
  requireEvidence(Number.isFinite(Date.parse(m.finishedAt)) && Date.parse(m.finishedAt) >= previousFinished, 'campaign ends before its final attempt');
  const summaries = m.config.stacks.map((stackId: string) => {
    const pairs = Array.from({ length: m.config.pairs }, (_, i) => {
      const pair = i + 1;
      const attempts = m.attempts.filter((a: any) => a.stackId === stackId && a.pair === pair);
      const buffered = attempts.find((a: any) => a.mode === 'buffered'), forwarded = attempts.find((a: any) => a.mode === 'forwarded');
      const complete = buffered.result.status === 'completed' && forwarded.result.status === 'completed';
      const values = complete ? { buffered: conditionValues(buffered.result.evidence), forwarded: conditionValues(forwarded.result.evidence) } : null;
      return { pair, order: attempts.map((a: any) => a.mode), complete,
        outcomes: attempts.map((a: any) => ({ mode: a.mode, resultId: a.result.resultId, status: a.result.status, error: a.result.error })), values };
    });
    const metrics = Object.fromEntries(metricKeys.map(key => {
      const values = pairs.flatMap(pair => {
        const a = pair.values?.buffered[key], b = pair.values?.forwarded[key];
        return typeof a === 'number' && typeof b === 'number' ? [{ pair: pair.pair, bufferedMs: a, forwardedMs: b,
          differenceMs: b - a, relativeChange: a > 0 ? (b - a) / a : null }] : [];
      });
      return [key, { pairs: values, pairedDifferenceMs: values.length ? trialSummary(values.map(value => value.differenceMs), m.config.seed) : null }];
    }));
    return { stackId, plannedPairs: m.config.pairs, completePairs: pairs.filter(pair => pair.complete).length, pairs, metrics };
  });
  return { method: LOADED_ANALYSIS_METHOD, campaignId: m.id, purpose: m.config.purpose, summaries,
    interpretation: 'Positive paired differences mean the forwarded condition took longer. Intervals resample independent pair differences, not pooled operations; fewer than five complete pairs have no interval.',
    limitation: 'This measures incremental native milestone forwarding in the declared common-RPC diagnostic workflow. Both modes retain buffering, CDP completion and resource sampling. It is neither all instrumentation overhead nor a correction factor for canonical browser timings. No cross-process clock subtraction or equivalence claim.' };
}

/** Raw per-attempt archive checks. The caller must separately verify the full
 * declaration/provenance, native evidence and complete fixed plan. */
export async function verifyLoadedAttemptArtifacts(dir: string, m: any, a: any, index: number): Promise<void> {
  const artifact = async (name: unknown): Promise<string> => {
    requireEvidence(typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name), 'artifact path is unsafe');
    const path = join(dir, name as string);
    requireEvidence((await lstat(path)).isFile(), 'trial artifact must be a regular file');
    return path;
  };
  const expected = `${String(index + 1).padStart(4, '0')}-${a.stackId}-pair-${a.pair}-${a.mode}.json`;
  requireEvidence(typeof a.result.workerResultAvailable === 'boolean', 'worker output availability is missing');
  requireEvidence(a.resultFile === expected && a.logFile === `${expected}.log` && a.inputFile === `${expected}.input.json`
    && a.workerResultFile === (a.result.workerResultAvailable ? `${expected}.worker.json` : null), 'artifact names differ from plan');
  if (a.result.status === 'completed' || a.result.status === 'failed') requireEvidence(a.result.workerResultAvailable, 'native outcome requires retained worker output');
  requireEvidence(hash(JSON.parse(await readFile(await artifact(a.resultFile), 'utf8'))) === hash(a.result), 'raw result differs from manifest');
  requireEvidence(sha256(await readFile(await artifact(a.logFile))) === a.result.logSha256, 'trial log changed');
  const inputBytes = await readFile(await artifact(a.inputFile)), input = JSON.parse(inputBytes.toString());
  requireEvidence(sha256(inputBytes) === a.result.inputSha256 && input.runId === m.id && hash(input.entry) === hash(entryOnly(a))
    && hash(input.runtime) === hash(m.config.runtime) && hash(input.browser) === hash(m.browser)
    && typeof input.bundlePath === 'string' && isAbsolute(input.bundlePath) && basename(input.bundlePath) === basename(m.browser.bundlePath), 'trial input differs from declaration');
  if (a.workerResultFile) {
    const bytes = await readFile(await artifact(a.workerResultFile));
    requireEvidence(sha256(bytes) === a.result.workerResultSha256, 'raw worker output changed');
    if (a.result.status === 'completed' || a.result.status === 'failed') {
      const worker = JSON.parse(bytes.toString());
      const start = Date.parse(worker.startedAt), finish = Date.parse(worker.finishedAt);
      requireEvidence(worker.version === 1 && worker.runId === m.id && worker.resultId === a.result.resultId && worker.inputSha256 === a.result.inputSha256
        && worker.status === a.result.status && hash(worker.entry) === hash(entryOnly(a)) && hash(worker.evidence) === hash(a.result.evidence)
        && (worker.error ?? null) === (a.result.error ?? null) && worker.durationMs === a.result.workerDurationMs
        && Number.isFinite(worker.durationMs) && worker.durationMs >= 0 && worker.durationMs <= a.result.durationMs
        && Number.isFinite(start) && Number.isFinite(finish) && start >= Date.parse(a.result.startedAt)
        && finish >= start && finish <= Date.parse(a.result.finishedAt), 'worker result differs from parent outcome');
    }
  } else requireEvidence(a.result.workerResultSha256 === null, 'missing worker output has a digest');
}

export async function verifyAndAnalyzeLoadedCampaign(manifestPath: string) {
  const dir = dirname(manifestPath), m = JSON.parse(await readFile(manifestPath, 'utf8'));
  const declarationBytes = await readFile(join(dir, 'DECLARATION.json'));
  requireEvidence(sha256(declarationBytes) === m.declarationSha256, 'declaration bytes changed');
  const d = JSON.parse(declarationBytes.toString());
  requireEvidence(d.version === 1 && d.id === m.id && d.declaredAt === m.declaredAt && d.analysisMethod === LOADED_ANALYSIS_METHOD
    && hash(d.config) === hash(m.config) && hash(d.plan) === hash(m.plan) && d.sourceHash === m.source.sourceHash
    && d.dependencies === m.dependencies.fingerprint && d.configuration === m.configuration.fingerprint
    && d.browser === m.browser.fingerprint && hash(d.machine) === hash(m.machine) && hash(d.images) === hash(m.images) && hash(d.controller) === hash(m.controller)
    && hash(d.serverStoragePolicy) === hash(serverStoragePolicy) && hash(m.serverStoragePolicy) === hash(serverStoragePolicy), 'declaration differs from campaign');
  await readCampaignSource(dir, m.source);
  const dependencies = await readCampaignDependencies(dir, m.dependencies, m.source);
  const configuration = JSON.parse((await readCampaignConfiguration(dir, m.configuration, m.source, m.config.stacks)).toString());
  await readCampaignBrowser(dir, m.browser, m.config.runtime, m.source, m.dependencies, JSON.parse(dependencies.toString()));
  requireEvidence(sourceIdentity().sourceHash === m.source.sourceHash
    && m.source.files['src/browser/loaded-analysis.ts']?.sha256 === sha256(await readFile(new URL(import.meta.url))), 'analysis source differs from the declared campaign');
  for (const [index, a] of m.attempts.entries()) {
    await verifyLoadedAttemptArtifacts(dir, m, a, index);
    requireEvidence(hash(a.result.serverStorage?.window) === hash({ startedAt: a.result.startedAt, finishedAt: a.result.finishedAt }), 'storage window differs from its actual trial');
    validateServerStoragePair(a.result.serverStorage, a.stackId, 'trial', configuration.services[a.stackId].containers);
  }
  const analysis = analyzeLoadedManifest(m);
  await writeFile(join(dir, 'ANALYSIS.json'), JSON.stringify(analysis, null, 2) + '\n');
  await writeFile(join(dir, 'VERIFICATION.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), method: LOADED_ANALYSIS_METHOD,
    manifestSha256: sha256(await readFile(manifestPath)), declarationSha256: m.declarationSha256, sourceHash: m.source.sourceHash,
    attempts: m.attempts.length, rawResultsLogsInputsAndWorkerOutputsVerified: true, sourceDependenciesConfigurationBrowserVerified: true,
    scope: 'Complete declared diagnostic and its archived evidence. This does not qualify canonical browser performance publication.' }, null, 2) + '\n');
  return analysis;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('Use loaded-analysis.ts path/to/EXPERIMENT.json');
  const analysis = await verifyAndAnalyzeLoadedCampaign(resolve(path));
  console.log(JSON.stringify({ campaignId: analysis.campaignId, summaries: analysis.summaries.map((s: any) => ({ stackId: s.stackId, completePairs: s.completePairs, plannedPairs: s.plannedPairs })) }));
}
