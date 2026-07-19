# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.
Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.
Experimental-lane stacks remain visible in scenario tables but are excluded from stable headline rankings.

## Highlights

- Bootstrap at 100k rows (median of the latest 1 runs where available): Electric is at 353.8 ms; Syncular is at 567.0 ms.
- Online propagation: Electric still leads on tail latency (10.61 ms p95), while Syncular is now at 24.18 ms p95 with 13.01 ms write ack.
- Native offline replay: Syncular currently converges in 34.80 ms; PowerSync is at 5115 ms.
- Permission change (median of the latest 1 runs where available): Syncular converges in 9.23 ms and Electric in 33.22 ms.
- Client bundle size: Syncular is currently 109.83 KB raw / 32.94 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 2097152 byte blob in 36.03 ms, syncs metadata to a second client in 36.03 ms, re-downloads it after cache clear in 7.31 ms, and recovers an interrupted queued upload in n/a.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k warm | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 48.75 ms | 91.47 ms | 567.0 ms | 132.1 ms | 3 | 79.66 MB | native |
| Syncular Rust Client | 264.5 ms | 99.46 ms | 1035 ms | 479.0 ms | 3 | 15.32 MB | native |
| Electric | 44.58 ms | 59.69 ms | 353.8 ms | n/a | 4 | 343.42 MB | native |
| Electric + TanStack DB | n/a | n/a | n/a | n/a | n/a | n/a | native |
| Zero | 218.5 ms | 936.3 ms | 7178 ms | n/a | 0 | 252.50 MB | native |
| PowerSync | 586.8 ms | 807.5 ms | 6486 ms | n/a | 1 | 214.86 MB | native |
| Turso Sync | n/a | n/a | n/a | n/a | n/a | n/a | native |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | n/a | n/a | native |
| Triplit | n/a | n/a | n/a | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 567.0 ms | 567.0 ms | 567.0 ms | 567.0 ms |
| Syncular Rust Client | 1 | 1035 ms | 1035 ms | 1035 ms | 1035 ms |
| Electric | 1 | 353.8 ms | 353.8 ms | 353.8 ms | 353.8 ms |
| Zero | 1 | 7178 ms | 7178 ms | 7178 ms | 7178 ms |
| PowerSync | 1 | 6486 ms | 6486 ms | 6486 ms | 6486 ms |

## Bootstrap Scale Study

| Stack | 250k rows | 500k rows | 500k avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | n/a | n/a | n/a | native |
| Syncular Rust Client | n/a | n/a | n/a | native |
| Electric | 826.0 ms | 1700 ms | 768.12 MB | native |
| Electric + TanStack DB | n/a | n/a | n/a | native |
| Zero | n/a | n/a | n/a | native |
| PowerSync | n/a | n/a | n/a | native |
| Turso Sync | n/a | n/a | n/a | native |
| Jazz v2 (experimental) | n/a | n/a | n/a | native |
| Triplit | n/a | n/a | n/a | native |

## Bootstrap Resource Summary

| Stack | Largest avg mem | Largest avg CPU | Largest peak mem | Largest peak CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 79.66 MB | 25.95% | 234.91 MB | 111.97% | native |
| Syncular Rust Client | 15.32 MB | 8.28% | 74.08 MB | 51.40% | native |
| Electric | 768.12 MB | 63.65% | 1109.05 MB | 163.10% | native |
| Electric + TanStack DB | n/a | n/a | n/a | n/a | native |
| Zero | 252.50 MB | 38.92% | 289.67 MB | 187.64% | native |
| PowerSync | 214.86 MB | 30.39% | 228.80 MB | 464.30% | native |
| Turso Sync | n/a | n/a | n/a | n/a | native |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | native |
| Triplit | n/a | n/a | n/a | n/a | native |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 13.01 ms | 13.42 ms | 24.18 ms | 286.13 MB | native |
| Syncular Rust Client | 90.63 ms | 46.79 ms | 243.8 ms | 11.73 MB | native |
| Electric | 2.52 ms | 2.95 ms | 10.61 ms | 1120.70 MB | native |
| Electric + TanStack DB | 5.61 ms | 10.19 ms | 12.83 ms | 138.19 MB | native |
| Zero | 17.62 ms | 16.95 ms | 48.51 ms | 189.58 MB | native |
| PowerSync | 1.05 ms | 1004 ms | 1064 ms | 214.20 MB | native |
| Turso Sync | 0.32 ms | 36.53 ms | 40.07 ms | 95.01 MB | native |
| Jazz v2 (experimental) | 0.28 ms | 11.81 ms | 51.30 ms | 159.29 MB | native |
| Triplit | 0.15 ms | 11.07 ms | 13.97 ms | 150.52 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 34.80 ms | 1 | 291.09 MB | native |
| Syncular Rust Client | 10 | 1212 ms | 2 | 5.36 MB | native |
| Electric | 10 | 289.6 ms | 5 | 1111.82 MB | emulated |
| Electric + TanStack DB | 10 | 1338 ms | 38 | 130.61 MB | native |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 10 | 5115 ms | 17 | 247.44 MB | native |
| Turso Sync | 10 | 326.4 ms | 7 | 75.88 MB | native |
| Jazz v2 (experimental) | 10 | 29.86 ms | n/a | 159.40 MB | native |
| Triplit | 10 | 56.46 ms | n/a | 147.14 MB | native |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | 500 clients | 1000 clients | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 54.50 ms | n/a | n/a | n/a | n/a | native |
| Syncular Rust Client | 112.5 ms | n/a | n/a | n/a | n/a | native |
| Electric | 239.4 ms | 2019 ms | 6055 ms | 8086 ms | n/a | native |
| Electric + TanStack DB | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Turso Sync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | n/a | unsupported |
| Triplit | n/a | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median | 500 median | 1000 median |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 5 | 54.50 ms | n/a | n/a | n/a | n/a |
| Syncular Rust Client | 1 | 112.5 ms | n/a | n/a | n/a | n/a |
| Electric | 1 | 239.4 ms | 2019 ms | 6055 ms | 8086 ms | n/a |

