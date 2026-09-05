# Dependency upgrade benchmark comparison

Baseline: `2026-09-05T13-13-39-332Z`. Updated: `2026-09-05T14-23-55-232Z,2026-09-05T19-35-13-932Z`.

A complete matrix was attempted for each dependency set on the same machine; Turso was then rerun after correcting HTTP request metering. Scenario sizes are unchanged. These are individual measurements, not statistically established improvements or regressions. Negative latency deltas mean faster. Unsupported scenarios are excluded from latency comparisons.

Baseline: 47 completed, 6 failed, 19 unsupported. Updated, after harness corrections: 52 completed, 1 failed, 19 unsupported.

Follow-up: [Syncular performance investigation](SYNCULAR_PERFORMANCE_INVESTIGATION.md) isolates extra server work and checks the large-queue result with repeated runs.

The later [Syncular coverage run](SYNCULAR_COVERAGE.md) changes the server's
Postgres executor and corrects storm resource polling and HTTP metering. Its
numbers in `RESULTS.md` are a new benchmark configuration; they are not an
additional package-only before/after comparison with this table.

## Selected latencies

| Stack | 100k bootstrap, before → after | Online p95, before → after | Offline replay, before → after |
| --- | ---: | ---: | ---: |
| syncular | 671.53 ms → 744.48 ms | 12.00 ms → 15.78 ms | 60.05 ms → 91.80 ms |
| syncular-rust | 891.26 ms → 1019.94 ms | 18.96 ms → 17.46 ms | 62.24 ms → 54.39 ms |
| electric | 400.50 ms → 403.29 ms | 13.00 ms → 13.34 ms | 277.24 ms → 71.52 ms |
| electric-tanstack | 1275.30 ms → 4235.42 ms | 12.00 ms → 13.51 ms | 1399.91 ms → 1566.55 ms |
| zero | 9372.37 ms → 8241.80 ms | 55.95 ms → 47.90 ms | unsupported → unsupported |
| powersync | 10374.59 ms → 6823.75 ms | 1079.59 ms → 1099.42 ms | 5139.62 ms → 1047.89 ms |
| turso | failed → 164.85 ms | failed → 48.08 ms | failed → 617.77 ms |
| jazz-v2 | failed → failed | 1527.89 ms → 62.10 ms | 1002.62 ms → 48.82 ms |

Compare before/after within each row. Electric’s offline replay is emulated.

## Versions

| Package | Before | After |
| --- | --- | --- |
| @electric-sql/client | 1.5.18 | 1.5.27 |
| @syncular/client | 0.15.18 | 0.16.1 |
| @syncular/core | 0.15.18 | 0.16.1 |
| @tanstack/db | 0.6.16 | 0.8.7 |
| @tanstack/electric-db-collection | 0.3.14 | 0.4.7 |
| @tanstack/node-db-sqlite-persistence | 0.2.8 | 0.2.20 |
| @tanstack/offline-transactions | 1.0.41 | 1.0.53 |
| @tursodatabase/sync | 0.7.0 | 0.7.2 |
| @powersync/node | 0.18.6 | 1.0.0 |
| @powersync/web | 1.38.1 | 2.3.0 |
| @rocicorp/zero | 1.1.1 | 1.9.0 |
| better-sqlite3 | 12.6.2 | 13.0.3 |
| esbuild | 0.27.3 | 0.28.2 |
| fake-indexeddb | 6.2.5 | 6.2.5 |
| hono | 4.12.5 | 4.13.7 |
| jose | 6.2.0 | 6.2.12 |
| jazz-tools | 2.0.0-alpha.53 | 2.0.0-alpha.53 |
| kysely | 0.28.11 | 0.29.5 |
| postgres | 3.4.8 | 3.4.9 |

## Scenario outcomes

