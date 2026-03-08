# Benchmark Results

This report is generated from the latest successful result for each stack/scenario pair under `.results/`.
Numbers are directly comparable within a scenario, but they may come from different run IDs because newer scenarios are being iterated independently.

## Highlights

- Bootstrap at 100k rows: Electric is currently fastest in this harness; Syncular is now below 1 second and close to Replicache on this workload.
- Online propagation: Electric still leads on raw tail latency, but Syncular is now in the low-double-digit millisecond range and clearly ahead of Zero, PowerSync, and LiveStore.
- Native offline replay: Syncular currently has the best convergence among the native durable-write paths measured here.
- Permission change: Syncular and Electric both now have real multi-project revocation coverage, with unauthorized rows disappearing while retained-project rows stay local.
- Canonical browser client bundle: Syncular is currently 156.82 KB raw / 38.05 KB gzip from the local checkout analysis.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 42.03 ms | 116.6 ms | 933.2 ms | 10 | 334.72 MB | native |
| Electric | 43.37 ms | 64.49 ms | 413.7 ms | 4 | 537.88 MB | native |
| Zero | 112.7 ms | 469.4 ms | 4070 ms | 0 | 507.96 MB | native |
| PowerSync | 5212 ms | 5512 ms | 8158 ms | 1 | 265.52 MB | native |
| Replicache | 32.33 ms | 105.0 ms | 1046 ms | 2 | 378.76 MB | native |
| LiveStore | 488.4 ms | 2539 ms | n/a | n/a | n/a | native |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10.40 ms | 16.13 ms | 19.85 ms | 242.86 MB | native |
| Electric | 4.06 ms | 5.26 ms | 12.72 ms | 684.14 MB | native |
| Zero | 50.64 ms | 41.56 ms | 152.2 ms | 216.58 MB | native |
| PowerSync | 0.52 ms | 995.2 ms | 1015 ms | 326.90 MB | native |
| Replicache | 0.25 ms | 31.78 ms | 49.55 ms | 218.01 MB | native |
| LiveStore | 0.59 ms | 218.2 ms | 1162 ms | 559.55 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 142.6 ms | 1 | 238.64 MB | native |
| Electric | 10 | 37.35 ms | 2 | 684.30 MB | emulated |
| PowerSync | 10 | 5191 ms | 17 | 318.15 MB | native |
| Replicache | 10 | 1253 ms | 18 | 210.83 MB | native |

## Reconnect Storm

| Stack | Clients | Convergence | Sync avg mem | Postgres avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 25 | 182.6 ms | 102.80 MB | 92.52 MB | native |
| Electric | 25 | 29.59 ms | 261.75 MB | 100.62 MB | native |

## Large Offline Queue

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 20 | 186.6 ms | 1 | 244.65 MB | native |
| Electric | 20 | 55.90 ms | 1 | 236.65 MB | emulated |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.14 ms | 0.08 ms | 5.50 ms | 347.66 MB | native |
| Electric | 8.56 ms | 2.84 ms | 6.98 ms | 793.22 MB | native |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Convergence | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1000 | 500 | 0 | 500 | 63.30 ms | native |
| Electric | 1000 | 500 | 0 | 500 | 15.96 ms | native |

## Client Bundle Size

| Library | Profile | Raw | Gzip |
| --- | --- | --- | --- |
| Syncular | canonical client | 156.82 KB | 38.05 KB |
| Electric | named import | 48.55 KB | 15.38 KB |
| Zero | named import | 285.61 KB | 92.91 KB |
| PowerSync | named import | 587.63 KB | 179.43 KB |
| Replicache | named import | 112.95 KB | 35.68 KB |
| LiveStore | named import | 717.55 KB | 223.24 KB |

## Notes

- `native` means the benchmark uses the product’s normal client model.
- `emulated` means the scenario required benchmark-owned durability or auth behavior around the product.
- `unsupported` stacks are intentionally omitted instead of being forced through non-native adapters.
- Syncular bundle size is taken from the canonical local-checkout browser-client analysis; other libraries use the named-import bundle-size profile from `.results/BUNDLE_SIZES.json`.

## Source Artifacts

### Bootstrap

- Syncular: [2026-03-08T09-41-34-479Z](./.results/2026-03-08T09-41-34-479Z/syncular/bootstrap.json)
- Electric: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/electric/bootstrap.json)
- Zero: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/zero/bootstrap.json)
- PowerSync: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/powersync/bootstrap.json)
- Replicache: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/replicache/bootstrap.json)
- LiveStore: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/livestore/bootstrap.json)

### Online propagation

- Syncular: [2026-03-08T09-46-49-140Z](./.results/2026-03-08T09-46-49-140Z/syncular/online-propagation.json)
- Electric: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/electric/online-propagation.json)
- Zero: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/zero/online-propagation.json)
- PowerSync: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/powersync/online-propagation.json)
- Replicache: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/replicache/online-propagation.json)
- LiveStore: [2026-03-07T23-56-55-477Z](./.results/2026-03-07T23-56-55-477Z/livestore/online-propagation.json)

### Offline replay

- Syncular: [2026-03-08T10-05-45-365Z](./.results/2026-03-08T10-05-45-365Z/syncular/offline-replay.json)
- Electric: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/electric/offline-replay.json)
- PowerSync: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/powersync/offline-replay.json)
- Replicache: [2026-03-08T00-04-34-429Z](./.results/2026-03-08T00-04-34-429Z/replicache/offline-replay.json)

### Reconnect storm

- Syncular: [2026-03-08T16-19-16-140Z](./.results/2026-03-08T16-19-16-140Z/syncular/reconnect-storm.json)
- Electric: [2026-03-08T16-19-16-137Z](./.results/2026-03-08T16-19-16-137Z/electric/reconnect-storm.json)

### Large offline queue

- Syncular: [2026-03-08T16-19-53-070Z](./.results/2026-03-08T16-19-53-070Z/syncular/large-offline-queue.json)
- Electric: [2026-03-08T16-19-53-066Z](./.results/2026-03-08T16-19-53-066Z/electric/large-offline-queue.json)

### Local query

- Syncular: [2026-03-08T16-18-57-341Z](./.results/2026-03-08T16-18-57-341Z/syncular/local-query.json)
- Electric: [2026-03-08T16-18-57-337Z](./.results/2026-03-08T16-18-57-337Z/electric/local-query.json)

### Permission-change convergence

- Syncular: [2026-03-08T16-15-35-149Z](./.results/2026-03-08T16-15-35-149Z/syncular/permission-change.json)
- Electric: [2026-03-08T16-14-40-432Z](./.results/2026-03-08T16-14-40-432Z/electric/permission-change.json)
