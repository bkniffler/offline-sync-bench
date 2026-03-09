# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.

## Highlights

- Bootstrap at 100k rows (median of the latest 3 runs where available): Electric is at 416.3 ms; Syncular is at 852.8 ms; Replicache is at 1046 ms.
- Online propagation: Electric still leads on tail latency (12.72 ms p95), while Syncular is now at 19.47 ms p95 with 11.35 ms write ack.
- Native offline replay: Syncular currently converges in 92.32 ms, ahead of Replicache (1253 ms) and PowerSync (5191 ms).
- Permission change: Syncular and Electric both have real multi-project revocation coverage here; Syncular converges in 43.56 ms and Electric in 15.96 ms.
- Client bundle size: Syncular is currently 829.83 KB raw / 238.32 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 524288 byte blob in 18.25 ms, syncs metadata to a second client in 46.78 ms, re-downloads it after cache clear in 9.28 ms, and recovers an interrupted queued upload in 12.53 ms.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 30.60 ms | 113.0 ms | 852.8 ms | 6 | 301.06 MB | native |
| Electric | 43.19 ms | 68.94 ms | 419.6 ms | 4 | 475.67 MB | native |
| Zero | 112.7 ms | 469.4 ms | 4070 ms | 0 | 507.96 MB | native |
| PowerSync | 5212 ms | 5512 ms | 8158 ms | 1 | 265.52 MB | native |
| Replicache | 37.55 ms | 116.4 ms | 1073 ms | 2 | 376.66 MB | native |
| LiveStore | 488.4 ms | 2539 ms | n/a | n/a | n/a | native |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 3 | 852.8 ms | 841.4 ms | 1012 ms | 852.8 ms |
| Electric | 3 | 416.3 ms | 413.7 ms | 419.6 ms | 419.6 ms |
| Zero | 3 | 4978 ms | 4070 ms | 6007 ms | 4070 ms |
| PowerSync | 3 | 8158 ms | 7193 ms | 20290 ms | 8158 ms |
| Replicache | 3 | 1046 ms | 972.2 ms | 1073 ms | 1073 ms |

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
| PowerSync | 10 | 5191 ms | 17 | 318.15 MB | native |
| Replicache | 10 | 1253 ms | 18 | 210.83 MB | native |

## Reconnect Storm

| Stack | Clients | Convergence | Sync avg mem | Postgres avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 25 | 251.3 ms | 91.50 MB | 56.28 MB | native |
| Electric | 25 | 44.84 ms | 277.15 MB | 63.14 MB | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 389.4 ms | 1994 ms | 3812 ms | 50 | native |
| Electric | n/a | n/a | n/a | n/a | emulated |
| PowerSync | 5466 ms | 6630 ms | 8019 ms | 1007 | native |
| Replicache | 1272 ms | 1280 ms | 1362 ms | 18 | native |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.25 ms | 0.10 ms | 5.83 ms | 374.53 MB | native |
| Electric | 8.56 ms | 2.84 ms | 6.98 ms | 793.22 MB | native |
| Zero | 8.10 ms | 5.10 ms | 8.74 ms | 392.06 MB | native |
| Replicache | 12.88 ms | 2.53 ms | 6.48 ms | 300.97 MB | native |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Convergence | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1000 | 500 | 0 | 500 | 43.56 ms | native |
| Electric | 1000 | 500 | 0 | 500 | 15.96 ms | native |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 524288 | 18.25 ms | 46.78 ms | 9.28 ms | 12.53 ms | 7183 B | native |

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
- `unsupported` stacks are intentionally omitted instead of being forced through non-native adapters.
- Bootstrap repeat summary uses the latest three successful 100k-row bootstrap runs per stack when available.
- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.
