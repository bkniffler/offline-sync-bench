# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.

## Highlights

- Bootstrap at 100k rows (median of the latest 3 runs where available): Electric is at 416.3 ms; Syncular is at 847.1 ms; Replicache is at 991.8 ms.
- Online propagation: Electric still leads on tail latency (12.72 ms p95), while Syncular is now at 19.47 ms p95 with 11.35 ms write ack.
- Native offline replay: Syncular currently converges in 92.32 ms, ahead of Replicache (1253 ms) and PowerSync (5191 ms).
- Permission change (median of the latest 3 runs where available): Syncular converges in 43.56 ms and Electric in 15.96 ms.
- Client bundle size: Syncular is currently 829.83 KB raw / 238.32 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 524288 byte blob in 17.60 ms, syncs metadata to a second client in 31.71 ms, re-downloads it after cache clear in 7.01 ms, and recovers an interrupted queued upload in 13.23 ms.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 39.74 ms | 98.18 ms | 847.1 ms | 6 | 305.62 MB | native |
| Electric | 38.60 ms | 64.21 ms | 402.1 ms | 4 | 526.86 MB | native |
| Zero | 112.7 ms | 469.4 ms | 4070 ms | 0 | 507.96 MB | native |
| PowerSync | 5212 ms | 5512 ms | 8158 ms | 1 | 265.52 MB | native |
| Replicache | 30.08 ms | 98.11 ms | 930.7 ms | 2 | 379.26 MB | native |
| LiveStore | 488.4 ms | 2539 ms | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 5 | 847.1 ms | 812.1 ms | 1012 ms | 847.1 ms |
| Electric | 5 | 416.3 ms | 402.1 ms | 419.6 ms | 402.1 ms |
| Zero | 5 | 4070 ms | 3781 ms | 6007 ms | 4070 ms |
| PowerSync | 5 | 7193 ms | 6645 ms | 20290 ms | 8158 ms |
| Replicache | 5 | 991.8 ms | 930.7 ms | 1073 ms | 930.7 ms |

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
| Syncular | 10 | 92.32 ms | 1 | 241.56 MB | native |
| Electric | 10 | 37.35 ms | 2 | 684.30 MB | emulated |
| Zero | n/a | n/a | n/a | n/a | unsupported |
| PowerSync | 10 | 5191 ms | 17 | 318.15 MB | native |
| Replicache | 10 | 1253 ms | 18 | 210.83 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | Support |
| --- | --- | --- | --- | --- |
| Syncular | 241.2 ms | 8068 ms | 16127 ms | native |
| Electric | 71.49 ms | 223.0 ms | 2019 ms | native |
| Zero | n/a | n/a | n/a | unsupported |
| PowerSync | n/a | n/a | n/a | unsupported |
| Replicache | 84.44 ms | 2040 ms | 14106 ms | native |
| LiveStore | n/a | n/a | n/a | unsupported |

## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median |
| --- | --- | --- | --- | --- |
| Syncular | 3 | 251.3 ms | 5072 ms | 16138 ms |
| Electric | 3 | 44.84 ms | 223.0 ms | 2019 ms |
| Replicache | 2 | 81.27 ms | 2040 ms | 14106 ms |

## Reconnect Storm Resource Summary

| Stack | 250 sync avg mem | 250 postgres avg mem | 250 sync avg CPU | 250 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 100.86 MB | 100.25 MB | 1.30% | 0.89% | native |
| Electric | 303.13 MB | 101.40 MB | 2.83% | 0.12% | native |
| Replicache | 56.70 MB | 78.84 MB | 1.33% | 1.35% | native |

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
| Syncular | 3 | 389.4 ms | 1994 ms | 3812 ms | 3812 ms |
| PowerSync | 1 | 5466 ms | 6630 ms | 8019 ms | 8019 ms |
| Replicache | 1 | 1272 ms | 1280 ms | 1362 ms | 1362 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.25 ms | 0.10 ms | 5.83 ms | 374.53 MB | native |
| Electric | 8.56 ms | 2.84 ms | 6.98 ms | 793.22 MB | native |
| Zero | 8.10 ms | 5.10 ms | 8.74 ms | 392.06 MB | native |
| PowerSync | n/a | n/a | n/a | n/a | unsupported |
| Replicache | 12.88 ms | 2.53 ms | 6.48 ms | 300.97 MB | native |
| LiveStore | n/a | n/a | n/a | n/a | unsupported |

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
| Syncular | 3 | 43.56 ms | 40.75 ms | 46.90 ms | 46.90 ms |
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
| Syncular | 3 | 18.25 ms | 36.88 ms | 13.23 ms |

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
- Bootstrap repeat summary uses the latest five successful 100k-row bootstrap runs per stack when available.
- Reconnect storm repeat summary uses the latest three successful runs per stack and reports tier medians for 25 / 100 / 250 clients when available.
- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.
