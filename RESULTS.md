# Benchmark Results

Raw outcomes: [RESULTS.json](./RESULTS.json). Syncular coverage and configuration changes: [measurement notes](./SYNCULAR_COVERAGE.md).

This report uses only runs `2026-09-05T14-23-55-232Z`, `2026-09-05T19-35-13-932Z`, `2026-09-05T21-15-06-535Z`, `2026-09-05T21-36-46-367Z`, `2026-09-05T21-46-32-225Z`. The latest attempt per stack/scenario determines its outcome. Failed measurements remain unavailable; older successes are not substituted. See [the dependency upgrade comparison](./UPGRADE_COMPARISON.md) for the before/after results.
These are individual scenario measurements on one machine, not statistically established performance rankings.
Reconnect Storm and Large Offline Queue headline tables prefer current-version medians from recent successful runs when available.
Experimental-lane stacks remain visible in scenario tables but are excluded from stable headline rankings. “Not measured” means no recorded metric; “unsupported” means the adapter lacks the scenario; “failed” means the selected attempt failed.

## Run outcomes

52 completed, 1 failed, 19 unsupported.

- Jazz v2 (experimental) / bootstrap: Jazz v2 runner failed for bootstrap  ([raw result](./RESULTS.json))

## Highlights

- Bootstrap at 100k rows (median of the latest 1 runs where available): Electric is at 403.3 ms; Syncular is at 1110 ms.
- Online propagation: Electric is at 13.34 ms p95; Syncular is at 16.47 ms p95 with 10.79 ms write ack.
- Native offline replay: Syncular currently converges in 44.79 ms; PowerSync is at 1048 ms.
- Permission change (median of the latest 1 runs where available): Syncular converges in 11.40 ms and Electric in 12.41 ms.
- Client bundle size: Syncular is currently 116.45 KB raw / 34.43 KB gzip for the named-import browser profile.
- Blob flow: Syncular currently uploads a 2097152 byte blob in 138.4 ms, syncs metadata to a second client in 138.4 ms, downloads it on a fresh reader in 20.11 ms, and recovers a queued upload after an injected transport outage in 42.16 ms.

## Bootstrap

| Stack | 1k | 10k | 100k | 100k warm | 100k reqs | 100k avg mem | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 80.63 ms | 245.3 ms | 1110 ms | 221.0 ms | 4 | 46.07 MB | native |
| Syncular Rust Client | 299.7 ms | 188.9 ms | 1481 ms | 354.9 ms | 4 | 16.43 MB | native |
| Electric | 43.04 ms | 70.53 ms | 403.3 ms | not measured | 4 | 142.55 MB | native |
| Electric + TanStack DB | 97.38 ms | 598.4 ms | 4235 ms | not measured | 6 | 391.58 MB | native |
| Zero | 3936 ms | 1367 ms | 8242 ms | not measured | 0 | 417.80 MB | native |
| PowerSync | 174.6 ms | 757.6 ms | 6824 ms | not measured | 2 | 231.90 MB | native |
| Turso Sync | 1248 ms | 180.1 ms | 164.8 ms | not measured | 2 | 118.94 MB | native |
| Jazz v2 (experimental) | failed | failed | failed | failed | failed | failed | native (failed) |

## Bootstrap Repeat Summary

| Stack | Runs | 100k median | 100k min | 100k max | Latest 100k |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 1110 ms | 1110 ms | 1110 ms | 1110 ms |
| Syncular Rust Client | 1 | 1481 ms | 1481 ms | 1481 ms | 1481 ms |
| Electric | 1 | 403.3 ms | 403.3 ms | 403.3 ms | 403.3 ms |
| Electric + TanStack DB | 1 | 4235 ms | 4235 ms | 4235 ms | 4235 ms |
| Zero | 1 | 8242 ms | 8242 ms | 8242 ms | 8242 ms |
| PowerSync | 1 | 6824 ms | 6824 ms | 6824 ms | 6824 ms |
| Turso Sync | 1 | 164.8 ms | 164.8 ms | 164.8 ms | 164.8 ms |

## Bootstrap Scale Study

