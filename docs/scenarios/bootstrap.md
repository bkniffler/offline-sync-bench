# Bootstrap

## Goal

Measure cold-start time until a client can run a usable local query.

## Workload

- Seed the canonical benchmark dataset.
- Start from an empty local cache or local database.
- Attach one client.
- Measure the point at which a representative task query returns the expected rows locally.

## Dataset sizes

- 1k rows
- 10k rows
- 100k rows
- 250k rows (extended study)
- 500k rows (extended study)

## Primary metrics

- `time_to_first_query_ms`
- `rows_loaded`
- `request_count`
- `request_bytes`
- `response_bytes`
- `bytes_transferred`
- `avg_memory_mb`
- `peak_memory_mb`

## Additional resource metrics

- `avg_cpu_pct`
- `peak_cpu_pct`

## Notes

- Do not include container boot time in the measurement.
- The benchmark should target a real local query surface, not just “HTTP request finished”.

Syncular JS and Rust run all five sizes by default. Each scale restarts the
sync service before measuring a fresh client; a second fresh client then
measures warm-server bootstrap. Seeding and restart time are excluded.

Fixture seeding uses the server's normal storage write path. To keep large
fixture setup practical, the admin service temporarily indexes row-scope
lookups while seeding, then drops that index before declaring the seed ready.
The harness waits for that cleanup; the index is absent during every timed
bootstrap and sync measurement.
