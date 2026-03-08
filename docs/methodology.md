# Methodology

This benchmark compares offline-sync systems by workload and capability, not by a single score.

## Benchmark mode

Public benchmark runs use the versions installed in this repo at run time:

- npm packages from `offline-sync-bench/package.json`
- Docker images or local Docker builds referenced by each stack's `docker-compose.yml`

This keeps public numbers reproducible. Development-only runs against local checkouts are allowed, but they should not be presented as public comparison results without changing the declared benchmark mode.

## Support levels

- `native`
  - The scenario uses the framework as shipped for that workflow.
- `emulated`
  - The benchmark adds a clearly documented auxiliary layer because the framework does not ship that capability directly in the tested path.
- `unsupported`
  - The scenario is intentionally not measured because the framework does not target that capability in this harness, or measuring it fairly would require inventing product behavior.

`unsupported` is preferred over a synthetic benchmark path that would stop measuring the actual framework.

## Fairness rules

- All stacks use the same seeded domain model: organizations, projects, users, memberships, and tasks.
- All stacks start from Docker Compose and are reset between runs so state does not leak across scenarios.
- Results are scenario-scoped. A framework can be strong in bootstrap and intentionally unsupported in offline replay.
- `emulated` scenarios must be labeled in the stack matrix, the result metadata, and the summaries.
- The benchmark does not assign a single winner across incomparable capability models.
- Runs should be compared within the same run or on the same hardware profile whenever possible.
- Package versions and image digests are captured in result metadata so claims can be reproduced precisely.

## What is comparable today

- `bootstrap`
  - Cold start until local queryability is the main comparison point, alongside request volume, bytes transferred, and process resource use.
- `online-propagation`
  - Write acknowledgment and second-client visibility are comparable, along with supporting network and process metrics.
- `offline-replay`
  - Only compare stacks where the scenario is `native` or where an `emulated` path is explicitly part of the claim, and keep the capability label attached to latency and resource numbers.
- `reconnect-storm`
  - Compare only the stacks where the harness exercises a real reconnect fan-in path and captures sync-service plus Postgres container resource metrics.
- `large-offline-queue`
  - Treat this as a scaling extension of offline replay, not as a generic throughput benchmark detached from capability labels.
- `local-query`
  - This is a separate local-read benchmark after materialization, not a sync-transport benchmark.
- `permission-change`
  - Compare only stacks where the harness is exercising a native auth-scoped replication path; unsupported is preferred over local-only filtering tricks.

## Current simplifications

- The first benchmark generation still uses benchmark-owned simplified auth/scoping setups rather than each product's full production policy stack.
- Permission-change convergence is currently verified for Syncular and for Electric through a benchmark-owned auth-scoped shape proxy; the remaining stacks are intentionally marked unsupported.
- Most scenarios still report benchmark-runner process metrics; reconnect-storm additionally captures sync-service and Postgres container CPU, memory, and network metrics.

## Interpretation guidance

- Do not compare `native` and `emulated` results as if they were the same product capability without calling out the difference.
- Do not treat `unsupported` as "slow." It means "not measured fairly in this harness."
- When presenting numbers publicly, link to the exact run summary and the methodology document together.
- Treat request/response counts and bytes as benchmark-path telemetry. Systems using long-lived streams or internal replication channels may surface lower or higher HTTP counts without that being the whole story by itself.
