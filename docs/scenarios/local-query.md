# Local Query

This scenario measures query efficiency after the client already holds a fully synced local view.

## Workload

1. Seed a single-project dataset with `100,000` tasks.
2. Materialize the client-local state fully.
3. Run 25 iterations of three screen-like local queries:
   - filtered list view
   - ID-prefix search
   - grouped aggregation

## Metrics

- `row_count`
- `iterations`
- `list_query_p50_ms`
- `list_query_p95_ms`
- `search_query_p50_ms`
- `search_query_p95_ms`
- `aggregate_query_p50_ms`
- `aggregate_query_p95_ms`
- `list_result_count`
- `search_result_count`
- `aggregate_result_count`
- `avg_memory_mb`
- `peak_memory_mb`
- `avg_cpu_pct`
- `peak_cpu_pct`

## Notes

- Syncular runs the workload on a fully materialized local Bun SQLite database populated through the direct sync protocol.
- Electric runs the workload on the fully materialized in-memory shape state.
- This is intentionally a separate query-efficiency benchmark, not a replication benchmark.
