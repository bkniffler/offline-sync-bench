# offline-sync-bench

Compare offline-first sync stacks using the same task app. The suite measures local queries, startup, edit delivery, offline recovery, conflicts, client scaling, access changes and attachments, and checks the returned data for correctness.

Includes Syncular JS/Rust, PowerSync, Turso, Zero, Electric, Electric + TanStack DB and experimental Jazz. Results describe each tested application and its guarantees.

## Latest results

**Latest available measurements · Apple M4 · local services · Syncular JS/Rust 0.17.0.** Times are **milliseconds; lower is faster**. Values are medians; query/edit timings summarize each run’s p50. An * marks earlier failures. A dash means no measurement; “Unavailable” means the tested adapter has no supported path for that case.

Collection dates, configurations, sample sizes and ranges are in the linked details. [Methods](./docs/methodology.md) · [Failure explanations](./docs/investigations/tuned-publication-failures.md)

### Local task queries

Filter a task list, search titles and count tasks by group across 100,000 already-loaded tasks. Each run measures 25 operations after five warmups.

| Client | Task list | Prefix search | Grouped counts |
| --- | ---: | ---: | ---: |
| Syncular JS | 0.020 ms | 0.010 ms | 3.88 ms |
| Syncular Rust | 0.020 ms | 0.020 ms | 3.54 ms |
| PowerSync | 0.110 ms | 0.110 ms | 4.39 ms |
| Turso | 0.070 ms | 0.100 ms | 13.82 ms |
| Zero | 0.110 ms | 0.140 ms | 63.87 ms |
| Electric | 1.27 ms | 0.885 ms | 3.46 ms |
| Electric + TanStack DB | 0.450 ms | 0.650 ms | 397.03 ms |
| Jazz v2 (experimental) | 1429.33 ms | 1435.88 ms | 2380.73 ms |

A controlled test confirmed that matching SQL indexes remove an avoidable sort. Syncular uses in-memory SQL here; PowerSync and Turso use file-backed stores. Sub-millisecond gaps are small in practice. [Index investigation](./docs/investigations/screen-index-effect.md). Electric filters/sorts arrays; TanStack uses indexed native queries; Jazz combines indexed search with JavaScript grouping.