| Stack | Scenario | Before | After |
| --- | --- | --- | --- |
| jazz-v2 | blob-flow | unsupported | unsupported |
| jazz-v2 | online-propagation | completed | completed |
| jazz-v2 | large-offline-queue | completed | completed |
| jazz-v2 | reconnect-storm | unsupported | unsupported |
| jazz-v2 | permission-change | unsupported | unsupported |
| jazz-v2 | local-query | completed | completed |
| jazz-v2 | deep-relationship-query | unsupported | unsupported |
| jazz-v2 | offline-replay | completed | completed |
| jazz-v2 | bootstrap | failed | failed |
| powersync | blob-flow | unsupported | unsupported |
| powersync | online-propagation | completed | completed |
| powersync | large-offline-queue | completed | completed |
| powersync | reconnect-storm | unsupported | unsupported |
| powersync | permission-change | unsupported | unsupported |
| powersync | local-query | completed | completed |
| powersync | deep-relationship-query | completed | completed |
| powersync | offline-replay | completed | completed |
| powersync | bootstrap | completed | completed |
| electric | blob-flow | unsupported | unsupported |
| electric | online-propagation | completed | completed |
| electric | large-offline-queue | completed | completed |
| electric | reconnect-storm | failed | completed |
| electric | permission-change | completed | completed |
| electric | local-query | completed | completed |
| electric | deep-relationship-query | unsupported | unsupported |
| electric | offline-replay | completed | completed |
| electric | bootstrap | completed | completed |
| zero | blob-flow | unsupported | unsupported |
| zero | online-propagation | completed | completed |
| zero | large-offline-queue | unsupported | unsupported |
| zero | reconnect-storm | unsupported | unsupported |
| zero | permission-change | unsupported | unsupported |
| zero | local-query | completed | completed |
| zero | deep-relationship-query | completed | completed |
| zero | offline-replay | unsupported | unsupported |
| zero | bootstrap | completed | completed |
| syncular-rust | blob-flow | completed | completed |
| syncular-rust | online-propagation | completed | completed |
| syncular-rust | large-offline-queue | completed | completed |
| syncular-rust | reconnect-storm | completed | completed |
| syncular-rust | permission-change | completed | completed |
| syncular-rust | local-query | completed | completed |
| syncular-rust | deep-relationship-query | completed | completed |
| syncular-rust | offline-replay | completed | completed |
| syncular-rust | bootstrap | completed | completed |
| syncular | blob-flow | completed | completed |
| syncular | online-propagation | completed | completed |
| syncular | large-offline-queue | completed | completed |
| syncular | reconnect-storm | completed | completed |
| syncular | permission-change | completed | completed |
| syncular | local-query | completed | completed |
| syncular | deep-relationship-query | completed | completed |
| syncular | offline-replay | completed | completed |
| syncular | bootstrap | completed | completed |
| turso | blob-flow | unsupported | unsupported |
| turso | online-propagation | failed | completed |
| turso | large-offline-queue | failed | completed |
| turso | reconnect-storm | unsupported | unsupported |
| turso | permission-change | unsupported | unsupported |
| turso | local-query | completed | completed |
| turso | deep-relationship-query | completed | completed |
| turso | offline-replay | failed | completed |
| turso | bootstrap | failed | completed |
| electric-tanstack | blob-flow | unsupported | unsupported |
| electric-tanstack | online-propagation | completed | completed |
| electric-tanstack | large-offline-queue | completed | completed |
| electric-tanstack | reconnect-storm | unsupported | unsupported |
| electric-tanstack | permission-change | completed | completed |
| electric-tanstack | local-query | completed | completed |
| electric-tanstack | deep-relationship-query | completed | completed |
| electric-tanstack | offline-replay | completed | completed |
| electric-tanstack | bootstrap | completed | completed |

## Latency comparison

