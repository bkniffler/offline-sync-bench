# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.
Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.

## Highlights

- Bootstrap at 100k rows (median of the latest 1 runs where available): Electric is at 353.8 ms; Syncular is at 4874 ms; Replicache is at 877.6 ms.
- Online propagation: Electric still leads on tail latency (10.61 ms p95), while Syncular is now at 18.74 ms p95 with 8.90 ms write ack.
- Native offline replay: Syncular currently converges in 62.11 ms, ahead of Replicache (1378 ms) and PowerSync (5115 ms).
- Permission change (median of the latest 1 runs where available): Syncular converges in 6.82 ms and Electric in 33.22 ms.
- Client bundle size: Syncular is currently 75.14 KB raw / 22.79 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 2097152 byte blob in 68.85 ms, syncs metadata to a second client in 68.85 ms, re-downloads it after cache clear in 9.41 ms, and recovers an interrupted queued upload in n/a.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 144.9 ms | 322.2 ms | 4874 ms | 3 | 106.74 MB | native |
| Syncular Rust Client | 114.1 ms | 499.7 ms | 5362 ms | 3 | 8.56 MB | native |
| Electric | 44.58 ms | 59.69 ms | 353.8 ms | 4 | 343.42 MB | native |
| Zero | 218.5 ms | 936.3 ms | 7178 ms | 0 | 252.50 MB | native |
| PowerSync | 586.8 ms | 807.5 ms | 6486 ms | 1 | 214.86 MB | native |
| Replicache | 57.68 ms | 126.8 ms | 877.6 ms | 2 | 284.42 MB | native |
| LiveStore | 786.0 ms | 1883 ms | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 4874 ms | 4874 ms | 4874 ms | 4874 ms |
| Syncular Rust Client | 1 | 5362 ms | 5362 ms | 5362 ms | 5362 ms |
| Electric | 1 | 353.8 ms | 353.8 ms | 353.8 ms | 353.8 ms |
| Zero | 1 | 7178 ms | 7178 ms | 7178 ms | 7178 ms |
| PowerSync | 1 | 6486 ms | 6486 ms | 6486 ms | 6486 ms |
| Replicache | 1 | 877.6 ms | 877.6 ms | 877.6 ms | 877.6 ms |

## Bootstrap Scale Study

| Stack | 250k rows | 500k rows | 500k avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | n/a | n/a | n/a | native |
| Syncular Rust Client | n/a | n/a | n/a | native |
| Electric | 826.0 ms | 1700 ms | 768.12 MB | native |
| Zero | n/a | n/a | n/a | native |
| PowerSync | n/a | n/a | n/a | native |
| Replicache | 2263 ms | 4843 ms | 1607.30 MB | native |
| LiveStore | n/a | n/a | n/a | native |

## Bootstrap Resource Summary