| Stack | 250k rows | 500k rows | 500k avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 3468 ms | 9943 ms | 44.96 MB | native |
| Syncular Rust Client | 2991 ms | 10890 ms | 32.84 MB | native |
| Electric | 909.8 ms | 2327 ms | 316.07 MB | native |
| Electric + TanStack DB | 10834 ms | 22161 ms | 3503.36 MB | native |
| Zero | not measured | not measured | not measured | native |
| PowerSync | not measured | not measured | not measured | native |
| Turso Sync | 330.0 ms | 710.9 ms | 111.99 MB | native |
| Jazz v2 (experimental) | failed | failed | failed | native (failed) |

## Bootstrap Resource Summary

| Stack | Largest avg mem | Largest avg CPU | Largest peak mem | Largest peak CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 44.96 MB | 7.24% | 553.86 MB | 117.58% | native |
| Syncular Rust Client | 32.84 MB | 9.99% | 430.30 MB | 100.00% | native |
| Electric | 316.07 MB | 35.20% | 519.78 MB | 100.44% | native |
| Electric + TanStack DB | 3503.36 MB | 125.11% | 3594.73 MB | 308.42% | native |
| Zero | 417.80 MB | 21.92% | 431.45 MB | 124.37% | native |
| PowerSync | 231.90 MB | 30.00% | 243.59 MB | 503.76% | native |
| Turso Sync | 111.99 MB | 41.28% | 298.23 MB | 124.51% | native |
| Jazz v2 (experimental) | failed | failed | failed | failed | native (failed) |

## Online Propagation

| Stack | Write ack | Visible p50 | Visible p95 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10.79 ms | 10.55 ms | 16.47 ms | 692.33 MB | native |
| Syncular Rust Client | 15.21 ms | 15.67 ms | 20.36 ms | 14.09 MB | native |
| Electric | 3.16 ms | 3.24 ms | 13.34 ms | 520.42 MB | native |
| Electric + TanStack DB | 6.34 ms | 11.19 ms | 13.51 ms | 140.78 MB | native |
| Zero | 20.01 ms | 20.34 ms | 47.90 ms | 71.61 MB | native |
| PowerSync | 1.27 ms | 1039 ms | 1099 ms | 304.75 MB | native |
| Turso Sync | 0.38 ms | 38.16 ms | 48.08 ms | 316.90 MB | native |
| Jazz v2 (experimental) | 0.77 ms | 23.29 ms | 62.10 ms | 156.90 MB | native |

## Offline Replay

| Stack | Queued writes | Convergence | Requests | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 10 | 44.79 ms | 1 | 694.43 MB | native |
| Syncular Rust Client | 10 | 55.57 ms | 2 | 6.93 MB | native |
| Electric | 10 | 71.52 ms | 2 | 521.33 MB | emulated |
| Electric + TanStack DB | 10 | 1567 ms | 40 | 134.74 MB | native |
| Zero | unsupported | unsupported | unsupported | unsupported | unsupported |
| PowerSync | 10 | 1048 ms | 18 | 238.42 MB | native |
| Turso Sync | 10 | 617.8 ms | 7 | 128.38 MB | native |
| Jazz v2 (experimental) | 10 | 48.82 ms | not measured | 159.88 MB | native |

## Reconnect Storm

| Stack | 25 clients | 100 clients | 250 clients | 500 clients | 1000 clients | Support |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 127.9 ms | 1127 ms | 464.5 ms | 5454 ms | 1277 ms | native |
| Syncular Rust Client | 119.7 ms | 335.4 ms | 682.1 ms | 1254 ms | 2523 ms | native |
| Electric | 48.92 ms | 237.0 ms | 1062 ms | 1057 ms | not measured | native |
| Electric + TanStack DB | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Zero | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| PowerSync | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Turso Sync | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Jazz v2 (experimental) | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |


## Reconnect Storm Repeat Summary

| Stack | Runs | 25 median | 100 median | 250 median | 500 median | 1000 median |
| --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 127.9 ms | 1127 ms | 464.5 ms | 5454 ms | 1277 ms |
| Syncular Rust Client | 1 | 119.7 ms | 335.4 ms | 682.1 ms | 1254 ms | 2523 ms |
| Electric | 1 | 48.92 ms | 237.0 ms | 1062 ms | 1057 ms | not measured |

