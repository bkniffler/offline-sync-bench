# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.
Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.

## Highlights

- Bootstrap at 100k rows (median of the latest 1 runs where available): Electric is at 413.7 ms; Syncular is at 801.2 ms; Replicache is at 901.6 ms.
- Online propagation: Electric still leads on tail latency (11.05 ms p95), while Syncular is now at 22.80 ms p95 with 11.22 ms write ack.
- Native offline replay: Syncular currently converges in 75.38 ms, ahead of Replicache (1247 ms) and PowerSync (5121 ms).
- Permission change (median of the latest 2 runs where available): Syncular converges in 38.51 ms and Electric in 24.06 ms.
- Client bundle size: Syncular is currently 217.72 KB raw / 52.95 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 524288 byte blob in 26.38 ms, syncs metadata to a second client in 35.77 ms, re-downloads it after cache clear in 7.23 ms, and recovers an interrupted queued upload in 14.28 ms.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 40.05 ms | 115.8 ms | 824.1 ms | 6 | 295.36 MB | native |
| Syncular Rust Client | 29.64 ms | 33.22 ms | 264.5 ms | 8 | 410.00 MB | native |
| Electric | 37.28 ms | 61.21 ms | 413.7 ms | 4 | 1634.14 MB | native |
| Zero | 208.9 ms | 776.3 ms | 8028 ms | 0 | 358.98 MB | native |
| PowerSync | 197.3 ms | 871.9 ms | 22196 ms | 1 | 245.71 MB | native |
| Replicache | 33.44 ms | 93.84 ms | 901.6 ms | 2 | 369.20 MB | native |
| LiveStore | 463.7 ms | 2348 ms | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 5 | 801.2 ms | 780.1 ms | 954.8 ms | 824.1 ms |
| Syncular Rust Client | 5 | 226.9 ms | 212.7 ms | 264.5 ms | 264.5 ms |
| Electric | 1 | 413.7 ms | 413.7 ms | 413.7 ms | 413.7 ms |
| Zero | 4 | 8223 ms | 8028 ms | 9015 ms | 8028 ms |
| PowerSync | 2 | 14600 ms | 7004 ms | 22196 ms | 22196 ms |
| Replicache | 5 | 974.1 ms | 881.9 ms | 1237 ms | 901.6 ms |

## Bootstrap Scale Study

| Stack | 250k rows | 500k rows | 500k avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 1994 ms | 4071 ms | 399.02 MB | native |
| Syncular Rust Client | 597.1 ms | 1250 ms | 574.28 MB | native |
| Electric | 947.9 ms | 1870 ms | 2504.63 MB | native |
| Zero | n/a | n/a | n/a | native |
| PowerSync | n/a | n/a | n/a | native |
| Replicache | 2422 ms | 5036 ms | 1857.49 MB | native |
| LiveStore | n/a | n/a | n/a | native |

## Bootstrap Resource Summary

| Stack | Largest avg mem | Largest avg CPU | Largest peak mem | Largest peak CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 399.02 MB | 72.15% | 475.55 MB | 118.50% | native |
| Syncular Rust Client | 574.28 MB | 107.69% | 693.31 MB | 138.03% | native |
| Electric | 2504.63 MB | 63.74% | 2992.72 MB | 179.58% | native |
| Zero | 358.98 MB | 33.21% | 391.84 MB | 191.15% | native |
| PowerSync | 245.71 MB | 14.36% | 287.19 MB | 422.97% | native |
| Replicache | 1857.49 MB | 98.87% | 2981.67 MB | 115.08% | native |
| LiveStore | n/a | n/a | n/a | n/a | native |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 11.22 ms | 15.27 ms | 22.80 ms | 235.65 MB | native |
| Syncular Rust Client | 9.37 ms | 8.71 ms | 16.04 ms | 800.99 MB | native |
| Electric | 3.31 ms | 4.27 ms | 11.05 ms | 3003.61 MB | native |
| Zero | 13.65 ms | 12.83 ms | 38.87 ms | 219.59 MB | native |
| PowerSync | 0.41 ms | 993.7 ms | 1019 ms | 329.88 MB | native |
| Replicache | 0.23 ms | 30.80 ms | 50.66 ms | 221.12 MB | native |
| LiveStore | 0.59 ms | 218.2 ms | 1162 ms | 559.55 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 75.38 ms | 1 | 389.58 MB | native |
| Syncular Rust Client | 10 | 52.12 ms | 2 | 801.01 MB | native |
| Electric | 10 | 522.8 ms | 10 | 3003.74 MB | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 10 | 5121 ms | 17 | 325.11 MB | native |
| Replicache | 10 | 1247 ms | 18 | 224.61 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | 500 clients | 1000 clients | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 133.8 ms | 2046 ms | 4068 ms | 2408 ms | n/a | native |
| Syncular Rust Client | 34.88 ms | n/a | 280.9 ms | 2019 ms | 2049 ms | native |
| Electric | 31.08 ms | 2010 ms | 2011 ms | 2022 ms | n/a | native |
| Zero | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 65.16 ms | 209.1 ms | 1178 ms | 1360 ms | 1158 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median | 500 median | 1000 median |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 8 | 133.8 ms | 2046 ms | 4068 ms | 2408 ms | n/a |
| Syncular Rust Client | 6 | 34.88 ms | n/a | 280.9 ms | 2019 ms | 2049 ms |
| Electric | 1 | 31.08 ms | 2010 ms | 2011 ms | 2022 ms | n/a |
| Replicache | 4 | 65.16 ms | 209.1 ms | 1178 ms | 1360 ms | 1158 ms |

