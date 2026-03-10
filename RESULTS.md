# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.
Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.

## Highlights

- Bootstrap at 100k rows (median of the latest 1 runs where available): Electric is at 416.3 ms; Syncular is at 882.2 ms; Replicache is at 991.8 ms.
- Online propagation: Electric still leads on tail latency (12.72 ms p95), while Syncular is now at 19.47 ms p95 with 11.35 ms write ack.
- Native offline replay: Syncular currently converges in 93.40 ms, ahead of Replicache (1253 ms) and PowerSync (5191 ms).
- Permission change (median of the latest 1 runs where available): Syncular converges in 46.90 ms and Electric in 15.96 ms.
- Client bundle size: Syncular is currently 829.83 KB raw / 238.32 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 524288 byte blob in 17.60 ms, syncs metadata to a second client in 31.71 ms, re-downloads it after cache clear in 7.01 ms, and recovers an interrupted queued upload in 13.23 ms.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 42.32 ms | 107.4 ms | 882.2 ms | 6 | 304.69 MB | native |
| Electric | 43.04 ms | 71.15 ms | 425.5 ms | 4 | 500.60 MB | native |
| Zero | 112.7 ms | 469.4 ms | 4070 ms | 0 | 507.96 MB | native |
| PowerSync | 5212 ms | 5512 ms | 8158 ms | 1 | 265.52 MB | native |
| Replicache | 40.37 ms | 108.4 ms | 1001 ms | 2 | 377.82 MB | native |
| LiveStore | 488.4 ms | 2539 ms | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 882.2 ms | 882.2 ms | 882.2 ms | 882.2 ms |
| Electric | 5 | 416.3 ms | 402.1 ms | 425.5 ms | 425.5 ms |
| Zero | 5 | 4070 ms | 3781 ms | 6007 ms | 4070 ms |
| PowerSync | 5 | 7193 ms | 6645 ms | 20290 ms | 8158 ms |
| Replicache | 5 | 991.8 ms | 930.7 ms | 1073 ms | 1001 ms |

## Bootstrap Scale Study

| Stack | 250k rows | 500k rows | 500k avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 2687 ms | 4179 ms | 440.92 MB | native |
| Electric | 949.4 ms | 1878 ms | 1324.90 MB | native |
| Zero | n/a | n/a | n/a | native |
| PowerSync | n/a | n/a | n/a | native |
| Replicache | 2551 ms | 5345 ms | 1819.74 MB | native |
| LiveStore | n/a | n/a | n/a | native |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 11.35 ms | 15.47 ms | 19.47 ms | 243.52 MB | native |
| Electric | 4.06 ms | 5.26 ms | 12.72 ms | 684.14 MB | native |
| Zero | 50.64 ms | 41.56 ms | 152.2 ms | 216.58 MB | native |
| PowerSync | 0.52 ms | 995.2 ms | 1015 ms | 326.90 MB | native |
| Replicache | 0.25 ms | 31.78 ms | 49.55 ms | 218.01 MB | native |
| LiveStore | 0.59 ms | 218.2 ms | 1162 ms | 559.55 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 93.40 ms | 1 | 239.99 MB | native |
| Electric | 10 | 37.35 ms | 2 | 684.30 MB | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 10 | 5191 ms | 17 | 318.15 MB | native |
| Replicache | 10 | 1253 ms | 18 | 210.83 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | 500 clients | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 113.1 ms | 1133 ms | 10090 ms | 2126 ms | native |
| Electric | 71.49 ms | 4057 ms | 2032 ms | 3037 ms | native |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 88.58 ms | 2019 ms | 4083 ms | 5100 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median | 500 median |
| --- | --- | --- | --- | --- | --- |
| Syncular | 2 | 113.1 ms | 1133 ms | 10090 ms | 2126 ms |
| Electric | 3 | 71.49 ms | 4057 ms | 2032 ms | 3037 ms |
| Replicache | 3 | 88.58 ms | 2019 ms | 4083 ms | 5100 ms |

## Reconnect Storm Resource Summary

