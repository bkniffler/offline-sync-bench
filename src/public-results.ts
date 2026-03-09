import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  benchmarkRoot,
  resultsRoot,
  toBenchmarkRelativePath,
} from './paths';
import { scenarios } from './scenarios';
import { stacks } from './stacks';
import type { ScenarioId, StackId } from './types';

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

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${Math.round(value)} B`;
}

function formatSupport(result: StoredBenchmarkResult | undefined): string {
  const supportLevel =
    typeof result?.metadata?.supportLevel === 'string'
      ? result.metadata.supportLevel
      : 'native';
  return supportLevel;
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
  return args.latest.get(args.scenarioId)?.get(args.stackId)?.slice(0, args.limit) ?? [];
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
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatMs(result.metrics.bootstrap_1000_ms),
        formatMs(result.metrics.bootstrap_10000_ms),
        formatMs(result.metrics.bootstrap_100000_ms),
        formatCount(result.metrics.request_count_100000),
        formatMb(result.metrics.avg_memory_mb_100000),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
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
        limit: 3,
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

  const onlineRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'online-propagation', stackId);
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatMs(result.metrics.write_ack_ms),
        formatMs(result.metrics.mirror_visible_p50_ms),
        formatMs(result.metrics.mirror_visible_p95_ms),
        formatMb(result.metrics.avg_memory_mb),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
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
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(firstMetric(result.metrics, ['queued_write_count', 'queued_mutations'])),
        formatMs(firstMetric(result.metrics, ['reconnect_convergence_ms', 'replay_visible_ms'])),
        formatCount(result.metrics.request_count),
        formatMb(result.metrics.avg_memory_mb),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
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
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(result.metrics.client_count),
        formatMs(result.metrics.reconnect_convergence_ms),
        formatMb(result.metrics.sync_avg_memory_mb),
        formatMb(result.metrics.postgres_avg_memory_mb),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
  sections.push(
    renderScenarioTable({
      title: 'Reconnect Storm',
      headers: [
        'Stack',
        'Clients',
        'Convergence',
        'Sync avg mem',
        'Postgres avg mem',
        'Support',
      ],
      rows: stormRows,
    })
  );

  const queueRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'large-offline-queue', stackId);
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatMs(result.metrics.queue_100_convergence_ms),
        formatMs(result.metrics.queue_500_convergence_ms),
        formatMs(result.metrics.queue_1000_convergence_ms),
        formatCount(result.metrics.queue_1000_request_count),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
  sections.push(
    renderScenarioTable({
      title: 'Large Offline Queue',
      headers: ['Stack', '100 writes', '500 writes', '1000 writes', '1000 reqs', 'Support'],
      rows: queueRows,
    })
  );

  const queryRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'local-query', stackId);
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatMs(result.metrics.list_query_p50_ms),
        formatMs(result.metrics.search_query_p50_ms),
        formatMs(result.metrics.aggregate_query_p50_ms),
        formatMb(result.metrics.avg_memory_mb),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
  sections.push(
    renderScenarioTable({
      title: 'Local Query',
      headers: ['Stack', 'List p50', 'Search p50', 'Aggregate p50', 'Avg mem', 'Support'],
      rows: queryRows,
    })
  );

  const permissionRows = stackOrder
    .map((stackId) => {
      const result = getResult(latest, 'permission-change', stackId);
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(result.metrics.initial_visible_rows),
        formatCount(result.metrics.post_revoke_visible_rows),
        formatCount(result.metrics.revoked_project_visible_rows_after_revoke),
        formatCount(result.metrics.retained_project_visible_rows_after_revoke),
        formatMs(result.metrics.permission_revoke_convergence_ms),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
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

  const permissionRepeatRows = ['syncular', 'electric']
    .map((stackId) => {
      const recentResults = getRecentResults({
        latest,
        scenarioId: 'permission-change',
        stackId: stackId as StackId,
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
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(result.metrics.blob_size_bytes),
        formatMs(result.metrics.upload_complete_ms),
        formatMs(result.metrics.metadata_visible_ms),
        formatMs(firstMetric(result.metrics, ['download_after_metadata_ms', 'download_after_clear_ms'])),
        formatMs(result.metrics.retry_recovery_ms),
        formatBytes(result.metrics.transfer_overhead_bytes),
        formatBytes(result.metrics.sqlite_storage_overhead_bytes_after_upload),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
  if (blobRows.length > 0) {
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
  }

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
  sections.push('- `unsupported` stacks are intentionally omitted instead of being forced through non-native adapters.');
  sections.push('- Bootstrap repeat summary uses the latest three successful 100k-row bootstrap runs per stack when available.');
  sections.push('- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.');
  sections.push('');

  const markdown = sections.join('\n');

  await writeFile(OUTPUT_MARKDOWN, markdown);
  console.log(`Wrote ${OUTPUT_MARKDOWN}`);
}

await main();