| Stack | Largest avg mem | Largest avg CPU | Largest peak mem | Largest peak CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 106.74 MB | 3.42% | 252.06 MB | 90.35% | native |
| Syncular Rust Client | 8.56 MB | 5.18% | 73.34 MB | 81.60% | native |
| Electric | 768.12 MB | 63.65% | 1109.05 MB | 163.10% | native |
| Zero | 252.50 MB | 38.92% | 289.67 MB | 187.64% | native |
| PowerSync | 214.86 MB | 30.39% | 228.80 MB | 464.30% | native |
| Replicache | 1607.30 MB | 90.69% | 2400.61 MB | 110.01% | native |
| LiveStore | n/a | n/a | n/a | n/a | native |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 8.90 ms | 8.18 ms | 18.74 ms | 331.03 MB | native |
| Syncular Rust Client | 12.16 ms | 12.60 ms | 26.28 ms | 10.86 MB | native |
| Electric | 2.52 ms | 2.95 ms | 10.61 ms | 1120.70 MB | native |
| Zero | 17.62 ms | 16.95 ms | 48.51 ms | 189.58 MB | native |
| PowerSync | 1.05 ms | 1004 ms | 1064 ms | 214.20 MB | native |
| Replicache | 0.27 ms | 30.94 ms | 41.40 ms | 172.51 MB | native |
| LiveStore | 2.38 ms | 700.0 ms | 1671 ms | 540.40 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 62.11 ms | 1 | 334.18 MB | native |
| Syncular Rust Client | 10 | 64.27 ms | 2 | 5.53 MB | native |
| Electric | 10 | 289.6 ms | 5 | 1111.82 MB | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 10 | 5115 ms | 17 | 247.44 MB | native |
| Replicache | 10 | 1378 ms | 18 | 162.34 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | 500 clients | 1000 clients | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 77.94 ms | n/a | n/a | n/a | n/a | native |
| Syncular Rust Client | 78.15 ms | n/a | n/a | n/a | n/a | native |
| Electric | 239.4 ms | 2019 ms | 6055 ms | 8086 ms | n/a | native |
| Zero | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 63.97 ms | 2027 ms | 6082 ms | 2120 ms | n/a | native |
| LiveStore | n/a | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median | 500 median | 1000 median |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 77.94 ms | n/a | n/a | n/a | n/a |
| Syncular Rust Client | 1 | 78.15 ms | n/a | n/a | n/a | n/a |
| Electric | 1 | 239.4 ms | 2019 ms | 6055 ms | 8086 ms | n/a |
| Replicache | 1 | 63.97 ms | 2027 ms | 6082 ms | 2120 ms | n/a |

## Reconnect Storm Resource Summary

| Stack | 500 sync avg mem | 500 postgres avg mem | 500 sync avg CPU | 500 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | n/a | n/a | 2.30% | 0.53% | native |
| Syncular Rust Client | 92.19 MB | 173.90 MB | 1.30% | 0.08% | native |
| Electric | 299.17 MB | 180.58 MB | 2.51% | 0.54% | native |
| Replicache | 40.36 MB | 154.30 MB | 3.18% | 2.30% | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 305.1 ms | 1593 ms | 3007 ms | 2 | native |
| Syncular Rust Client | 443.2 ms | 1859 ms | 2522 ms | 3 | native |
| Electric | n/a | n/a | n/a | n/a | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 5461 ms | 6669 ms | 7153 ms | 1007 | native |
| Replicache | 1310 ms | 1451 ms | 1594 ms | 16 | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Large Offline Queue Repeat Summary

| Stack | Runs | 100 median | 500 median | 1000 median | Latest 1000 |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 305.1 ms | 1593 ms | 3007 ms | 3007 ms |
| Syncular Rust Client | 1 | 443.2 ms | 1859 ms | 2522 ms | 2522 ms |
| PowerSync | 1 | 5461 ms | 6669 ms | 7153 ms | 7153 ms |
| Replicache | 1 | 1310 ms | 1451 ms | 1594 ms | 1594 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1.15 ms | 0.03 ms | 1.22 ms | 195.79 MB | native |
| Syncular Rust Client | 1.06 ms | 0.02 ms | 2.03 ms | 12.66 MB | native |
| Electric | 3.54 ms | 1.50 ms | 4.60 ms | 864.53 MB | native |
| Zero | 2.57 ms | 2.03 ms | 5.04 ms | 264.25 MB | native |
| PowerSync | 41.49 ms | 11.97 ms | 103.7 ms | 260.51 MB | native |
| Replicache | 9.29 ms | 1.71 ms | 4.79 ms | 175.29 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Deep Relationship Query

| Stack | Dashboard p50 | Detail join p50 | Avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 2.30 ms | 1.07 ms | 188.52 MB | native |
| Syncular Rust Client | 2.77 ms | 0.37 ms | n/a | native |
| Electric | n/a | n/a | n/a | unsupported |
| Zero | 5.12 ms | 3.18 ms | 332.37 MB | native |
| PowerSync | 211.5 ms | 3.29 ms | 269.28 MB | native |
| Replicache | 3.19 ms | 1.76 ms | 192.78 MB | native |
| LiveStore | n/a | n/a | n/a | unsupported |

## Deep Relationship Repeat Summary

