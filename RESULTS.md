# Benchmark Results

This report uses only runs `2026-09-05T14-23-55-232Z`, `2026-09-05T19-35-13-932Z`. The latest attempt per stack/scenario determines its outcome. Failed measurements remain unavailable; older successes are not substituted. See [the dependency upgrade comparison](./UPGRADE_COMPARISON.md) for the before/after results.
These are individual scenario measurements on one machine, not statistically established performance rankings.
Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.
Experimental-lane stacks remain visible in scenario tables but are excluded from stable headline rankings.

## Run outcomes

52 completed, 1 failed, 19 unsupported.

- Jazz v2 (experimental) / bootstrap: Jazz v2 runner failed for bootstrap  ([raw result](./.results/2026-09-05T14-23-55-232Z/jazz-v2/bootstrap.json))

## Highlights

- Bootstrap at 100k rows (median of the latest 1 runs where available): Electric is at 403.3 ms; Syncular is at 744.5 ms.
- Online propagation: Electric is at 13.34 ms p95; Syncular is at 15.78 ms p95 with 10.61 ms write ack.
- Native offline replay: Syncular currently converges in 91.80 ms; PowerSync is at 1048 ms.
- Permission change (median of the latest 1 runs where available): Syncular converges in 15.84 ms and Electric in 12.41 ms.
- Client bundle size: Syncular is currently 116.45 KB raw / 34.43 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 2097152 byte blob in 73.76 ms, syncs metadata to a second client in 73.77 ms, re-downloads it after cache clear in 10.67 ms, and recovers an interrupted queued upload in n/a.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k warm | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 105.2 ms | 130.5 ms | 744.5 ms | 165.8 ms | 4 | 90.69 MB | native |
| Syncular Rust Client | 819.3 ms | 189.4 ms | 1020 ms | 350.2 ms | 4 | 23.22 MB | native |
| Electric | 43.04 ms | 70.53 ms | 403.3 ms | n/a | 4 | 142.55 MB | native |
| Electric + TanStack DB | 97.38 ms | 598.4 ms | 4235 ms | n/a | 6 | 391.58 MB | native |
| Zero | 3936 ms | 1367 ms | 8242 ms | n/a | 0 | 417.80 MB | native |
| PowerSync | 174.6 ms | 757.6 ms | 6824 ms | n/a | 2 | 231.90 MB | native |
| Turso Sync | 1248 ms | 180.1 ms | 164.8 ms | n/a | 2 | 118.94 MB | native |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 744.5 ms | 744.5 ms | 744.5 ms | 744.5 ms |
| Syncular Rust Client | 1 | 1020 ms | 1020 ms | 1020 ms | 1020 ms |
| Electric | 1 | 403.3 ms | 403.3 ms | 403.3 ms | 403.3 ms |
| Electric + TanStack DB | 1 | 4235 ms | 4235 ms | 4235 ms | 4235 ms |
| Zero | 1 | 8242 ms | 8242 ms | 8242 ms | 8242 ms |
| PowerSync | 1 | 6824 ms | 6824 ms | 6824 ms | 6824 ms |
| Turso Sync | 1 | 164.8 ms | 164.8 ms | 164.8 ms | 164.8 ms |

## Bootstrap Scale Study

| Stack | 250k rows | 500k rows | 500k avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | n/a | n/a | n/a | native |
| Syncular Rust Client | n/a | n/a | n/a | native |
| Electric | 909.8 ms | 2327 ms | 316.07 MB | native |
| Electric + TanStack DB | 10834 ms | 22161 ms | 3503.36 MB | native |
| Zero | n/a | n/a | n/a | native |
| PowerSync | n/a | n/a | n/a | native |
| Turso Sync | 330.0 ms | 710.9 ms | 111.99 MB | native |
| Jazz v2 (experimental) | n/a | n/a | n/a | native |

## Bootstrap Resource Summary

