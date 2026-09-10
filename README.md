# offline-sync-bench

Compare offline-first sync stacks using the same task app. The suite measures local queries, startup, edit delivery, offline recovery, conflicts, client scaling, access changes and attachments, and checks the returned data for correctness.

Includes Syncular JS/Rust, PowerSync, Turso, Zero, Electric, Electric + TanStack DB and experimental Jazz. Results describe each tested application and its guarantees.

## Latest results

**Latest available measurements · Apple M4 · local services · Syncular JS/Rust 0.17.0.** Latency is shown in **milliseconds; lower is faster**. Client JavaScript sizes use **KiB**. Latency values are medians; query/edit timings summarize each run’s p50. Starred entries are explained below each table. “Not supported” means the library lacks the native feature required by that test. Benchmark implementation gaps are work to fix, not product limitations.

Collection dates, configurations, sample sizes and ranges are in the linked details. [Methods](./docs/methodology.md) · [Missing-case review](./docs/investigations/missing-coverage.md) · [Failure explanations](./docs/investigations/tuned-publication-failures.md)

### Local task queries

Filter a task list, search titles and count tasks by group across 100,000 already-loaded tasks. Each run measures 25 operations after five warmups.

| Client | Task list | Prefix search | Grouped counts |
| --- | ---: | ---: | ---: |
| Syncular JS | 0.020 ms | 0.010 ms | 3.88 ms |
| Syncular Rust | 0.020 ms | 0.020 ms | 3.54 ms |
| PowerSync | 0.110 ms | 0.120 ms | 4.22 ms |
| Turso | 0.070 ms | 0.100 ms | 13.82 ms |
| Zero | 0.110 ms | 0.140 ms | 63.87 ms |
| Electric | 1.27 ms | 0.885 ms | 3.46 ms |
| Electric + TanStack DB | 0.450 ms | 0.650 ms | 397.03 ms |
| Jazz v2 (experimental) | 1429.33 ms | 1435.88 ms | 2380.73 ms |

A controlled test confirmed that matching SQL indexes remove an avoidable sort. Syncular uses in-memory SQL here; PowerSync and Turso use file-backed stores. Sub-millisecond gaps are small in practice. [Index investigation](./docs/investigations/screen-index-effect.md). Electric filters/sorts arrays; TanStack uses indexed native queries; Jazz combines indexed search with JavaScript grouping.

