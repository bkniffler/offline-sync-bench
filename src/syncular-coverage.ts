import type { ScenarioId, StackId } from './types';

/** Required cells in the published Syncular tables, including extended scales. */
export function syncularCoverageGaps(
  stackId: StackId,
  scenarioId: ScenarioId,
  metrics: Record<string, number | null>
): string[] {
  if (stackId !== 'syncular' && stackId !== 'syncular-rust') return [];
  const required = scenarioId === 'bootstrap'
    ? [1_000, 10_000, 100_000, 250_000, 500_000].flatMap(rows => [
        `bootstrap_${rows}_ms`, `rows_loaded_${rows}`, `avg_memory_mb_${rows}`,
      ])
    : scenarioId === 'reconnect-storm'
      ? [25, 100, 250, 500, 1_000].map(count => `clients_${count}_convergence_ms`).concat([
          'clients_500_sync_avg_memory_mb', 'clients_500_postgres_avg_memory_mb',
          'clients_500_sync_avg_cpu_pct', 'clients_500_postgres_avg_cpu_pct',
        ])
      : scenarioId === 'blob-flow'
        ? ['blob_size_bytes', 'upload_complete_ms', 'metadata_visible_ms',
            'download_after_metadata_ms', 'retry_recovery_ms', 'transfer_overhead_bytes',
            'sqlite_storage_overhead_bytes_after_upload', 'retry_pending_after_failure',
            'retry_pending_after_recovery', 'retry_hash_verified']
        : scenarioId === 'deep-relationship-query'
          ? ['dashboard_query_p50_ms', 'detail_join_query_p50_ms', 'avg_memory_mb']
          : [];
  return required.filter(key => {
    const count = scenarioId === 'reconnect-storm' ? /^clients_(\d+)_/.exec(key)?.[1] : undefined;
    // An explicitly attempted, failed tier is covered, but cannot supply a
    // latency or resource value. The report must show the failure itself.
    if (count && metrics[`clients_${count}_failed`] === 1) return false;
    return typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key]);
  });
}