## Reconnect Storm Resource Summary

| Stack | 500 sync avg mem | 500 postgres avg mem | 500 sync avg CPU | 500 postgres avg CPU | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 82.59 MB | 196.74 MB | 40.73% | 35.64% | native |
| Syncular Rust Client | 93.27 MB | 191.37 MB | 8.64% | 10.11% | native |
| Electric | 306.67 MB | 161.57 MB | 3.44% | 0.11% | native |

## Large Offline Queue

| Stack | 100 writes | 500 writes | 1000 writes | 1000 reqs | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 361.3 ms | 1464 ms | 3269 ms | 2 | native |
| Syncular Rust Client | 275.5 ms | 1508 ms | 3451 ms | 3 | native |
| Electric | not measured | not measured | not measured | not measured | emulated |
| Electric + TanStack DB | 2105 ms | 4858 ms | 10025 ms | 3010 | native |
| Zero | unsupported | unsupported | unsupported | unsupported | unsupported |
| PowerSync | 6062 ms | 2444 ms | 8346 ms | 1009 | native |
| Turso Sync | 664.7 ms | 660.6 ms | 791.9 ms | 7 | native |
| Jazz v2 (experimental) | 319.3 ms | 2438 ms | 7671 ms | not measured | native |

## Large Offline Queue Repeat Summary

| Stack | Runs | 100 median | 500 median | 1000 median | Latest 1000 |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 361.3 ms | 1464 ms | 3269 ms | 3269 ms |
| Syncular Rust Client | 1 | 275.5 ms | 1508 ms | 3451 ms | 3451 ms |
| Electric + TanStack DB | 1 | 2105 ms | 4858 ms | 10025 ms | 10025 ms |
| PowerSync | 1 | 6062 ms | 2444 ms | 8346 ms | 8346 ms |
| Turso Sync | 1 | 664.7 ms | 660.6 ms | 791.9 ms | 791.9 ms |
| Jazz v2 (experimental) | 1 | 319.3 ms | 2438 ms | 7671 ms | 7671 ms |

## Local Query

| Stack | List p50 | Search p50 | Aggregate p50 | Avg mem | Support |
| --- | --- | --- | --- | --- | --- |
| Syncular | 0.98 ms | 1.39 ms | 1.73 ms | 273.70 MB | native |
| Syncular Rust Client | 0.91 ms | 1.25 ms | 1.91 ms | 16.33 MB | native |
| Electric | 2.63 ms | 1.30 ms | 3.46 ms | 309.45 MB | native |
| Electric + TanStack DB | 0.72 ms | 0.97 ms | 384.5 ms | 447.13 MB | native |
| Zero | 2.10 ms | 1.89 ms | 4.04 ms | 176.96 MB | native |
| PowerSync | 38.97 ms | 10.91 ms | 103.9 ms | 330.23 MB | native |
| Turso Sync | 40.62 ms | 41.66 ms | 64.25 ms | 144.11 MB | native |
| Jazz v2 (experimental) | 845.2 ms | 846.7 ms | 1732 ms | 2725.07 MB | emulated |

## Deep Relationship Query

| Stack | Dashboard p50 | Detail join p50 | Avg mem | Support |
| --- | --- | --- | --- | --- |
| Syncular | 1.38 ms | 0.42 ms | 293.27 MB | native |
| Syncular Rust Client | 2.78 ms | 0.35 ms | 14.82 MB | native |
| Electric | unsupported | unsupported | unsupported | unsupported |
| Electric + TanStack DB | 547.4 ms | 84.43 ms | 464.54 MB | native |
| Zero | 0.77 ms | 1.16 ms | 159.47 MB | native |
| PowerSync | 241.3 ms | 3.25 ms | 403.32 MB | native |
| Turso Sync | 105.8 ms | 14.96 ms | 164.24 MB | native |
| Jazz v2 (experimental) | unsupported | unsupported | unsupported | unsupported |

## Deep Relationship Repeat Summary

