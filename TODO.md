# TODO

## Implemented

- [x] Create a standalone Bun/TypeScript benchmark harness
- [x] Define the first three benchmark scenarios
- [x] Add Docker Compose stacks for Syncular and Electric
- [x] Add a shared Postgres admin service for reset, seed, fixtures, and direct writes
- [x] Add deterministic seeding with stable task IDs and reset all `sync_*` state between runs
- [x] Implement result storage in `.results/<runId>/<stack>/<scenario>.json`
- [x] Index runs in `.results/catalog.sqlite`
- [x] Generate markdown run summaries
- [x] Implement Syncular bootstrap against `/api/sync` with snapshot chunk materialization into Bun SQLite
- [x] Implement Syncular online propagation with two real clients
- [x] Implement Syncular offline replay with the real durable outbox
- [x] Implement Electric bootstrap against `/v1/shape`
- [x] Implement Electric online propagation with live shape follow
- [x] Implement Electric offline replay as an explicit emulated Bun SQLite outbox
- [x] Add Zero stack and verify `bootstrap` / `online-propagation`
- [x] Mark Zero `offline-replay` unsupported instead of faking an extra client-side durability layer
- [x] Add PowerSync stack and verify all three scenarios
- [x] Add Replicache stack and verify all three scenarios
- [x] Add LiveStore stack and verify `bootstrap` / `online-propagation`
- [x] Mark LiveStore `offline-replay` unsupported in this harness for the official Node adapter + `sync-electric` path
- [x] Verify a full `bun run bench:all` run locally across all current stacks

## Methodology

- [x] Pin exact framework/service versions in benchmark output for every stack that can expose them in the harness
- [x] Record and publish the benchmark machine profile in run summaries
- [x] Add process CPU metrics alongside time, rows, bytes, and memory
- [x] Track average and peak memory, plus request/response volume, in every supported scenario
- [x] Track sync-service / Postgres container CPU, memory, and network metrics in reconnect-storm scenarios
- [x] Write down fairness rules for auth, subscriptions, and cache layers
- [x] Decide that public benchmark runs use published packages and declared image references; keep local-checkout runs as development-only unless explicitly labeled otherwise

## Reporting

- [x] Generate markdown summary tables from raw JSON results
- [x] Add repeated-run bootstrap reporting so the public report shows recent median/min/max instead of only one noisy point
- [x] Keep a machine-readable results catalog
- [x] Export chart-friendly CSV artifacts
- [x] Export a normalized JSON summary artifact per run
- [x] Capture exact stack/image/version metadata alongside each run
- [x] Add a simple “latest run” report view
- [x] Emit a machine-readable run manifest with benchmark policy and environment context
- [x] Add client library raw/gzip bundle-size reporting

## Coverage

- [x] Mark support levels as `native` / `emulated` / `unsupported`
- [x] Add reconnect storm / fan-in recovery for Syncular, Electric, and Replicache
- [x] Add a larger offline queue replay scenario for Syncular and Electric
- [x] Extend large-offline-queue to 100 / 500 / 1000 queued writes for Syncular, Replicache, and PowerSync
- [x] Add local-query benchmarking for Syncular and Electric
- [x] Extend local-query benchmarking to Zero and Replicache on their native local client paths
- [x] Add permission change convergence with native Syncular coverage plus auth-scoped Electric and Replicache benchmark paths, while keeping the remaining stacks explicitly unsupported
- [x] Add scoped multi-project datasets to permission-change benchmarks so revocation removes only the unauthorized project while retaining still-authorized data
- [x] Add a first native Syncular blob flow benchmark covering immediate upload, forced cache-miss download, transferred bytes, and client resource use
- [x] Extend blob benchmarking to cross-client metadata visibility before authenticated re-download
- [x] Add interrupted upload recovery and storage-overhead comparisons to blob benchmarking
- [ ] Add more stacks beyond the current six, likely PowerSync alternatives or CRDT-first systems with clearly marked non-comparable scenarios

## Cleanup

- [x] Add a cleanup/archive command for stale failed result directories from early scaffolding runs
- [x] Decide whether to keep or delete old `.tmp` investigation databases
