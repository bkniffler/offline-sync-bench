# Offline replay

## Goal

Measure how a system handles queued writes after a client goes offline and later reconnects.

## Workload

- Start one client online, then disconnect it.
- Queue a fixed batch of writes while offline.
- Restore connectivity.
- Measure convergence, replay success, and conflict outcomes.

## Primary metrics

- `queued_write_count`
- `reconnect_convergence_ms`
- `conflict_count`
- `replayed_write_success_rate`

## Additional resource metrics

- `request_count`
- `request_bytes`
- `response_bytes`
- `bytes_transferred`
- `avg_memory_mb`
- `peak_memory_mb`
- `avg_cpu_pct`
- `peak_cpu_pct`

## Notes

- If a system does not provide an offline write path, mark the scenario unsupported.
- Do not hide unsupported scenarios by adding a custom application outbox unless that becomes part of a clearly labeled second benchmark class.
