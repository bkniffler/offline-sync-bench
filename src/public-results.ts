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
  Map<ScenarioId, Map<StackId, StoredBenchmarkResult>>
> {
  const files = await walkJsonFiles(RESULTS_DIR);
  const latest = new Map<ScenarioId, Map<StackId, StoredBenchmarkResult>>();

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
    const scenarioMap = latest.get(scenarioId) ?? new Map<StackId, StoredBenchmarkResult>();
    const existing = scenarioMap.get(typedStackId);
    const existingFinishedAt = existing?.finishedAt ?? '';
    if (!existing || parsed.finishedAt > existingFinishedAt) {
      scenarioMap.set(typedStackId, {
        ...parsed,
        _path: toBenchmarkRelativePath(filePath),
      });
      latest.set(scenarioId, scenarioMap);
    }
  }

  return latest;
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
  latest: Map<ScenarioId, Map<StackId, StoredBenchmarkResult>>,
  scenarioId: ScenarioId,
  stackId: StackId
): StoredBenchmarkResult | undefined {
  return latest.get(scenarioId)?.get(stackId);
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

  if (electricBootstrap && syncularBootstrap && replicacheBootstrap) {
    sections.push(
      `- Bootstrap at 100k rows: Electric currently leads at ${formatMs(electricBootstrap.metrics.bootstrap_100000_ms)}; Syncular is at ${formatMs(syncularBootstrap.metrics.bootstrap_100000_ms)} and Replicache is at ${formatMs(replicacheBootstrap.metrics.bootstrap_100000_ms)}.`
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
  if (syncularPermission && electricPermission) {
    sections.push(
      `- Permission change: Syncular and Electric both have real multi-project revocation coverage here; Syncular converges in ${formatMs(syncularPermission.metrics.permission_revoke_convergence_ms)} and Electric in ${formatMs(electricPermission.metrics.permission_revoke_convergence_ms)}.`
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
      const result = latest.get('bootstrap')?.get(stackId);
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

  const onlineRows = stackOrder
    .map((stackId) => {
      const result = latest.get('online-propagation')?.get(stackId);
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
      const result = latest.get('offline-replay')?.get(stackId);
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
      const result = latest.get('reconnect-storm')?.get(stackId);
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
      const result = latest.get('large-offline-queue')?.get(stackId);
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(result.metrics.queue_20_queued_writes),
        formatMs(result.metrics.queue_20_convergence_ms),
        formatCount(result.metrics.queue_20_request_count),
        formatMb(result.metrics.queue_20_avg_memory_mb),
        formatSupport(result),
      ];
    })
    .filter((row): row is string[] => row !== null);
  sections.push(
    renderScenarioTable({
      title: 'Large Offline Queue',
      headers: ['Stack', 'Queued writes', 'Convergence', 'Requests', 'Avg mem', 'Support'],
      rows: queueRows,
    })
  );

  const queryRows = stackOrder
    .map((stackId) => {
      const result = latest.get('local-query')?.get(stackId);
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
      const result = latest.get('permission-change')?.get(stackId);
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

  const blobRows = stackOrder
    .map((stackId) => {
      const result = latest.get('blob-flow')?.get(stackId);
      if (!result) return null;
      return [
        stacks.find((stack) => stack.id === stackId)?.title ?? stackId,
        formatCount(result.metrics.blob_size_bytes),
        formatMs(result.metrics.upload_complete_ms),
        formatMs(result.metrics.metadata_visible_ms),
        formatMs(firstMetric(result.metrics, ['download_after_metadata_ms', 'download_after_clear_ms'])),
        formatMs(result.metrics.retry_recovery_ms),
        formatBytes(result.metrics.transfer_overhead_bytes),
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
          'Support',
        ],
        rows: blobRows,
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
  sections.push('- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.');
  sections.push('');

  const markdown = sections.join('\n');

  await writeFile(OUTPUT_MARKDOWN, markdown);
  console.log(`Wrote ${OUTPUT_MARKDOWN}`);
}

await main();