[Workload details](./docs/benchmarks.md#local-screens) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#task-screens) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#task-screens) · [Zero details](results/reports/tuned-v017-zero/results/reports/campaign-2026-09-09T11-26-05-626Z/DETAILS.md#task-screens) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#local-query)

### Queries across related records

Query 100,000 tasks across four projects. **Project detail** returns the first 100 tasks in one project, with each task’s title, project name and organization name. **Organization dashboard** summarizes all four projects with total, completed and open task counts, ordered by most open tasks.

| Client | Project detail | Organization dashboard |
| --- | ---: | ---: |
| Syncular JS | 0.020 ms | 5.20 ms |
| Syncular Rust | 0.040 ms | 4.73 ms |
| PowerSync | 0.170 ms | 5.55 ms |
| Turso | 0.200 ms | 23.58 ms |
| Zero | 0.210 ms | 47.96 ms |
| Electric | <0.005 ms \* | 0.120 ms \* |
| Electric + TanStack DB | 130.62 ms | 567.16 ms |
| Jazz v2 (experimental) | 7476.44 ms \*\* | 2684.66 ms \*\* |

\* One run (n=1); run-to-run variability is unknown. Electric uses application lookup/order indexes over native shapes; dashboard counts are computed per query. “<0.005 ms” is below the saved p50’s 0.01 ms rounding precision; raw operation samples remain available.

\*\* One run (n=1); run-to-run variability is unknown. Jazz uses native relationship includes for detail and materializes rows for JavaScript dashboard aggregation. Their separate costs are not isolated.

Storage matches the local-query case. Zero uses native relationships with JavaScript aggregation; their separate costs have not been measured.

[Workload details](./docs/benchmarks.md#local-screens) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#relationship-screens) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#relationship-screens) · [Zero details](results/reports/tuned-v017-zero/results/reports/campaign-2026-09-09T11-26-05-626Z/DETAILS.md#relationship-screens) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#deep-relationship-query) · [Repaired case details](results/reports/coverage-fixes/results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md#relationship-screens)

### Starting with an empty client

Download data into a fresh client. These results use 100,000 tasks and warm services; details also cover 1,000/10,000 tasks and restarted services.

| Client | First correct screen | Complete local dataset |
| --- | ---: | ---: |
| Syncular JS | 370.43 ms | 403.98 ms |
| Syncular Rust | 953.75 ms | 946.63 ms |
| PowerSync | 2652.49 ms | 2844.49 ms |
| Turso | 2625.69 ms | 2828.21 ms |
| Zero | 2078.49 ms | 2089.18 ms |
| Electric | 376.61 ms | 379.25 ms |
| Electric + TanStack DB | 7908.41 ms | 8076.20 ms |
| Jazz v2 (experimental) | Not reached \* | Not reached \* |

\* Cold 100k startup exceeded 90 seconds; warm startup was never reached.

Screen and complete-dataset milestones are observed independently. Server storage and OS caches are retained. PowerSync compacts fixture history before timing; the earlier setup failures came from missing maintenance in this harness. [Explanation](./docs/investigations/tuned-publication-failures.md). Electric and Zero load memory caches, so their “Complete local dataset” does not establish a persistent offline copy.

[Workload details](./docs/benchmarks.md#startup) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#initial-startup-100000-tasks) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#initial-startup-100000-tasks) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#bootstrap)

### Reopening an offline replica

Open an existing 2,000-task store in a new process with the network blocked. Measure when the first screen and all expected rows become available.

| Client | First correct screen | All rows available |
| --- | ---: | ---: |
| Syncular JS | 53.14 ms | 55.48 ms |
| Syncular Rust | 46.89 ms | 52.74 ms |
| PowerSync | 197.66 ms | 202.65 ms |
| Turso | 40.95 ms \* | 46.32 ms \* |
| Zero | 90.87 ms \*\* | 92.55 ms \*\* |
| Electric | 25.29 ms \*\*\* | 26.78 ms \*\*\* |
| Electric + TanStack DB | 151.00 ms | 159.19 ms |
| Jazz v2 (experimental) | 134.94 ms | 166.01 ms |

\* One earlier attempt lost its connection during initial sync; these medians use the two successful runs. The cause remains unknown.

\*\* One run (n=1); run-to-run variability is unknown. Zero reopens its native SQLite store. A two-second preparation wait lets scheduled persistence finish before close; it is outside the timing.

\*\*\* One run (n=1); run-to-run variability is unknown. Electric reopens an application-owned SQLite cache.

The OS file cache remains warm.

[Workload details](./docs/benchmarks.md#startup) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#persisted-replica-startup) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#persisted-replica-startup) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#replica-reopen) · [Repaired case details](results/reports/coverage-fixes/results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md#persisted-replica-startup)

### Sharing an edit

Make 50 title edits with 200 tasks loaded on independent writer and reader clients. Measure local commit, observed server acceptance and visibility on the reader.

| Client | Local commit | Server accepted | Reader visible |
| --- | ---: | ---: | ---: |
| Syncular JS | 0.110 ms | 10.03 ms | 6.22 ms |
| Syncular Rust | 0.150 ms | 11.67 ms | 7.31 ms |
| PowerSync | 0.270 ms | 984.92 ms | 1003.20 ms |
| Turso | 0.120 ms | 24.23 ms | 25.93 ms |
| Zero | 0.360 ms | 15.14 ms | 15.65 ms |
| Electric | Not supported \* | Not supported \* | Not supported \* |
| Electric + TanStack DB | Not measured \*\* | 3.00 ms | 5.24 ms |
| Jazz v2 (experimental) | 0.320 ms | 8.54 ms | 9.11 ms |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

\*\* The adapter deliberately disables localCommit even though the collection exposes the optimistic local update; that is not a durable queue receipt.

These milestones overlap; local commit does not prove crash durability. PowerSync’s default 1,000 ms upload throttle may contribute to its delay, but that cause remains unproven. [Investigation](./docs/investigations/powersync-collaboration.md).

[Workload details](./docs/benchmarks.md#collaboration) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#collaboration) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#collaboration) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#online-propagation)

### Syncing edits after an outage

Queue ten writes against 2,000 tasks during a 20-second writer outage. Time queue completion and correct reader data after connectivity returns.

| Client | Queue completed | Reader visible |
| --- | ---: | ---: |
| Syncular JS | 70.72 ms | 71.79 ms |
| Syncular Rust | 94.52 ms | 97.18 ms |
| PowerSync | 51.13 ms | 133.38 ms |
| Turso | 43.04 ms | 46.97 ms |
| Zero | 134.07 ms | 129.62 ms |
| Electric | Not supported \* | Not supported \* |
| Electric + TanStack DB | 11111.22 ms | 11111.98 ms |
| Jazz v2 (experimental) | 586.18 ms | 340.84 ms |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

Queue completion and reader visibility have independent observers.

[Workload details](./docs/benchmarks.md#offline-recovery) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#offline-replay) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#offline-replay) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#offline-replay)

### Syncing a larger offline queue

Repeat recovery with 100, 500 and 1,000 queued writes. Each column measures time from reconnection until the reader has the correct data.

| Client | 100 writes | 500 writes | 1,000 writes |
| --- | ---: | ---: | ---: |
| Syncular JS | 407.14 ms | 1562.45 ms | 2985.25 ms |
| Syncular Rust | 394.40 ms | 1603.45 ms | 3058.36 ms |
| PowerSync | 560.21 ms | 2263.44 ms | 4356.07 ms |
| Turso | 35.63 ms | 38.30 ms | 92.48 ms |
| Zero | 577.68 ms | 3093.88 ms | 5194.49 ms |
| Electric | Not supported \* | Not supported \* | Not supported \* |
| Electric + TanStack DB | 23423.11 ms | 23247.82 ms | 18323.55 ms |
| Jazz v2 (experimental) | 1445.02 ms | 2561.66 ms | 5413.21 ms |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

The cause of the large Turso/Syncular gap remains unmeasured.

[Workload details](./docs/benchmarks.md#offline-recovery) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#replay-scaling) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#replay-scaling) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#large-offline-queue)

### Recovering queued edits after a crash

Queue 1,000 writes, kill the writer process, reopen the same store offline, then reconnect. Verify every pending edit survives and reaches the reader.

| Client | Reopen offline | Queue completed | Reader visible |
| --- | ---: | ---: | ---: |
| Syncular JS | 56.35 ms | 3421.95 ms | 3368.31 ms |
| Syncular Rust | 62.79 ms | 3364.58 ms | 3297.35 ms |
| PowerSync | 194.33 ms | 5112.17 ms | 5167.18 ms |
| Turso | 38.06 ms | 77.64 ms | 86.86 ms |
| Zero | Needs persistent test \* | Needs persistent test \* | Needs persistent test \* |
| Electric | Not supported \*\* | Not supported \*\* | Not supported \*\* |
| Electric + TanStack DB | 330.41 ms \*\*\* | 18091.82 ms \*\*\* | 18096.21 ms \*\*\* |
| Jazz v2 (experimental) | 195.26 ms | 11780.65 ms | 10728.40 ms |

\* Memory storage explains the current skip, but IndexedDB alone does not prove immediate crash durability. Zero limits offline writes by connection state.

\*\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

\*\*\* One run (n=1); run-to-run variability is unknown. The native executor restores all 1,000 transactions from an application-supplied SQLite storage adapter.

Reopen time starts at process launch; recovery times start at network restoration.

[Workload details](./docs/benchmarks.md#offline-recovery) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#offline-process-recovery) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#offline-process-recovery) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#offline-restart) · [Repaired case details](results/reports/coverage-fixes/results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md#offline-process-recovery)

### Two clients editing the same task

A queues an offline edit; B edits the same task online. Reconnect A and verify all three clients agree with the configured conflict policy.

| Client | Verified outcome | All clients agree |
| --- | --- | ---: |
| Syncular JS | B’s edit retained | 35.67 ms |
| Syncular Rust | B’s edit retained | 46.55 ms |
| PowerSync | A’s replayed edit retained | 50.44 ms |
| Turso | A’s replayed edit retained | 90.93 ms |
| Zero | A’s replayed edit retained | 3821.52 ms |
| Electric | Not supported \* | Not supported \* |
| Electric + TanStack DB | A’s replayed edit retained | 855.28 ms |
| Jazz v2 (experimental) | B’s edit retained | 1012.84 ms |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

The timings describe different conflict policies. Syncular rejects stale versions; PowerSync and Turso replay A’s title update. TanStack and Zero apply A’s arriving title update; Jazz retains B’s later-written field.

[Workload details](./docs/benchmarks.md#conflicting-edits) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#conflicting-edits) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#conflicting-edits) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#conflict-update-update)

### An offline edit racing with deletion

A queues an offline edit; B deletes that task online. Reconnect A and check that the deleted task stays deleted on all three clients.

| Client | Verified outcome | All clients agree |
| --- | --- | ---: |
| Syncular JS | Deletion retained | 34.35 ms |
| Syncular Rust | Deletion retained | 43.35 ms |
| PowerSync | Deletion retained | 164.32 ms |
| Turso | Deletion retained | 80.04 ms |
| Zero | Deletion retained | 3849.39 ms |
| Electric | Not supported \* | Not supported \* |
| Electric + TanStack DB | Deletion retained | 823.76 ms |
| Jazz v2 (experimental) | Not established \*\* | Did not converge \*\* |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

\*\* Writer and other clients disagree after acknowledged writes and a 90-second deadline.

Syncular rejects the stale write; PowerSync and Turso’s SQL UPDATE leaves the missing row deleted. This tests one ordered race, not every conflict interleaving.

[Workload details](./docs/benchmarks.md#conflicting-edits) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#conflicting-edits) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#conflicting-edits) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#conflict-update-delete)

### Sending one edit to many clients

With 2,000 tasks on each reader, measure one live edit reaching every connected client. The columns show time until the slowest reader is correct.

| Client | 5 readers | 25 readers |
| --- | ---: | ---: |
| Syncular JS | 16.43 ms | 17.26 ms |
| Syncular Rust | 16.50 ms | 28.13 ms |
| PowerSync | 723.54 ms | 595.21 ms |
| Turso | 39.08 ms \* | 534.47 ms \* |
| Zero | 31.46 ms | 79.28 ms |
| Electric | Not supported \*\* | Not supported \*\* |
| Electric + TanStack DB | 16.33 ms | 32.24 ms |
| Jazz v2 (experimental) | 153.85 ms | 337.17 ms |

\* One earlier attempt ran out of disk space during 25-reader setup; these medians use the two successful runs.

\*\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

PowerSync’s observed ranges overlap at five and 25 readers; the lower 25-reader median does not establish a speedup.

[Workload details](./docs/benchmarks.md#connected-clients-and-reconnecting-clients) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#connected-client-fanout) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#connected-client-fanout) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#connected-fanout)

### Many clients reconnecting together

Disconnect five or 25 readers, accumulate 100 updates, then restore their connections together. Measure time until every reader has the complete correct dataset.

| Client | 5 readers | 25 readers |
| --- | ---: | ---: |
| Syncular JS | 87.17 ms | 291.64 ms |
| Syncular Rust | 78.96 ms | 281.34 ms |
| PowerSync | 36.74 ms | 153.73 ms |
| Turso | 51.55 ms \* | 119.52 ms \* |
| Zero | 4279.02 ms | 4331.42 ms |
| Electric | Not supported \*\* | Not supported \*\* |
| Electric + TanStack DB | 1926.60 ms | 3628.66 ms |
| Jazz v2 (experimental) | 2145.69 ms | 6908.60 ms |

\* One earlier attempt ran out of disk space during 25-reader setup; these medians use the two successful runs.

\*\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

Retained storage and the maintenance pause affect the environment.

[Workload details](./docs/benchmarks.md#connected-clients-and-reconnecting-clients) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#reconnect-with-backlog) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#reconnect-with-backlog) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#reconnect-storm)

### Removing access to a project

Revoke access to one of two 500-task projects. Measure removal of unauthorized rows while preserving the allowed project, both online and after reconnecting.

| Client | Online removal | Removal after reconnect |
| --- | ---: | ---: |
| Syncular JS | 14.25 ms | 10.04 ms |
| Syncular Rust | 18.35 ms | 13.30 ms |
| PowerSync | 52.14 ms | 4693.80 ms |
| Turso | No equivalent \* | No equivalent \* |
| Zero | 67.46 ms | 5028.48 ms |
| Electric | 42.41 ms | 46.46 ms |
| Electric + TanStack DB | 53.77 ms | 63.64 ms |
| Jazz v2 (experimental) | Purge timed out \*\* | Purge timed out \*\* |

\* The pinned local sync server exposes database replication, not per-actor row revocation while retaining other actors and server data. Lazy page fetching is not authorization filtering.

\*\* The 60,000 ms purge deadline expires: online queries hide revoked rows but local storage retains them; reconnect also leaves queries stale. Fresh-client authorization passes.

Syncular uses explicit synchronization; PowerSync uses continuous synchronization. Local removal cannot erase previously copied data. Electric and TanStack rebuild the application cache; Zero invalidates its native memory cache. These provide different guarantees from persistent native purge.

[Workload details](./docs/benchmarks.md#access-revocation) · [Syncular/Turso details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#access-revocation-native-purge) · [PowerSync details](results/reports/powersync-maintained/results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md#access-revocation-native-purge) · [Other client details](results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md#permission-change)

### Uploading and downloading attachments

Transfer two 2 MiB objects linked to tasks. Measure upload, an uncached download and recovery after an interrupted download; verify the complete object hashes.

| Client | Upload | Fresh download | Download retry |
| --- | ---: | ---: | ---: |
| Syncular JS | 30.53 ms | 28.57 ms | 18.52 ms |
| Syncular Rust | 20.08 ms \* | 47.96 ms \* | 38.90 ms \* |
| PowerSync | 21.06 ms \*\* | 53.15 ms \*\* | 10.91 ms \*\* |
| Turso | Not supported \*\*\* | Not supported \*\*\* | Not supported \*\*\* |
| Zero | Not supported \*\*\* | Not supported \*\*\* | Not supported \*\*\* |
| Electric | Not supported \*\*\*\* | Not supported \*\*\*\* | Not supported \*\*\*\* |
| Electric + TanStack DB | Not supported \*\*\* | Not supported \*\*\* | Not supported \*\*\* |
| Jazz v2 (experimental) | 201.37 ms \*\*\*\*\* | 205.93 ms \*\*\*\*\* | 685.48 ms \*\*\*\*\* |

\* One run (n=1); run-to-run variability is unknown. Early WebSocket frames are now buffered while the server session opens; upload and interrupted-download checks pass.

\*\* One run (n=1). Uses PowerSync’s experimental native attachment queue and streaming transport with MinIO. Upload excludes file staging; download retry follows an HTTP cut after 64 KiB.

\*\*\* This library has no native attachment storage and transfer API. An application-provided uploader is outside this benchmark.

\*\*\*\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

\*\*\*\*\* One run (n=1). Uses Jazz’s native 256 KiB file chunks. Upload includes chunk creation and edge persistence; retry follows a disconnect after the first chunk and reuses the native cache. These boundaries differ from the object-store clients.

Syncular and PowerSync retry object-store downloads; Jazz reads native synced chunks. The footnotes explain the different upload and retry boundaries.

[Workload details](./docs/benchmarks.md#attachments) · [Syncular JS details](results/reports/tuned-v017-sql/results/reports/campaign-2026-09-08T22-58-56-419Z/DETAILS.md#attachments) · [Syncular Rust details](results/reports/coverage-fixes/results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md#attachments) · [PowerSync and Jazz details](results/reports/native-files/results/reports/campaign-2026-09-10T11-43-03-468Z/DETAILS.md#attachments)

### Uploading and downloading a 500 MB file

Upload one 500,000,000-byte file linked to a task, then download it in a new process with an empty client cache. Upload includes native staging; download ends when complete bytes are materialized. Verify the full SHA-256 hash. One run per client (n=1), using local services; file preparation and final hash validation are outside the clock.

| Client | Upload | Fresh download |
| --- | ---: | ---: |
| Syncular JS | 3522.82 ms | 2306.69 ms |
| Syncular Rust | 3253.71 ms \* | 3041.53 ms \* |
| PowerSync | 1175.71 ms \*\* | 604.40 ms \*\* |
| Turso | Not supported \*\*\* | Not supported \*\*\* |
| Zero | Not supported \*\*\* | Not supported \*\*\* |
| Electric | Not supported \*\*\* | Not supported \*\*\* |
| Electric + TanStack DB | Not supported \*\*\* | Not supported \*\*\* |
| Jazz v2 (experimental) | 49314.22 ms \*\*\*\* | 60176.33 ms \*\*\*\* |

\* Rust uses its published native blob API, which materializes bytes as hex internally. That conversion is included; the harness returns only a hash receipt over stdio.

\*\* PowerSync uses its experimental native attachment queue and filesystem transport.

\*\*\* These libraries have no native attachment upload/download feature; Electric is read-only.

\*\*\*\* Jazz uses its default 256 KiB chunks (1,908 parts). Its native helper awaits each part insertion; the other measured clients transfer whole objects through MinIO.

[Workload, cached fixture and raw results](./results/large-files/README.md)

### Client JavaScript size

Build a browser bundle exporting each client’s sync API. Measure all emitted JavaScript after minification and gzip compression. **JavaScript only:** additional WASM, runtime-loaded workers and storage engines are excluded. Smaller is better; 1 KiB = 1,024 bytes.

| Client | Minified JS | Gzip JS |
| --- | ---: | ---: |
| Syncular JS | 116.89 KiB | 34.57 KiB |
| Syncular Rust | Not applicable \* | Not applicable \* |
| PowerSync | 525.36 KiB | 160.46 KiB |
| Turso | Not applicable \* | Not applicable \* |
| Zero | 302.94 KiB | 94.90 KiB |
| Electric | 55.47 KiB | 17.42 KiB |
| Electric + TanStack DB | 240.21 KiB | 68.42 KiB |
| Jazz v2 (experimental) | 289.98 KiB | 83.04 KiB |

\* Syncular Rust and Turso use native clients in these benchmarks, so browser JavaScript size does not apply to those tested clients. PowerSync’s size uses its Web SDK; its latency tests use Node.

[Build details and exact imports](./results/client-size/README.md) · [Scope and excluded assets](./docs/appendices/deployment-footprint.md)

## Run a benchmark

Install Bun and start Docker, then:

```sh
bun install --frozen-lockfile
bun run bench:run -- --stack syncular --scenario local-query
```

The harness resets the selected stack’s benchmark fixtures. [Running campaigns and publishing results](./docs/reporting.md) · [Benchmark definitions](./docs/benchmarks.md)