| Stack | Runs | Dashboard median | Detail median | Latest dashboard | Latest detail |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 2.30 ms | 1.07 ms | 2.30 ms | 1.07 ms |
| Syncular Rust Client | 1 | 2.77 ms | 0.37 ms | 2.77 ms | 0.37 ms |
| Zero | 1 | 5.12 ms | 3.18 ms | 5.12 ms | 3.18 ms |
| PowerSync | 1 | 211.5 ms | 3.29 ms | 211.5 ms | 3.29 ms |
| Replicache | 1 | 3.19 ms | 1.76 ms | 3.19 ms | 1.76 ms |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Same-client | Rebootstrap | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1525 | 500 | 0 | 500 | 6.82 ms | 65.77 ms | native |
| Syncular Rust Client | 1525 | 500 | 0 | 500 | 21.08 ms | 84.16 ms | native |
| Electric | 1000 | 500 | 0 | 500 | n/a | 29.22 ms | native |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 1000 | 1000 | 500 | 500 | n/a | 19.69 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Permission Change Repeat Summary

| Stack | Runs | Median | Min | Max | Latest |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 6.82 ms | 6.82 ms | 6.82 ms | 6.82 ms |
| Syncular Rust Client | 1 | 21.08 ms | 21.08 ms | 21.08 ms | 21.08 ms |
| Electric | 1 | 33.22 ms | 33.22 ms | 33.22 ms | 33.22 ms |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | SQLite upload overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 2097152 | 68.85 ms | 68.85 ms | 9.41 ms | n/a | n/a | n/a | native |
| Syncular Rust Client | 2097152 | 101.3 ms | 65.59 ms | 90.47 ms | n/a | n/a | n/a | native |
| Electric | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| LiveStore | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Blob Flow Repeat Summary

| Stack | Runs | Upload median | Metadata median | Latest retry recovery |
| --- | --- | --- | --- | --- |
| Syncular | 1 | 68.85 ms | 68.85 ms | n/a |
| Syncular Rust Client | 1 | 101.3 ms | 65.59 ms | n/a |

## Client Bundle Size

| Library | Profile | Raw | Gzip |
| --- | --- | --- | --- |
| Syncular | named import | 75.14 KB | 22.79 KB |
| Electric | named import | 52.77 KB | 16.79 KB |
| Zero | named import | 287.98 KB | 91.37 KB |
| PowerSync | named import | 532.98 KB | 165.65 KB |
| Replicache | named import | 113.00 KB | 35.64 KB |
| LiveStore | named import | 717.61 KB | 221.53 KB |

## Notes

- `native` means the benchmark uses the product’s normal client model.
- Model difference, stated honestly: the CDC stacks (Electric, Zero, PowerSync, LiveStore via sync-electric) observe an app-owned Postgres via WAL/CDC, so the bench admin writes plain SQL. Syncular v2 materializes real per-app Postgres tables but owns them — ingestion goes through the engine (push/storage API), never CDC — so its bench admin writes through the storage API and wakes clients via the engine’s Postgres LISTEN/NOTIFY fanout, while reads use plain SQL over the materialized columns.
- The two Syncular rows share one server stack and differ only in client core: `syncular` is the JS client on bun:sqlite; `syncular-rust` is the native Rust client (rusqlite) driven over real HTTP+WebSocket by a standalone bench binary. Both are built from the same unpublished v2 checkout; scenario parameters (datasets, query shapes, blob sizes, iteration counts) are identical across the two rows.
- Syncular bootstrap is measured cold-server + cold-client: the sync service is restarted before every scale so in-memory segment/sqlite-image caches never serve the measurement.
- `emulated` means the scenario required benchmark-owned durability or auth behavior around the product.
- `unsupported` rows stay visible as `n/a` so the support matrix remains explicit without inventing benchmark-owned adapters.
- LiveStore local-query remains unsupported at the shared 100000-row scale because the current wa-sqlite configuration aborts with a wasm heap OOM in this harness.
- Repeat summaries use the latest successful runs for the current framework version per stack/scenario.
- Bootstrap repeat summary uses up to five successful 100k-row runs per current version when available.
- Reconnect storm repeat summary uses up to three successful runs per current version and reports tier medians for 25 / 100 / 250 / 500 clients when available.
- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.