| Stack | Runs | Dashboard median | Detail median | Latest dashboard | Latest detail |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 1.38 ms | 0.42 ms | 1.38 ms | 0.42 ms |
| Syncular Rust Client | 1 | 2.78 ms | 0.35 ms | 2.78 ms | 0.35 ms |
| Electric + TanStack DB | 1 | 547.4 ms | 84.43 ms | 547.4 ms | 84.43 ms |
| Zero | 1 | 0.77 ms | 1.16 ms | 0.77 ms | 1.16 ms |
| PowerSync | 1 | 241.3 ms | 3.25 ms | 241.3 ms | 3.25 ms |
| Turso Sync | 2 | 111.4 ms | 15.50 ms | 105.8 ms | 14.96 ms |

## Permission Change

| Stack | Initial rows | After revoke | Revoked rows left | Retained rows left | Same-client | Rebootstrap | Support |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 1000 | 500 | 0 | 500 | 11.40 ms | 21.67 ms | native |
| Syncular Rust Client | 1000 | 500 | 0 | 500 | 31.73 ms | 42.88 ms | native |
| Electric | 1000 | 500 | 0 | 500 | not measured | 9.05 ms | native |
| Electric + TanStack DB | 1000 | 500 | 0 | 500 | 9080 ms | 59.59 ms | native |
| Zero | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| PowerSync | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Turso Sync | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Jazz v2 (experimental) | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |

## Permission Change Repeat Summary

| Stack | Runs | Median | Min | Max | Latest |
| --- | --- | --- | --- | --- | --- |
| Syncular | 1 | 11.40 ms | 11.40 ms | 11.40 ms | 11.40 ms |
| Syncular Rust Client | 1 | 31.73 ms | 31.73 ms | 31.73 ms | 31.73 ms |
| Electric | 1 | 12.41 ms | 12.41 ms | 12.41 ms | 12.41 ms |
| Electric + TanStack DB | 1 | 9080 ms | 9080 ms | 9080 ms | 9080 ms |

## Blob Flow

| Stack | Blob bytes | Upload | Metadata visible | Re-download | Retry recovery | Transfer overhead | SQLite upload overhead | Support |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular | 2097152 | 138.4 ms | 138.4 ms | 20.11 ms | 42.16 ms | 2909 B | 0 B | native |
| Syncular Rust Client | 2097152 | 115.4 ms | 115.5 ms | 138.7 ms | 61.13 ms | ≥ 2719 B | 0 B | native |
| Electric | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Electric + TanStack DB | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Zero | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| PowerSync | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Turso Sync | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |
| Jazz v2 (experimental) | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported |

Blob transfer overhead is measured body bytes above one upload and one download. A ≥ prefix marks a lower bound where the native transport omits grant/redirect JSON bodies. SQLite overhead is the client database page allocation increase minus one payload; it excludes separate blob storage such as MinIO. Retry recovery is a separate injected upload-outage case.

## Blob Flow Repeat Summary

| Stack | Runs | Upload median | Metadata median | Latest retry recovery |
| --- | --- | --- | --- | --- |
| Syncular | 1 | 138.4 ms | 138.4 ms | 42.16 ms |
| Syncular Rust Client | 1 | 115.4 ms | 115.5 ms | 61.13 ms |

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
- Syncular bootstrap is measured cold-server + cold-client: the sync service is restarted before every scale so in-memory segment/sqlite-image caches never serve the measurement. `100k warm` is a second fresh client bootstrapping the same dataset without a restart (populated caches); stacks without the metric show `not measured`.
- JS memory includes the Bun suite process and allocations retained from earlier cases. Rust memory is native-client process RSS. These columns have different measurement scopes.
- `emulated` means the scenario required benchmark-owned durability or auth behavior around the product.
- `unsupported` rows stay visible as `unsupported` so the support matrix remains explicit without inventing benchmark-owned adapters.
- Repeat summaries use recent runs with the current framework version and implementation. Partial reconnect sweeps retain successful tiers and show failed tiers explicitly; earlier successes never replace a failed latest tier.
- Bootstrap repeat summary uses up to five successful 100k-row runs per current version when available.
- Reconnect storm repeat summary uses up to ten runs of the current version and implementation and reports tier medians for 25 / 100 / 250 / 500 / 1000 clients when available.
- Bundle sizes are taken from the named-import browser bundle profile in `.results/BUNDLE_SIZES.json`.
