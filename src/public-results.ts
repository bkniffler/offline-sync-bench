import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  benchmarkRoot,
  resultsRoot,
  toBenchmarkRelativePath,
} from './paths';
import { scenarios } from './scenarios';
import { stacks } from './stacks';
import type { ScenarioId, StackCapabilities, StackId, SupportLevel } from './types';

interface StoredBenchmarkResult {
  runId: string;
  stackId: StackId;
  scenarioId: ScenarioId;
  status: string;
  finishedAt: string;
  metrics: Record<string, number | null>;
  metadata?: Record<string, unknown>;
  notes?: string[];
  _path?: string;
}

interface BundleSizeRow {
  id: string;
  label: string;
  rawKb: number;
  gzipKb: number;
  profile?: string;
}

const ROOT_DIR = benchmarkRoot;
const RESULTS_DIR = resultsRoot;
const OUTPUT_MARKDOWN = join(ROOT_DIR, 'RESULTS.md');

async function walkJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function collectLatestResults(): Promise<
  Map<ScenarioId, Map<StackId, StoredBenchmarkResult[]>>
> {
  const files = await walkJsonFiles(RESULTS_DIR);
  const history = new Map<ScenarioId, Map<StackId, StoredBenchmarkResult[]>>();

  for (const filePath of files) {
    const rel = relative(RESULTS_DIR, filePath).split(/[\\/]/);
    if (rel.length !== 3) continue;
    const [runId, stackId, fileName] = rel;
    const scenarioId = fileName.replace(/\.json$/, '') as ScenarioId;
    const stack = stacks.find((entry) => entry.id === stackId);
    const scenario = scenarios.find((entry) => entry.id === scenarioId);
    if (!runId || !stack || !scenario) continue;
    const typedStackId = stack.id;

    let parsed: StoredBenchmarkResult;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8')) as StoredBenchmarkResult;
    } catch {
      continue;
    }

    if (parsed.status !== 'completed') continue;
    const scenarioMap =
      history.get(scenarioId) ?? new Map<StackId, StoredBenchmarkResult[]>();
    const stackResults = scenarioMap.get(typedStackId) ?? [];
    stackResults.push({
      ...parsed,
      _path: toBenchmarkRelativePath(filePath),
    });
    scenarioMap.set(typedStackId, stackResults);
    history.set(scenarioId, scenarioMap);
  }

  for (const scenarioMap of history.values()) {
    for (const [stackId, results] of scenarioMap) {
      scenarioMap.set(
        stackId,
        results.sort((left, right) => right.finishedAt.localeCompare(left.finishedAt))
      );
    }
  }

  return history;
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  if (value >= 1000) return `${value.toFixed(0)} ms`;
  if (value >= 100) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${Math.round(value)}`;
}

function formatKb(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value.toFixed(2)} KB`;
}

