# offline-sync-bench

Workload-oriented benchmarks for offline sync systems.

This repo stays separate from any one product repo. The goal is to compare systems by scenario and capability, not to flatten everything into a single vanity score.

Current readable report:

- [RESULTS.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/RESULTS.md)

## Principles

- Benchmark user-visible workloads, not isolated micro-ops.
- Keep stack setup reproducible with Docker Compose.
- Publish raw results and the exact scenario implementation.
- Prefer `emulated` or `unsupported` over pretending different systems provide the same client model.

## Implemented scenarios

- `bootstrap`: cold start until a local query is usable at 1k / 10k / 100k rows
- `online-propagation`: write on client A, observe on client B
- `offline-replay`: queue writes offline, reconnect, and measure convergence
- `reconnect-storm`: restart sync, then fan out one change to many already-bootstrapped clients while sampling server resources
- `large-offline-queue`: replay a materially larger queued write set than the baseline offline-replay case
- `local-query`: run screen-like filtered list, search, and aggregation workloads on the fully synced local client state
- `permission-change`: revoke scoped access and measure how quickly previously visible local rows disappear

Detailed specs live in:

- [docs/scenarios/bootstrap.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/docs/scenarios/bootstrap.md)
- [docs/scenarios/online-propagation.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/docs/scenarios/online-propagation.md)
- [docs/scenarios/offline-replay.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/docs/scenarios/offline-replay.md)
- [docs/scenarios/reconnect-storm.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/docs/scenarios/reconnect-storm.md)
- [docs/scenarios/large-offline-queue.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/docs/scenarios/large-offline-queue.md)
- [docs/scenarios/local-query.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/docs/scenarios/local-query.md)
- [docs/scenarios/permission-change.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/docs/scenarios/permission-change.md)
- [docs/methodology.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/docs/methodology.md)

## Stacks

- `syncular`
  - `bootstrap`: `native`
  - `online-propagation`: `native`
  - `offline-replay`: `native`
  - `reconnect-storm`: `native`
  - `large-offline-queue`: `native`
  - `local-query`: `native`
  - `permission-change`: `native`
- `electric`
  - `bootstrap`: `native`
  - `online-propagation`: `native`
  - `offline-replay`: `emulated` via a benchmark-owned Bun SQLite outbox
  - `reconnect-storm`: `native`
  - `large-offline-queue`: `emulated`
  - `local-query`: `native`
  - `permission-change`: `native` via a benchmark-owned auth-scoped Electric shape proxy
- `zero`
  - `bootstrap`: `native`
  - `online-propagation`: `native`
  - `offline-replay`: `unsupported`
  - `reconnect-storm`: `unsupported`
  - `large-offline-queue`: `unsupported`
  - `local-query`: `unsupported`
  - `permission-change`: `unsupported`
- `powersync`
  - `bootstrap`: `native`
  - `online-propagation`: `native`
  - `offline-replay`: `native`
  - `reconnect-storm`: `unsupported`
  - `large-offline-queue`: `unsupported`
  - `local-query`: `unsupported`
  - `permission-change`: `unsupported`
- `replicache`
  - `bootstrap`: `native`
  - `online-propagation`: `native`
  - `offline-replay`: `native`
  - `reconnect-storm`: `unsupported`
  - `large-offline-queue`: `unsupported`
  - `local-query`: `unsupported`
  - `permission-change`: `unsupported`
- `livestore`
  - `bootstrap`: `native`
  - `online-propagation`: `native`
  - `offline-replay`: `unsupported` in this harness for the official Node adapter + `sync-electric` path
  - `reconnect-storm`: `unsupported`
  - `large-offline-queue`: `unsupported`
  - `local-query`: `unsupported`
  - `permission-change`: `unsupported`

Each stack is defined with Docker Compose under [`stacks/`](/Users/bkniffler/GitHub/sync/offline-sync-bench/stacks).

## Shared admin service

The shared admin service owns benchmark schema setup, reset, deterministic seeding, fixture discovery, and direct write helpers against Postgres. It also clears `sync_*` tables during resets so cached commit/snapshot state does not leak across runs.

Current admin endpoints:

- `GET /health`
- `GET /admin/stats`
- `GET /admin/fixtures`
- `GET /admin/tasks`
- `GET /admin/tasks/:taskId`
- `POST /admin/reset`
- `POST /admin/seed`
- `POST /admin/write`