| Stack | Largest avg mem | Largest avg CPU | Largest peak mem | Largest peak CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 90.69 MB | 22.96% | 188.69 MB | 93.07% | native |
| Syncular Rust Client | 23.22 MB | 11.97% | 79.13 MB | 57.40% | native |
| Electric | 316.07 MB | 35.20% | 519.78 MB | 100.44% | native |
| Electric + TanStack DB | 3503.36 MB | 125.11% | 3594.73 MB | 308.42% | native |
| Zero | 417.80 MB | 21.92% | 431.45 MB | 124.37% | native |
| PowerSync | 231.90 MB | 30.00% | 243.59 MB | 503.76% | native |
| Turso Sync | 111.99 MB | 41.28% | 298.23 MB | 124.51% | native |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | native |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10.61 ms | 10.12 ms | 15.78 ms | 184.69 MB | native |
| Syncular Rust Client | 12.41 ms | 13.97 ms | 17.46 ms | 14.04 MB | native |
| Electric | 3.16 ms | 3.24 ms | 13.34 ms | 520.42 MB | native |
| Electric + TanStack DB | 6.34 ms | 11.19 ms | 13.51 ms | 140.78 MB | native |
| Zero | 20.01 ms | 20.34 ms | 47.90 ms | 71.61 MB | native |
| PowerSync | 1.27 ms | 1039 ms | 1099 ms | 304.75 MB | native |
| Turso Sync | 0.38 ms | 38.16 ms | 48.08 ms | 316.90 MB | native |
| Jazz v2 (experimental) | 0.77 ms | 23.29 ms | 62.10 ms | 156.90 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 91.80 ms | 1 | 192.35 MB | native |
| Syncular Rust Client | 10 | 54.39 ms | 2 | 6.99 MB | native |
| Electric | 10 | 71.52 ms | 2 | 521.33 MB | emulated |
| Electric + TanStack DB | 10 | 1567 ms | 40 | 134.74 MB | native |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 10 | 1048 ms | 18 | 238.42 MB | native |
| Turso Sync | 10 | 617.8 ms | 7 | 128.38 MB | native |
| Jazz v2 (experimental) | 10 | 48.82 ms | n/a | 159.88 MB | native |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | 500 clients | 1000 clients | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 80.21 ms | n/a | n/a | n/a | n/a | native |
| Syncular Rust Client | 95.31 ms | n/a | n/a | n/a | n/a | native |
| Electric | 43.25 ms | 249.2 ms | 6043 ms | 2013 ms | n/a | native |
| Electric + TanStack DB | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Turso Sync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median | 500 median | 1000 median |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 80.21 ms | n/a | n/a | n/a | n/a |
| Syncular Rust Client | 1 | 95.31 ms | n/a | n/a | n/a | n/a |
| Electric | 1 | 43.25 ms | 249.2 ms | 6043 ms | 2013 ms | n/a |

## Reconnect Storm Resource Summary

| Stack | 500 sync avg mem | 500 postgres avg mem | 500 sync avg CPU | 500 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | n/a | n/a | n/a | n/a | native |
| Syncular Rust Client | n/a | n/a | n/a | n/a | native |
| Electric | 297.90 MB | 184.70 MB | 4.69% | 0.09% | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 365.5 ms | 1534 ms | 3622 ms | 2 | native |
| Syncular Rust Client | 269.4 ms | 1250 ms | 2571 ms | 3 | native |
| Electric | n/a | n/a | n/a | n/a | emulated |
| Electric + TanStack DB | 2105 ms | 4858 ms | 10025 ms | 3010 | native |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 6062 ms | 2444 ms | 8346 ms | 1009 | native |
| Turso Sync | 664.7 ms | 660.6 ms | 791.9 ms | 7 | native |
| Jazz v2 (experimental) | 319.3 ms | 2438 ms | 7671 ms | n/a | native |

## Large Offline Queue Repeat Summary

| Stack | Runs | 100 median | 500 median | 1000 median | Latest 1000 |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 365.5 ms | 1534 ms | 3622 ms | 3622 ms |
| Syncular Rust Client | 1 | 269.4 ms | 1250 ms | 2571 ms | 2571 ms |
| Electric + TanStack DB | 1 | 2105 ms | 4858 ms | 10025 ms | 10025 ms |
| PowerSync | 1 | 6062 ms | 2444 ms | 8346 ms | 8346 ms |
| Turso Sync | 1 | 664.7 ms | 660.6 ms | 791.9 ms | 791.9 ms |
| Jazz v2 (experimental) | 1 | 319.3 ms | 2438 ms | 7671 ms | 7671 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1.01 ms | 1.43 ms | 1.79 ms | 201.01 MB | native |
| Syncular Rust Client | 0.94 ms | 1.31 ms | 2.02 ms | 16.48 MB | native |
| Electric | 2.63 ms | 1.30 ms | 3.46 ms | 309.45 MB | native |
| Electric + TanStack DB | 0.72 ms | 0.97 ms | 384.5 ms | 447.13 MB | native |
| Zero | 2.10 ms | 1.89 ms | 4.04 ms | 176.96 MB | native |
| PowerSync | 38.97 ms | 10.91 ms | 103.9 ms | 330.23 MB | native |
| Turso Sync | 40.62 ms | 41.66 ms | 64.25 ms | 144.11 MB | native |
| Jazz v2 (experimental) | 845.2 ms | 846.7 ms | 1732 ms | 2725.07 MB | emulated |

## Deep Relationship Query

| Stack | Dashboard p50 | Detail join p50 | Avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 1.39 ms | 0.42 ms | 202.91 MB | native |
| Syncular Rust Client | 2.83 ms | 0.36 ms | n/a | native |
| Electric | n/a | n/a | n/a | unsupported |
| Electric + TanStack DB | 547.4 ms | 84.43 ms | 464.54 MB | native |
| Zero | 0.77 ms | 1.16 ms | 159.47 MB | native |
| PowerSync | 241.3 ms | 3.25 ms | 403.32 MB | native |
| Turso Sync | 105.8 ms | 14.96 ms | 164.24 MB | native |
| Jazz v2 (experimental) | n/a | n/a | n/a | unsupported |

