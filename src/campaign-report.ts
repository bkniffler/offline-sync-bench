import { readCampaignRustBuild, type RustBuildIdentity } from './rust-build.ts';
import { validateBrowserIdentity, validateTrialBrowser, readCampaignBrowser } from './browser/provenance.ts';
import { serverStoragePolicy, validateServerStoragePair } from './server-storage.ts';
import { startupSizes } from './contracts/startup.ts';
import { validateConfigurationIdentity, readCampaignConfiguration } from './configuration.ts';
import { validateDependencyIdentity, readCampaignDependencies } from './dependencies.ts';
import { validateExecutableProvenance, validateTrialExecutable } from './executables.ts';
import { validateSourceProvenance, readCampaignSource } from './source-snapshot.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { hash } from './contracts/screens.ts';
import { validateResult } from './execution.ts';
import { resultProfile } from './profiles.ts';
import { validateConfiguredParameters, planCampaign, type CampaignManifest, type CampaignAttempt } from './campaign.ts';
import { trialSummary } from './statistics.ts';
import { suites } from './suites.ts';
import { compactCoverage, findingGroups, metricUnit, profileLabel, reportDetailsPath, validateFindingSelection, workloadLabel } from './report-editorial.ts';
import type { JsonObject } from './types.ts';
import { describeNetworkProfile, validateTrialNetwork } from './network/campaign.ts';

