# Retained September 7 results

Generated from the unchanged cases in the stopped, withdrawn September 7 campaign. These are historical estimates, not a newly completed campaign. Each cell shows its own successful-trial median, observed range and sample size; a failed latest trial has no timing. No samples are pooled with September 9.

[Archive and restoration](./README.md) · [Raw campaign archive](./campaign.tar.gz) · [Selected trial identities and hashes](../../diagnostics/publication-index-review/RETAINED-HISTORY.json) · [Current README](../../../README.md)

Source hash: `f6d23b446229ead3546f0e49c869e5150500c559446dfe349cb0e17e2cd8198b`. Jazz uses the experimental runtime. Exact profiles, configurations, operation samples and logs remain in the archive. Plain Electric write workflows are excluded from current tables; their archived custom-outbox results are not product write benchmarks.

## local-query

Filter a task list, search titles and count tasks by group across 100,000 already-loaded tasks. Each run measures 25 operations after five warmups.

| Client | Task list | Prefix search | Grouped counts |
| --- | ---: | ---: | ---: |
| Electric | 1.27 ms (1.16 ms–1.51 ms; n=4) | 0.885 ms (0.840 ms–1.06 ms; n=4) | 3.46 ms (3.33 ms–3.59 ms; n=4) |
| Electric + TanStack DB | 0.450 ms (0.430 ms–0.540 ms; n=5) | 0.650 ms (0.590 ms–0.810 ms; n=5) | 397.03 ms (388.71 ms–439.93 ms; n=5) |
| Jazz v2 (experimental) | 1429.33 ms (1407.03 ms–1524.43 ms; n=4) | 1435.88 ms (1338.08 ms–1730.14 ms; n=4) | 2380.73 ms (2223.61 ms–2561.81 ms; n=4) |

Electric filters/sorts arrays; TanStack uses indexed native queries; Jazz combines indexed search with JavaScript grouping.

- **Electric**: javascript-map; application-processing. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Electric + TanStack DB**: tanstack-sqlite-persistence; native-reactive-query. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; mixed-native-and-application. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## deep-relationship-query

Query 100,000 tasks across four projects. **Project detail** returns the first 100 tasks in one project, with each task’s title, project name and organization name. **Organization dashboard** summarizes all four projects with total, completed and open task counts, ordered by most open tasks.

| Client | Project detail | Organization dashboard |
| --- | ---: | ---: |
| Electric + TanStack DB | 130.62 ms (127.53 ms–143.72 ms; n=4) | 567.16 ms (564.35 ms–600.59 ms; n=4) |



- **Electric + TanStack DB**: tanstack-sqlite-persistence; native-reactive-query. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## bootstrap

Download data into a fresh client. These results use 100,000 tasks and warm services; details also cover 1,000/10,000 tasks and restarted services.

| Client | First correct screen | Complete local dataset |
| --- | ---: | ---: |
| Electric | 376.61 ms (357.24 ms–382.75 ms; n=5) | 379.25 ms (359.74 ms–385.51 ms; n=5) |
| Electric + TanStack DB | 7908.41 ms (7528.03 ms–10875.02 ms; n=4) | 8076.20 ms (7668.44 ms–11303.35 ms; n=4) |
| Jazz v2 (experimental) | Not reached \* | Not reached \* |
| Zero | 2078.49 ms (1923.18 ms–2144.32 ms; n=4) | 2089.18 ms (1929.93 ms–2154.82 ms; n=4) |

\* Cold 100k startup exceeded 90 seconds; warm startup was never reached.

Electric and Zero load memory caches, so their “Complete local dataset” does not establish a persistent offline copy.

- **Electric**: electric-shape-memory; application-processing. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Jazz v2 (experimental)**: unspecified; unspecified. Outcomes: trial 1: timed-out, trial 2: timed-out, trial 3: timed-out, trial 4: timed-out, trial 5: timed-out.
- **Zero**: zero-memory; native-reactive-query. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## replica-reopen

Open an existing 2,000-task store in a new process with the network blocked. Measure when the first screen and all expected rows become available.

| Client | First correct screen | All rows available |
| --- | ---: | ---: |
| Electric + TanStack DB | 151.00 ms (145.62 ms–160.59 ms; n=4) | 159.19 ms (152.89 ms–169.36 ms; n=4) |
| Jazz v2 (experimental) | 134.94 ms (131.10 ms–379.75 ms; n=4) | 166.01 ms (161.58 ms–490.82 ms; n=4) |



- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## online-propagation

Make 50 title edits with 200 tasks loaded on independent writer and reader clients. Measure local commit, observed server acceptance and visibility on the reader.

| Client | Local commit | Server accepted | Reader visible |
| --- | ---: | ---: | ---: |
| Electric | Not supported \* | Not supported \* | Not supported \* |
| Electric + TanStack DB | Not measured \*\* | 3.00 ms (2.34 ms–3.28 ms; n=4) | 5.24 ms (4.66 ms–5.74 ms; n=4) |
| Jazz v2 (experimental) | 0.320 ms (0.280 ms–0.360 ms; n=4) | 8.54 ms (8.01 ms–8.68 ms; n=4) | 9.11 ms (9.02 ms–9.40 ms; n=4) |
| Zero | 0.360 ms (0.340 ms–0.410 ms; n=5) | 15.14 ms (14.70 ms–19.54 ms; n=5) | 15.65 ms (14.32 ms–19.80 ms; n=5) |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