[Workload details](./docs/benchmarks.md#local-screens) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#task-screens) · [Zero details](results/reports/tuned-v017-zero/results/reports/campaign-2026-09-09T11-26-05-626Z/DETAILS.md#task-screens) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#local-query)

### Queries across related records

Query 100,000 tasks across four projects. **Project detail** returns the first 100 tasks in one project, with each task’s title, project name and organization name. **Organization dashboard** summarizes all four projects with total, completed and open task counts, ordered by most open tasks.

| Client | Project detail | Organization dashboard |
| --- | ---: | ---: |
| Syncular JS | 0.020 ms | 5.20 ms |
| Syncular Rust | 0.040 ms | 4.73 ms |
| PowerSync | 0.170 ms | 5.79 ms |
| Turso | 0.200 ms | 23.58 ms |
| Zero | 0.210 ms | 47.96 ms |
| Electric | Unavailable | Unavailable |
| Electric + TanStack DB | 130.62 ms | 567.16 ms |
| Jazz v2 (experimental) | Unavailable | Unavailable |

Storage matches the local-query case. Zero uses native relationships with JavaScript aggregation; their separate costs have not been measured.

[Workload details](./docs/benchmarks.md#local-screens) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#relationship-screens) · [Zero details](results/reports/tuned-v017-zero/results/reports/campaign-2026-09-09T11-26-05-626Z/DETAILS.md#relationship-screens) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#deep-relationship-query)

### Starting with an empty client

Download data into a fresh client. These results use 100,000 tasks and warm services; details also cover 1,000/10,000 tasks and restarted services.

| Client | First correct screen | Complete local dataset |
| --- | ---: | ---: |
| Syncular JS | 370.43 ms | 403.98 ms |
| Syncular Rust | 953.75 ms | 946.63 ms |
| PowerSync | Timed out | Timed out |
| Turso | 2625.69 ms | 2828.21 ms |
| Zero | 2078.49 ms | 2089.18 ms |
| Electric | 376.61 ms | 379.25 ms |
| Electric + TanStack DB | 7908.41 ms | 8076.20 ms |
| Jazz v2 (experimental) | Timed out | Timed out |

PowerSync timed out at the initial 1,000-task stage and never reached this size. Screen and complete-dataset milestones are observed independently. Server storage and OS caches are retained. Electric and Zero load memory caches, so their “Complete local dataset” does not establish a persistent offline copy.

[Workload details](./docs/benchmarks.md#startup) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#initial-startup-100000-tasks) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#bootstrap)

### Reopening an offline replica

Open an existing 2,000-task store in a new process with the network blocked. Measure when the first screen and all expected rows become available.

| Client | First correct screen | All rows available |
| --- | ---: | ---: |
| Syncular JS | 53.14 ms | 55.48 ms |
| Syncular Rust | 46.89 ms | 52.74 ms |
| PowerSync | Timed out | Timed out |
| Turso | 40.95 ms * | 46.32 ms * |
| Zero | Unavailable | Unavailable |
| Electric | Unavailable | Unavailable |
| Electric + TanStack DB | 151.00 ms | 159.19 ms |
| Jazz v2 (experimental) | 134.94 ms | 166.01 ms |

PowerSync timed out during setup. Turso’s * marks an earlier connection failure. The OS file cache remains warm. Electric and Zero have no eligible persistent-reopen path in these tested configurations.

[Workload details](./docs/benchmarks.md#startup) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#persisted-replica-startup) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#replica-reopen)

### Sharing an edit

Make 50 title edits with 200 tasks loaded on independent writer and reader clients. Measure local commit, observed server acceptance and visibility on the reader.

| Client | Local commit | Server accepted | Reader visible |
| --- | ---: | ---: | ---: |
| Syncular JS | 0.110 ms | 10.03 ms | 6.22 ms |
| Syncular Rust | 0.150 ms | 11.67 ms | 7.31 ms |
| PowerSync | 0.350 ms | 322.82 ms | 1005.13 ms |
| Turso | 0.120 ms | 24.23 ms | 25.93 ms |
| Zero | 0.360 ms | 15.14 ms | 15.65 ms |
| Electric | — | 1.58 ms | 2.22 ms |
| Electric + TanStack DB | — | 3.00 ms | 5.24 ms |
| Jazz v2 (experimental) | 0.320 ms | 8.54 ms | 9.11 ms |

These milestones overlap; local commit does not prove crash durability. PowerSync’s default 1,000 ms upload throttle may contribute to its delay, but that cause remains unproven. [Investigation](./docs/investigations/powersync-collaboration.md).

[Workload details](./docs/benchmarks.md#collaboration) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#collaboration) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#online-propagation)

### Syncing edits after an outage

Queue ten writes against 2,000 tasks during a 20-second writer outage. Time queue completion and correct reader data after connectivity returns.

| Client | Queue completed | Reader visible |
| --- | ---: | ---: |
| Syncular JS | 70.72 ms | 71.79 ms |
| Syncular Rust | 94.52 ms | 97.18 ms |
| PowerSync | Setup failed | Setup failed |
| Turso | 43.04 ms | 46.97 ms |
| Zero | 134.07 ms | 129.62 ms |
| Electric | 20021.82 ms | 20019.48 ms |
| Electric + TanStack DB | 11111.22 ms | 11111.98 ms |
| Jazz v2 (experimental) | 586.18 ms | 340.84 ms |

PowerSync failed initial readiness before the outage. Queue completion and reader visibility have independent observers.

[Workload details](./docs/benchmarks.md#offline-recovery) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#offline-replay) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#offline-replay)

### Syncing a larger offline queue

Repeat recovery with 100, 500 and 1,000 queued writes. Each column measures time from reconnection until the reader has the correct data.

| Client | 100 writes | 500 writes | 1,000 writes |
| --- | ---: | ---: | ---: |
| Syncular JS | 407.14 ms | 1562.45 ms | 2985.25 ms |
| Syncular Rust | 394.40 ms | 1603.45 ms | 3058.36 ms |
| PowerSync | Setup failed | Setup failed | Setup failed |
| Turso | 35.63 ms | 38.30 ms | 92.48 ms |
| Zero | 577.68 ms | 3093.88 ms | 5194.49 ms |
| Electric | 11364.54 ms | 22174.49 ms | 19808.32 ms |
| Electric + TanStack DB | 23423.11 ms | 23247.82 ms | 18323.55 ms |
| Jazz v2 (experimental) | 1445.02 ms | 2561.66 ms | 5413.21 ms |

PowerSync failed setup. The cause of the large Turso/Syncular gap remains unmeasured.

[Workload details](./docs/benchmarks.md#offline-recovery) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#replay-scaling) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#large-offline-queue)

### Recovering queued edits after a crash

Queue 1,000 writes, kill the writer process, reopen the same store offline, then reconnect. Verify every pending edit survives and reaches the reader.

| Client | Reopen offline | Queue completed | Reader visible |
| --- | ---: | ---: | ---: |
| Syncular JS | 56.35 ms | 3421.95 ms | 3368.31 ms |
| Syncular Rust | 62.79 ms | 3364.58 ms | 3297.35 ms |
| PowerSync | Setup failed | Setup failed | Setup failed |
| Turso | 38.06 ms | 77.64 ms | 86.86 ms |
| Zero | Unavailable | Unavailable | Unavailable |
| Electric | 29.33 ms | 16433.91 ms | 16431.58 ms |
| Electric + TanStack DB | Unavailable | Unavailable | Unavailable |
| Jazz v2 (experimental) | 195.26 ms | 11780.65 ms | 10728.40 ms |

PowerSync failed setup before the crash test. Reopen time starts at process launch; recovery times start at network restoration. Electric’s durable outbox is benchmark-owned. TanStack and Zero use memory queues here and cannot establish crash recovery.

[Workload details](./docs/benchmarks.md#offline-recovery) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#offline-process-recovery) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#offline-restart)

### Two clients editing the same task

A queues an offline edit; B edits the same task online. Reconnect A and verify all three clients agree with the configured conflict policy.

| Client | Verified outcome | All clients agree |
| --- | --- | ---: |
| Syncular JS | B’s edit retained | 35.67 ms |
| Syncular Rust | B’s edit retained | 46.55 ms |
| PowerSync | Not measured | Setup failed |
| Turso | A’s replayed edit retained | 90.93 ms |
| Zero | A’s replayed edit retained | 3821.52 ms |
| Electric | A’s replayed edit retained | 190.27 ms |
| Electric + TanStack DB | A’s replayed edit retained | 855.28 ms |
| Jazz v2 (experimental) | B’s edit retained | 1012.84 ms |

The timings describe different conflict policies. Syncular rejects stale versions; Turso replays A’s title update. PowerSync failed setup. Electric, TanStack and Zero apply A’s arriving title update; Jazz retains B’s later-written field.

[Workload details](./docs/benchmarks.md#conflicting-edits) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#conflicting-edits) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#conflict-update-update)

### An offline edit racing with deletion

A queues an offline edit; B deletes that task online. Reconnect A and check that the deleted task stays deleted on all three clients.

| Client | Verified outcome | All clients agree |
| --- | --- | ---: |
| Syncular JS | Deletion retained | 34.35 ms |
| Syncular Rust | Deletion retained | 43.35 ms |
| PowerSync | Not measured | Setup failed |
| Turso | Deletion retained | 80.04 ms |
| Zero | Deletion retained | 3849.39 ms |
| Electric | Deletion retained | 504.95 ms |
| Electric + TanStack DB | Deletion retained | 823.76 ms |
| Jazz v2 (experimental) | Not established | Timed out |

Syncular rejects the stale write; Turso’s SQL UPDATE leaves the missing row deleted. This tests one ordered race, not every conflict interleaving. PowerSync failed setup. Jazz timed out without establishing deletion retention.

[Workload details](./docs/benchmarks.md#conflicting-edits) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#conflicting-edits) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#conflict-update-delete)

### Sending one edit to many clients

With 2,000 tasks on each reader, measure one live edit reaching every connected client. The columns show time until the slowest reader is correct.

| Client | 5 readers | 25 readers |
| --- | ---: | ---: |
| Syncular JS | 16.43 ms | 17.26 ms |
| Syncular Rust | 16.50 ms | 28.13 ms |
| PowerSync | Setup failed | Setup failed |
| Turso | 39.08 ms * | 534.47 ms * |
| Zero | 31.46 ms | 79.28 ms |
| Electric | 17.84 ms | 40.37 ms |
| Electric + TanStack DB | 16.33 ms | 32.24 ms |
| Jazz v2 (experimental) | 153.85 ms | 337.17 ms |

PowerSync failed setup before reader creation. Turso’s * marks an earlier disk-space failure during 25-reader setup.

[Workload details](./docs/benchmarks.md#connected-clients-and-reconnecting-clients) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#connected-client-fanout) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#connected-fanout)

### Many clients reconnecting together

Disconnect five or 25 readers, accumulate 100 updates, then restore their connections together. Measure time until every reader has the complete correct dataset.

| Client | 5 readers | 25 readers |
| --- | ---: | ---: |
| Syncular JS | 87.17 ms | 291.64 ms |
| Syncular Rust | 78.96 ms | 281.34 ms |
| PowerSync | Setup failed | Setup failed |
| Turso | 51.55 ms * | 119.52 ms * |
| Zero | 4279.02 ms | 4331.42 ms |
| Electric | 2304.59 ms | 3682.57 ms |
| Electric + TanStack DB | 1926.60 ms | 3628.66 ms |
| Jazz v2 (experimental) | 2145.69 ms | 6908.60 ms |

PowerSync failed setup. Turso’s * marks an earlier disk-space failure; retained storage and the maintenance pause affect the environment.

[Workload details](./docs/benchmarks.md#connected-clients-and-reconnecting-clients) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#reconnect-with-backlog) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#reconnect-storm)

### Removing access to a project

Revoke access to one of two 500-task projects. Measure removal of unauthorized rows while preserving the allowed project, both online and after reconnecting.

| Client | Online removal | Removal after reconnect |
| --- | ---: | ---: |
| Syncular JS | 14.25 ms | 10.04 ms |
| Syncular Rust | 18.35 ms | 13.30 ms |
| PowerSync | 1057.20 ms | 6496.84 ms |
| Turso | Unavailable | Unavailable |
| Zero | 67.46 ms | 5028.48 ms |
| Electric | 42.41 ms | 46.46 ms |
| Electric + TanStack DB | 53.77 ms | 63.64 ms |
| Jazz v2 (experimental) | Timed out | Timed out |

Syncular uses explicit synchronization; PowerSync uses continuous synchronization. Turso’s tested adapter has no equivalent row-revocation case. Local removal cannot erase previously copied data. Electric and TanStack rebuild the application cache; Zero invalidates its native memory cache. These provide different guarantees from persistent native purge. Jazz timed out.

[Workload details](./docs/benchmarks.md#access-revocation) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#access-revocation-native-purge) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#permission-change)

### Uploading and downloading attachments

Transfer two 2 MiB objects linked to tasks. Measure upload, an uncached download and recovery after an interrupted download; verify the complete object hashes.

| Client | Upload | Fresh download | Download retry |
| --- | ---: | ---: | ---: |
| Syncular JS | 30.53 ms | 28.57 ms | 18.52 ms |
| Syncular Rust | Timed out | Timed out | Timed out |
| PowerSync | Unavailable | Unavailable | Unavailable |
| Turso | Unavailable | Unavailable | Unavailable |
| Zero | Unavailable | Unavailable | Unavailable |
| Electric | Unavailable | Unavailable | Unavailable |
| Electric + TanStack DB | Unavailable | Unavailable | Unavailable |
| Jazz v2 (experimental) | Unavailable | Unavailable | Unavailable |

Rust timed out during reader preparation. Only the Syncular JS adapter measured transfers. Download recovery retries the full object.

[Workload details](./docs/benchmarks.md#attachments) · [SQL details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#attachments) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#blob-flow)

## Run a benchmark

Install Bun and start Docker, then:

```sh
bun install --frozen-lockfile
bun run bench:run -- --stack syncular --scenario local-query
```

The harness resets the selected stack’s benchmark fixtures. [Running campaigns and publishing results](./docs/reporting.md) · [Benchmark definitions](./docs/benchmarks.md)