## Reconnect Storm Resource Summary

| Stack | 500 sync avg mem | 500 postgres avg mem | 500 sync avg CPU | 500 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | n/a | n/a | n/a | n/a | native |
| Syncular Rust Client | n/a | n/a | n/a | n/a | native |
| Electric | 299.17 MB | 180.58 MB | 2.51% | 0.54% | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 242.3 ms | 1109 ms | 2216 ms | 2 | native |
| Syncular Rust Client | 251.6 ms | 1334 ms | 2142 ms | 3 | native |
| Electric | n/a | n/a | n/a | n/a | emulated |
| Electric + TanStack DB | 1823 ms | 4504 ms | 8718 ms | 3008 | native |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 5461 ms | 6669 ms | 7153 ms | 1007 | native |
| Turso Sync | 350.4 ms | 298.0 ms | 300.0 ms | 7 | native |
| Jazz v2 (experimental) | 147.3 ms | 1636 ms | 6187 ms | n/a | native |
| Triplit | 24.50 ms | 108.8 ms | 200.4 ms | n/a | native |

## Large Offline Queue Repeat Summary

| Stack | Runs | 100 median | 500 median | 1000 median | Latest 1000 |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 242.3 ms | 1109 ms | 2216 ms | 2216 ms |
| Syncular Rust Client | 1 | 251.6 ms | 1334 ms | 2142 ms | 2142 ms |
| Electric + TanStack DB | 1 | 1823 ms | 4504 ms | 8718 ms | 8718 ms |
| PowerSync | 1 | 5461 ms | 6669 ms | 7153 ms | 7153 ms |
| Turso Sync | 1 | 350.4 ms | 298.0 ms | 300.0 ms | 300.0 ms |
| Jazz v2 (experimental) | 1 | 147.3 ms | 1636 ms | 6187 ms | 6187 ms |
| Triplit | 1 | 24.50 ms | 108.8 ms | 200.4 ms | 200.4 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.96 ms | 1.37 ms | 1.76 ms | 374.81 MB | native |
| Syncular Rust Client | 0.96 ms | 1.42 ms | 2.49 ms | 12.94 MB | native |
| Electric | 3.54 ms | 1.50 ms | 4.60 ms | 864.53 MB | native |
| Electric + TanStack DB | 0.71 ms | 0.91 ms | 415.9 ms | 335.50 MB | native |
| Zero | 2.57 ms | 2.03 ms | 5.04 ms | 264.25 MB | native |
| PowerSync | 41.49 ms | 11.97 ms | 103.7 ms | 260.51 MB | native |
| Turso Sync | 43.57 ms | 45.14 ms | 77.20 ms | 119.27 MB | native |
| Jazz v2 (experimental) | 847.9 ms | 837.6 ms | 1734 ms | 2477.34 MB | emulated |
| Triplit | 87.02 ms | 114.2 ms | 113.8 ms | 1107.48 MB | emulated |

## Deep Relationship Query

| Stack | Dashboard p50 | Detail join p50 | Avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 1.22 ms | 0.41 ms | 381.33 MB | native |
| Syncular Rust Client | 2.77 ms | 0.36 ms | n/a | native |
| Electric | n/a | n/a | n/a | unsupported |
| Electric + TanStack DB | 519.6 ms | 65.51 ms | 375.00 MB | native |
| Zero | 5.12 ms | 3.18 ms | 332.37 MB | native |
| PowerSync | 211.5 ms | 3.29 ms | 269.28 MB | native |
| Turso Sync | 98.73 ms | 14.16 ms | 132.62 MB | native |
| Jazz v2 (experimental) | n/a | n/a | n/a | unsupported |
| Triplit | 111.0 ms | n/a | 933.61 MB | native |