\*\* The adapter deliberately disables localCommit even though the collection exposes the optimistic local update; that is not a durable queue receipt.



- **Electric**: javascript-map; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Electric + TanStack DB**: tanstack-sqlite-persistence; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Zero**: zero-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.

## offline-replay

Queue ten writes against 2,000 tasks during a 20-second writer outage. Time queue completion and correct reader data after connectivity returns.

| Client | Queue completed | Reader visible |
| --- | ---: | ---: |
| Electric | Not supported \* | Not supported \* |
| Electric + TanStack DB | 11111.22 ms (11092.79 ms–17217.40 ms; n=4) | 11111.98 ms (11094.51 ms–17219.52 ms; n=4) |
| Jazz v2 (experimental) | 586.18 ms (561.19 ms–892.33 ms; n=4) | 340.84 ms (324.00 ms–654.42 ms; n=4) |
| Zero | 134.07 ms (120.22 ms–151.52 ms; n=4) | 129.62 ms (111.65 ms–145.11 ms; n=4) |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.



- **Electric**: benchmark-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Zero**: zero-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## large-offline-queue

Repeat recovery with 100, 500 and 1,000 queued writes. Each column measures time from reconnection until the reader has the correct data.

| Client | 100 writes | 500 writes | 1,000 writes |
| --- | ---: | ---: | ---: |
| Electric | Not supported \* | Not supported \* | Not supported \* |
| Electric + TanStack DB | 23423.11 ms (11663.38 ms–25423.11 ms; n=5) | 23247.82 ms (19826.16 ms–27083.33 ms; n=5) | 18323.55 ms (16847.86 ms–29596.74 ms; n=5) |
| Jazz v2 (experimental) | 1445.02 ms (308.03 ms–1490.07 ms; n=4) | 2561.66 ms (1656.78 ms–5192.52 ms; n=4) | 5413.21 ms (2841.95 ms–10658.38 ms; n=4) |
| Zero | 577.68 ms (565.58 ms–946.05 ms; n=4) | 3093.88 ms (1981.79 ms–3415.16 ms; n=4) | 5194.49 ms (3769.32 ms–7318.82 ms; n=4) |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.



- **Electric**: benchmark-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Zero**: zero-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## offline-restart

Queue 1,000 writes, kill the writer process, reopen the same store offline, then reconnect. Verify every pending edit survives and reaches the reader.

| Client | Reopen offline | Queue completed | Reader visible |
| --- | ---: | ---: | ---: |
| Electric | Not supported \* | Not supported \* | Not supported \* |
| Jazz v2 (experimental) | 195.26 ms (191.77 ms–197.02 ms; n=4) | 11780.65 ms (10797.98 ms–18515.98 ms; n=4) | 10728.40 ms (7508.49 ms–11658.75 ms; n=4) |
| Zero | Needs persistent test \*\* | Needs persistent test \*\* | Needs persistent test \*\* |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

\*\* Memory storage explains the current skip, but IndexedDB alone does not prove immediate crash durability. Zero limits offline writes by connection state.



- **Electric**: benchmark-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Zero**: unspecified; unspecified. Outcomes: trial 1: unsupported, trial 2: unsupported, trial 3: unsupported, trial 4: unsupported.

## conflict-update-update

A queues an offline edit; B edits the same task online. Reconnect A and verify all three clients agree with the configured conflict policy.

| Client | Verified outcome | All clients agree |
| --- | --- | ---: |
| Electric | Not supported \* | Not supported \* |
| Electric + TanStack DB | A’s replayed edit retained | 855.28 ms (770.71 ms–1560.49 ms; n=5) |
| Jazz v2 (experimental) | B’s edit retained | 1012.84 ms (692.59 ms–1182.75 ms; n=4) |
| Zero | A’s replayed edit retained | 3821.52 ms (3551.29 ms–3848.83 ms; n=5) |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

TanStack and Zero apply A’s arriving title update; Jazz retains B’s later-written field.

- **Electric**: benchmark-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Zero**: zero-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.

## conflict-update-delete

A queues an offline edit; B deletes that task online. Reconnect A and check that the deleted task stays deleted on all three clients.

| Client | Verified outcome | All clients agree |
| --- | --- | ---: |
| Electric | Not supported \* | Not supported \* |
| Electric + TanStack DB | Deletion retained | 823.76 ms (816.20 ms–846.93 ms; n=4) |
| Jazz v2 (experimental) | Not established \*\* | Did not converge \*\* |
| Zero | Deletion retained | 3849.39 ms (3810.56 ms–3884.87 ms; n=4) |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

\*\* Writer and other clients disagree after acknowledged writes and a 90-second deadline.



