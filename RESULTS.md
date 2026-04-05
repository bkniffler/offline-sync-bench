# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.
Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.

## Highlights

- Bootstrap at 100k rows (median of the latest 1 runs where available): Electric is at 522.7 ms; Syncular is at 1373 ms; Replicache is at 1001 ms.
- Online propagation: Electric still leads on tail latency (12.74 ms p95), while Syncular is now at 17.40 ms p95 with 8.82 ms write ack.
- Native offline replay: Syncular currently converges in 75.38 ms, ahead of Replicache (1251 ms) and PowerSync (5191 ms).
- Permission change (median of the latest 1 runs where available): Syncular converges in 42.79 ms and Electric in 27.29 ms.
- Client bundle size: Syncular is currently 217.72 KB raw / 52.95 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 524288 byte blob in 26.38 ms, syncs metadata to a second client in 35.77 ms, re-downloads it after cache clear in 7.23 ms, and recovers an interrupted queued upload in 14.28 ms.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 58.02 ms | 135.4 ms | 1373 ms | 6 | 280.12 MB | native |
| Electric | 41.08 ms | 89.61 ms | 522.7 ms | 4 | 1085.85 MB | native |
| Zero | 217.2 ms | 1165 ms | 9015 ms | 0 | 349.07 MB | native |
| PowerSync | 1492 ms | 13290 ms | 43308 ms | 1 | 215.36 MB | native |
| Replicache | 40.04 ms | 123.0 ms | 1237 ms | 2 | 349.76 MB | native |
| LiveStore | 628.7 ms | 3049 ms | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 1373 ms | 1373 ms | 1373 ms | 1373 ms |
| Electric | 1 | 522.7 ms | 522.7 ms | 522.7 ms | 522.7 ms |
| Zero | 1 | 9015 ms | 9015 ms | 9015 ms | 9015 ms |
| PowerSync | 1 | 43308 ms | 43308 ms | 43308 ms | 43308 ms |
| Replicache | 5 | 1001 ms | 930.7 ms | 1237 ms | 1237 ms |

## Bootstrap Scale Study

| Stack | 250k rows | 500k rows | 500k avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 4772 ms | 5338 ms | 381.06 MB | native |
| Electric | 1285 ms | 2530 ms | 1656.14 MB | native |
| Zero | n/a | n/a | n/a | native |
| PowerSync | n/a | n/a | n/a | native |
| Replicache | 3330 ms | 7005 ms | 2439.14 MB | native |
| LiveStore | n/a | n/a | n/a | native |

## Bootstrap Resource Summary

| Stack | Largest avg mem | Largest avg CPU | Largest peak mem | Largest peak CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 381.06 MB | 68.19% | 469.59 MB | 113.75% | native |
| Electric | 1656.14 MB | 61.16% | 1806.30 MB | 167.64% | native |
| Zero | 349.07 MB | 47.57% | 394.77 MB | 190.44% | native |
| PowerSync | 215.36 MB | 12.21% | 284.14 MB | 630.42% | native |
| Replicache | 2439.14 MB | 97.16% | 4292.13 MB | 114.09% | native |
| LiveStore | n/a | n/a | n/a | n/a | native |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 8.82 ms | 11.46 ms | 17.40 ms | 389.38 MB | native |
| Electric | 3.43 ms | 4.21 ms | 12.74 ms | 1806.43 MB | native |
| Zero | 15.43 ms | 16.63 ms | 42.46 ms | 218.15 MB | native |
| PowerSync | 0.47 ms | 1001 ms | 1026 ms | 320.49 MB | native |
| Replicache | 0.27 ms | 30.72 ms | 44.78 ms | 224.80 MB | native |
| LiveStore | 0.59 ms | 218.2 ms | 1162 ms | 559.55 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 75.38 ms | 1 | 389.58 MB | native |
| Electric | 10 | 680.8 ms | 11 | 1806.48 MB | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 10 | 5191 ms | 17 | 318.15 MB | native |
| Replicache | 10 | 1251 ms | 21 | 213.04 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | 500 clients | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 119.6 ms | 2046 ms | 4097 ms | 2409 ms | native |
| Electric | 42.80 ms | 62.09 ms | 1983 ms | 2011 ms | native |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 96.20 ms | 248.7 ms | 2062 ms | 3411 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median | 500 median |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 119.6 ms | 2046 ms | 4097 ms | 2409 ms |
| Electric | 1 | 42.80 ms | 62.09 ms | 1983 ms | 2011 ms |
| Replicache | 1 | 96.20 ms | 248.7 ms | 2062 ms | 3411 ms |

