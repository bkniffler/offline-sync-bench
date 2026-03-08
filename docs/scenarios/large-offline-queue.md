# Large Offline Queue

This scenario extends the baseline offline replay case with a larger queued write set.

## Workload

1. Seed a single-project dataset large enough to provide distinct replay targets.
2. Bootstrap a client locally.
3. Stop the sync service.
4. Queue a larger set of local writes while offline.
5. Restart the sync service.
6. Recreate or resume the client on the same local state.
7. Measure how long it takes the queued writes to clear and become visible locally.

## Default scale

- `20` queued writes

The default intentionally stays above the baseline `offline-replay` case without turning the standard benchmark run into a stress test.

## Metrics

- `queue_<n>_queued_writes`
- `queue_<n>_convergence_ms`
- `queue_<n>_request_count`
- `queue_<n>_bytes_transferred`
- `queue_<n>_avg_memory_mb`
- `queue_<n>_peak_memory_mb`
- `queue_<n>_avg_cpu_pct`
- `queue_<n>_peak_cpu_pct`

## Notes

- Syncular uses the real durable outbox persisted in the local client database.
- Electric uses an explicit benchmark-owned Bun SQLite outbox and is therefore marked `emulated`.
- Larger queue sweeps can still be run ad hoc, but the default scenario is kept practical for repeatable local development runs.