| Stack | Scenario | Metric | Before (ms) | After (ms) | Change |
| --- | --- | --- | ---: | ---: | ---: |
| jazz-v2 | online-propagation | write_ack_ms | 0.51 | 0.77 | +51.0% |
| jazz-v2 | online-propagation | mirror_visible_p50_ms | 911.52 | 23.29 | -97.4% |
| jazz-v2 | online-propagation | mirror_visible_p95_ms | 1527.89 | 62.10 | -95.9% |
| jazz-v2 | online-propagation | mirror_visible_p99_ms | 1527.89 | 62.10 | -95.9% |
| jazz-v2 | large-offline-queue | queue_100_convergence_ms | 1256.81 | 319.26 | -74.6% |
| jazz-v2 | large-offline-queue | queue_500_convergence_ms | 25034.83 | 2437.93 | -90.3% |
| jazz-v2 | large-offline-queue | queue_1000_convergence_ms | 12340.71 | 7670.88 | -37.8% |
| jazz-v2 | local-query | list_query_p50_ms | 918.23 | 845.21 | -8.0% |
| jazz-v2 | local-query | list_query_p95_ms | 1565.39 | 964.75 | -38.4% |
| jazz-v2 | local-query | search_query_p50_ms | 901.01 | 846.66 | -6.0% |
| jazz-v2 | local-query | search_query_p95_ms | 1257.54 | 1526.96 | +21.4% |
| jazz-v2 | local-query | aggregate_query_p50_ms | 1849.34 | 1732.20 | -6.3% |
| jazz-v2 | local-query | aggregate_query_p95_ms | 2185.92 | 1872.55 | -14.3% |
| jazz-v2 | offline-replay | replay_visible_ms | 1002.62 | 48.82 | -95.1% |
| powersync | online-propagation | write_ack_ms | 0.69 | 1.27 | +84.1% |
| powersync | online-propagation | mirror_visible_p50_ms | 993.43 | 1038.51 | +4.5% |
| powersync | online-propagation | mirror_visible_p95_ms | 1079.59 | 1099.42 | +1.8% |
| powersync | online-propagation | mirror_visible_p99_ms | 1079.59 | 1099.42 | +1.8% |
| powersync | large-offline-queue | queue_100_convergence_ms | 5463.01 | 6062.33 | +11.0% |
| powersync | large-offline-queue | queue_500_convergence_ms | 6672.90 | 2443.72 | -63.4% |
| powersync | large-offline-queue | queue_1000_convergence_ms | 9740.52 | 8345.86 | -14.3% |
| powersync | local-query | list_query_p50_ms | 43.39 | 38.97 | -10.2% |
| powersync | local-query | list_query_p95_ms | 52.26 | 42.18 | -19.3% |
| powersync | local-query | search_query_p50_ms | 12.61 | 10.91 | -13.5% |
| powersync | local-query | search_query_p95_ms | 30.52 | 11.45 | -62.5% |
| powersync | local-query | aggregate_query_p50_ms | 127.51 | 103.87 | -18.5% |
| powersync | local-query | aggregate_query_p95_ms | 142.99 | 138.12 | -3.4% |
| powersync | deep-relationship-query | dashboard_query_p50_ms | 226.39 | 241.35 | +6.6% |
| powersync | deep-relationship-query | dashboard_query_p95_ms | 277.68 | 277.13 | -0.2% |
| powersync | deep-relationship-query | detail_join_query_p50_ms | 3.63 | 3.25 | -10.5% |
| powersync | deep-relationship-query | detail_join_query_p95_ms | 3.77 | 3.55 | -5.8% |
| powersync | offline-replay | reconnect_convergence_ms | 5139.62 | 1047.89 | -79.6% |
| powersync | bootstrap | bootstrap_1000_ms | 5318.67 | 174.55 | -96.7% |
| powersync | bootstrap | bootstrap_10000_ms | 5718.66 | 757.59 | -86.8% |
| powersync | bootstrap | bootstrap_100000_ms | 10374.59 | 6823.75 | -34.2% |
| electric | online-propagation | write_ack_ms | 4.79 | 3.16 | -34.0% |
| electric | online-propagation | mirror_visible_p50_ms | 5.67 | 3.24 | -42.9% |
| electric | online-propagation | mirror_visible_p95_ms | 13.00 | 13.34 | +2.6% |
| electric | online-propagation | mirror_visible_p99_ms | 13.00 | 13.34 | +2.6% |
| electric | large-offline-queue | queue_20_convergence_ms | 59.75 | 93.92 | +57.2% |
| electric | permission-change | permission_revoke_convergence_ms | 19.53 | 12.41 | -36.5% |
| electric | permission-change | revoke_request_ms | 3.49 | 3.23 | -7.4% |
| electric | permission-change | rebootstrap_permission_visible_ms | 15.88 | 9.05 | -43.0% |
| electric | local-query | list_query_p50_ms | 3.55 | 2.63 | -25.9% |
| electric | local-query | list_query_p95_ms | 4.30 | 3.62 | -15.8% |
| electric | local-query | search_query_p50_ms | 2.02 | 1.30 | -35.6% |
| electric | local-query | search_query_p95_ms | 2.46 | 1.72 | -30.1% |
| electric | local-query | aggregate_query_p50_ms | 3.94 | 3.46 | -12.2% |
| electric | local-query | aggregate_query_p95_ms | 5.03 | 4.98 | -1.0% |
| electric | offline-replay | reconnect_convergence_ms | 277.24 | 71.52 | -74.2% |
| electric | bootstrap | bootstrap_1000_ms | 39.73 | 43.04 | +8.3% |
| electric | bootstrap | bootstrap_10000_ms | 65.26 | 70.53 | +8.1% |
| electric | bootstrap | bootstrap_100000_ms | 400.50 | 403.29 | +0.7% |
| electric | bootstrap | bootstrap_250000_ms | 950.79 | 909.76 | -4.3% |
| electric | bootstrap | bootstrap_500000_ms | 1917.78 | 2326.69 | +21.3% |
| zero | online-propagation | write_ack_ms | 25.63 | 20.01 | -21.9% |
| zero | online-propagation | mirror_visible_p50_ms | 44.70 | 20.34 | -54.5% |
| zero | online-propagation | mirror_visible_p95_ms | 55.95 | 47.90 | -14.4% |
| zero | online-propagation | mirror_visible_p99_ms | 55.95 | 47.90 | -14.4% |
| zero | local-query | list_query_p50_ms | 3.44 | 2.10 | -39.0% |
| zero | local-query | list_query_p95_ms | 4.61 | 2.77 | -39.9% |
| zero | local-query | search_query_p50_ms | 3.57 | 1.89 | -47.1% |
| zero | local-query | search_query_p95_ms | 4.82 | 2.79 | -42.1% |
| zero | local-query | aggregate_query_p50_ms | 5.93 | 4.04 | -31.9% |
| zero | local-query | aggregate_query_p95_ms | 8.78 | 7.56 | -13.9% |
| zero | deep-relationship-query | dashboard_query_p50_ms | 1.25 | 0.77 | -38.4% |
| zero | deep-relationship-query | dashboard_query_p95_ms | 3.86 | 2.60 | -32.6% |
| zero | deep-relationship-query | detail_join_query_p50_ms | 1.39 | 1.16 | -16.5% |
| zero | deep-relationship-query | detail_join_query_p95_ms | 2.32 | 2.35 | +1.3% |
| zero | bootstrap | bootstrap_1000_ms | 219.78 | 3935.68 | +1690.7% |
| zero | bootstrap | bootstrap_10000_ms | 1179.62 | 1367.11 | +15.9% |
| zero | bootstrap | bootstrap_100000_ms | 9372.37 | 8241.80 | -12.1% |
| syncular-rust | blob-flow | upload_complete_ms | 73.83 | 116.91 | +58.4% |
| syncular-rust | blob-flow | metadata_visible_ms | 46.46 | 83.91 | +80.6% |
| syncular-rust | blob-flow | download_after_metadata_ms | 82.95 | 96.45 | +16.3% |
| syncular-rust | online-propagation | write_ack_ms | 14.83 | 12.41 | -16.3% |
| syncular-rust | online-propagation | mirror_visible_p50_ms | 14.71 | 13.97 | -5.1% |
| syncular-rust | online-propagation | mirror_visible_p95_ms | 18.96 | 17.46 | -7.9% |
| syncular-rust | online-propagation | mirror_visible_p99_ms | 18.96 | 17.46 | -7.9% |
| syncular-rust | large-offline-queue | queue_100_convergence_ms | 309.73 | 269.36 | -13.0% |
| syncular-rust | large-offline-queue | queue_500_convergence_ms | 1205.12 | 1249.93 | +3.7% |
| syncular-rust | large-offline-queue | queue_1000_convergence_ms | 2349.96 | 2571.44 | +9.4% |
| syncular-rust | reconnect-storm | reconnect_convergence_ms | 53.20 | 95.31 | +79.2% |
| syncular-rust | reconnect-storm | clients_25_convergence_ms | 53.20 | 95.31 | +79.2% |
| syncular-rust | permission-change | permission_revoke_convergence_ms | 28.30 | 36.11 | +27.6% |
| syncular-rust | permission-change | same_client_permission_revoke_convergence_ms | 28.30 | 36.11 | +27.6% |
| syncular-rust | permission-change | revoke_request_ms | 7.15 | 8.18 | +14.4% |
| syncular-rust | permission-change | rebootstrap_permission_visible_ms | 26.28 | 39.48 | +50.2% |
| syncular-rust | local-query | list_query_p50_ms | 0.93 | 0.94 | +0.9% |
| syncular-rust | local-query | list_query_p95_ms | 1.03 | 1.31 | +27.6% |
| syncular-rust | local-query | search_query_p50_ms | 1.27 | 1.31 | +3.5% |
| syncular-rust | local-query | search_query_p95_ms | 1.32 | 2.50 | +89.3% |
| syncular-rust | local-query | aggregate_query_p50_ms | 1.91 | 2.02 | +5.9% |
| syncular-rust | local-query | aggregate_query_p95_ms | 1.98 | 3.80 | +91.7% |
| syncular-rust | deep-relationship-query | dashboard_query_p50_ms | 2.83 | 2.83 | 0.0% |
| syncular-rust | deep-relationship-query | dashboard_query_p95_ms | 2.98 | 3.09 | +3.7% |
| syncular-rust | deep-relationship-query | detail_join_query_p50_ms | 0.36 | 0.36 | +1.4% |
| syncular-rust | deep-relationship-query | detail_join_query_p95_ms | 0.39 | 0.44 | +11.2% |
| syncular-rust | offline-replay | reconnect_convergence_ms | 62.24 | 54.39 | -12.6% |
| syncular-rust | bootstrap | bootstrap_1000_ms | 135.23 | 819.25 | +505.8% |
| syncular-rust | bootstrap | bootstrap_warm_1000_ms | 32.41 | 72.68 | +124.3% |
| syncular-rust | bootstrap | bootstrap_10000_ms | 137.91 | 189.38 | +37.3% |
| syncular-rust | bootstrap | bootstrap_warm_10000_ms | 60.78 | 51.75 | -14.9% |
| syncular-rust | bootstrap | bootstrap_100000_ms | 891.26 | 1019.94 | +14.4% |
| syncular-rust | bootstrap | bootstrap_warm_100000_ms | 361.98 | 350.18 | -3.3% |
| syncular | blob-flow | upload_complete_ms | 76.70 | 73.76 | -3.8% |
| syncular | blob-flow | metadata_visible_ms | 76.70 | 73.77 | -3.8% |
| syncular | blob-flow | download_after_metadata_ms | 11.42 | 10.67 | -6.6% |
| syncular | online-propagation | write_ack_ms | 9.06 | 10.61 | +17.1% |
| syncular | online-propagation | mirror_visible_p50_ms | 9.60 | 10.12 | +5.4% |
| syncular | online-propagation | mirror_visible_p95_ms | 12.00 | 15.78 | +31.5% |
| syncular | online-propagation | mirror_visible_p99_ms | 12.00 | 15.78 | +31.5% |
| syncular | large-offline-queue | queue_100_convergence_ms | 375.33 | 365.48 | -2.6% |
| syncular | large-offline-queue | queue_500_convergence_ms | 1126.46 | 1533.61 | +36.1% |
| syncular | large-offline-queue | queue_1000_convergence_ms | 1922.94 | 3621.86 | +88.4% |
| syncular | reconnect-storm | reconnect_convergence_ms | 51.77 | 80.21 | +54.9% |
| syncular | reconnect-storm | clients_25_convergence_ms | 51.77 | 80.21 | +54.9% |
| syncular | permission-change | permission_revoke_convergence_ms | 15.34 | 15.84 | +3.3% |
| syncular | permission-change | same_client_permission_revoke_convergence_ms | 15.34 | 15.84 | +3.3% |
| syncular | permission-change | revoke_request_ms | 6.97 | 6.47 | -7.2% |
| syncular | permission-change | rebootstrap_permission_visible_ms | 21.59 | 34.21 | +58.5% |
| syncular | local-query | list_query_p50_ms | 1.06 | 1.01 | -4.7% |
| syncular | local-query | list_query_p95_ms | 1.38 | 1.17 | -15.2% |
| syncular | local-query | search_query_p50_ms | 1.53 | 1.43 | -6.5% |
| syncular | local-query | search_query_p95_ms | 1.99 | 1.67 | -16.1% |
| syncular | local-query | aggregate_query_p50_ms | 1.86 | 1.79 | -3.8% |
| syncular | local-query | aggregate_query_p95_ms | 2.45 | 2.01 | -18.0% |
| syncular | deep-relationship-query | dashboard_query_p50_ms | 1.37 | 1.39 | +1.5% |
| syncular | deep-relationship-query | dashboard_query_p95_ms | 1.48 | 1.46 | -1.4% |
| syncular | deep-relationship-query | detail_join_query_p50_ms | 0.41 | 0.42 | +2.4% |
| syncular | deep-relationship-query | detail_join_query_p95_ms | 0.48 | 0.47 | -2.1% |
| syncular | offline-replay | reconnect_convergence_ms | 60.05 | 91.80 | +52.9% |
| syncular | bootstrap | bootstrap_1000_ms | 89.26 | 105.22 | +17.9% |
| syncular | bootstrap | bootstrap_warm_1000_ms | 31.74 | 46.33 | +46.0% |
| syncular | bootstrap | bootstrap_10000_ms | 125.74 | 130.53 | +3.8% |
| syncular | bootstrap | bootstrap_warm_10000_ms | 29.29 | 33.13 | +13.1% |
| syncular | bootstrap | bootstrap_100000_ms | 671.53 | 744.48 | +10.9% |
| syncular | bootstrap | bootstrap_warm_100000_ms | 164.38 | 165.80 | +0.9% |
| turso | local-query | list_query_p50_ms | 49.06 | 40.62 | -17.2% |
| turso | local-query | list_query_p95_ms | 71.72 | 138.49 | +93.1% |
| turso | local-query | search_query_p50_ms | 50.81 | 41.66 | -18.0% |
| turso | local-query | search_query_p95_ms | 78.43 | 96.23 | +22.7% |
| turso | local-query | aggregate_query_p50_ms | 86.45 | 64.25 | -25.7% |
| turso | local-query | aggregate_query_p95_ms | 104.98 | 117.23 | +11.7% |
| turso | deep-relationship-query | dashboard_query_p50_ms | 127.88 | 105.80 | -17.3% |
| turso | deep-relationship-query | dashboard_query_p95_ms | 280.19 | 118.65 | -57.7% |
| turso | deep-relationship-query | detail_join_query_p50_ms | 17.21 | 14.96 | -13.1% |
| turso | deep-relationship-query | detail_join_query_p95_ms | 40.03 | 18.56 | -53.6% |
| electric-tanstack | online-propagation | write_ack_ms | 5.64 | 6.34 | +12.4% |
| electric-tanstack | online-propagation | mirror_visible_p50_ms | 10.29 | 11.19 | +8.7% |
| electric-tanstack | online-propagation | mirror_visible_p95_ms | 12.00 | 13.51 | +12.6% |
| electric-tanstack | online-propagation | mirror_visible_p99_ms | 12.00 | 13.51 | +12.6% |
| electric-tanstack | large-offline-queue | queue_100_convergence_ms | 1949.34 | 2105.21 | +8.0% |
| electric-tanstack | large-offline-queue | queue_500_convergence_ms | 5380.81 | 4857.62 | -9.7% |
| electric-tanstack | large-offline-queue | queue_1000_convergence_ms | 11915.21 | 10025.38 | -15.9% |
| electric-tanstack | permission-change | permission_revoke_convergence_ms | 85.32 | 9080.23 | +10542.6% |
| electric-tanstack | permission-change | same_client_permission_revoke_convergence_ms | 85.16 | 9079.98 | +10562.3% |
| electric-tanstack | permission-change | revoke_request_ms | 29.46 | 16.48 | -44.1% |
| electric-tanstack | permission-change | rebootstrap_permission_visible_ms | 29.34 | 59.59 | +103.1% |
| electric-tanstack | local-query | list_query_p50_ms | 0.65 | 0.72 | +10.8% |
| electric-tanstack | local-query | list_query_p95_ms | 1.78 | 88.93 | +4896.1% |
| electric-tanstack | local-query | search_query_p50_ms | 0.91 | 0.97 | +6.6% |
| electric-tanstack | local-query | search_query_p95_ms | 1.88 | 4.69 | +149.5% |
| electric-tanstack | local-query | aggregate_query_p50_ms | 425.78 | 384.48 | -9.7% |
| electric-tanstack | local-query | aggregate_query_p95_ms | 872.90 | 580.61 | -33.5% |
| electric-tanstack | deep-relationship-query | dashboard_query_p50_ms | 544.25 | 547.44 | +0.6% |
| electric-tanstack | deep-relationship-query | dashboard_query_p95_ms | 705.28 | 724.03 | +2.7% |
| electric-tanstack | deep-relationship-query | detail_join_query_p50_ms | 75.63 | 84.43 | +11.6% |
| electric-tanstack | deep-relationship-query | detail_join_query_p95_ms | 209.44 | 185.37 | -11.5% |
| electric-tanstack | offline-replay | reconnect_convergence_ms | 1399.91 | 1566.55 | +11.9% |
| electric-tanstack | bootstrap | bootstrap_1000_ms | 89.07 | 97.38 | +9.3% |
| electric-tanstack | bootstrap | bootstrap_10000_ms | 159.16 | 598.35 | +275.9% |
| electric-tanstack | bootstrap | bootstrap_100000_ms | 1275.30 | 4235.42 | +232.1% |
| electric-tanstack | bootstrap | bootstrap_250000_ms | 3196.91 | 10833.56 | +238.9% |
| electric-tanstack | bootstrap | bootstrap_500000_ms | 6794.24 | 22161.48 | +226.2% |