export interface Annotation {
  id: string;
  resultIds: string[];
  sourceHash: string;
  resultDigests: Record<string, string>;
  status: 'confirmed' | 'supported-hypothesis' | 'unexplained';
  observation: string;
  explanation: string;
  implication: string;
  nextExperiment?: string;
  question?: string;
  chart?: { path: string; alt: string; caption: string };
  table?: { scenarioId: string; metrics: { key: string; label: string }[] };
  evidence: { path: string; description: string; kind: 'trace' | 'controlled-experiment' | 'direct-accounting' }[];
}
export function validateManifest(manifest: CampaignManifest): void {
  if (manifest.version !== 1 || manifest.status !== 'complete') throw new Error('Publication requires a completed valid campaign');
  if (manifest.config.purpose !== 'publication') throw new Error('Smoke and diagnostic campaigns cannot be published as comparisons');
  validateSourceProvenance(manifest.source);
  validateDependencyIdentity(manifest.dependencies, manifest.source);
  validateConfigurationIdentity(manifest.configuration, manifest.source, manifest.config.stacks);
  validateExecutableProvenance(manifest.executables, manifest.config.runtime?.kind === 'chromium' ? [] : manifest.config.stacks, true, manifest.source);
  validateBrowserIdentity(manifest.browser, manifest.config.runtime, manifest.source, manifest.dependencies);
  if (typeof manifest.machine?.cpuModel !== 'string' || typeof manifest.machine.memoryBytes !== 'number' || typeof manifest.machine.nodeVersion !== 'string' || typeof manifest.machine.bunVersion !== 'string') throw new Error('Machine/runtime provenance is incomplete');
  for (const stack of manifest.config.stacks) {
    const images = manifest.images?.[stack];
    if (!Array.isArray(images) || !images.length || images.some(image => !image || typeof image !== 'object' || Array.isArray(image) || typeof image.imageId !== 'string' || !image.imageId.startsWith('sha256:'))) throw new Error(`Image provenance missing for ${stack}`);
  }
  const expected = planCampaign(manifest.config);
  if (hash(expected) !== hash(manifest.plan) || expected.length !== manifest.attempts.length) throw new Error('Campaign has missing or mismatched planned attempts');
  const ids = new Set<string>();
  for (const [index, attempt] of manifest.attempts.entries()) {
    const planned = expected[index];
    if (planned.stackId !== attempt.stackId || planned.scenarioId !== attempt.scenarioId || planned.trial !== attempt.trial || attempt.result.runId !== manifest.id || attempt.result.stackId !== attempt.stackId || attempt.result.scenarioId !== attempt.scenarioId || ids.has(attempt.result.resultId)) throw new Error('Attempt identity does not match the campaign plan');
    ids.add(attempt.result.resultId);
    if (!manifest.serverStoragePolicy || hash(manifest.serverStoragePolicy) !== hash(serverStoragePolicy)) throw new Error('Publication requires a declared server-storage preparation policy');
    const storage = attempt.result.metadata.serverStorage as JsonObject;
    validateServerStoragePair(storage, attempt.stackId, 'trial');
    if (hash(storage.window) !== hash({ startedAt: attempt.result.startedAt, finishedAt: attempt.result.finishedAt })) throw new Error('Server-storage trial window differs from the measured result');
    if (attempt.result.status === 'completed' && attempt.scenarioId === 'bootstrap') for (const c of attempt.result.metadata.cases as JsonObject[]) validateServerStoragePair(c.serverStorage as JsonObject, attempt.stackId, 'startup-client');
    validateTrialExecutable(attempt.result, manifest.executables);
    validateTrialBrowser(attempt.result, manifest.config.runtime, manifest.browser);
    validateResult(attempt.result);
    validateConfiguredParameters(attempt.result, manifest.config.parameters);
    validateTrialNetwork(attempt.result, manifest.config.network);
    const profile = resultProfile(attempt.result, { ...manifest, network: manifest.config.network });
    if (hash(profile) !== hash(attempt.result.metadata.profile)) throw new Error('Attempt profile differs from campaign provenance');
  }
}
export function validateAnnotations(manifest: CampaignManifest): Annotation[] {
  const annotations = manifest.annotations as Annotation[];
  if (!Array.isArray(annotations)) throw new Error('Invalid annotations');
  const ids = new Set<string>();
  for (const annotation of annotations) {
    if (!annotation.id || ids.has(annotation.id) || !['confirmed', 'supported-hypothesis', 'unexplained'].includes(annotation.status)) throw new Error('Invalid or duplicate annotation');
    ids.add(annotation.id);
    if (annotation.sourceHash !== manifest.source.sourceHash) throw new Error(`Annotation ${annotation.id} needs review for changed source`);
    if (!annotation.resultIds?.length || annotation.resultIds.some(id => !manifest.attempts.some(a => a.result.resultId === id))) throw new Error(`Annotation ${annotation.id} references unknown results`);
    for (const id of annotation.resultIds) if (annotation.resultDigests?.[id] !== hash(manifest.attempts.find(a => a.result.resultId === id)!.result)) throw new Error(`Annotation ${annotation.id} needs review for changed results or configuration`);
    if (![annotation.observation, annotation.explanation, annotation.implication].every(text => typeof text === 'string' && text.trim())) throw new Error(`Annotation ${annotation.id} is incomplete`);
    if (!Array.isArray(annotation.evidence) || !annotation.evidence.length) throw new Error(`Annotation ${annotation.id} needs evidence`);
    for (const evidence of annotation.evidence) if (!evidence.path || !evidence.description || !['trace', 'controlled-experiment', 'direct-accounting'].includes(evidence.kind)) throw new Error(`Invalid evidence for ${annotation.id}`);
    if (annotation.status === 'confirmed' && !annotation.evidence.some(e => ['controlled-experiment', 'direct-accounting'].includes(e.kind))) throw new Error(`Confirmed annotation ${annotation.id} needs causal evidence`);
    if (annotation.status !== 'confirmed' && !annotation.nextExperiment?.trim()) throw new Error(`Annotation ${annotation.id} needs a next experiment`);
    if (annotation.chart) {
      const { path, alt, caption } = annotation.chart;
      if (typeof path !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*\.(svg|png|webp)$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')
        || typeof alt !== 'string' || !alt.trim() || typeof caption !== 'string' || !caption.trim()
        || !annotation.evidence.some(e => e.path === path)) throw new Error(`Annotation ${annotation.id} chart needs a local evidence artifact, alt text and caption`);
    }
  }
  return annotations;
}

