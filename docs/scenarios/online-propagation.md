# Online propagation

## Goal

Measure end-to-end visibility from a write on client A to visible state on client B.

## Workload

- Start two clients with overlapping access to the same project.
- Perform a write on client A.
- Measure the time until client B can read the new state locally.

## Primary metrics

- `write_ack_ms`
- `mirror_visible_p50_ms`
- `mirror_visible_p95_ms`
- `mirror_visible_p99_ms`

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

- Measure user-visible convergence, not only transport latency.
- Use each product’s intended write path rather than an artificial shortcut.