## Deep Relationship Repeat Summary

| Stack | Runs | Dashboard median | Detail median | Latest dashboard | Latest detail |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 1.39 ms | 0.42 ms | 1.39 ms | 0.42 ms |
| Syncular Rust Client | 1 | 2.83 ms | 0.36 ms | 2.83 ms | 0.36 ms |
| Electric + TanStack DB | 1 | 547.4 ms | 84.43 ms | 547.4 ms | 84.43 ms |
| Zero | 1 | 0.77 ms | 1.16 ms | 0.77 ms | 1.16 ms |
| PowerSync | 1 | 241.3 ms | 3.25 ms | 241.3 ms | 3.25 ms |
| Turso Sync | 2 | 111.4 ms | 15.50 ms | 105.8 ms | 14.96 ms |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Same-client | Rebootstrap | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1000 | 500 | 0 | 500 | 15.84 ms | 34.21 ms | native |
| Syncular Rust Client | 1000 | 500 | 0 | 500 | 36.11 ms | 39.48 ms | native |
| Electric | 1000 | 500 | 0 | 500 | n/a | 9.05 ms | native |
| Electric + TanStack DB | 1000 | 500 | 0 | 500 | 9080 ms | 59.59 ms | native |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Turso Sync | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Permission Change Repeat Summary

| Stack | Runs | Median | Min | Max | Latest |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 15.84 ms | 15.84 ms | 15.84 ms | 15.84 ms |
| Syncular Rust Client | 1 | 36.11 ms | 36.11 ms | 36.11 ms | 36.11 ms |
| Electric | 1 | 12.41 ms | 12.41 ms | 12.41 ms | 12.41 ms |
| Electric + TanStack DB | 1 | 9080 ms | 9080 ms | 9080 ms | 9080 ms |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | SQLite upload overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 2097152 | 73.76 ms | 73.77 ms | 10.67 ms | n/a | n/a | n/a | native |
| Syncular Rust Client | 2097152 | 116.9 ms | 83.91 ms | 96.45 ms | n/a | n/a | n/a | native |
| Electric | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Electric + TanStack DB | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Turso Sync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Blob Flow Repeat Summary

| Stack | Runs | Upload median | Metadata median | Latest retry recovery |
| --- | --- | --- | --- | --- |
| Syncular | 1 | 73.76 ms | 73.77 ms | n/a |
| Syncular Rust Client | 1 | 116.9 ms | 83.91 ms | n/a |

## Client Bundle Size

| Library | Profile | Raw | Gzip |
| --- | --- | --- | --- |
| Syncular | named import | 116.45 KB | 34.43 KB |
| Electric | named import | 55.54 KB | 17.44 KB |
| Zero | named import | 303.02 KB | 94.94 KB |
| PowerSync | named import | 525.43 KB | 160.49 KB |
| Electric + TanStack DB | named import | 240.23 KB | 68.42 KB |
| Jazz v2 (experimental) | named import | 290.05 KB | 83.07 KB |

## Notes

- `native` means the benchmark uses the product’s normal client model.
- Model difference, stated honestly: the CDC stacks (Electric, Zero, and PowerSync) observe an app-owned Postgres via WAL/CDC, so the bench admin writes plain SQL. Syncular v2 materializes real per-app Postgres tables but owns them — ingestion goes through the engine (push/storage API), never CDC — so its bench admin writes through the storage API and wakes clients via the engine’s Postgres LISTEN/NOTIFY fanout, while reads use plain SQL over the materialized columns.
- The two Syncular rows share one server stack and differ only in client core: `syncular` is the JS client on bun:sqlite; `syncular-rust` is the native Rust client (rusqlite) driven over real HTTP+WebSocket by a standalone bench binary. Both use the published packages, versions pinned (npm @syncular/*@0.16.1 for the JS client and server stack, crates.io syncular-client/syncular-command/syncular-ffi 0.16.1 for the native binary); scenario parameters (datasets, query shapes, blob sizes, iteration counts) are identical across the two rows.
- Syncular bootstrap is measured cold-server + cold-client: the sync service is restarted before every scale so in-memory segment/sqlite-image caches never serve the measurement. `100k warm` is a second fresh client bootstrapping the same dataset without a restart (populated caches); stacks without the metric show n/a.
- `emulated` means the scenario required benchmark-owned durability or auth behavior around the product.
- `unsupported` rows stay visible as `n/a` so the support matrix remains explicit without inventing benchmark-owned adapters.
- Repeat summaries use the latest successful runs for the current framework version per stack/scenario.
- Bootstrap repeat summary uses up to five successful 100k-row runs per current version when available.
- Reconnect storm repeat summary uses up to three successful runs per current version and reports tier medians for 25 / 100 / 250 / 500 clients when available.
- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.