## Reconnect Storm Resource Summary

| Stack | 500 sync avg mem | 500 postgres avg mem | 500 sync avg CPU | 500 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 118.20 MB | 195.13 MB | 10.87% | 12.33% | native |
| Electric | 292.33 MB | 182.97 MB | 3.48% | 0.86% | native |
| Replicache | 34.45 MB | 154.53 MB | 0.54% | 1.25% | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 506.9 ms | 4346 ms | 24719 ms | 50 | native |
| Electric | n/a | n/a | n/a | n/a | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 5466 ms | 6630 ms | 8019 ms | 1007 | native |
| Replicache | 1349 ms | 1300 ms | 1342 ms | 18 | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Large Offline Queue Repeat Summary

| Stack | Runs | 100 median | 500 median | 1000 median | Latest 1000 |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 506.9 ms | 4346 ms | 24719 ms | 24719 ms |
| PowerSync | 1 | 5466 ms | 6630 ms | 8019 ms | 8019 ms |
| Replicache | 2 | 1349 ms | 1300 ms | 1342 ms | 1323 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.10 ms | 0.07 ms | 7.51 ms | 936.78 MB | native |
| Electric | 11.08 ms | 4.07 ms | 9.85 ms | 1861.42 MB | native |
| Zero | 9.52 ms | 6.31 ms | 12.85 ms | 340.19 MB | native |
| PowerSync | 70.75 ms | 20.73 ms | 163.8 ms | 311.12 MB | native |
| Replicache | 12.73 ms | 2.85 ms | 8.56 ms | 269.85 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Deep Relationship Query

| Stack | Dashboard p50 | Detail join p50 | Avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 77.38 ms | 0.25 ms | 950.61 MB | native |
| Electric | n/a | n/a | n/a | unsupported |
| Zero | 9.70 ms | 6.37 ms | 332.56 MB | native |
| PowerSync | 360.3 ms | 5.70 ms | 316.93 MB | native |
| Replicache | 3.57 ms | 2.31 ms | 254.19 MB | native |
| LiveStore | n/a | n/a | n/a | unsupported |

## Deep Relationship Repeat Summary

| Stack | Runs | Dashboard median | Detail median | Latest dashboard | Latest detail |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 77.38 ms | 0.25 ms | 77.38 ms | 0.25 ms |
| Zero | 1 | 9.70 ms | 6.37 ms | 9.70 ms | 6.37 ms |
| PowerSync | 1 | 360.3 ms | 5.70 ms | 360.3 ms | 5.70 ms |
| Replicache | 2 | 3.44 ms | 2.12 ms | 3.57 ms | 2.31 ms |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Convergence | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1000 | 500 | 0 | 500 | 42.79 ms | native |
| Electric | 1000 | 500 | 0 | 500 | 27.29 ms | native |
| Zero | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 1000 | 500 | 0 | 500 | 10.74 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | n/a | unsupported |

## Permission Change Repeat Summary

| Stack | Runs | Median | Min | Max | Latest |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 42.79 ms | 42.79 ms | 42.79 ms | 42.79 ms |
| Electric | 1 | 27.29 ms | 27.29 ms | 27.29 ms | 27.29 ms |
| Replicache | 2 | 19.45 ms | 10.74 ms | 28.16 ms | 10.74 ms |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | SQLite upload overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 524288 | 26.38 ms | 35.77 ms | 7.23 ms | 14.28 ms | 7183 B | 0 B | native |
| Electric | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| LiveStore | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Blob Flow Repeat Summary

| Stack | Runs | Upload median | Metadata median | Latest retry recovery |
| --- | --- | --- | --- | --- |
| Syncular | 1 | 26.38 ms | 35.77 ms | 14.28 ms |

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