export function groupAttempts(attempts: CampaignAttempt[]): Map<string, CampaignAttempt[]> {
  const groups = new Map<string, CampaignAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.stackId}/${attempt.scenarioId}`;
    groups.set(key, [...(groups.get(key) ?? []), attempt]);
  }
  for (const group of groups.values()) {
    const passed = group.filter(a => a.result.status === 'completed');
    const keys = new Set(passed.map(a => (a.result.metadata.profile as JsonObject)?.comparisonKey));
    if (keys.size > 1) throw new Error('Cannot aggregate incompatible profiles');
    group.sort((a, b) => a.trial - b.trial);
  }
  return groups;
}
export function summarizeCase(attempts: CampaignAttempt[], metric: string) {
  const latest = attempts.at(-1)!;
  const failures = attempts.filter(a => ['failed', 'timed-out', 'invalid'].includes(a.result.status)).length;
  const profile = latest.result.metadata.profile as JsonObject;
  if (latest.result.status !== 'completed' || profile?.eligible !== true) return { status: latest.result.status === 'completed' ? 'not-comparable' : latest.result.status, failures, summary: null };
  const values = attempts.filter(a => a.result.status === 'completed').map(a => a.result.metrics[metric]);
  if (values.some(v => typeof v !== 'number' || !Number.isFinite(v)) || !values.length) return { status: 'not-measured', failures, summary: null };
  return { status: failures ? 'passed-with-failures' : 'passed', failures, summary: trialSummary(values as number[]) };
}
const escape = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const number = (value: number) => value >= 100 ? value.toFixed(0) : value.toFixed(2);
const metricNames: Record<string, string[]> = {
  'blob-flow': ['initial_upload_ms', 'initial_server_accepted_ms', 'initial_metadata_visible_ms', 'fresh_download_ms', 'download_interruption_recovery_ms'],
  'permission-change': ['online_convergence_ms', 'offline_reconnect_convergence_ms'],
  'connected-fanout': ['clients_5_all_converged_ms', 'clients_25_all_converged_ms'],
  'reconnect-storm': ['clients_5_all_converged_ms', 'clients_25_all_converged_ms'],
  bootstrap: ['startup_process_cold_100000_first_screen_ms', 'startup_process_cold_100000_full_data_ms', 'startup_warm_100000_first_screen_ms', 'startup_warm_100000_full_data_ms'],
  'replica-reopen': ['reopen_process_ms', 'reopen_first_screen_ms', 'reopen_all_rows_ms'],
  'online-propagation': ['local_commit_p50_ms', 'server_accepted_p50_ms', 'mirror_visible_p50_ms'],
  'offline-replay': ['queue_10_drain_ms', 'queue_10_mirror_visible_ms'],
  'large-offline-queue': ['queue_100_mirror_visible_ms', 'queue_500_mirror_visible_ms', 'queue_1000_mirror_visible_ms'],
  'offline-restart': ['queue_1000_reopen_local_ms', 'queue_1000_drain_ms', 'queue_1000_mirror_visible_ms'],
  'local-query': ['list_query_p50_ms', 'search_query_p50_ms', 'aggregate_query_p50_ms'],
  'deep-relationship-query': ['dashboard_query_p50_ms', 'detail_join_query_p50_ms'],
};
export function renderCampaignDetails(manifest: CampaignManifest): string {
  validateManifest(manifest);
  const annotations = validateAnnotations(manifest);
  const groups = groupAttempts(manifest.attempts);
  const lines = ['# Benchmark results', '', `Campaign \`${manifest.id}\`. ${manifest.config.trials} independent trials per case, with seeded randomized order. Network: ${describeNetworkProfile(manifest.config.network)}. [Measurements and manifest](./RESULTS.json). [Methodology](./docs/methodology.md).`, '',
    'These measurements describe the listed runtime and workload profiles. A failed latest attempt remains failed; older successful attempts do not replace it. Confidence intervals resample independent trial medians. Results with fewer than five successful trials show the observed min–max range, not a confidence interval.', '',
    '## Coverage and outcomes', '', '| Stack | Case | Latest outcome | Passed / attempted | Comparison |', '| --- | --- | --- | --- | --- |'];
  for (const [key, group] of groups) {
    const latest = group.at(-1)!;
    const profile = latest.result.metadata.profile as JsonObject;
    const coverage = latest.result.metadata.coverage as JsonObject | undefined;
    lines.push(`| ${key.split('/').join(' | ')} | ${coverage?.status === 'unsupported-tested-configuration' ? 'unsupported in tested configuration' : latest.result.status} | ${group.filter(a => a.result.status === 'completed').length} / ${group.length} | ${profile.eligible ? escape(String(profile.execution === 'unspecified' ? profile.storage : profile.execution)) : escape(String(coverage?.reason ?? profile.ineligibleReason ?? 'Unavailable'))} |`);
  }
  lines.push('', `[Individual trial files and logs](./results/reports/${manifest.id}/TRIALS.json). The index includes every attempt and its outcome.`, '', '## Server storage preparation', '', serverStoragePolicy.preparation + '.', '', 'Each attempt retains before/after Docker writable-layer bytes and mounted-path allocated KiB in its raw metadata. Startup additionally records each client boundary after fixture preparation. These are live observations, not logical payload sizes or evidence of normalized server state. Missing counters remain unavailable. Read-only configuration mounts are covered by the configuration artifact. In-memory caches, deleted-file storage and OS caches are outside these disk observations.', '');
  const measured = new Set(manifest.config.scenarios as string[]);
  lines.push('', `Outside this campaign: ${suites.flatMap(suite => suite.cases.filter(id => !measured.has(id))).join(', ')}. These cases remain visible as coverage work; omission does not establish a missing product capability.`, '', '## Findings', '');
  if (!annotations.length) lines.push('No reviewed explanatory annotations are attached to this campaign. The tables below show observations; they do not establish why a product is faster or slower.', '');
  for (const annotation of annotations) {
    lines.push(`### ${annotation.observation}`, '', `Evidence: **${annotation.status.replaceAll('-', ' ')}**. ${annotation.explanation}`, '', annotation.implication, '',
      ...annotation.evidence.map(e => `- [${e.description}](${e.path})`), '',
      ...(annotation.nextExperiment ? [`Next experiment: ${annotation.nextExperiment}`, ''] : []));
  }
  const conflictGroups = [...groups.values()].filter(group => group[0].scenarioId.startsWith('conflict-'));
  if (conflictGroups.length) {
    lines.push('## Conflicting edits', '', 'A stale writer reconnects only after a third client confirms the competing operation. These are policy checks, not a shared speed ranking. Every task is validated on all three clients; native rejection is an expected outcome when the declared policy requires it.', '',
      '| Stack | Case | Declared write policy | Expected outcome | Latest check |', '| --- | --- | --- | --- | --- |');
    for (const group of conflictGroups) {
      const latest = group.at(-1)!.result;
      const policy = (latest.metadata.policy ?? (latest.metadata.evidence as JsonObject | undefined)?.policy) as JsonObject | undefined;
      lines.push(`| ${latest.stackId} | ${latest.scenarioId.replace('conflict-', '')} | ${escape(String(policy?.enforcement ?? 'Unavailable'))} | ${escape(String(policy?.outcome ?? 'Unavailable'))} | ${latest.status} |`);
    }
    lines.push('', 'PowerSync’s result describes this repository’s SQL mutation backend. Syncular uses an explicit version precondition in these cases. A different application policy requires a new profile; successful queue drain cannot substitute for the declared user-visible outcome.', '');
  }
  const tables = Object.entries(metricNames).flatMap<{ scenario: string; startupCount: number | undefined; defaultMetrics: string[] }>(([scenario, defaults]) => scenario === 'bootstrap'
    ? (manifest.config.parameters?.startupSizes ?? startupSizes).map(startupCount => ({ scenario, startupCount, defaultMetrics: defaults.map(metric => metric.replace('_100000_', `_${startupCount}_`)) }))
    : [{ scenario, startupCount: undefined, defaultMetrics: defaults }]);
  for (const { scenario, defaultMetrics, startupCount } of tables) {
    const fanout = ['connected-fanout', 'reconnect-storm'].includes(scenario);
    const metrics = fanout ? (manifest.config.parameters?.clientCounts ?? [5, 25]).map(n => `clients_${n}_all_converged_ms`) : defaultMetrics;
    const allRelevant = [...groups].filter(([, group]) => group[0].scenarioId === scenario);
    // Keep different guarantees and experimental lanes in separate tables in
    // the companion too, even when the scenario and metric names match.
    const comparisonGroups = new Map<string, typeof allRelevant>();
    for (const entry of allRelevant) {
      const profile = entry[1].at(-1)!.result.metadata.profile as JsonObject;
      const key = JSON.stringify([profile.lane, profile.comparisonKey]);
      comparisonGroups.set(key, [...(comparisonGroups.get(key) ?? []), entry]);
    }
    for (const relevant of comparisonGroups.values()) {
    if (!relevant.length) continue;
    const recovery = ['offline-replay', 'large-offline-queue', 'offline-restart'].includes(scenario);
    const reopen = scenario === 'replica-reopen';
    const access = relevant[0]?.[1].at(-1)?.result.metadata;
    const accessLabel = access?.workloadContract === 'access-revocation-v1' ? 'native purge' : access?.workloadContract === 'access-refresh-v1' ? `application refresh (${(access.accessProfile as JsonObject).cacheKind})` : 'unverified profile';
    const title = { 'blob-flow': 'Attachments', 'permission-change': 'Access revocation', bootstrap: 'Initial startup', 'connected-fanout': 'Connected client fanout', 'reconnect-storm': 'Reconnect with backlog', 'replica-reopen': 'Persisted replica startup', 'local-query': 'Task screens', 'deep-relationship-query': 'Relationship screens', 'online-propagation': 'Collaboration', 'offline-replay': 'Offline replay', 'large-offline-queue': 'Replay scaling', 'offline-restart': 'Offline process recovery' }[scenario];
    const description = scenario === 'blob-flow' ? 'Two deterministic 2 MiB objects, 50 validated tasks and four distinct client stores. Upload receipt, native metadata acceptance and independent reader visibility begin at sync invocation; fresh-download and interrupted-download recovery use their own clocks. Staging and queue-failure details remain in the artifact. Resource windows are declared separately.' : scenario === 'permission-change' ? 'Two 500-task projects. The declared native-purge or application-refresh strategy removes exactly one project from the active client cache; different strategies and persistence guarantees appear in separate tables. Online timing includes the revoke request; offline recovery timing begins at route restoration. Fresh-client checks verify narrowed access and preservation for an unaffected actor.' : scenario === 'bootstrap' ? `${startupCount!.toLocaleString('en-US')}-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained.` : fanout ? `2,000 tasks per reader. ${scenario === 'connected-fanout' ? 'One update reaches already-connected native subscriptions.' : '100 updates accumulate behind blocked reader routes before simultaneous restoration and native reconnect.'} Cells summarize the time until every reader converges; per-reader distributions and server resource windows remain in the artifact.` : reopen ? '2,000 persisted tasks, a fresh process and blocked client routes. Cumulative milestones cover initialization, a correct 50-row task screen and all local rows. The OS file cache is not cleared.' : recovery ? '2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen.' : scenario === 'online-propagation' ? '200 validated local tasks, five warmups and 50 measured writes. Local commit may be unavailable for a tested write path.' : '100,000 validated local tasks. Each trial runs five warmups and 25 measured operations.';
    const tableProfile = relevant[0][1].at(-1)!.result.metadata.profile as JsonObject;
    lines.push(`## ${title}${startupCount ? `: ${startupCount.toLocaleString('en-US')} tasks` : ''}${scenario === 'permission-change' ? `: ${accessLabel}` : ''}`, '', `Profile: \`${tableProfile.comparisonKey}\` (${tableProfile.lane}).`, '', `${description} Cells show the median of successful trial ${recovery || reopen || fanout || scenario === 'blob-flow' || scenario === 'bootstrap' || scenario === 'permission-change' ? 'durations' : 'p50 values'} in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.`, '',
      '| Stack / lane | ' + metrics.map(m => /^clients_/.test(m) ? m.replace(/^clients_(\d+)_all_converged_ms$/, '$1 readers') : m.replace(/^startup_(process_cold|warm)_\d+_(first_screen|full_data)_ms$/, '$2 ($1)').replace(/(_query)?_p50_ms$|_ms$/, '').replaceAll('_', ' ')).join(' | ') + ' |', '| --- | ' + metrics.map(() => '---').join(' | ') + ' |');
    for (const [, group] of relevant) {
      const profile = group.at(-1)!.result.metadata.profile as JsonObject;
      const cells = metrics.map(metric => {
        const summary = summarizeCase(group, metric);
        if (!summary.summary) return summary.status;
        const { median, min, max, confidence95, trials } = summary.summary;
        const wide = confidence95 && median > 0 && (confidence95[1] - confidence95[0]) / median > 0.25;
        return `${number(median)}${confidence95 ? ` [${number(confidence95[0])}, ${number(confidence95[1])}]` : ` [${number(min)}–${number(max)}] (n=${trials})`}${wide ? ' †' : ''}`;
      });
      lines.push(`| ${group[0].stackId} / ${profile.lane} | ${cells.join(' | ')} |`);
    }
    lines.push('', '† Interval width exceeds 25% of the median. Treat this estimate as imprecise.', '');
    }
  }
  lines.push('## Interpretation', '',
    'External resource samples, raw operation timings, output digests, runtime versions, source fingerprints, and image identities are included in the measurements. Sampled RSS is process-tree memory and can count shared pages more than once. Each contract records its measurement window; recovery excludes setup and queue construction.', '',
    `[Exact benchmark source snapshot](./results/sources/${manifest.source.sourceHash}/SOURCE.json) includes file bytes, modes, symlinks and deleted paths. Source revision: \`${manifest.source.revision}\`; dirty: ${manifest.source.dirty}.`, '',
    `Stopping rule: ${manifest.config.stoppingRule}`, '',
    'Historical measurements predating the shared contracts are preserved in [the archive](./results/history/2026-09-05/README.md). They are excluded from these comparisons.', '');
  return lines.join('\n');
}