- **Electric**: benchmark-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Jazz v2 (experimental)**: unspecified; unspecified. Outcomes: trial 1: timed-out, trial 2: timed-out, trial 3: timed-out, trial 4: timed-out, trial 5: timed-out.
- **Zero**: zero-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## connected-fanout

With 2,000 tasks on each reader, measure one live edit reaching every connected client. The columns show time until the slowest reader is correct.

| Client | 5 readers | 25 readers |
| --- | ---: | ---: |
| Electric | Not supported \* | Not supported \* |
| Electric + TanStack DB | 16.33 ms (15.05 ms–31.40 ms; n=4) | 32.24 ms (29.08 ms–37.53 ms; n=4) |
| Jazz v2 (experimental) | 153.85 ms (144.09 ms–187.04 ms; n=5) | 337.17 ms (290.29 ms–407.14 ms; n=5) |
| Zero | 31.46 ms (28.34 ms–46.32 ms; n=4) | 79.28 ms (59.42 ms–100.20 ms; n=4) |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.



- **Electric**: benchmark-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Zero**: zero-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## reconnect-storm

Disconnect five or 25 readers, accumulate 100 updates, then restore their connections together. Measure time until every reader has the complete correct dataset.

| Client | 5 readers | 25 readers |
| --- | ---: | ---: |
| Electric | Not supported \* | Not supported \* |
| Electric + TanStack DB | 1926.60 ms (965.72 ms–4204.44 ms; n=4) | 3628.66 ms (3022.35 ms–7635.45 ms; n=4) |
| Jazz v2 (experimental) | 2145.69 ms (1801.17 ms–2311.72 ms; n=4) | 6908.60 ms (6112.25 ms–9671.63 ms; n=4) |
| Zero | 4279.02 ms (4226.82 ms–4329.55 ms; n=4) | 4331.42 ms (4141.11 ms–4619.04 ms; n=4) |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.



- **Electric**: benchmark-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Jazz v2 (experimental)**: jazz-napi-sqlite-file; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.
- **Zero**: zero-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## permission-change

Revoke access to one of two 500-task projects. Measure removal of unauthorized rows while preserving the allowed project, both online and after reconnecting.

| Client | Online removal | Removal after reconnect |
| --- | ---: | ---: |
| Electric | 42.41 ms (24.34 ms–49.63 ms; n=5) | 46.46 ms (20.82 ms–62.29 ms; n=5) |
| Electric + TanStack DB | 53.77 ms (43.64 ms–87.09 ms; n=5) | 63.64 ms (51.39 ms–68.34 ms; n=5) |
| Jazz v2 (experimental) | Purge timed out \* | Purge timed out \* |
| Zero | 67.46 ms (53.80 ms–75.97 ms; n=4) | 5028.48 ms (4999.71 ms–5231.74 ms; n=4) |

\* The 60,000 ms purge deadline expires: online queries hide revoked rows but local storage retains them; reconnect also leaves queries stale. Fresh-client authorization passes.

Electric and TanStack rebuild the application cache; Zero invalidates its native memory cache. These provide different guarantees from persistent native purge.

- **Electric**: electric-shape-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Electric + TanStack DB**: tanstack-node-sqlite-cache; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed, trial 5: completed.
- **Jazz v2 (experimental)**: jazz-node-sqlite; unspecified. Outcomes: trial 1: timed-out, trial 2: timed-out, trial 3: timed-out, trial 4: timed-out.
- **Zero**: zero-memory; unspecified. Outcomes: trial 1: completed, trial 2: completed, trial 3: completed, trial 4: completed.

## blob-flow

Transfer two 2 MiB objects linked to tasks. Measure upload, an uncached download and recovery after an interrupted download; verify the complete object hashes.

| Client | Upload | Fresh download | Download retry |
| --- | ---: | ---: | ---: |
| Electric | Not supported \* | Not supported \* | Not supported \* |
| Electric + TanStack DB | Not implemented \*\* | Not implemented \*\* | Not implemented \*\* |
| Jazz v2 (experimental) | Not implemented \*\*\* | Not implemented \*\*\* | Not implemented \*\*\* |
| Zero | Not implemented \*\* | Not implemented \*\* | Not implemented \*\* |

\* Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.

\*\* No standalone attachment queue is wired for this adapter; the application can sync file references and use object storage.

\*\*\* Jazz 2 alpha has chunked file creation/loading APIs; our adapter returns a placeholder.



- **Electric**: unspecified; unspecified. Outcomes: trial 1: unsupported, trial 2: unsupported, trial 3: unsupported, trial 4: unsupported.
- **Electric + TanStack DB**: unspecified; unspecified. Outcomes: trial 1: unsupported, trial 2: unsupported, trial 3: unsupported, trial 4: unsupported.
- **Jazz v2 (experimental)**: unspecified; unspecified. Outcomes: trial 1: unsupported, trial 2: unsupported, trial 3: unsupported, trial 4: unsupported.
- **Zero**: unspecified; unspecified. Outcomes: trial 1: unsupported, trial 2: unsupported, trial 3: unsupported, trial 4: unsupported.