## Reconnect Storm Resource Summary

| Stack | 500 sync avg mem | 500 postgres avg mem | 500 sync avg CPU | 500 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 119.42 MB | 196.23 MB | 1.72% | 0.77% | native |
| Syncular Rust Client | n/a | n/a | n/a | n/a | native |
| Electric | 280.60 MB | 182.67 MB | 3.77% | 0.77% | native |
| Replicache | n/a | n/a | n/a | n/a | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 506.9 ms | 4346 ms | 24719 ms | 50 | native |
| Syncular Rust Client | 277.7 ms | 832.2 ms | 1887 ms | 20 | native |
| Electric | n/a | n/a | n/a | n/a | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 5456 ms | 7676 ms | 7976 ms | 1007 | native |
| Replicache | 1202 ms | 1293 ms | 1311 ms | 18 | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Large Offline Queue Repeat Summary

| Stack | Runs | 100 median | 500 median | 1000 median | Latest 1000 |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 506.9 ms | 4346 ms | 24719 ms | 24719 ms |
| Syncular Rust Client | 3 | 277.7 ms | 832.2 ms | 1887 ms | 1651 ms |
| PowerSync | 1 | 5456 ms | 7676 ms | 7976 ms | 7976 ms |
| Replicache | 3 | 1202 ms | 1293 ms | 1311 ms | 1390 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.21 ms | 0.09 ms | 5.94 ms | 372.62 MB | native |
| Syncular Rust Client | 0.12 ms | 0.17 ms | 0.01 ms | 1270.29 MB | native |
| Electric | 6.54 ms | 2.15 ms | 6.23 ms | 3222.70 MB | native |
| Zero | 4.32 ms | 2.63 ms | 6.67 ms | 330.15 MB | native |
| PowerSync | 49.60 ms | 15.47 ms | 115.8 ms | 270.12 MB | native |
| Replicache | 13.33 ms | 2.49 ms | 6.86 ms | 281.36 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Deep Relationship Query

| Stack | Dashboard p50 | Detail join p50 | Avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 77.38 ms | 0.25 ms | 950.61 MB | native |
| Syncular Rust Client | 0.02 ms | 0.28 ms | 428.13 MB | native |
| Electric | n/a | n/a | n/a | unsupported |
| Zero | 6.51 ms | 4.24 ms | 332.86 MB | native |
| PowerSync | 261.0 ms | 4.48 ms | 284.59 MB | native |
| Replicache | 3.86 ms | 2.15 ms | 262.64 MB | native |
| LiveStore | n/a | n/a | n/a | unsupported |

## Deep Relationship Repeat Summary

| Stack | Runs | Dashboard median | Detail median | Latest dashboard | Latest detail |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 77.38 ms | 0.25 ms | 77.38 ms | 0.25 ms |
| Syncular Rust Client | 3 | 0.03 ms | 0.34 ms | 0.02 ms | 0.28 ms |
| Zero | 3 | 3.90 ms | 2.56 ms | 6.51 ms | 4.24 ms |
| PowerSync | 3 | 261.0 ms | 4.48 ms | 261.0 ms | 4.48 ms |
| Replicache | 3 | 3.48 ms | 2.02 ms | 3.86 ms | 2.15 ms |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Same-client | Rebootstrap | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1000 | 500 | 0 | 500 | n/a | n/a | native |
| Syncular Rust Client | 1000 | 500 | 0 | 500 | 43.92 ms | 16.77 ms | native |
| Electric | 1000 | 500 | 0 | 500 | n/a | 32.13 ms | native |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 1000 | 1000 | 500 | 500 | n/a | 13.46 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Permission Change Repeat Summary

| Stack | Runs | Median | Min | Max | Latest |
| --- | --- | --- | --- | --- | --- |
| Syncular | 3 | 38.51 ms | 36.44 ms | 42.79 ms | 38.51 ms |
| Syncular Rust Client | 3 | 43.92 ms | 26.94 ms | 54.24 ms | 43.92 ms |
| Electric | 2 | 24.06 ms | 12.58 ms | 35.55 ms | 35.55 ms |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | SQLite upload overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 524288 | 26.38 ms | 35.77 ms | 7.23 ms | 14.28 ms | 7183 B | 0 B | native |
| Syncular Rust Client | 524288 | 22.75 ms | 22.72 ms | 13.62 ms | 11.98 ms | 5210 B | n/a | native |
| Electric | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| LiveStore | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Blob Flow Repeat Summary

| Stack | Runs | Upload median | Metadata median | Latest retry recovery |
| --- | --- | --- | --- | --- |
| Syncular | 1 | 26.38 ms | 35.77 ms | 14.28 ms |
| Syncular Rust Client | 3 | 24.40 ms | 26.44 ms | 11.98 ms |

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
