import type { Annotation } from './campaign-report.ts';
import type { CampaignAttempt, CampaignManifest } from './campaign.ts';
import type { JsonObject } from './types.ts';
import { suites } from './suites.ts';
import { stacks } from './stacks.ts';

export function reportDetailsPath(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error('Unsafe campaign report directory');
  return `results/reports/${id}/DETAILS.md`;
}

export function metricUnit(key: string): string {
  if (key.endsWith('_ms')) return 'ms';
  if (key.endsWith('_bytes')) return 'bytes';
  if (/memory(_delta)?_mb$/.test(key)) return 'MiB';
  if (key.endsWith('_cpu_pct')) return '%';
  if (key.endsWith('_count')) return 'count';
  throw new Error(`Finding metric has no declared unit: ${key}`);
}

export function validateFindingSelection(manifest: CampaignManifest, annotations: Annotation[], publication = false): Annotation[] {
  const ids = manifest.report?.findingIds ?? [];
  if (!Array.isArray(ids) || ids.length > 5 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new Error('Select at most five distinct finding IDs');
  if (publication && ids.length < 3) throw new Error('Publication requires three to five reviewed findings');
  const selected = ids.map(id => {
    const item = annotations.find(a => a.id === id);
    if (!item) throw new Error(`Unknown selected finding: ${id}`);
    if (typeof item.question !== 'string' || !item.question.trim()) throw new Error(`Finding ${id} needs an application question`);
    const table = item.table;
    if (!table || !manifest.config.scenarios.some(s => s === table.scenarioId) || !Array.isArray(table.metrics) || table.metrics.length > 3) throw new Error(`Finding ${id} needs a measured case and at most three table metrics`);
    const keys = new Set<string>();
    for (const metric of table.metrics) {
      if (typeof metric?.key !== 'string' || typeof metric.label !== 'string' || !metric.label.trim() || keys.has(metric.key)) throw new Error(`Invalid or duplicate metric in finding ${id}`);
      metricUnit(metric.key);
      keys.add(metric.key);
      if (!manifest.attempts.some(a => a.scenarioId === table.scenarioId && Object.hasOwn(a.result.metrics, metric.key))) throw new Error(`Finding ${id} references an unmeasured metric: ${metric.key}`);
    }
    // A table always includes all trials and all configured stacks for its case.
    // Bind the annotation to those results so a later failure expires its review.
    const plotted = manifest.attempts.filter(a => a.scenarioId === table.scenarioId);
    if (!plotted.length || plotted.some(a => !item.resultIds.includes(a.result.resultId))) throw new Error(`Finding ${id} must bind every table attempt, including failures`);
    return item;
  });
  reportDetailsPath(manifest.id);
  return selected;
}

export function findingGroups(manifest: CampaignManifest, annotation: Annotation) {
  const groups = new Map<string, { profile: JsonObject; attempts: CampaignAttempt[][] }>();
  for (const stack of manifest.config.stacks) {
    const attempts = manifest.attempts.filter(a => a.stackId === stack && a.scenarioId === annotation.table!.scenarioId).sort((a, b) => a.trial - b.trial);
    if (!attempts.length) continue;
    const profile = attempts.at(-1)!.result.metadata.profile as JsonObject;
    const key = JSON.stringify([profile.lane, profile.comparisonKey]);
    const group = groups.get(key) ?? { profile, attempts: [] };
    group.attempts.push(attempts);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function profileLabel(profile: JsonObject): string {
  const contract = profile.contract;
  const guarantee = profile.guarantee as JsonObject | undefined;
  const behavior = contract === 'access-revocation-v1' ? 'native purge'
    : contract === 'access-refresh-v1' ? `application refresh, ${guarantee?.cacheKind} cache`
    : contract === 'initial-startup-v1' ? guarantee?.client === 'fresh-process-and-new-memory-cache' ? 'fresh memory cache; no persistence' : 'fresh product file'
    : contract === 'screens-v2' ? 'equivalent local screen output'
    : contract === 'offline-recovery-v2' ? recoveryProfileLabel(guarantee)
    : contract === 'client-fanout-recovery-v1' ? `${guarantee?.clientCache === 'memory' ? 'memory cache' : guarantee?.clientCache === 'benchmark-owned-persistent-file' ? 'benchmark-owned persisted cache' : guarantee?.clientCache === 'product-persistent-file' ? 'product persisted cache' : 'unspecified cache'}; live delivery, no process-restart guarantee`
    : contract === 'persisted-replica-reopen-v1' ? 'existing product store, offline reopen'
    : typeof contract === 'string' ? contract : 'unverified workload';
  const duration = (profile.outagePolicy as JsonObject | undefined)?.durationMs;
  const restoration = contract === 'offline-recovery-v2'
    ? typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? `; network restored after ${duration / 1000}s outage` : '; outage duration unavailable'
    : '';
  return `${String(profile.lane).replaceAll('-', ' ')}; ${behavior}${restoration}`;
}

function recoveryProfileLabel(guarantee: JsonObject | undefined): string {
  const owner = guarantee?.offlineQueue === 'benchmark-managed' ? 'benchmark-owned queue'
    : guarantee?.offlineQueue === 'product-managed' ? 'product queue' : 'unspecified queue ownership';
  const storage = (value: unknown) => value === 'memory' ? 'memory' : value === 'persistent-file' ? 'persisted' : 'unspecified';
  const cache = storage(guarantee?.localStore), queue = storage(guarantee?.queueStore);
  const persistence = cache === queue && cache !== 'unspecified' ? `${cache} cache and queue` : `${cache} cache, ${queue} queue storage`;
  const lifecycle = guarantee?.restart === 'SIGKILL-and-reopen-offline' ? 'SIGKILL recovery'
    : guarantee?.restart === 'live-process-replay' ? 'live replay' : 'unspecified lifecycle';
  return `${owner}; ${persistence}; ${lifecycle}`;
}

const failures = new Set(['failed', 'invalid', 'timed-out']);

export function compactCoverage(manifest: CampaignManifest): string[] {
  const lines = ['## Coverage and outcomes', '',
    '| Suite | ' + manifest.config.stacks.join(' | ') + ' |',
    '| --- | ' + manifest.config.stacks.map(() => '---').join(' | ') + ' |'];
  for (const suite of suites) {
    const cells = manifest.config.stacks.map(stack => {
      const counts = new Map<string, number>();
      let failedTrials = 0;
      for (const scenario of suite.cases) {
        const attempts = manifest.attempts.filter(a => a.stackId === stack && a.scenarioId === scenario).sort((a, b) => a.trial - b.trial);
        const last = attempts.at(-1)?.result;
        const coverage = last?.metadata.coverage as JsonObject | undefined;
        const label = !last ? 'not run'
          : last.status === 'completed' ? (last.metadata.profile as JsonObject).eligible ? 'passed' : 'unverified'
          : last.status === 'unsupported' ? coverage?.status === 'unsupported-tested-configuration' ? 'unsupported' : 'not implemented'
          : last.status === 'timed-out' ? 'timed out' : last.status;
        counts.set(label, (counts.get(label) ?? 0) + 1);
        failedTrials += attempts.filter(a => failures.has(a.result.status)).length;
      }
      return [...counts].map(([label, count]) => `${count} ${label}`).join('; ') + (failedTrials ? `; ${failedTrials} failed trials` : '');
    });
    lines.push(`| ${suite.title} | ${cells.join(' | ')} |`);
  }
  lines.push('', 'Counts describe the latest outcome per case. Failed-trial counts include every failed, invalid or timed-out attempt, even when a later trial passed. “Unsupported” applies only to the tested configuration; “not implemented” and “not run” make no product-capability claim.');
  const omitted = stacks.filter(s => !manifest.config.stacks.includes(s.id));
  if (omitted.length) lines.push('', `Stacks outside this campaign: ${omitted.map(s => s.title).join(', ')}.`);
  return lines;
}

export function workloadLabel(scenario: string, startupCounts = [1_000, 10_000, 100_000]): string {
  switch (scenario) {
    case 'local-query': return '100,000 local tasks; five warmups and 25 measured operations per trial.';
    case 'deep-relationship-query': return '100,000 local tasks and their related tables; five warmups and 25 measured operations per trial.';
    case 'online-propagation': return '200 local tasks; five warmups and 50 measured writes per trial.';
    case 'bootstrap': return `Fresh clients at ${startupCounts.map(count => count.toLocaleString('en-US')).join(', ')} tasks, against restarted and warm sync services.`;
    case 'replica-reopen': return 'A fresh process reopens 2,000 persisted tasks while offline.';
    case 'permission-change': return 'Revoke one of two 500-task projects, with online and offline checks.';
    case 'blob-flow': return 'Two 2 MiB objects linked to 50-task fixtures; native upload and independent fresh/retry clients.';
    case 'connected-fanout': return '2,000 tasks per connected reader; deliver one update.';
    case 'reconnect-storm': return '2,000 tasks per reader; restore connectivity after 100 updates.';
    default: return '2,000 tasks per client; the selected metric identifies the queue size or convergence milestone.';
  }
}
