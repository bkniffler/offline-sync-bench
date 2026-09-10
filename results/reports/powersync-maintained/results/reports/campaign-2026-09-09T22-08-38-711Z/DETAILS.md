# Benchmark results

Campaign `campaign-2026-09-09T22-08-38-711Z`. 3 independent trials per case, with seeded randomized order. Network: local service routes, no injected delay or loss. [Measurements and manifest](../../../archive/files/RESULTS.json.gz). [Methodology](../../../docs/methodology.md).

These measurements describe the listed runtime and workload profiles. A failed latest attempt remains failed; older successful attempts do not replace it. Confidence intervals resample independent trial medians. Results with fewer than five successful trials show the observed min–max range, not a confidence interval.

## Coverage and outcomes

| Stack | Case | Latest outcome | Passed / attempted | Comparison |
| --- | --- | --- | --- | --- |
| powersync | offline-restart | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | conflict-update-update | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | local-query | completed | 3 / 3 | native-sql |
| powersync | offline-replay | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | blob-flow | unsupported | 0 / 3 | Blob flow benchmarking is not implemented for PowerSync in this harness yet. |
| powersync | connected-fanout | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | large-offline-queue | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | conflict-update-delete | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | bootstrap | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | permission-change | completed | 3 / 3 | powersync-persistent-file |
| powersync | deep-relationship-query | completed | 3 / 3 | native-sql |
| powersync | reconnect-storm | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | replica-reopen | completed | 3 / 3 | powersync-node-sqlite-file |
| powersync | online-propagation | completed | 3 / 3 | powersync-node-sqlite-file |

[Individual trial files and logs](../../../archive/files/results/reports/campaign-2026-09-09T22-08-38-711Z/TRIALS.json.gz). The index includes every attempt and its outcome.

## Server storage preparation

retain existing server volumes and writable layers; scenario-specific logical fixture preparation.

Each attempt retains before/after Docker writable-layer bytes and mounted-path allocated KiB in its raw metadata. Startup additionally records each client boundary after fixture preparation. These are live observations, not logical payload sizes or evidence of normalized server state. Missing counters remain unavailable. Read-only configuration mounts are covered by the configuration artifact. In-memory caches, deleted-file storage and OS caches are outside these disk observations.


Outside this campaign: . These cases remain visible as coverage work; omission does not establish a missing product capability.

## Findings

### Native bucket compaction fixes the reproduced fresh-client setup failure.

Evidence: **confirmed**. The follow-up reproduced the initial-writer timeout with 2,000 current tasks and 5,980,513 global bucket operations. After native compaction, the same task fixture synchronized on direct and relayed fresh clients in about 755 ms and passed full-row validation. The bucket then contained 2,002 PUTs and one CLEAR. Those probes are diagnostic evidence, separate from the startup measurements below.

Fixture resets must include server-history maintenance. This campaign waits for replication and compacts before opening clients; it retains server volumes and keeps preparation outside client timing.

- [Original fixture and operation counts](../../../archive/files/evidence/history/BEFORE.json.gz)
- [Reproduced setup failure](../../../archive/files/evidence/history/reproduction-before.json.gz)
- [Direct client after compaction with full-row validation](../../../evidence/history/after-direct.jsonl)
- [Relayed client after compaction with full-row validation](../../../evidence/history/after-relay.jsonl)
- [One-time cleanup using the pinned native compactor](../../../evidence/history/compact-large-batches.mjs)

### Crash recovery now reaches the intended queue-survival test.

Evidence: **confirmed**. The harness queues 1,000 edits, kills the writer process, reopens the same SQLite store without connectivity, and checks the pending queue and every task before and after reconnection. Completed attempts validate all intended edits and untouched rows on the independent reader. Earlier setup failures never reached this work.

The table measures the configured persistent store and product-managed queue. Reopen and post-reconnection visibility have separate timing boundaries; queue completion alone does not establish reader visibility.

- [Every trial outcome, preparation record, result digest and metric](../../../archive/files/evidence/trial-checks.json.gz)

### The 25-reader median is lower, but the observed ranges overlap.

Evidence: **unexplained**. Five-reader observations range from about 646 to 803 ms; 25-reader observations range from about 558 to 1,868 ms. Every run validates the update on every reader. These three-trial samples show variability and do not establish that adding readers makes delivery faster. They do not isolate server scheduling, checkpoint publication or client application costs.