function formatMb(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value.toFixed(2)} MB`;
}

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value.toFixed(2)}%`;
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${Math.round(value)} B`;
}

function capabilityKeyForScenario(
  scenarioId: ScenarioId
): keyof StackCapabilities {
  switch (scenarioId) {
    case 'bootstrap':
      return 'bootstrap';
    case 'online-propagation':
      return 'onlinePropagation';
    case 'offline-replay':
      return 'offlineReplay';
    case 'reconnect-storm':
      return 'reconnectStorm';
    case 'large-offline-queue':
      return 'largeOfflineQueue';
    case 'local-query':
      return 'localQuery';
    case 'deep-relationship-query':
      return 'deepRelationshipQuery';
    case 'permission-change':
      return 'permissionChange';
    case 'blob-flow':
      return 'blobFlow';
  }
}

function formatSupport(args: {
  result: StoredBenchmarkResult | undefined;
  scenarioId: ScenarioId;
  stackId: StackId;
}): string {
  const metadataSupport = args.result?.metadata?.supportLevel;
  if (
    metadataSupport === 'native' ||
    metadataSupport === 'emulated' ||
    metadataSupport === 'unsupported'
  ) {
    return metadataSupport;
  }

  const stack = stacks.find((entry) => entry.id === args.stackId);
  if (!stack) {
    return 'unknown';
  }

  return stack.capabilities[capabilityKeyForScenario(args.scenarioId)] as SupportLevel;
}

function firstMetric(
  metrics: Record<string, number | null>,
  keys: string[]
): number | null | undefined {
  for (const key of keys) {
    const value = metrics[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function markdownTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

function getResult(
  latest: Map<ScenarioId, Map<StackId, StoredBenchmarkResult[]>>,
  scenarioId: ScenarioId,
  stackId: StackId
): StoredBenchmarkResult | undefined {
  return latest.get(scenarioId)?.get(stackId)?.[0];
}

function getRecentResults(args: {
  latest: Map<ScenarioId, Map<StackId, StoredBenchmarkResult[]>>;
  scenarioId: ScenarioId;
  stackId: StackId;
  limit: number;
}): StoredBenchmarkResult[] {
  const results = args.latest.get(args.scenarioId)?.get(args.stackId) ?? [];
  const latestResult = results[0];
  if (!latestResult) {
    return [];
  }

  const latestFrameworkVersion =
    typeof latestResult.metadata?.frameworkVersion === 'string'
      ? latestResult.metadata.frameworkVersion
      : null;
  const latestImplementation =
    typeof latestResult.metadata?.implementation === 'string'
      ? latestResult.metadata.implementation
      : null;

  return results
    .filter((result) => {
      if (
        latestFrameworkVersion &&
        result.metadata?.frameworkVersion !== latestFrameworkVersion
      ) {
        return false;
      }
      if (
        latestImplementation &&
        result.metadata?.implementation !== latestImplementation
      ) {
        return false;
      }
      return true;
    })
    .slice(0, args.limit);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) {
    return null;
  }
  return (left + right) / 2;
}

function medianMetricFromRecentResults(args: {
  latest: Map<ScenarioId, Map<StackId, StoredBenchmarkResult[]>>;
  scenarioId: ScenarioId;
  stackId: StackId;
  limit: number;
  metricKeys: string[];
}): number | null {
  const recentResults = getRecentResults({
    latest: args.latest,
    scenarioId: args.scenarioId,
    stackId: args.stackId,
    limit: args.limit,
  });
  const samples = recentResults
    .map((result) => firstMetric(result.metrics, args.metricKeys))
    .filter((value): value is number => typeof value === 'number');
  return median(samples);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function collectBundleRows(): Promise<BundleSizeRow[]> {
  const bundleSizes = await readJsonFile<BundleSizeRow[]>(
    join(RESULTS_DIR, 'BUNDLE_SIZES.json')
  );
  const lookup = new Map(bundleSizes.map((entry) => [entry.id, entry] as const));

  const rows: Array<BundleSizeRow | null> = [
    lookup.get('syncular-client-root-named')
      ? {
          ...lookup.get('syncular-client-root-named')!,
          label: 'Syncular',
          profile: 'named import',
        }
      : null,
    lookup.get('electric-minimal')
      ? { ...lookup.get('electric-minimal')!, label: 'Electric', profile: 'named import' }
      : null,
    lookup.get('zero-minimal')
      ? { ...lookup.get('zero-minimal')!, label: 'Zero', profile: 'named import' }
      : null,
    lookup.get('powersync-minimal')
      ? { ...lookup.get('powersync-minimal')!, label: 'PowerSync', profile: 'named import' }
      : null,
    lookup.get('replicache-minimal')
      ? { ...lookup.get('replicache-minimal')!, label: 'Replicache', profile: 'named import' }
      : null,
    lookup.get('livestore-minimal')
      ? { ...lookup.get('livestore-minimal')!, label: 'LiveStore', profile: 'named import' }
      : null,
  ];

  return rows.filter((entry): entry is BundleSizeRow => entry !== null);
}

function renderScenarioTable(args: {
  title: string;
  headers: string[];
  rows: string[][];
}): string {
  return [`## ${args.title}`, '', markdownTable(args.headers, args.rows), ''].join('\n');
}

function stackTitle(stackId: StackId): string {
  return stacks.find((stack) => stack.id === stackId)?.title ?? stackId;
}