/** The main report contains editorial selections. Complete tables remain in a
 * generated companion; selection never removes failures from the coverage view. */
export function renderCampaign(manifest: CampaignManifest): string {
  validateManifest(manifest);
  const annotations = validateAnnotations(manifest);
  const selected = validateFindingSelection(manifest, annotations);
  groupAttempts(manifest.attempts); // Validate all repeated cases, including unselected ones.
  const detailPath = reportDetailsPath(manifest.id);
  const lines = ['# Benchmark results', '',
    ...(selected[0] ? [`**${selected[0].observation}**`, '', selected[0].implication, ''] : []),
    `Campaign \`${manifest.id}\`: ${manifest.config.trials} independent trials per case, in seeded randomized order. Network: ${describeNetworkProfile(manifest.config.network)}. Host: ${escape(String(manifest.machine.cpuModel))}.`, '',
    `[Full tables and explanations](./${detailPath}) · [Raw measurements](./RESULTS.json) · [Methodology](./docs/methodology.md)`, '',
    ...compactCoverage(manifest), '',
    '## Findings', '',
  ];
  if (!selected.length) lines.push('No findings have been selected. This report preview is awaiting editorial review; publication requires three to five evidence-backed findings.', '');
  for (const annotation of selected) {
    lines.push(`### ${annotation.observation}`, '', annotation.question!, '');
    if (annotation.chart) lines.push(`![${annotation.chart.alt.replace(/[\[\]\\]/g, '\\$&')}](${annotation.chart.path})`, '', annotation.chart.caption, '');
    // The companion retains exact tables; do not repeat a plotted comparison.
    for (const { profile, attempts } of annotation.chart ? [] : findingGroups(manifest, annotation)) {
      lines.push(`${workloadLabel(annotation.table!.scenarioId, manifest.config.parameters?.startupSizes)} Profile: ${escape(profileLabel(profile))}. [Full configuration](./${detailPath}).`, '');
      const metrics = annotation.table!.metrics;
      const columns = ['Stack / client path', 'Passed / attempted', 'Latest outcome', ...metrics.map(m => `${escape(m.label)} (${metricUnit(m.key)})`)];
      lines.push('| ' + columns.join(' | ') + ' |', '| ' + columns.map(() => '---').join(' | ') + ' |');
      // Keep configured stack order; do not imply a ranking by sorting on speed.
      for (const group of attempts) {
        const latest = group.at(-1)!.result;
        const passed = group.filter(a => a.result.status === 'completed').length;
        const cells = metrics.map(metric => {
          const result = summarizeCase(group, metric.key);
          if (!result.summary) return result.status;
          const { median, min, max, confidence95 } = result.summary;
          const wide = confidence95 && median > 0 && (confidence95[1] - confidence95[0]) / median > 0.25;
          return `${number(median)}${confidence95 ? ` [${number(confidence95[0])}, ${number(confidence95[1])}]` : ` [${number(min)}–${number(max)}]`}${wide ? ' †' : ''}`;
        });
        const implementation = latest.metadata.profile as JsonObject;
        const path = implementation.execution !== 'unspecified' ? implementation.execution : implementation.storage;
        const label = `${latest.stackId}${typeof path === 'string' && path !== 'unspecified' ? ` / ${escape(path)}` : ''}`;
        lines.push(`| ${label} | ${passed} / ${group.length} | ${latest.status} |${cells.length ? ' ' + cells.join(' | ') + ' |' : ''}`);
      }
      lines.push('');
    }
    lines.push(`Evidence: **${annotation.status.replaceAll('-', ' ')}**. ${annotation.explanation}`, '', annotation.implication, '',
      ...annotation.evidence.map(e => `- [${e.description}](${e.path})`), '',
      ...(annotation.nextExperiment ? [`Next experiment: ${annotation.nextExperiment}`, ''] : []));
  }
  const unselected = annotations.length - selected.length;
  if (unselected) lines.push(`${unselected} additional reviewed annotation${unselected === 1 ? '' : 's'} remain in the [full report](./${detailPath}#findings).`, '');
  lines.push('## Reading these results', '',
    'Server volumes and writable layers are retained under the declared preparation policy. Physical-state observations are linked in the full report; logical fixture resets do not establish fresh storage.', '',
    'Cells summarize independent trial values: median and observed min–max range with fewer than five successes, or median and 95% bootstrap interval with at least five. † marks an interval wider than 25% of the median; treat that estimate as imprecise. Operation percentiles remain distinct from trial counts. A failed latest attempt has no speed estimate; earlier failures remain in the coverage summary and full tables. Different profiles appear in separate tables.', '',
    `Stopping rule: ${manifest.config.stoppingRule}`, '',
    `[Exact benchmark source snapshot](./results/sources/${manifest.source.sourceHash}/SOURCE.json). [Installed dependency inventory](./results/dependencies/${manifest.dependencies!.fingerprint}/DEPENDENCIES.json) records host package and native addon checksums. [Runtime and service configuration](./results/configurations/${manifest.configuration!.fingerprint}/CONFIGURATION.json) records overrides, resolved services and mounted configuration inputs. Raw operation samples, resource windows, output checks and configuration are in the measurements. Source revision: \`${manifest.source.revision}\`; dirty: ${manifest.source.dirty}.`, '',
    'Historical measurements predating the shared contracts remain in [the archive](./results/history/2026-09-05/README.md).', '');
  return lines.join('\n');
}