Compare the observed ranges as well as the medians. The metric ends when the slowest reader is correct; this is not a throughput or capacity test.

- [Every fanout observation and its bound trial outcome](../../../archive/files/evidence/trial-checks.json.gz)

Next experiment: Trace server commit, checkpoint publication and each reader’s apply time at both scales to distinguish scheduling delay from the cost of delivering to more readers.

## Conflicting edits

A stale writer reconnects only after a third client confirms the competing operation. These are policy checks, not a shared speed ranking. Every task is validated on all three clients; native rejection is an expected outcome when the declared policy requires it.

| Stack | Case | Declared write policy | Expected outcome | Latest check |
| --- | --- | --- | --- | --- |
| powersync | update-update | Benchmark application backend PATCH uses SQL UPDATE by primary key without a version predicate | last-arriving-patch | completed |
| powersync | update-delete | Benchmark application backend PATCH uses SQL UPDATE by primary key without a version predicate | delete-retained | completed |

PowerSync’s result describes this repository’s SQL mutation backend. Syncular uses an explicit version precondition in these cases. A different application policy requires a new profile; successful queue drain cannot substitute for the declared user-visible outcome.

## Attachments

Profile: `1fe939f1eacb33d9973a81729ded7e0d2360e0396ac6d610839048f7a58fb862` (stable-native-host).

Two deterministic 2 MiB objects, 50 validated tasks and four distinct client stores. Upload receipt, native metadata acceptance and independent reader visibility begin at sync invocation; fresh-download and interrupted-download recovery use their own clocks. Staging and queue-failure details remain in the artifact. Resource windows are declared separately. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | initial upload | initial server accepted | initial metadata visible | fresh download | download interruption recovery |
| --- | --- | --- | --- | --- | --- |
| powersync / stable-native-host | unsupported | unsupported | unsupported | unsupported | unsupported |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Access revocation: native purge

Profile: `3a4b229ac13d1a560524b01accf96b2b1f81fba65bb70aa7daa476b751135646` (stable-native-host).

Two 500-task projects. The declared native-purge or application-refresh strategy removes exactly one project from the active client cache; different strategies and persistence guarantees appear in separate tables. Online timing includes the revoke request; offline recovery timing begins at route restoration. Fresh-client checks verify narrowed access and preservation for an unaffected actor. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | online convergence | offline reconnect convergence |
| --- | --- | --- |
| powersync / stable-native-host | 52.14 [50.39–63.82] (n=3) | 4694 [4491–5097] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Connected client fanout

Profile: `ed1cf2e0a5b065cbbbed25155ff3aeabbc008ac1f60b1e12ce4f48942d186e22` (stable-native-host).

2,000 tasks per reader. One update reaches already-connected native subscriptions. Cells summarize the time until every reader converges; per-reader distributions and server resource windows remain in the artifact. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | 5 readers | 25 readers |
| --- | --- | --- |
| powersync / stable-native-host | 724 [646–803] (n=3) | 595 [558–1868] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Reconnect with backlog

Profile: `b29a6d7a3b6ffa91ac96622d8c4b35f71de500d078fe1c992d9061ee662df58a` (stable-native-host).

2,000 tasks per reader. 100 updates accumulate behind blocked reader routes before simultaneous restoration and native reconnect. Cells summarize the time until every reader converges; per-reader distributions and server resource windows remain in the artifact. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | 5 readers | 25 readers |
| --- | --- | --- |
| powersync / stable-native-host | 36.74 [35.25–39.28] (n=3) | 154 [148–301] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 1,000 tasks

Profile: `dab6f2ca848823489bf23727ff814f0eb3d9ee8ace52c4ab2942a7a9cfc5c4ee` (stable-native-host).

1,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| powersync / stable-native-host | 324 [290–328] (n=3) | 327 [291–330] (n=3) | 249 [241–263] (n=3) | 251 [243–264] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 10,000 tasks

Profile: `dab6f2ca848823489bf23727ff814f0eb3d9ee8ace52c4ab2942a7a9cfc5c4ee` (stable-native-host).

10,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| powersync / stable-native-host | 527 [523–542] (n=3) | 546 [543–563] (n=3) | 461 [457–465] (n=3) | 482 [477–485] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 100,000 tasks

Profile: `dab6f2ca848823489bf23727ff814f0eb3d9ee8ace52c4ab2942a7a9cfc5c4ee` (stable-native-host).