async function main(): Promise<void> {
  const latest = await collectLatestResults();
  const bundleRows = await collectBundleRows();

  const stackOrder = stacks.map((stack) => stack.id);
  const sections: string[] = [];
  sections.push('# Benchmark Results');
  sections.push('');
  sections.push(
    'This report is generated from the latest successful result for each stack/scenario pair under `.results/`.'
  );
  sections.push(
    'Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.'
  );
  sections.push(
    'Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.'
  );
  sections.push('');
  sections.push('## Highlights');
  sections.push('');
  const syncularBootstrap = getResult(latest, 'bootstrap', 'syncular');
  const electricBootstrap = getResult(latest, 'bootstrap', 'electric');
  const replicacheBootstrap = getResult(latest, 'bootstrap', 'replicache');
  const syncularOnline = getResult(latest, 'online-propagation', 'syncular');
  const electricOnline = getResult(latest, 'online-propagation', 'electric');
  const syncularReplay = getResult(latest, 'offline-replay', 'syncular');
  const replicacheReplay = getResult(latest, 'offline-replay', 'replicache');
  const powersyncReplay = getResult(latest, 'offline-replay', 'powersync');
  const syncularPermission = getResult(latest, 'permission-change', 'syncular');
  const electricPermission = getResult(latest, 'permission-change', 'electric');
  const syncularBlobFlow = getResult(latest, 'blob-flow', 'syncular');
  const syncularBundle = bundleRows.find((row) => row.label === 'Syncular');

  const syncularBootstrapRecent = getRecentResults({
    latest,
    scenarioId: 'bootstrap',
    stackId: 'syncular',
    limit: 3,
  });
  const electricBootstrapRecent = getRecentResults({
    latest,
    scenarioId: 'bootstrap',
    stackId: 'electric',
    limit: 3,
  });
  const replicacheBootstrapRecent = getRecentResults({
    latest,
    scenarioId: 'bootstrap',
    stackId: 'replicache',
    limit: 3,
  });

  const syncularBootstrapMedian = median(
    syncularBootstrapRecent
      .map((result) => result.metrics.bootstrap_100000_ms)
      .filter((value): value is number => typeof value === 'number')
  );
  const electricBootstrapMedian = median(
    electricBootstrapRecent
      .map((result) => result.metrics.bootstrap_100000_ms)
      .filter((value): value is number => typeof value === 'number')
  );
  const replicacheBootstrapMedian = median(
    replicacheBootstrapRecent
      .map((result) => result.metrics.bootstrap_100000_ms)
      .filter((value): value is number => typeof value === 'number')
  );

  const syncularPermissionRecent = getRecentResults({
    latest,
    scenarioId: 'permission-change',
    stackId: 'syncular',
    limit: 3,
  });
  const electricPermissionRecent = getRecentResults({
    latest,
    scenarioId: 'permission-change',
    stackId: 'electric',
    limit: 3,
  });
  const syncularPermissionMedian = median(
    syncularPermissionRecent
      .map((result) => result.metrics.permission_revoke_convergence_ms)
      .filter((value): value is number => typeof value === 'number')
  );
  const electricPermissionMedian = median(
    electricPermissionRecent
      .map((result) => result.metrics.permission_revoke_convergence_ms)
      .filter((value): value is number => typeof value === 'number')
  );

  if (
    electricBootstrapMedian !== null &&
    syncularBootstrapMedian !== null &&
    replicacheBootstrapMedian !== null
  ) {
    sections.push(
      `- Bootstrap at 100k rows (median of the latest ${Math.min(electricBootstrapRecent.length, syncularBootstrapRecent.length, replicacheBootstrapRecent.length)} runs where available): Electric is at ${formatMs(electricBootstrapMedian)}; Syncular is at ${formatMs(syncularBootstrapMedian)}; Replicache is at ${formatMs(replicacheBootstrapMedian)}.`
    );
  }
  if (electricOnline && syncularOnline) {
    sections.push(
      `- Online propagation: Electric still leads on tail latency (${formatMs(electricOnline.metrics.mirror_visible_p95_ms)} p95), while Syncular is now at ${formatMs(syncularOnline.metrics.mirror_visible_p95_ms)} p95 with ${formatMs(syncularOnline.metrics.write_ack_ms)} write ack.`
    );
  }
  if (syncularReplay && replicacheReplay && powersyncReplay) {
    sections.push(
      `- Native offline replay: Syncular currently converges in ${formatMs(firstMetric(syncularReplay.metrics, ['reconnect_convergence_ms', 'replay_visible_ms']))}, ahead of Replicache (${formatMs(firstMetric(replicacheReplay.metrics, ['reconnect_convergence_ms', 'replay_visible_ms']))}) and PowerSync (${formatMs(firstMetric(powersyncReplay.metrics, ['reconnect_convergence_ms', 'replay_visible_ms']))}).`
    );
  }
  if (
    syncularPermissionMedian !== null &&
    electricPermissionMedian !== null
  ) {
    sections.push(
      `- Permission change (median of the latest ${Math.min(syncularPermissionRecent.length, electricPermissionRecent.length)} runs where available): Syncular converges in ${formatMs(syncularPermissionMedian)} and Electric in ${formatMs(electricPermissionMedian)}.`
    );
  }
  if (syncularBundle) {
    sections.push(
      `- Client bundle size: Syncular is currently ${formatKb(syncularBundle.rawKb)} raw / ${formatKb(syncularBundle.gzipKb)} gzip for the named-import browser profile.`
    );
  }
  if (syncularBlobFlow) {
    sections.push(
      `- Blob flow: Syncular currently uploads a ${formatCount(syncularBlobFlow.metrics.blob_size_bytes)} byte blob in ${formatMs(syncularBlobFlow.metrics.upload_complete_ms)}, syncs metadata to a second client in ${formatMs(syncularBlobFlow.metrics.metadata_visible_ms)}, re-downloads it after cache clear in ${formatMs(firstMetric(syncularBlobFlow.metrics, ['download_after_metadata_ms', 'download_after_clear_ms']))}, and recovers an interrupted queued upload in ${formatMs(syncularBlobFlow.metrics.retry_recovery_ms)}.`
    );
  }
  sections.push('');

  const bootstrapRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'bootstrap', stackId);
      return [
        stackTitle(stackId),
        formatMs(result?.metrics.bootstrap_1000_ms),
        formatMs(result?.metrics.bootstrap_10000_ms),
        formatMs(result?.metrics.bootstrap_100000_ms),
        formatCount(result?.metrics.request_count_100000),
        formatMb(result?.metrics.avg_memory_mb_100000),
        formatSupport({ result, scenarioId: 'bootstrap', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Bootstrap',
      headers: ['Stack', '1k', '10k', '100k', '100k reqs', '100k avg mem', 'Support'],
      rows: bootstrapRows,
    })
  );

  const bootstrapRepeatRows = stackOrder
    .map((stackId) => {
      const recentResults = getRecentResults({
        latest,
        scenarioId: 'bootstrap',
        stackId,
        limit: 5,
      });
      if (recentResults.length === 0) return null;
      const bootstrapSamples = recentResults
        .map((result) => result.metrics.bootstrap_100000_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      if (bootstrapSamples.length === 0) return null;
      const latestResult = recentResults[0];
      const minSample = bootstrapSamples[0];
      const maxSample = bootstrapSamples[bootstrapSamples.length - 1];
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(bootstrapSamples.length),
        formatMs(median(bootstrapSamples)),
        formatMs(minSample),
        formatMs(maxSample),
        formatMs(latestResult?.metrics.bootstrap_100000_ms),
      ];
    })
    .filter((row): row is string[] => row !== null);
  sections.push(
    renderScenarioTable({
      title: 'Bootstrap Repeat Summary',
      headers: ['Stack', 'Runs', '100k median', '100k min', '100k max', 'Latest 100k'],
      rows: bootstrapRepeatRows,
    })
  );

  const bootstrapScaleRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'bootstrap', stackId);
      return [
        stackTitle(stackId),
        formatMs(result?.metrics.bootstrap_250000_ms),
        formatMs(result?.metrics.bootstrap_500000_ms),
        formatMb(result?.metrics.avg_memory_mb_500000),
        formatSupport({ result, scenarioId: 'bootstrap', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Bootstrap Scale Study',
      headers: ['Stack', '250k rows', '500k rows', '500k avg mem', 'Support'],
      rows: bootstrapScaleRows,
    })
  );

  const bootstrapResourceRows = stackOrder.map((stackId) => {
    const result = getResult(latest, 'bootstrap', stackId);
    return [
      stackTitle(stackId),
      formatMb(
        firstMetric(result?.metrics ?? {}, [
          'avg_memory_mb_500000',
          'avg_memory_mb_250000',
          'avg_memory_mb_100000',
        ])
      ),
      formatPct(
        firstMetric(result?.metrics ?? {}, [
          'avg_cpu_pct_500000',
          'avg_cpu_pct_250000',
          'avg_cpu_pct_100000',
        ])
      ),
      formatMb(
        firstMetric(result?.metrics ?? {}, [
          'peak_memory_mb_500000',
          'peak_memory_mb_250000',
          'peak_memory_mb_100000',
        ])
      ),
      formatPct(
        firstMetric(result?.metrics ?? {}, [
          'peak_cpu_pct_500000',
          'peak_cpu_pct_250000',
          'peak_cpu_pct_100000',
        ])
      ),
      formatSupport({ result, scenarioId: 'bootstrap', stackId }),
    ];
  });
  sections.push(
    renderScenarioTable({
      title: 'Bootstrap Resource Summary',
      headers: [
        'Stack',
        'Largest avg mem',
        'Largest avg CPU',
        'Largest peak mem',
        'Largest peak CPU',
        'Support',
      ],
      rows: bootstrapResourceRows,
    })
  );

  const onlineRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'online-propagation', stackId);
      return [
        stackTitle(stackId),
        formatMs(result?.metrics.write_ack_ms),
        formatMs(result?.metrics.mirror_visible_p50_ms),
        formatMs(result?.metrics.mirror_visible_p95_ms),
        formatMb(result?.metrics.avg_memory_mb),
        formatSupport({ result, scenarioId: 'online-propagation', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Online Propagation',
      headers: ['Stack', 'Write ack', 'Visible p50', 'Visible p95', 'Avg mem', 'Support'],
      rows: onlineRows,
    })
  );

  const replayRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'offline-replay', stackId);
      return [
        stackTitle(stackId),
        formatCount(firstMetric(result?.metrics ?? {}, ['queued_write_count', 'queued_mutations'])),
        formatMs(firstMetric(result?.metrics ?? {}, ['reconnect_convergence_ms', 'replay_visible_ms'])),
        formatCount(result?.metrics.request_count),
        formatMb(result?.metrics.avg_memory_mb),
        formatSupport({ result, scenarioId: 'offline-replay', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Offline Replay',
      headers: ['Stack', 'Queued writes', 'Convergence', 'Requests', 'Avg mem', 'Support'],
      rows: replayRows,
    })
  );

  const stormRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'reconnect-storm', stackId);
      const median25 = medianMetricFromRecentResults({
        latest,
        scenarioId: 'reconnect-storm',
        stackId,
        limit: 3,
        metricKeys: ['clients_25_convergence_ms', 'reconnect_convergence_ms'],
      });
      const median100 = medianMetricFromRecentResults({
        latest,
        scenarioId: 'reconnect-storm',
        stackId,
        limit: 3,
        metricKeys: ['clients_100_convergence_ms'],
      });
      const median250 = medianMetricFromRecentResults({
        latest,
        scenarioId: 'reconnect-storm',
        stackId,
        limit: 3,
        metricKeys: ['clients_250_convergence_ms'],
      });
      const median500 = medianMetricFromRecentResults({
        latest,
        scenarioId: 'reconnect-storm',
        stackId,
        limit: 3,
        metricKeys: ['clients_500_convergence_ms'],
      });
      return [
        stackTitle(stackId),
        formatMs(
          median25 ??
            firstMetric(result?.metrics ?? {}, [
              'clients_25_convergence_ms',
              'reconnect_convergence_ms',
            ])
        ),
        formatMs(median100 ?? result?.metrics.clients_100_convergence_ms),
        formatMs(median250 ?? result?.metrics.clients_250_convergence_ms),
        formatMs(median500 ?? result?.metrics.clients_500_convergence_ms),
        formatSupport({ result, scenarioId: 'reconnect-storm', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Reconnect Storm',
      headers: [
        'Stack',
        '25 clients',
        '100 clients',
        '250 clients',
        '500 clients',
        'Support',
      ],
      rows: stormRows,
    })
  );

  const reconnectRepeatRows = stackOrder
    .map((stackId) => {
      const recentResults = getRecentResults({
        latest,
        scenarioId: 'reconnect-storm',
        stackId,
        limit: 3,
      });
      if (recentResults.length === 0) return null;
      const samples25 = recentResults
        .map((result) =>
          firstMetric(result.metrics, [
            'clients_25_convergence_ms',
            'reconnect_convergence_ms',
          ])
        )
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      const samples100 = recentResults
        .map((result) => result.metrics.clients_100_convergence_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      const samples250 = recentResults
        .map((result) => result.metrics.clients_250_convergence_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      const samples500 = recentResults
        .map((result) => result.metrics.clients_500_convergence_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      const runCount = Math.max(
        samples25.length,
        samples100.length,
        samples250.length,
        samples500.length
      );
      if (runCount === 0) return null;
      return [
        stackTitle(stackId),
        formatCount(runCount),
        formatMs(samples25.length > 0 ? median(samples25) : null),
        formatMs(samples100.length > 0 ? median(samples100) : null),
        formatMs(samples250.length > 0 ? median(samples250) : null),
        formatMs(samples500.length > 0 ? median(samples500) : null),
      ];
    })
    .filter((row): row is string[] => row !== null);
  if (reconnectRepeatRows.length > 0) {
    sections.push(
      renderScenarioTable({
        title: 'Reconnect Storm Repeat Summary',
        headers: [
          'Stack',
          'Runs',
          '25 median',
          '100 median',
          '250 median',
          '500 median',
        ],
        rows: reconnectRepeatRows,
      })
    );
  }

  const reconnectResourceRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'reconnect-storm', stackId);
      if (!result) return null;
      return [
        stackTitle(stackId),
        formatMb(
          firstMetric(result.metrics, [
            'clients_500_sync_avg_memory_mb',
            'clients_250_sync_avg_memory_mb',
            'sync_avg_memory_mb',
          ])
        ),
        formatMb(
          firstMetric(result.metrics, [
            'clients_500_postgres_avg_memory_mb',
            'clients_250_postgres_avg_memory_mb',
            'postgres_avg_memory_mb',
          ])
        ),
        formatPct(
          firstMetric(result.metrics, [
            'clients_500_sync_avg_cpu_pct',
            'clients_250_sync_avg_cpu_pct',
            'sync_avg_cpu_pct',
          ])
        ),
        formatPct(
          firstMetric(result.metrics, [
            'clients_500_postgres_avg_cpu_pct',
            'clients_250_postgres_avg_cpu_pct',
            'postgres_avg_cpu_pct',
          ])
        ),
        formatSupport({ result, scenarioId: 'reconnect-storm', stackId }),
      ];
    })
    .filter((row): row is string[] => row !== null);
  if (reconnectResourceRows.length > 0) {
    sections.push(
      renderScenarioTable({
        title: 'Reconnect Storm Resource Summary',
        headers: [
          'Stack',
          '500 sync avg mem',
          '500 postgres avg mem',
          '500 sync avg CPU',
          '500 postgres avg CPU',
          'Support',
        ],
        rows: reconnectResourceRows,
      })
    );
  }

  const queueRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'large-offline-queue', stackId);
      const median100 = medianMetricFromRecentResults({
        latest,
        scenarioId: 'large-offline-queue',
        stackId,
        limit: 3,
        metricKeys: ['queue_100_convergence_ms'],
      });
      const median500 = medianMetricFromRecentResults({
        latest,
        scenarioId: 'large-offline-queue',
        stackId,
        limit: 3,
        metricKeys: ['queue_500_convergence_ms'],
      });
      const median1000 = medianMetricFromRecentResults({
        latest,
        scenarioId: 'large-offline-queue',
        stackId,
        limit: 3,
        metricKeys: ['queue_1000_convergence_ms'],
      });
      const median1000Reqs = medianMetricFromRecentResults({
        latest,
        scenarioId: 'large-offline-queue',
        stackId,
        limit: 3,
        metricKeys: ['queue_1000_request_count'],
      });
      return [
        stackTitle(stackId),
        formatMs(median100 ?? result?.metrics.queue_100_convergence_ms),
        formatMs(median500 ?? result?.metrics.queue_500_convergence_ms),
        formatMs(median1000 ?? result?.metrics.queue_1000_convergence_ms),
        formatCount(median1000Reqs ?? result?.metrics.queue_1000_request_count),
        formatSupport({ result, scenarioId: 'large-offline-queue', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Large Offline Queue',
      headers: ['Stack', '100 writes', '500 writes', '1000 writes', '1000 reqs', 'Support'],
      rows: queueRows,
    })
  );

  const largeQueueRepeatRows = stackOrder
    .map((stackId) => {
      const recentResults = getRecentResults({
        latest,
        scenarioId: 'large-offline-queue',
        stackId,
        limit: 3,
      });
      if (recentResults.length === 0) return null;
      const queue100Samples = recentResults
        .map((result) => result.metrics.queue_100_convergence_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      const queue500Samples = recentResults
        .map((result) => result.metrics.queue_500_convergence_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      const queue1000Samples = recentResults
        .map((result) => result.metrics.queue_1000_convergence_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);

      if (
        queue100Samples.length === 0 ||
        queue500Samples.length === 0 ||
        queue1000Samples.length === 0
      ) {
        return null;
      }

      return [
        stackTitle(stackId),
        formatCount(recentResults.length),
        formatMs(median(queue100Samples)),
        formatMs(median(queue500Samples)),
        formatMs(median(queue1000Samples)),
        formatMs(recentResults[0]?.metrics.queue_1000_convergence_ms),
      ];
    })
    .filter((row): row is string[] => row !== null);
  if (largeQueueRepeatRows.length > 0) {
    sections.push(
      renderScenarioTable({
        title: 'Large Offline Queue Repeat Summary',
        headers: ['Stack', 'Runs', '100 median', '500 median', '1000 median', 'Latest 1000'],
        rows: largeQueueRepeatRows,
      })
    );
  }

  const queryRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'local-query', stackId);
      return [
        stackTitle(stackId),
        formatMs(result?.metrics.list_query_p50_ms),
        formatMs(result?.metrics.search_query_p50_ms),
        formatMs(result?.metrics.aggregate_query_p50_ms),
        formatMb(result?.metrics.avg_memory_mb),
        formatSupport({ result, scenarioId: 'local-query', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Local Query',
      headers: ['Stack', 'List p50', 'Search p50', 'Aggregate p50', 'Avg mem', 'Support'],
      rows: queryRows,
    })
  );

  const deepQueryRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'deep-relationship-query', stackId);
      return [
        stackTitle(stackId),
        formatMs(result?.metrics.dashboard_query_p50_ms),
        formatMs(result?.metrics.detail_join_query_p50_ms),
        formatMb(result?.metrics.avg_memory_mb),
        formatSupport({
          result,
          scenarioId: 'deep-relationship-query',
          stackId,
        }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Deep Relationship Query',
      headers: ['Stack', 'Dashboard p50', 'Detail join p50', 'Avg mem', 'Support'],
      rows: deepQueryRows,
    })
  );

  const deepQueryRepeatRows = stackOrder
    .map((stackId) => {
      const recentResults = getRecentResults({
        latest,
        scenarioId: 'deep-relationship-query',
        stackId,
        limit: 3,
      });
      if (recentResults.length === 0) return null;
      const dashboardSamples = recentResults
        .map((result) => result.metrics.dashboard_query_p50_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      const detailSamples = recentResults
        .map((result) => result.metrics.detail_join_query_p50_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      if (dashboardSamples.length === 0 || detailSamples.length === 0) {
        return null;
      }
      return [
        stackTitle(stackId),
        formatCount(Math.min(dashboardSamples.length, detailSamples.length)),
        formatMs(median(dashboardSamples)),
        formatMs(median(detailSamples)),
        formatMs(recentResults[0]?.metrics.dashboard_query_p50_ms),
        formatMs(recentResults[0]?.metrics.detail_join_query_p50_ms),
      ];
    })
    .filter((row): row is string[] => row !== null);
  if (deepQueryRepeatRows.length > 0) {
    sections.push(
      renderScenarioTable({
        title: 'Deep Relationship Repeat Summary',
        headers: [
          'Stack',
          'Runs',
          'Dashboard median',
          'Detail median',
          'Latest dashboard',
          'Latest detail',
        ],
        rows: deepQueryRepeatRows,
      })
    );
  }

  const permissionRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'permission-change', stackId);
      return [
        stackTitle(stackId),
        formatCount(result?.metrics.initial_visible_rows),
        formatCount(result?.metrics.post_revoke_visible_rows),
        formatCount(result?.metrics.revoked_project_visible_rows_after_revoke),
        formatCount(result?.metrics.retained_project_visible_rows_after_revoke),
        formatMs(result?.metrics.permission_revoke_convergence_ms),
        formatSupport({ result, scenarioId: 'permission-change', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Permission Change',
      headers: [
        'Stack',
        'Initial rows',
        'After revoke',
        'Revoked rows left',
        'Retained rows left',
        'Convergence',
        'Support',
      ],
      rows: permissionRows,
    })
  );

  const permissionRepeatRows = stackOrder
    .map((stackId) => {
      const recentResults = getRecentResults({
        latest,
        scenarioId: 'permission-change',
        stackId,
        limit: 3,
      });
      if (recentResults.length === 0) return null;
      const samples = recentResults
        .map((result) => result.metrics.permission_revoke_convergence_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      if (samples.length === 0) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(samples.length),
        formatMs(median(samples)),
        formatMs(samples[0]),
        formatMs(samples[samples.length - 1]),
        formatMs(recentResults[0]?.metrics.permission_revoke_convergence_ms),
      ];
    })
    .filter((row): row is string[] => row !== null);
  sections.push(
    renderScenarioTable({
      title: 'Permission Change Repeat Summary',
      headers: ['Stack', 'Runs', 'Median', 'Min', 'Max', 'Latest'],
      rows: permissionRepeatRows,
    })
  );

  const blobRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'blob-flow', stackId);
      return [
        stackTitle(stackId),
        formatCount(result?.metrics.blob_size_bytes),
        formatMs(result?.metrics.upload_complete_ms),
        formatMs(result?.metrics.metadata_visible_ms),
        formatMs(firstMetric(result?.metrics ?? {}, ['download_after_metadata_ms', 'download_after_clear_ms'])),
        formatMs(result?.metrics.retry_recovery_ms),
        formatBytes(result?.metrics.transfer_overhead_bytes),
        formatBytes(result?.metrics.sqlite_storage_overhead_bytes_after_upload),
        formatSupport({ result, scenarioId: 'blob-flow', stackId }),
      ];
    });
  sections.push(
    renderScenarioTable({
      title: 'Blob Flow',
      headers: [
        'Stack',
        'Blob bytes',
        'Upload',
        'Metadata visible',
        'Re-download',
        'Retry recovery',
        'Transfer overhead',
        'SQLite upload overhead',
        'Support',
      ],
      rows: blobRows,
    })
  );

  const blobRepeatRows = stackOrder
    .map((stackId) => {
      const recentResults = getRecentResults({
        latest,
        scenarioId: 'blob-flow',
        stackId,
        limit: 3,
      });
      if (recentResults.length === 0) return null;
      const uploadSamples = recentResults
        .map((result) => result.metrics.upload_complete_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      const metadataSamples = recentResults
        .map((result) => result.metrics.metadata_visible_ms)
        .filter((value): value is number => typeof value === 'number')
        .sort((left, right) => left - right);
      if (uploadSamples.length === 0 || metadataSamples.length === 0) {
        return null;
      }
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(uploadSamples.length),
        formatMs(median(uploadSamples)),
        formatMs(median(metadataSamples)),
        formatMs(recentResults[0]?.metrics.retry_recovery_ms),
      ];
    })
    .filter((row): row is string[] => row !== null);
  if (blobRepeatRows.length > 0) {
    sections.push(
      renderScenarioTable({
        title: 'Blob Flow Repeat Summary',
        headers: ['Stack', 'Runs', 'Upload median', 'Metadata median', 'Latest retry recovery'],
        rows: blobRepeatRows,
      })
    );
  }

  const bundleTable = markdownTable(
    ['Library', 'Profile', 'Raw', 'Gzip'],
    bundleRows.map((row) => [
      row.label,
      row.profile ?? 'named import',
      formatKb(row.rawKb),
      formatKb(row.gzipKb),
    ])
  );
  sections.push('## Client Bundle Size');
  sections.push('');
  sections.push(bundleTable);
  sections.push('');

  sections.push('## Notes');
  sections.push('');
  sections.push('- `native` means the benchmark uses the product’s normal client model.');
  sections.push('- `emulated` means the scenario required benchmark-owned durability or auth behavior around the product.');
  sections.push('- `unsupported` rows stay visible as `n/a` so the support matrix remains explicit without inventing benchmark-owned adapters.');
  sections.push('- LiveStore local-query remains unsupported at the shared 100000-row scale because the current wa-sqlite configuration aborts with a wasm heap OOM in this harness.');
  sections.push('- Repeat summaries use the latest successful runs for the current framework version per stack/scenario.');
  sections.push('- Bootstrap repeat summary uses up to five successful 100k-row runs per current version when available.');
  sections.push('- Reconnect storm repeat summary uses up to three successful runs per current version and reports tier medians for 25 / 100 / 250 / 500 clients when available.');
  sections.push('- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.');
  sections.push('');

  const markdown = sections.join('\n');

  await writeFile(OUTPUT_MARKDOWN, markdown);
  console.log(`Wrote ${OUTPUT_MARKDOWN}`);
}

await main();