## Deep Relationship Repeat Summary

| Stack | Runs | Dashboard median | Detail median | Latest dashboard | Latest detail |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 1.22 ms | 0.41 ms | 1.22 ms | 0.41 ms |
| Syncular Rust Client | 1 | 2.77 ms | 0.36 ms | 2.77 ms | 0.36 ms |
| Electric + TanStack DB | 1 | 519.6 ms | 65.51 ms | 519.6 ms | 65.51 ms |
| Zero | 1 | 5.12 ms | 3.18 ms | 5.12 ms | 3.18 ms |
| PowerSync | 1 | 211.5 ms | 3.29 ms | 211.5 ms | 3.29 ms |
| Turso Sync | 1 | 98.73 ms | 14.16 ms | 98.73 ms | 14.16 ms |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Same-client | Rebootstrap | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1525 | 500 | 0 | 500 | 9.23 ms | 17.35 ms | native |
| Syncular Rust Client | 1525 | 500 | 0 | 500 | 28.78 ms | 21.69 ms | native |
| Electric | 1000 | 500 | 0 | 500 | n/a | 29.22 ms | native |
| Electric + TanStack DB | n/a | n/a | n/a | n/a | n/a | n/a | native |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Turso Sync | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Triplit | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Permission Change Repeat Summary

| Stack | Runs | Median | Min | Max | Latest |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 9.23 ms | 9.23 ms | 9.23 ms | 9.23 ms |
| Syncular Rust Client | 1 | 28.78 ms | 28.78 ms | 28.78 ms | 28.78 ms |
| Electric | 1 | 33.22 ms | 33.22 ms | 33.22 ms | 33.22 ms |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | SQLite upload overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 2097152 | 36.03 ms | 36.03 ms | 7.31 ms | n/a | n/a | n/a | native |
| Syncular Rust Client | 2097152 | 98.17 ms | 74.25 ms | 171.4 ms | n/a | n/a | n/a | native |
| Electric | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Electric + TanStack DB | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Turso Sync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Jazz v2 (experimental) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Triplit | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Blob Flow Repeat Summary

| Stack | Runs | Upload median | Metadata median | Latest retry recovery |
| --- | --- | --- | --- | --- |
| Syncular | 1 | 36.03 ms | 36.03 ms | n/a |
| Syncular Rust Client | 1 | 98.17 ms | 74.25 ms | n/a |

## Client Bundle Size

| Library | Profile | Raw | Gzip |
| --- | --- | --- | --- |
| Syncular | named import | 109.83 KB | 32.94 KB |
| Electric | named import | 52.77 KB | 16.79 KB |
| Zero | named import | 287.98 KB | 91.37 KB |
| PowerSync | named import | 532.98 KB | 165.65 KB |
| Electric + TanStack DB | named import | 208.61 KB | 60.55 KB |
| Jazz v2 (experimental) | named import | 294.88 KB | 84.84 KB |
| Triplit | named import | 234.28 KB | 70.97 KB |

## Notes

- `native` means the benchmark uses the product’s normal client model.
- Model difference, stated honestly: the CDC stacks (Electric, Zero, and PowerSync) observe an app-owned Postgres via WAL/CDC, so the bench admin writes plain SQL. Syncular v2 materializes real per-app Postgres tables but owns them — ingestion goes through the engine (push/storage API), never CDC — so its bench admin writes through the storage API and wakes clients via the engine’s Postgres LISTEN/NOTIFY fanout, while reads use plain SQL over the materialized columns.
- The two Syncular rows share one server stack and differ only in client core: `syncular` is the JS client on bun:sqlite; `syncular-rust` is the native Rust client (rusqlite) driven over real HTTP+WebSocket by a standalone bench binary. Both use the published packages, versions pinned (npm @syncular/*@0.15.18 for the JS client and server stack, crates.io syncular-client/syncular-command/syncular-ffi 0.15.18 for the native binary); scenario parameters (datasets, query shapes, blob sizes, iteration counts) are identical across the two rows.
- Syncular bootstrap is measured cold-server + cold-client: the sync service is restarted before every scale so in-memory segment/sqlite-image caches never serve the measurement. `100k warm` is a second fresh client bootstrapping the same dataset without a restart (populated caches); stacks without the metric show n/a.
- `emulated` means the scenario required benchmark-owned durability or auth behavior around the product.
- `unsupported` rows stay visible as `n/a` so the support matrix remains explicit without inventing benchmark-owned adapters.
- Repeat summaries use the latest successful runs for the current framework version per stack/scenario.
- Bootstrap repeat summary uses up to five successful 100k-row runs per current version when available.
- Reconnect storm repeat summary uses up to three successful runs per current version and reports tier medians for 25 / 100 / 250 / 500 clients when available.
- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.
