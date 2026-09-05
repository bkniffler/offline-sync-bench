# Reconnect Storm

This scenario measures concurrent catch-up by already-bootstrapped clients.

## Workload

1. Seed one project with 200 tasks.
2. Bootstrap the selected number of clients, outside the measurement window.
3. Start service resource sampling and the convergence timer.
4. Write one changed task, then let all clients catch up simultaneously.
5. Stop the timer after every client's local query sees the new title.

Syncular JS and Rust default to a full sweep of **25, 100, 250, 500 and 1,000
clients**. Each case seeds a fresh dataset, restarts the service to clear state from the
previous fixture, then bootstraps its clients. Setup and restart are excluded
from the convergence timer; all clients are closed afterward.
Use `SYNCULAR_STORM_CLIENTS` or `SYNCULAR_RUST_STORM_CLIENTS` with one count or a
comma-separated list for a targeted run. Targeted runs do not constitute the
full report scale study.

The Syncular case uses concurrent HTTP sync rounds against a running service;
it does not restart the service. The Rust adapter runs one native process per
client. Electric uses its live shape subscriptions and its own reconnect flow.

## Metrics

- `clients_<count>_convergence_ms`
- `clients_<count>_request_count`, request/response bytes and total transfer
- `clients_<count>_sync_*`: container CPU, memory and network usage
- `clients_<count>_postgres_*`: database container CPU, memory and network usage
- Rust aggregate client-process memory

The resource summary displays the 500-client case. Resource metrics must carry
that count in their names; measurements from a different case cannot fill it.

Docker stats polling runs asynchronously, with one poll in flight at a time.
The initial sample finishes before the convergence timer starts; the final
sample is collected after it stops. These coarse container samples can extend
beyond the short convergence window. Earlier synchronous polling blocked the
harness event loop and inflated longer runs; results from that implementation
are excluded from medians for the corrected implementation.

A failed tier records its reason and does not erase successful tiers. The sweep
continues through the remaining counts. Transport/driver commands have bounded
timeouts so stalled requests become failures instead of hanging publication.
