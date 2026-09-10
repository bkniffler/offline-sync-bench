# PowerSync replacement measurements

This campaign runs the same fourteen task-app cases with the pinned PowerSync Node client and self-hosted service. It replaces the prior PowerSync samples; no old samples are pooled into these results. Every case has three independent attempts, including failures and unavailable adapters, in the predeclared randomized order.

Each fixture seed is followed by a no-op organization update as a replication barrier, a check that the service has reached the source WAL checkpoint, and native bucket compaction. Preparation finishes before measured clients open. Persistent server volumes and OS caches remain in place. The raw results include preparation timestamps and checkpoints. Existing physical SQLite indexes match the measured filters and ordering.

The harness validates complete records and expected screen output. Startup uses fresh client processes and stores; reopen and crash recovery reuse the declared persistent stores. Recovery blocks the network for twenty seconds before restoration. Local commit, server acceptance, queue completion and reader visibility are separate observations and may overlap.

Tables show independent-trial medians and observed ranges. Three attempts provide no confidence interval. Each raw result retains operation samples, correctness checks, resource windows and profiles. A failed latest attempt supplies no latency; an unavailable adapter makes no product-capability claim.

[Full benchmark definitions](https://github.com/bkniffler/offline-sync-bench/blob/main/docs/benchmarks.md) and [running instructions](https://github.com/bkniffler/offline-sync-bench/blob/main/docs/reporting.md) explain the workloads. The packaged source, dependency and configuration snapshots bind the exact implementation used here. The history-cleanup diagnostics are separate from comparison samples.