| Stack | 500 sync avg mem | 500 postgres avg mem | 500 sync avg CPU | 500 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 114.25 MB | 54.48 MB | 4.51% | 6.57% | native |
| Electric | 286.58 MB | 85.01 MB | 4.01% | 1.05% | native |
| Replicache | 36.14 MB | 61.07 MB | 1.20% | 0.22% | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 389.4 ms | 1994 ms | 3812 ms | 50 | native |
| Electric | n/a | n/a | n/a | n/a | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 5466 ms | 6630 ms | 8019 ms | 1007 | native |
| Replicache | 1272 ms | 1280 ms | 1362 ms | 18 | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Large Offline Queue Repeat Summary

| Stack | Runs | 100 median | 500 median | 1000 median | Latest 1000 |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 389.4 ms | 1994 ms | 3812 ms | 3812 ms |
| PowerSync | 1 | 5466 ms | 6630 ms | 8019 ms | 8019 ms |
| Replicache | 1 | 1272 ms | 1280 ms | 1362 ms | 1362 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.25 ms | 0.10 ms | 5.83 ms | 374.53 MB | native |
| Electric | 8.56 ms | 2.84 ms | 6.98 ms | 793.22 MB | native |
| Zero | 8.10 ms | 5.10 ms | 8.74 ms | 392.06 MB | native |
| PowerSync | 51.20 ms | 15.45 ms | 115.1 ms | 286.56 MB | native |
| Replicache | 12.88 ms | 2.53 ms | 6.48 ms | 300.97 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Deep Relationship Query

| Stack | Dashboard p50 | Detail join p50 | Avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 187.9 ms | 0.69 ms | 390.04 MB | native |
| Electric | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | unsupported |
| PowerSync | 564.4 ms | 9.05 ms | 302.01 MB | native |
| Replicache | n/a | n/a | n/a | unsupported |
| LiveStore | n/a | n/a | n/a | unsupported |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Convergence | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1000 | 500 | 0 | 500 | 46.90 ms | native |
| Electric | 1000 | 500 | 0 | 500 | 39.36 ms | native |
| Zero | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 1000 | 500 | 0 | 500 | 28.16 ms | native |
| LiveStore | n/a | n/a | n/a | n/a | n/a | unsupported |

## Permission Change Repeat Summary

| Stack | Runs | Median | Min | Max | Latest |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 46.90 ms | 46.90 ms | 46.90 ms | 46.90 ms |
| Electric | 3 | 15.96 ms | 15.25 ms | 39.36 ms | 39.36 ms |
| Replicache | 1 | 28.16 ms | 28.16 ms | 28.16 ms | 28.16 ms |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | SQLite upload overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 524288 | 17.60 ms | 31.71 ms | 7.01 ms | 13.23 ms | 7183 B | 0 B | native |
| Electric | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Zero | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| Replicache | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |
| LiveStore | n/a | n/a | n/a | n/a | n/a | n/a | n/a | unsupported |

## Blob Flow Repeat Summary

| Stack | Runs | Upload median | Metadata median | Latest retry recovery |
| --- | --- | --- | --- | --- |
| Syncular | 2 | 20.66 ms | 34.30 ms | 13.23 ms |

## Client Bundle Size

| Library | Profile | Raw | Gzip |
| --- | --- | --- | --- |
| Syncular | named import | 829.83 KB | 238.32 KB |
| Electric | named import | 48.55 KB | 15.38 KB |
| Zero | named import | 285.61 KB | 92.91 KB |
| PowerSync | named import | 587.63 KB | 179.43 KB |
| Replicache | named import | 112.95 KB | 35.68 KB |
| LiveStore | named import | 717.55 KB | 223.24 KB |

## Notes

- `native` means the benchmark uses the product’s normal client model.
- `emulated` means the scenario required benchmark-owned durability or auth behavior around the product.
- `unsupported` rows stay visible as `n/a` so the support matrix remains explicit without inventing benchmark-owned adapters.
- Repeat summaries use the latest successful runs for the current framework version per stack/scenario.
- Bootstrap repeat summary uses up to five successful 100k-row runs per current version when available.
- Reconnect storm repeat summary uses up to three successful runs per current version and reports tier medians for 25 / 100 / 250 / 500 clients when available.
- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.
