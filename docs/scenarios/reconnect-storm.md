# Reconnect Storm

This scenario measures fan-in recovery after the sync service is restarted.

## Workload

1. Seed a single-project dataset with 200 tasks.
2. Bootstrap 25 clients against the same project.
3. Stop the sync service.
4. Start the sync service again.
5. Write one changed task after restart.
6. Measure how long it takes all clients to observe the changed title.

## Metrics

- `client_count`
- `reconnect_convergence_ms`
- `request_count`
- `request_bytes`
- `response_bytes`
- `bytes_transferred`
- `sync_avg_cpu_pct`
- `sync_peak_cpu_pct`
- `sync_avg_memory_mb`
- `sync_peak_memory_mb`
- `sync_rx_network_mb`
- `sync_tx_network_mb`
- `postgres_avg_cpu_pct`
- `postgres_peak_cpu_pct`
- `postgres_avg_memory_mb`
- `postgres_peak_memory_mb`
- `postgres_rx_network_mb`
- `postgres_tx_network_mb`

## Notes

- The goal is server-side recovery and fanout pressure, not first bootstrap cost.
- Syncular measures already-bootstrapped HTTP clients catching up after restart.
- Electric measures already-bootstrapped live-shape clients resuming after restart.
- Resource metrics are sampled from Docker container stats during the recovery window.