## Scripts

```bash
bun run scenarios
bun run stacks
bun run bench:plan
bun run bench:run -- --stack syncular --scenario bootstrap
bun run bench:all
bun run bench:report
bun run results:md
bun run bundle:size
bun run bundle:analyze
bun run bundle:check
```

Stack helpers:

```bash
bun run stacks:syncular:up
bun run stacks:electric:up
bun run stacks:zero:up
bun run stacks:powersync:up
bun run stacks:replicache:up
bun run stacks:livestore:up
bun run stacks:syncular:down
bun run stacks:electric:down
bun run stacks:zero:down
bun run stacks:powersync:down
bun run stacks:replicache:down
bun run stacks:livestore:down
```

## Results

Each run is stored in:

- raw JSON: `.results/<runId>/<stack>/<scenario>.json`
- markdown summary: `.results/<runId>/SUMMARY.md`
- normalized JSON summary: `.results/<runId>/SUMMARY.json`
- chart-friendly CSV summary: `.results/<runId>/SUMMARY.csv`
- run manifest: `.results/<runId>/RUN_MANIFEST.json`
- catalog SQLite: `.results/catalog.sqlite`
- latest-run mirrors: `.results/LATEST.md`, `.results/LATEST.json`, `.results/LATEST.csv`, `.results/LATEST_MANIFEST.json`

The Bun/TypeScript CLI writes and indexes results automatically.

Resource tracking now includes:

- network request count
- request bytes
- response bytes
- total transferred bytes
- average memory
- peak memory
- average CPU
- peak CPU
- sync-service and Postgres container CPU / memory / network in reconnect-storm scenarios
- scenario latency metrics such as bootstrap completion, write acknowledgment, mirror visibility, and reconnect convergence

Bundle-size reporting now includes:

- raw browser bundle size per client library entrypoint
- gzip-compressed size per entrypoint
- emitted artifact count per entrypoint
- output artifacts: `.results/BUNDLE_SIZES.json` and `.results/BUNDLE_SIZES.md`
- compiled canonical-client attribution via esbuild metafiles
- bundle guard output for the saved Syncular local-checkout budget
- a canonical browser entrypoint guard for the local `@syncular/client` path
- output artifacts: `.results/BUNDLE_ANALYSIS.json`, `.results/BUNDLE_ANALYSIS.md`, and `.results/BUNDLE_CHECK.md`

Interpretation:

- `bundle:size` is the broad cross-library entrypoint report used for like-for-like comparisons across libraries
- `bundle:analyze` and `bundle:check` focus on the compiled canonical `@syncular/client` browser client path and are the better tools for identifying or guarding Syncular-specific regressions

## Current status

The benchmark harness is operational for six stacks, with the expanded scenario set currently verified for:

- Syncular: `bootstrap`, `online-propagation`, `offline-replay`, `reconnect-storm`, `large-offline-queue`, `local-query`, `permission-change`
- Electric: `bootstrap`, `online-propagation`, `offline-replay` (emulated), `reconnect-storm`, `large-offline-queue` (emulated), `local-query`, `permission-change`

The older full-matrix artifact set is still useful for the first six-stack comparison:

- run ID: `2026-03-07T23-10-07-008Z`
- markdown summary: [.results/2026-03-07T23-10-07-008Z/SUMMARY.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/.results/2026-03-07T23-10-07-008Z/SUMMARY.md)
- json summary: [.results/2026-03-07T23-10-07-008Z/SUMMARY.json](/Users/bkniffler/GitHub/sync/offline-sync-bench/.results/2026-03-07T23-10-07-008Z/SUMMARY.json)
- csv summary: [.results/2026-03-07T23-10-07-008Z/SUMMARY.csv](/Users/bkniffler/GitHub/sync/offline-sync-bench/.results/2026-03-07T23-10-07-008Z/SUMMARY.csv)
- run manifest: [.results/2026-03-07T23-10-07-008Z/RUN_MANIFEST.json](/Users/bkniffler/GitHub/sync/offline-sync-bench/.results/2026-03-07T23-10-07-008Z/RUN_MANIFEST.json)

The current gaps are primarily broader scenario coverage for the non-Syncular/Electric stacks and cleanup/archive tooling, not missing core adapters or missing resource telemetry.

See [TODO.md](/Users/bkniffler/GitHub/sync/offline-sync-bench/TODO.md) for the remaining work.
