# Deep Relationship Query

## Goal

Measure how well a stack answers screen-like local queries when the client has to traverse and aggregate across multiple related tables, not just a single large flat table.

## Dataset

- `1` organization
- `4` projects in that organization
- `100,000` tasks total
- related local tables:
  - `organizations`
  - `projects`
  - `tasks`

The scenario is intentionally shaped like a real app screen, not an abstract join microbenchmark.

## Queries

### Organization dashboard

For one organization, compute a per-project dashboard rollup:

- total task count
- completed task count
- open task count

This stresses:

- joins across `organizations -> projects -> tasks`
- `GROUP BY`
- filtered aggregates

### Project detail join

For one project, load the first `100` tasks together with their parent project and organization metadata.

This stresses:

- selective multi-table joins
- detail-view style fan-in reads

## Metrics

- `dashboard_query_p50_ms`
- `dashboard_query_p95_ms`
- `detail_join_query_p50_ms`
- `detail_join_query_p95_ms`
- `avg_memory_mb`
- `peak_memory_mb`
- `avg_cpu_pct`
- `peak_cpu_pct`

## Support policy

- `native`: the stack exposes a real local relational query path that can answer these workloads directly from local state
- `unsupported`: the harness would need to invent extra benchmark-owned query behavior that is not part of the stack’s normal client model

## Notes

- This scenario is separate from `local-query`.
- `local-query` focuses on filtered list/search/dashboard reads against one main table.
- `deep-relationship-query` exists to expose how well a client handles relationship-heavy local reads once multiple related tables are synced.
