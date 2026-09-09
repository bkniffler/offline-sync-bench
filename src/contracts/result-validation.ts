import { percentile } from '../metrics.ts';
import { COLLABORATION_CONTRACT, collaborationIterations, collaborationSeed, collaborationWarmup } from './collaboration.ts';
import { arrayScreenQuery, assertRows, canonicalData, ContractError, fixtureTasks, hash, queryNames, SCREEN_CONTRACT, screenIterations, screenSeed, screenWarmup, validateScreenData, type ScreenCase } from './screens.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';
import { validateElectricCollaboration } from './electric-collaboration.ts';

type Result = Pick<BenchmarkResult, 'scenarioId' | 'metadata' | 'metrics'>;
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function checkSummary(metrics: Result['metrics'], prefix: string, samples: number[] | null): void {
  for (const p of [50, 95]) {
    const expected = samples === null ? null : percentile(samples, p);
    if (metrics[`${prefix}_p${p}_ms`] !== expected) throw new ContractError(`${prefix} p${p} does not match recorded samples`);
  }
  if (Object.hasOwn(metrics, `${prefix}_p99_ms`)) throw new ContractError('These operation counts do not support a reported p99');
}
function checkResources(metadata: JsonObject): void {
  const resources = metadata.resources;
  if (!object(resources) || resources.method !== 'external-ps-process-tree-v1' || !Array.isArray(resources.samples) || resources.samples.length < 2) throw new ContractError('External resource samples missing');
}

// Cache only small digests/output counts, never the 100k-row reference corpus.
const screenEvidence = new Map<ScreenCase, { validation: JsonObject; digests: Record<string, string>; counts: Record<string, number> }>();
function expectedScreenEvidence(scenario: ScreenCase) {
  let evidence = screenEvidence.get(scenario);
  if (!evidence) {
    const data = canonicalData(scenario);
    evidence = { validation: validateScreenData(scenario, data), digests: {}, counts: {} };
    for (const name of queryNames(scenario)) {
      const rows = arrayScreenQuery(name, data);
      evidence.digests[name] = assertRows(name, rows, rows); evidence.counts[name] = rows.length;
    }
    screenEvidence.set(scenario, evidence);
  }
  return evidence;
}
export function validateScreenResult(result: Result & { scenarioId: ScreenCase }): void {
  const { metadata, metrics, scenarioId } = result;
  if (metadata.workloadContract !== SCREEN_CONTRACT || hash(metadata.fixture) !== hash(screenSeed(scenarioId)) || metrics.row_count !== 100_000 || metrics.iterations !== screenIterations || metrics.warmup_iterations !== screenWarmup) throw new ContractError('screen result does not match the shared fixture and sampling contract');
  const expected = expectedScreenEvidence(scenarioId);
  const validation = metadata.validation;
  if (!object(validation) || Object.entries(expected.validation).some(([key, value]) => validation[key] !== value)) throw new ContractError('screen materialization evidence differs from the full fixture');
  if (!object(metadata.samples) || !object(metadata.outputDigests)) throw new ContractError('screen samples or output digests missing');
  for (const name of queryNames(scenarioId)) {
    const samples = metadata.samples[name];
    if (!Array.isArray(samples) || samples.length !== screenIterations || !samples.every(duration)) throw new ContractError(`${name} samples missing or invalid`);
    if (metadata.outputDigests[name] !== expected.digests[name] || metrics[`${name}_result_count`] !== expected.counts[name]) throw new ContractError(`${name} output differs from the expected screen`);
    checkSummary(metrics, `${name}_query`, samples);
  }
  if (scenarioId === 'deep-relationship-query' && (metrics.project_count !== 4 || metrics.org_count !== 1)) throw new ContractError('relationship scope mismatch');
  if (!['native-sql', 'native-reactive-query', 'application-processing', 'mixed-native-and-application'].includes(String(metadata.queryExecution))) throw new ContractError('Screen execution model missing');
  checkResources(metadata);
}
export function validateCollaborationResult(result: Result & Partial<Pick<BenchmarkResult, 'stackId'>>): void {
  if (result.stackId === 'electric') validateElectricCollaboration(result.metadata);
  validateCollaborationMeasurement(result);
}

/** Shared fixture, sampling and resource rules. Implementation-specific native
 * or browser receipt validation is a separate required step for admission. */
export function validateCollaborationMeasurement(result: Result): void {
  const { metadata, metrics } = result, samples = metadata.samples;
  const rows = fixtureTasks(collaborationSeed), digest = assertRows('expected collaboration', rows, rows);
  if (result.scenarioId !== 'online-propagation' || metadata.workloadContract !== COLLABORATION_CONTRACT || hash(metadata.fixture) !== hash(collaborationSeed) || metrics.iterations !== collaborationIterations || metrics.warmup_iterations !== collaborationWarmup || !object(metadata.validation) || metadata.validation.taskCount !== 200 || metadata.validation.tasksDigest !== digest) throw new ContractError('Collaboration contract or full-fixture evidence missing');
  if (typeof metadata.localCommitAvailable !== 'boolean' || !Array.isArray(samples) || samples.length !== collaborationIterations) throw new ContractError('Collaboration samples or local receipt availability missing');
  const local: number[] = [], accepted: number[] = [], visible: number[] = [];
  for (const [i, sample] of samples.entries()) {
    if (!object(sample) || sample.iteration !== i || !duration(sample.serverAcceptedMs) || !duration(sample.mirrorVisibleMs)) throw new ContractError('Invalid or duplicated collaboration sample');
    if (metadata.localCommitAvailable) {
      if (!duration(sample.localCommitMs) || sample.localCommitMs > sample.serverAcceptedMs) throw new ContractError('Local commit receipt is missing or follows server acceptance');
      local.push(sample.localCommitMs);
    } else if (sample.localCommitMs !== null) throw new ContractError('Unavailable local commit must remain null');
    // A mirror can observe the write before the writer receives server acceptance.
    accepted.push(sample.serverAcceptedMs); visible.push(sample.mirrorVisibleMs);
  }
  checkSummary(metrics, 'local_commit', metadata.localCommitAvailable ? local : null);
  checkSummary(metrics, 'server_accepted', accepted); checkSummary(metrics, 'mirror_visible', visible);
  checkResources(metadata);
}