export async function publishCampaign(manifestPath: string, outputRoot: string): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CampaignManifest;
  validateManifest(manifest);
  const sourceBytes = await readCampaignSource(dirname(manifestPath), manifest.source);
  const dependencyBytes = await readCampaignDependencies(dirname(manifestPath), manifest.dependencies!, manifest.source);
  const rustInputs = ((manifest.executables?.rustDriver as JsonObject)?.build as JsonObject)?.inputs as unknown as RustBuildIdentity | undefined;
  const rustDriver = manifest.executables?.rustDriver as JsonObject | undefined;
  const rustArtifacts = rustInputs ? await readCampaignRustBuild(dirname(manifestPath), rustInputs, manifest.source, { build: rustDriver!.build as JsonObject, executable: rustDriver!.executable as JsonObject }) : undefined;
  const browserArtifacts = manifest.browser ? await readCampaignBrowser(dirname(manifestPath), manifest.browser, manifest.config.runtime!, manifest.source, manifest.dependencies!, JSON.parse(dependencyBytes.toString())) : undefined;
  const configurationBytes = await readCampaignConfiguration(dirname(manifestPath), manifest.configuration!, manifest.source, manifest.config.stacks);
  const serviceConfiguration = JSON.parse(configurationBytes.toString());
  const trialArtifacts: Array<{ resultPath: string; resultBytes: Buffer; logPath: string; logBytes: Buffer }> = [];
  for (const [index, attempt] of manifest.attempts.entries()) {
    const containers = serviceConfiguration.services[attempt.stackId].containers;
    validateServerStoragePair(attempt.result.metadata.serverStorage as JsonObject, attempt.stackId, 'trial', containers);
    if (attempt.result.status === 'completed' && attempt.scenarioId === 'bootstrap') for (const c of attempt.result.metadata.cases as JsonObject[]) validateServerStoragePair(c.serverStorage as JsonObject, attempt.stackId, 'startup-client', containers);
    const path = resolve(dirname(manifestPath), attempt.resultFile);
    if (relative(dirname(manifestPath), path).startsWith('..')) throw new Error('Result path must stay inside its campaign');
    const resultBytes = await readFile(path), stored = JSON.parse(resultBytes.toString());
    if (hash(stored) !== hash(attempt.result)) throw new Error(`Stored result differs from manifest: ${attempt.resultFile}`);
    const resultPath = `results/reports/${manifest.id}/trials/${String(index + 1).padStart(4, '0')}-${attempt.stackId}-${attempt.scenarioId}.json`;
    // An empty log is valid. Missing logs must not silently disappear from a
    // publication, especially when a failed result directs readers to them.
    const logBytes = await readFile(`${path}.log`);
    trialArtifacts.push({ resultPath, resultBytes, logPath: `${resultPath}.log`, logBytes });
  }
  const annotations = validateAnnotations(manifest);
  validateFindingSelection(manifest, annotations, true);
  for (const annotation of annotations) for (const evidence of annotation.evidence) {
    if (/^[a-z]+:/i.test(evidence.path) || evidence.path.startsWith('/')) throw new Error('Evidence must be a local artifact included with the report');
    const path = resolve(outputRoot, evidence.path);
    if (relative(outputRoot, path).startsWith('..')) throw new Error('Evidence must remain inside the report directory');
    await readFile(path);
  }
  const markdown = renderCampaign(manifest);
  const detailsPath = reportDetailsPath(manifest.id);
  // The complete renderer's artifact links are rooted at the publication root.
  // Relocate them when writing the companion three directories below it.
  const details = renderCampaignDetails(manifest).replace(/(\]\()(?!(?:[a-z]+:|#|\/))([^\s)]+)(\))/gi,
    (_match, before, path, after) => `${before}../../../${path.replace(/^\.\//, '')}${after}`);
  await mkdir(dirname(join(outputRoot, detailsPath)), { recursive: true });
  await writeFile(join(outputRoot, detailsPath), details);
  const sourceDir = join(outputRoot, 'results', 'sources', String(manifest.source.sourceHash));
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'SOURCE.json'), sourceBytes);
  const dependencyDir = join(outputRoot, 'results', 'dependencies', manifest.dependencies!.fingerprint);
  await mkdir(dependencyDir, { recursive: true });
  await writeFile(join(dependencyDir, 'DEPENDENCIES.json'), dependencyBytes);
  const configurationDir = join(outputRoot, 'results', 'configurations', manifest.configuration!.fingerprint);
  await mkdir(configurationDir, { recursive: true });
  await writeFile(join(configurationDir, 'CONFIGURATION.json'), configurationBytes);
  const published = structuredClone(manifest);
  const trialIndex = [];
  for (const [index, artifact] of trialArtifacts.entries()) {
    await mkdir(dirname(join(outputRoot, artifact.resultPath)), { recursive: true });
    await writeFile(join(outputRoot, artifact.resultPath), artifact.resultBytes);
    await writeFile(join(outputRoot, artifact.logPath), artifact.logBytes);
    const attempt = published.attempts[index]; attempt.resultFile = artifact.resultPath;
    trialIndex.push({ trial: attempt.trial, stackId: attempt.stackId, scenarioId: attempt.scenarioId, resultId: attempt.result.resultId,
      status: attempt.result.status, durationMs: attempt.result.durationMs, resultFile: artifact.resultPath, logFile: artifact.logPath });
  }
  await writeFile(join(outputRoot, 'results', 'reports', manifest.id, 'TRIALS.json'), JSON.stringify({ campaignId: manifest.id, pathsRelativeTo: 'publication-root', attempts: trialIndex }, null, 2) + '\n');
  if (rustArtifacts && rustInputs) {
    const rustDir = `results/rust-builds/${rustInputs.fingerprint}`;
    await mkdir(join(outputRoot, rustDir), { recursive: true });
    await writeFile(join(outputRoot, rustDir, 'RUST-BUILD.json'), rustArtifacts.bytes);
    const publishedBuild = (published.executables!.rustDriver as JsonObject).build as JsonObject;
    (publishedBuild.inputs as JsonObject).path = `${rustDir}/RUST-BUILD.json`;
  }
  if (browserArtifacts && published.browser) {
    const browserDir = `results/browsers/${published.browser.fingerprint}`;
    await mkdir(join(outputRoot, browserDir), { recursive: true });
    await writeFile(join(outputRoot, browserDir, 'BROWSER.json'), browserArtifacts.bytes);
    await writeFile(join(outputRoot, browserDir, 'BROWSER.bundle.js'), browserArtifacts.bundle);
    published.browser.path = `${browserDir}/BROWSER.json`; published.browser.bundlePath = `${browserDir}/BROWSER.bundle.js`;
  }
  published.configuration!.path = `results/configurations/${manifest.configuration!.fingerprint}/CONFIGURATION.json`;
  published.dependencies!.path = `results/dependencies/${manifest.dependencies!.fingerprint}/DEPENDENCIES.json`;
  (published.source.snapshot as JsonObject).path = `results/sources/${manifest.source.sourceHash}/SOURCE.json`;
  await writeFile(join(outputRoot, 'RESULTS.json'), `${JSON.stringify(published, null, 2)}\n`);
  await writeFile(join(outputRoot, 'RESULTS.md'), markdown);
}
