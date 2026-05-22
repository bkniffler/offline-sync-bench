# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.
Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.

## Highlights

- Bootstrap at 100k rows (median of the latest 1 runs where available): Electric is at 413.5 ms; Syncular is at 801.2 ms; Replicache is at 1001 ms.
- Online propagation: Electric still leads on tail latency (10.33 ms p95), while Syncular is now at 22.80 ms p95 with 11.22 ms write ack.
- Native offline replay: Syncular currently converges in 75.38 ms, ahead of Replicache (1215 ms) and PowerSync (5191 ms).
- Permission change (median of the latest 1 runs where available): Syncular converges in 38.51 ms and Electric in 16.30 ms.
- Client bundle size: Syncular is currently 217.72 KB raw / 52.95 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 524288 byte blob in 26.38 ms, syncs metadata to a second client in 35.77 ms, re-downloads it after cache clear in 7.23 ms, and recovers an interrupted queued upload in 14.28 ms.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 40.05 ms | 115.8 ms | 824.1 ms | 6 | 295.36 MB | native |
| Syncular Rust Client | 28.24 ms | 33.36 ms | 229.9 ms | 8 | 447.99 MB | native |
| Electric | 41.21 ms | 60.85 ms | 413.5 ms | 4 | 1587.36 MB | native |
| Zero | 209.7 ms | 1244 ms | 8319 ms | 0 | 358.08 MB | native |
| PowerSync | 1492 ms | 13290 ms | 43308 ms | 1 | 215.36 MB | native |
| Replicache | 32.95 ms | 97.66 ms | 974.1 ms | 2 | 363.93 MB | native |
| LiveStore | 472.8 ms | 2244 ms | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 5 | 801.2 ms | 780.1 ms | 954.8 ms | 824.1 ms |
| Syncular Rust Client | 5 | 226.9 ms | 212.7 ms | 229.9 ms | 229.9 ms |
| Electric | 1 | 413.5 ms | 413.5 ms | 413.5 ms | 413.5 ms |
| Zero | 2 | 8667 ms | 8319 ms | 9015 ms | 8319 ms |
| PowerSync | 1 | 43308 ms | 43308 ms | 43308 ms | 43308 ms |
| Replicache | 5 | 991.8 ms | 930.7 ms | 1237 ms | 974.1 ms |

## Bootstrap Scale Study

| Stack | 250k rows | 500k rows | 500k avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 1994 ms | 4071 ms | 399.02 MB | native |
| Syncular Rust Client | 576.4 ms | 1149 ms | 598.24 MB | native |
| Electric | 968.6 ms | 2534 ms | 4072.84 MB | native |
| Zero | n/a | n/a | n/a | native |
| PowerSync | n/a | n/a | n/a | native |
| Replicache | 2573 ms | 5512 ms | 1788.83 MB | native |
| LiveStore | n/a | n/a | n/a | native |

## Bootstrap Resource Summary

| Stack | Largest avg mem | Largest avg CPU | Largest peak mem | Largest peak CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 399.02 MB | 72.15% | 475.55 MB | 118.50% | native |
| Syncular Rust Client | 598.24 MB | 106.57% | 720.47 MB | 136.14% | native |
| Electric | 4072.84 MB | 59.15% | 4752.41 MB | 116.65% | native |
| Zero | 358.08 MB | 37.28% | 384.06 MB | 169.33% | native |
| PowerSync | 215.36 MB | 12.21% | 284.14 MB | 630.42% | native |
| Replicache | 1788.83 MB | 93.35% | 3083.69 MB | 113.00% | native |
| LiveStore | n/a | n/a | n/a | n/a | native |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 11.22 ms | 15.27 ms | 22.80 ms | 235.65 MB | native |
| Syncular Rust Client | 9.29 ms | 8.94 ms | 16.25 ms | 432.55 MB | native |
| Electric | 3.91 ms | 4.71 ms | 10.33 ms | 4785.56 MB | native |
| Zero | 17.56 ms | 16.38 ms | 45.43 ms | 218.26 MB | native |
| PowerSync | 0.41 ms | 990.0 ms | 1016 ms | 327.92 MB | native |
| Replicache | 0.23 ms | 31.74 ms | 49.28 ms | 224.48 MB | native |
| LiveStore | 0.59 ms | 218.2 ms | 1162 ms | 559.55 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 75.38 ms | 1 | 389.58 MB | native |
| Syncular Rust Client | 10 | 50.17 ms | 2 | 314.85 MB | native |
| Electric | 10 | 55.20 ms | 6 | 4785.64 MB | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 10 | 5191 ms | 17 | 318.15 MB | native |
| Replicache | 10 | 1215 ms | 18 | 216.56 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | 500 clients | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 136.0 ms | 2106 ms | 4040 ms | 2412 ms | native |
| Syncular Rust Client | 94.80 ms | 224.7 ms | 2070 ms | n/a | native |
| Electric | 28.00 ms | 36.49 ms | 2007 ms | 2011 ms | native |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 73.70 ms | 202.8 ms | 1185 ms | 2021 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median | 500 median |
| --- | --- | --- | --- | --- | --- |
| Syncular | 3 | 136.0 ms | 2106 ms | 4040 ms | 2412 ms |
| Syncular Rust Client | 3 | 94.80 ms | 224.7 ms | 2070 ms | n/a |
| Electric | 1 | 28.00 ms | 36.49 ms | 2007 ms | 2011 ms |
| Replicache | 2 | 73.70 ms | 202.8 ms | 1185 ms | 2021 ms |

## Reconnect Storm Resource Summary