100,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| powersync / stable-native-host | 2635 [2615–4601] (n=3) | 2953 [2809–4831] (n=3) | 2652 [2586–3322] (n=3) | 2844 [2777–3531] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Persisted replica startup

Profile: `42713c2a892359a07a92d960e30a56accfcd0cd3522671640d83b4550ab00022` (stable-native-host).

2,000 persisted tasks, a fresh process and blocked client routes. Cumulative milestones cover initialization, a correct 50-row task screen and all local rows. The OS file cache is not cleared. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | reopen process | reopen first screen | reopen all rows |
| --- | --- | --- | --- |
| powersync / stable-native-host | 197 [183–207] (n=3) | 198 [183–207] (n=3) | 203 [188–212] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Collaboration

Profile: `7128dbee83e62ef0e9caa6dba6dbbd2914a647936ee37e62f552fb4d3f6865c9` (stable-native-host).

200 validated local tasks, five warmups and 50 measured writes. Local commit may be unavailable for a tested write path. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | local commit | server accepted | mirror visible |
| --- | --- | --- | --- |
| powersync / stable-native-host | 0.27 [0.25–0.29] (n=3) | 985 [966–998] (n=3) | 1003 [988–1021] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Offline replay

Profile: `8ab689b661f216a3b732694989020781fcd2f04e73bbc34150f4941faf7750b6` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 10 drain | queue 10 mirror visible |
| --- | --- | --- |
| powersync / stable-native-host | 51.13 [47.02–89.22] (n=3) | 133 [104–529] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Replay scaling

Profile: `8ab689b661f216a3b732694989020781fcd2f04e73bbc34150f4941faf7750b6` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 100 mirror visible | queue 500 mirror visible | queue 1000 mirror visible |
| --- | --- | --- | --- |
| powersync / stable-native-host | 560 [513–6922] (n=3) | 2263 [1835–3402] (n=3) | 4356 [3345–5118] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Offline process recovery

Profile: `f4baa1172df5c5c5c04ffd36a21bf6b1b3d7616719aeed73f9e16939b07b3701` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 1000 reopen local | queue 1000 drain | queue 1000 mirror visible |
| --- | --- | --- | --- |
| powersync / stable-native-host | 194 [193–196] (n=3) | 5112 [3566–6436] (n=3) | 5167 [3616–6878] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Task screens

Profile: `9f29a8d6d012b4b83a8bc06f3e09a02a182c28432d1fc58371b1a4a992479a22` (stable-native-host).

100,000 validated local tasks. Each trial runs five warmups and 25 measured operations. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | list | search | aggregate |
| --- | --- | --- | --- |
| powersync / stable-native-host | 0.11 [0.11–0.11] (n=3) | 0.12 [0.11–0.13] (n=3) | 4.22 [4.20–4.24] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Relationship screens

Profile: `5f06bf1f76c56f7f0a56fdb9a7866a882fa7f519c9429d8b8a823a5edb1c51e1` (stable-native-host).

100,000 validated local tasks. Each trial runs five warmups and 25 measured operations. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | dashboard | detail join |
| --- | --- | --- |
| powersync / stable-native-host | 5.55 [5.43–5.67] (n=3) | 0.17 [0.17–0.17] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Interpretation

External resource samples, raw operation timings, output digests, runtime versions, source fingerprints, and image identities are included in the measurements. Sampled RSS is process-tree memory and can count shared pages more than once. Each contract records its measurement window; recovery excludes setup and queue construction.

[Exact benchmark source snapshot](../../../archive/files/results/sources/210b590c47cb9b3420db5248da6bb7c300fa6d9a5b9ff357441fa2b9841e0217/SOURCE.json.gz) includes file bytes, modes, symlinks and deleted paths. Source revision: `dd376f7b4dbe50f81305dbbf44e2ebcf677366ab`; dirty: true.

Stopping rule: Run exactly three independent attempts per PowerSync case, including failures and unavailable cases. Replace the prior PowerSync campaign as a whole; never pool its samples with these runs. Wait for fixture replication and run native bucket compaction before opening measured clients. Retain persistent server volumes. No selective retries. Report medians and observed ranges.

Historical measurements predating the shared contracts are preserved in [the archive](../../history/2026-09-05/README.md). They are excluded from these comparisons.
