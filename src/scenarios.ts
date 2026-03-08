import type { BenchmarkScenario } from './types';

export const scenarios: BenchmarkScenario[] = [
  {
    id: 'bootstrap',
    title: 'Bootstrap',
    summary:
      'Measure cold start until a local query is usable at 1k / 10k / 100k rows.',
    primaryMetrics: [
      'time_to_first_query_ms',
      'rows_loaded',
      'bytes_transferred',
      'peak_memory_mb',
    ],
    notes: [
      'Run on a clean local cache or local database each time.',
      'Use the same seeded relational shape across stacks.',
    ],
  },
  {
    id: 'online-propagation',
    title: 'Online propagation',
    summary:
      'Measure how long a write from client A takes to become visible on client B.',
    primaryMetrics: [
      'write_ack_ms',
      'mirror_visible_p50_ms',
      'mirror_visible_p95_ms',
      'mirror_visible_p99_ms',
    ],
    notes: [
      'This is end-to-end visibility, not just transport latency.',
      'The write path must use each product the way its users would actually ship it.',
    ],
  },
  {
    id: 'offline-replay',
    title: 'Offline replay',
    summary:
      'Queue writes offline, restore connectivity, and measure convergence and conflict behavior.',
    primaryMetrics: [
      'queued_write_count',
      'reconnect_convergence_ms',
      'conflict_count',
      'replayed_write_success_rate',
    ],
    notes: [
      'Mark unsupported systems as unsupported rather than approximating a custom outbox.',
      'Record both replay latency and final consistency outcome.',
    ],
  },
  {
    id: 'reconnect-storm',
    title: 'Reconnect storm',
    summary:
      'Bring many already-bootstrapped clients back at once and measure convergence plus sync/database service load.',
    primaryMetrics: [
      'client_count',
      'reconnect_convergence_ms',
      'sync_avg_cpu_pct',
      'postgres_avg_cpu_pct',
    ],
    notes: [
      'Measure container CPU, memory, and network while the reconnect fan-in is happening.',
      'Keep the workload identical across stacks: same client count, same stale change to catch up, same seeded data shape.',
    ],
  },
  {
    id: 'large-offline-queue',
    title: 'Large offline queue',
    summary:
      'Replay much larger offline write queues than the base offline-replay scenario and measure throughput plus resource use.',
    primaryMetrics: [
      'queue_100_convergence_ms',
      'queue_500_convergence_ms',
      'queue_500_request_count',
      'queue_500_bytes_transferred',
    ],
    notes: [
      'Use multiple queue sizes so the benchmark shows scaling, not just a single point.',
      'Mark stacks unsupported instead of inventing client durability layers they do not ship.',
    ],
  },
  {
    id: 'local-query',
    title: 'Local query',
    summary:
      'Measure local filtered-list, search, and aggregation workloads after the client dataset is already materialized.',
    primaryMetrics: [
      'list_query_p50_ms',
      'list_query_p95_ms',
      'aggregate_query_p50_ms',
      'aggregate_query_p95_ms',
    ],
    notes: [
      'This is a separate local-read benchmark, not a sync-transport benchmark.',
      'Use the same seeded task shape and equivalent client-visible workloads across stacks.',
    ],
  },
  {
    id: 'permission-change',
    title: 'Permission-change convergence',
    summary:
      'Revoke access to one of several scoped projects and measure how long it takes until rows for the revoked project disappear while still-authorized rows remain.',
    primaryMetrics: [
      'initial_visible_rows',
      'post_revoke_visible_rows',
      'revoked_project_visible_rows_after_revoke',
      'retained_project_visible_rows_after_revoke',
      'permission_revoke_convergence_ms',
      'bytes_transferred',
    ],
    notes: [
      'This benchmark only counts native auth-scoped replication paths; unsupported is preferred over fake local filtering.',
      'Use the same seeded multi-project dataset and revoke the same project membership shape across comparable stacks.',
    ],
  },
];