## Failures

- Baseline, jazz-v2/bootstrap: Jazz v2 runner failed for bootstrap  
- Baseline, electric/reconnect-storm: Electric shape request failed: 409 Conflict
- Baseline, turso/online-propagation: Turso runner failed for online-propagation  error: sync engine operation failed: database sync engine error: remote server returned an error: status=500, body=Internal Server Error: Failed to decode PullUpdatesRequest: failed to decode Protobuf message: PullUpdatesReqProtoBody.client_pages: invalid wire type: ThirtyTwoBit (expected LengthDelimited)  code: "GenericFailure"   Bun v1.4.0 (macOS arm64) 
- Baseline, turso/large-offline-queue: Turso runner failed for large-offline-queue  error: sync engine operation failed: database sync engine error: remote server returned an error: status=500, body=Internal Server Error: Failed to decode PullUpdatesRequest: failed to decode Protobuf message: PullUpdatesReqProtoBody.client_pages: invalid wire type: ThirtyTwoBit (expected LengthDelimited)  code: "GenericFailure"   Bun v1.4.0 (macOS arm64) 
- Baseline, turso/offline-replay: Turso runner failed for offline-replay  error: sync engine operation failed: database sync engine error: remote server returned an error: status=500, body=Internal Server Error: Failed to decode PullUpdatesRequest: failed to decode Protobuf message: PullUpdatesReqProtoBody.client_pages: invalid wire type: ThirtyTwoBit (expected LengthDelimited)  code: "GenericFailure"   Bun v1.4.0 (macOS arm64) 
- Baseline, turso/bootstrap: Turso runner failed for bootstrap  error: sync engine operation failed: database sync engine error: remote server returned an error: status=500, body=Internal Server Error: Failed to decode PullUpdatesRequest: failed to decode Protobuf message: PullUpdatesReqProtoBody.client_pages: invalid wire type: EndGroup (expected LengthDelimited)  code: "GenericFailure"   Bun v1.4.0 (macOS arm64) 
- Updated, jazz-v2/bootstrap: Jazz v2 runner failed for bootstrap  

