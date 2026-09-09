import type { BenchmarkScenario } from './types';

export const scenarios: BenchmarkScenario[] = [
  { id: 'connected-fanout', title: 'Connected client fanout', summary: 'Deliver one update to already-connected readers and validate every complete local replica.', primaryMetrics: ['clients_5_all_converged_ms', 'clients_25_all_converged_ms'], notes: ['Distinct reader processes; live native delivery; no harness catch-up request after the write.'] },
  { id: 'replica-reopen', title: 'Persisted replica startup', summary: 'Open a clean persisted replica in a new process without network access, then validate the first screen and all 2,000 local tasks.', primaryMetrics: ['reopen_process_ms', 'reopen_first_screen_ms', 'reopen_all_rows_ms'], notes: ['OS file cache is not cleared; cold network bootstrap is a separate case.'] },
  ...(['conflict-update-update', 'conflict-update-delete'] as const).map(id => ({ id, title: id === 'conflict-update-update' ? 'Concurrent updates' : 'Concurrent update and delete', summary: 'Queue a stale edit, confirm the competing operation through a third client, then verify the declared conflict policy on all clients.', primaryMetrics: ['writer_settled_ms', 'all_clients_converged_ms'], notes: ['Different conflict policies remain separate comparison profiles.'] })),
  { id: 'offline-restart', title: 'Offline process recovery', summary: 'Kill the writer after 1,000 offline commits, reopen its product store while still disconnected, then verify complete replay on a second client.', primaryMetrics: ['queue_1000_reopen_local_ms', 'queue_1000_drain_ms', 'queue_1000_mirror_visible_ms'], notes: ['Requires an actual SIGKILL and persisted native queue; same-process executor recreation does not qualify.'] },
  {
    id: 'bootstrap',
    title: 'Initial startup',
    summary: 'Observe initialization, the first correct screen and full local data at 1k / 10k / 100k tasks under process-cold and warm server conditions.',
    primaryMetrics: ['startup_process_cold_100000_first_screen_ms', 'startup_process_cold_100000_full_data_ms', 'startup_warm_100000_first_screen_ms', 'startup_warm_100000_full_data_ms'],
    notes: ['Each case launches a new process and the declared product file or memory cache. Process-cold restarts only the sync service; server volumes and OS caches remain intact. Legacy adapters are ineligible until migrated.'],
  },
  {
    id: 'online-propagation',
    title: 'Online propagation',
    summary:
      'Measure how long a write from client A takes to become visible on client B.',
    primaryMetrics: [
      'local_commit_p50_ms',
      'server_accepted_p50_ms',
      'mirror_visible_p50_ms',
      'mirror_visible_p95_ms',
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
      'Block only the writer network, queue ten writes, then measure native queue drain and independent reader visibility.',
    primaryMetrics: [
      'queue_10_local_commit_ms',
      'queue_10_drain_ms',
      'queue_10_mirror_visible_ms',
    ],
    notes: [
      'Mark unsupported systems as unsupported rather than approximating a custom outbox.',
      'Shared-contract adapters validate all 2,000 records; legacy adapter outcomes remain ineligible for comparison.',
    ],
  },
  {
    id: 'reconnect-storm',
    title: 'Reconnect with backlog',
    summary: 'Restore all reader routes after 100 verified updates accumulate, and measure every client reaching the correct full replica.',
    primaryMetrics: ['clients_5_all_converged_ms', 'clients_25_all_converged_ms'],
    notes: ['Service stays healthy during the client outage. Per-reader stale data and blocked-route probes are required. Legacy adapters remain ineligible until migrated.'],
  },
  {
    id: 'large-offline-queue',
    title: 'Large offline queue',
    summary:
      'Replay much larger offline write queues than the base offline-replay scenario and measure throughput plus resource use.',
    primaryMetrics: [
      'queue_100_mirror_visible_ms',
      'queue_500_mirror_visible_ms',
      'queue_1000_mirror_visible_ms',
      'queue_1000_drain_ms',
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
    id: 'deep-relationship-query',
    title: 'Deep relationship query',
    summary:
      'Measure local multi-table relationship workloads after organizations, projects, and tasks are all materialized on the client.',
    primaryMetrics: [
      'dashboard_query_p50_ms',
      'dashboard_query_p95_ms',
      'detail_join_query_p50_ms',
      'detail_join_query_p95_ms',
    ],
    notes: [
      'This benchmark is only native when the client really holds the related tables locally.',
      'The baseline workload joins organizations -> projects -> tasks and measures a dashboard rollup plus a detail join query.',
    ],
  },
  {
    id: 'permission-change',
    title: 'Access revocation',
    summary: 'Verify exact removal of revoked data, preservation of authorized data, offline cache behavior and fresh-client authorization.',
    primaryMetrics: ['online_convergence_ms', 'offline_reconnect_convergence_ms'],
    notes: [
      'Online timing begins before the revoke request; offline recovery timing begins at route restoration after revocation.',
      'Native purge and application rebootstrap are different implementations and require explicit profiles.',
      'Checking row counts alone cannot establish correct removal or preservation. Missing adapter coverage does not imply a product lacks revocation.',
    ],
  },
  {
    id: 'blob-flow',
    title: 'Blob flow',
    summary:
      'Measure a real cross-client blob upload, metadata sync, and authenticated re-download through the product blob APIs.',
    primaryMetrics: ['initial_stage_commit_ms', 'initial_upload_ms', 'initial_server_accepted_ms', 'initial_metadata_visible_ms', 'fresh_download_ms', 'retry_server_accepted_ms', 'download_interruption_recovery_ms'],
    notes: [
      'Use the product’s real blob client and server routes instead of a benchmark-owned upload helper.',
      'Include upload completion, metadata visibility on a second client, and authenticated re-download readiness so media-heavy flows expose end-to-end cost.',
    ],
  },
];