| Stack | 500 sync avg mem | 500 postgres avg mem | 500 sync avg CPU | 500 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 119.42 MB | 196.23 MB | 1.72% | 0.77% | native |
| Syncular Rust Client | 118.50 MB | 193.53 MB | 1.91% | 0.01% | native |
| Electric | 319.33 MB | 183.13 MB | 1.73% | 0.79% | native |
| Replicache | 36.48 MB | 153.80 MB | 0.11% | 0.90% | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 506.9 ms | 4346 ms | 24719 ms | 50 | native |
| Syncular Rust Client | n/a | n/a | 1757 ms | 14 | native |
| Electric | n/a | n/a | n/a | n/a | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 5466 ms | 6630 ms | 8019 ms | 1007 | native |
| Replicache | 1272 ms | 1320 ms | 1323 ms | 18 | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Large Offline Queue Repeat Summary

| Stack | Runs | 100 median | 500 median | 1000 median | Latest 1000 |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 506.9 ms | 4346 ms | 24719 ms | 24719 ms |
| PowerSync | 1 | 5466 ms | 6630 ms | 8019 ms | 8019 ms |
| Replicache | 3 | 1272 ms | 1320 ms | 1323 ms | 1311 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.21 ms | 0.09 ms | 5.94 ms | 372.62 MB | native |
| Syncular Rust Client | 0.17 ms | 0.24 ms | 0.01 ms | 1251.01 MB | native |
| Electric | 9.14 ms | 3.57 ms | 6.97 ms | 4834.84 MB | native |
| Zero | 6.81 ms | 4.00 ms | 8.00 ms | 328.35 MB | native |
| PowerSync | 50.94 ms | 15.93 ms | 156.9 ms | 318.35 MB | native |
| Replicache | 12.09 ms | 2.26 ms | 6.62 ms | 268.41 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Deep Relationship Query

| Stack | Dashboard p50 | Detail join p50 | Avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 77.38 ms | 0.25 ms | 950.61 MB | native |
| Syncular Rust Client | 0.03 ms | 0.34 ms | 419.30 MB | native |
| Electric | n/a | n/a | n/a | unsupported |
| Zero | 3.90 ms | 2.56 ms | 346.63 MB | native |
| PowerSync | 289.3 ms | 4.68 ms | 311.18 MB | native |
| Replicache | 3.48 ms | 2.02 ms | 257.53 MB | native |
| LiveStore | n/a | n/a | n/a | unsupported |

## Deep Relationship Repeat Summary

| Stack | Runs | Dashboard median | Detail median | Latest dashboard | Latest detail |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 77.38 ms | 0.25 ms | 77.38 ms | 0.25 ms |
| Syncular Rust Client | 3 | 0.05 ms | 0.44 ms | 0.03 ms | 0.34 ms |
| Zero | 2 | 6.80 ms | 4.46 ms | 3.90 ms | 2.56 ms |
| PowerSync | 1 | 289.3 ms | 4.68 ms | 289.3 ms | 4.68 ms |
| Replicache | 3 | 3.48 ms | 2.02 ms | 3.48 ms | 2.02 ms |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Convergence | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1000 | 500 | 0 | 500 | 38.51 ms | native |
| Syncular Rust Client | 1000 | 500 | 0 | 500 | 38.95 ms | native |
| Electric | 1000 | 500 | 0 | 500 | 16.30 ms | native |
| Zero | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 1000 | 500 | 0 | 500 | 10.66 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | n/a | unsupported |

## Permission Change Repeat Summary

| Stack | Runs | Median | Min | Max | Latest |
| --- | --- | --- | --- | --- | --- |
| Syncular | 3 | 38.51 ms | 36.44 ms | 42.79 ms | 38.51 ms |
| Syncular Rust Client | 1 | 38.95 ms | 38.95 ms | 38.95 ms | 38.95 ms |
| Electric | 1 | 16.30 ms | 16.30 ms | 16.30 ms | 16.30 ms |
| Replicache | 3 | 10.74 ms | 10.66 ms | 28.16 ms | 10.66 ms |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | SQLite upload overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 524288 | 26.38 ms | 35.77 ms | 7.23 ms | 14.28 ms | 7183 B | 0 B | native |
| Syncular Rust Client | 524288 | 24.45 ms | 31.76 ms | 15.69 ms | 116.4 ms | 5210 B | n/a | native |
| Electric | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| LiveStore | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Blob Flow Repeat Summary

| Stack | Runs | Upload median | Metadata median | Latest retry recovery |
| --- | --- | --- | --- | --- |
| Syncular | 1 | 26.38 ms | 35.77 ms | 14.28 ms |
| Syncular Rust Client | 2 | 28.57 ms | 30.67 ms | 116.4 ms |

## Client Bundle Size

| Library | Profile | Raw | Gzip |
| --- | --- | --- | --- |
| Syncular | named import | 217.72 KB | 52.95 KB |
| Electric | named import | 48.85 KB | 15.57 KB |
| Zero | named import | 287.93 KB | 91.51 KB |
| PowerSync | named import | 593.76 KB | 181.46 KB |
| Replicache | named import | 112.95 KB | 35.68 KB |
| LiveStore | named import | 717.55 KB | 223.24 KB |

## Notes

- `native` means the benchmark uses the product’s normal client model.
- `emulated` means the scenario required benchmark-owned durability or auth behavior around the product.
- `unsupported` rows stay visible as `n/a` so the support matrix remains explicit without inventing benchmark-owned adapters.
- LiveStore local-query remains unsupported at the shared 100000-row scale because the current wa-sqlite configuration aborts with a wasm heap OOM in this harness.
- Repeat summaries use the latest successful runs for the current framework version per stack/scenario.
- Bootstrap repeat summary uses up to five successful 100k-row runs per current version when available.
- Reconnect storm repeat summary uses up to three successful runs per current version and reports tier medians for 25 / 100 / 250 / 500 clients when available.
- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.