## Browser bundle comparison

Named-import profiles. Both library versions and the esbuild version changed.

| Client | Before gzip (KB) | After gzip (KB) | Change |
| --- | ---: | ---: | ---: |
| Syncular Client | 32.54 | 34.43 | 5.8% |
| Electric Client | 16.63 | 17.44 | 4.9% |
| Zero | 89.97 | 94.94 | 5.5% |
| PowerSync Web | 160.79 | 160.49 | -0.2% |
| Electric + TanStack DB | 59.86 | 68.42 | 14.3% |
| Jazz v2 (experimental) | 83.78 | 83.07 | -0.8% |

## Run details and interpretation

- Triplit was removed at the user’s request during its baseline bootstrap. It is excluded from both compared matrices; its incomplete attempt is not counted as a product failure.
- Each compared matrix has eight stack variants and nine scenario slots per variant. The two Syncular rows use the same server and different client cores.
- The baseline used installed packages and existing Docker build definitions. Zero’s unpinned server build resolved to 1.9.0 while its host client was 1.1.1. Electric and PowerSync used their existing floating image references. Baseline container image IDs are saved in `.results/upgrade-2026-09-05/baseline-images.json`.
- Updated servers: Syncular npm and Rust 0.16.1, Zero 1.9.0, Electric 1.8.0, PowerSync 1.25.0, and Turso 0.7.2. Jazz stays on 2.0.0-alpha.53, its latest v2 alpha; its npm `latest` tag points to the older v0 product line.
- Compatibility changes: regenerate Syncular schema bindings and create its migration lockfile; import the SQLite image builder from `@syncular/server/sqlite`; use `statusSnapshot().syncNeeded` through the Rust command adapter; remove TypeScript’s retired `baseUrl` option; remove redundant PowerSync implicit-id declarations and enable chunk-wise HTTP metering for its new long-lived response transport. Scenario datasets, iterations, timeouts, and measurement boundaries remain unchanged.
- Jazz baseline bootstrap reached the existing 30-minute child-process timeout while working through the extended scale sweep. The original harness emitted only a generic runner failure; no completed bootstrap metric was saved.
- Turso’s updated sync failures were traced to a harness/server interaction: cloning the Bun Request changed fixed-length binary uploads into chunked requests, and the server parsed the chunk framing as Protobuf. Direct pulls succeeded; fixed-length metered pulls succeeded too. The final Turso results come from a separate rerun after that correction. The baseline showed similar decoding failures, but was not rerun with the corrected meter; there is no valid baseline sync latency for those scenarios.
- The first updated PowerSync bootstrap was interrupted after diagnosing a metering deadlock: the new long-lived HTTP stream could never finish the meter’s awaited response clone. Its scenarios were restarted after enabling streaming metering. HTTP byte counts now include its streaming response payloads and should not be treated as the same coverage as the older SDK transport.
- A single before/after run cannot establish a reliable performance trend. OS scheduling, caching, background load, and dependency changes can all affect the measurements.

## Artifacts

- [Baseline summary](./.results/2026-09-05T13-13-39-332Z/SUMMARY.md)
- [Updated summary: 2026-09-05T14-23-55-232Z](./.results/2026-09-05T14-23-55-232Z/SUMMARY.md)
- [Updated summary: 2026-09-05T19-35-13-932Z](./.results/2026-09-05T19-35-13-932Z/SUMMARY.md)
- [Normalized latency comparisons](./.results/upgrade-2026-09-05/comparison.json)
- [Baseline log](./.results/upgrade-2026-09-05/baseline.log)
- [Updated log](./.results/upgrade-2026-09-05/updated.log)
- [Published package versions queried before the upgrade](./.results/upgrade-2026-09-05/registry-versions.json)
