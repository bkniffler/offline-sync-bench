# offline-sync-bench

Workload-oriented benchmarks for offline sync systems.

This repo stays separate from any one product repo. The goal is to compare systems by scenario and capability, not to flatten everything into a single vanity score.

Current readable report:

- [RESULTS.md](./RESULTS.md)
- [Dependency upgrade comparison](./UPGRADE_COMPARISON.md)

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
- `deep-relationship-query`: run organization dashboard rollups and project detail joins over a fully synced multi-table local relational dataset
- `permission-change`: revoke scoped access and measure how quickly previously visible local rows disappear
- `blob-flow`: upload a blob, observe cross-client metadata visibility, force a cache miss, and measure authenticated re-download plus interrupted upload recovery

Detailed specs live in:

- [docs/scenarios/bootstrap.md](./docs/scenarios/bootstrap.md)
- [docs/scenarios/online-propagation.md](./docs/scenarios/online-propagation.md)
- [docs/scenarios/offline-replay.md](./docs/scenarios/offline-replay.md)
- [docs/scenarios/reconnect-storm.md](./docs/scenarios/reconnect-storm.md)
- [docs/scenarios/large-offline-queue.md](./docs/scenarios/large-offline-queue.md)
- [docs/scenarios/local-query.md](./docs/scenarios/local-query.md)
- [docs/scenarios/deep-relationship-query.md](./docs/scenarios/deep-relationship-query.md)
- [docs/scenarios/permission-change.md](./docs/scenarios/permission-change.md)
- [docs/scenarios/blob-flow.md](./docs/scenarios/blob-flow.md)
- [docs/methodology.md](./docs/methodology.md)

## Stacks

The comparison admits deployable full-stack sync products with a server/backend and local client. Exceptionally popular, officially supported combinations may also be included when the combination supplies the missing layer; Electric + TanStack DB is the current exception. Generic BYOB client libraries and rows with little meaningful benchmark coverage are excluded.

| Stack | Bootstrap | Online | Offline | Large queue | Local query | Deep query | Permission | Blob |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Syncular JS | native | native | native | native | native | native | native | native |
| Syncular Rust | native | native | native | native | native | native | native | native |
| Electric | native | native | emulated | emulated | native | unsupported | native | unsupported |
| Electric + TanStack DB | native | native | native | native | native | native | native | unsupported |
| Zero | native | native | unsupported | unsupported | native | native | unsupported | unsupported |
| PowerSync | native | native | native | native | native | native | unsupported | unsupported |
| Turso Sync | native | native | native | native | native | native | unsupported | unsupported |
| Jazz v2 (experimental) | native | native | native | native | emulated | unsupported | unsupported | unsupported |

Jazz v2 uses an alpha release and is reported in an experimental lane, outside stable headline rankings. Each stack is defined with Docker Compose under [`stacks/`](./stacks/).

## Stack setup and admin services

Postgres-backed stacks share an admin service for schema setup, reset, deterministic seeding, fixture discovery, and direct write helpers. Turso uses a synced native admin client; Jazz v2 uses its official schema deployment and backend APIs.

Current admin endpoints:

- `GET /health`
- `GET /admin/stats`
- `GET /admin/fixtures`
- `GET /admin/tasks`
- `GET /admin/tasks/:taskId`
- `POST /admin/reset`
- `POST /admin/seed`
- `POST /admin/write`
- `POST /admin/revoke-membership`

## Scripts

```bash
bun run scenarios
bun run stacks
bun run bench:plan
bun run bench:run -- --stack syncular --scenario bootstrap
bun run bench:all
bun run bench:report
bun run bench:cleanup -- --dry-run
bun run results:md
bun run results:md -- --run-id <runId>
bun run bundle:size
```

Repeat `--run-id` to combine selected runs, such as a complete suite and a later
stack rerun. The report uses the latest outcome per stack/scenario and does not
replace failures with older successes.

Stack helpers:

```bash
bun run stacks:syncular:up
bun run stacks:electric:up
bun run stacks:zero:up
bun run stacks:powersync:up
bun run stacks:turso:up
bun run stacks:jazz-v2:up
bun run stacks:syncular:down
bun run stacks:electric:down
bun run stacks:zero:down
bun run stacks:powersync:down
bun run stacks:turso:down
bun run stacks:jazz-v2:down
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

Interpretation:

- `bundle:size` is the neutral cross-library entrypoint report used for like-for-like comparisons across libraries

## Current status

The benchmark harness is operational for the admitted full-stack products, the Electric + TanStack DB combination, and Syncular's Rust client variant. New coverage includes:

- Syncular: `bootstrap`, `online-propagation`, `offline-replay`, `reconnect-storm`, `large-offline-queue`, `local-query`, `deep-relationship-query`, `permission-change`, `blob-flow`
- Electric: `bootstrap`, `online-propagation`, `offline-replay` (emulated), `reconnect-storm`, `large-offline-queue` (emulated), `local-query`, `permission-change`
- Electric + TanStack DB: `bootstrap`, `online-propagation`, `offline-replay`, `large-offline-queue`, `local-query`, `deep-relationship-query`, `permission-change`
- Zero: `bootstrap`, `online-propagation`, `local-query`, `deep-relationship-query`
- PowerSync: `bootstrap`, `online-propagation`, `offline-replay`, `large-offline-queue`, `local-query`, `deep-relationship-query`
- Turso Sync: `bootstrap`, `online-propagation`, `offline-replay`, `large-offline-queue`, `local-query`, `deep-relationship-query`
- Jazz v2 experimental: `bootstrap`, `online-propagation`, `offline-replay`, `large-offline-queue`, `local-query` (aggregate emulated)

LiveStore and Replicache were removed from the active matrix: LiveStore had effectively no comparable coverage, and Replicache requires a benchmark-owned BYOB server rather than providing an admitted full-stack deployment.

See [TODO.md](./TODO.md) for the remaining work.
