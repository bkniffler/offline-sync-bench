# Methods for this publication

This summary describes the comparison rules used by the [report and its linked manifest](../RESULTS.md). The manifest, per-attempt files and source archive are the authority for exact versions, configuration, sample values and implementation. Development smoke campaigns are separate evidence and do not contribute performance samples.

## Comparisons and trial design

The corrected collection runs three independent attempts per configured product/case. Failures and unavailable cases count toward that cap; there are no selective replacements. SQL configurations and Zero screens are separate campaigns. Retained historical coverage remains labeled and is never pooled into their timing summaries.

A comparison requires matching application output, fixture, timing boundaries, network conditions and guarantees. Tables identify client runtime, storage, query strategy and persistence behavior. Browser and native-host measurements stay separate, as do incompatible access or conflict policies. A benchmark-owned outbox cannot establish product-provided durability. There is no overall product score.

The controller uses fresh trial processes and seeded randomized blocks. Workload code owns expected outputs, warmups, repetitions, fault timing and validation. Reported values are medians and observed ranges across successful independent trials. Operation p50/p95 values describe operations within a trial; operations are not additional independent trials. Three attempts do not support the declared confidence intervals, which require at least five successful trials. A failed latest attempt supplies no timing estimate; earlier failures remain visible after a later success.

## Application contracts

| Case family | Required work and timing limits |
| --- | --- |
| Local screens | Canonical 100,000-task data; task list, prefix search, task aggregate, project detail and organization dashboard. Five warmups and 25 samples per query. Exact projected values, ordering and aggregates are checked outside timed queries. |
| Collaboration | 200 initial tasks, five warmups and 50 measured updates. Local commit, client-observed server acceptance and independent reader visibility are separate milestones. |
| Initial startup | Declared 1k/10k/100k task sizes, first correct usable screen and complete offline dataset. Restarted and warm sync-service processes are distinct conditions; neither implies cold OS caches. |
| Replica reopen | Existing 2,000-task persistent store, fresh client process and blocked network. Initialization, first correct screen and complete local data are separate milestones. |
| Offline recovery | Complete data and queue checks before/after client-only network interruption, with independent reader convergence. The declared outage is 20 seconds. Offline restart additionally requires queued writes to survive SIGKILL and reopening the same store while offline. |
| Conflicts | Stale update versus peer update or deletion; a third client confirms the peer operation before reconnection. Declared outcome policies determine validation and comparison eligibility. |
| Fanout and reconnect | Five/25 independent readers and complete 2,000-task validation. Connected delivery sends one update; reconnect recovery restores clients behind a verified 100-update backlog. |
| Access revocation | Removed and retained authorized data, same-client behavior, offline/reconnect behavior and fresh actors. Local removal cannot establish erasure of previously copied data. |
| Attachments | Two deterministic 2 MiB objects; upload, metadata visibility, fresh-reader download and interruption recovery validate actual bytes and queue state. Unavailable configurations remain explicit. |

SQL screen indexes match the measured filters and ordering and are installed before ingestion. Actual query plans and fixture/output digests are recorded. Zero uses native filtering, ordering and relationships with explicitly identified application aggregation. Neither path's latency isolates a programming language or query engine from the rest of its tested implementation.

## Resources, infrastructure and failures

Resource sampling runs outside the measured client event loop and records its process-tree scope and window. RSS can double-count shared pages; polling can miss short peaks. CPU sampling has finite resolution. Resource totals are not interchangeable with individual operation latency.

The local-loopback profile injects no delay or loss. HTTP instrumentation preserves streaming. Payload-byte meters and TCP-relay byte counts have different scopes; unavailable transport counters are not zero. Per-process durations use monotonic clocks, and phases are not assumed to be additive.

Scenario fixture preparation resets logical data while retaining physical server storage. Before/after records cover configured writable layers and data mounts outside workload windows. Storage traversal can warm caches, and allocation measurements are non-atomic. Collection interruptions and any accepted recovery equivalence must accompany affected campaign evidence; resumption does not recreate uninterrupted cache or service conditions.

Timeouts and invalid outputs retain status, elapsed time and evidence. A setup failure provides no workload latency when the workload never began. Confirmed explanations require controlled experiments or direct accounting; supported hypotheses and unexplained findings identify the next experiment. Architecture descriptions alone cannot establish a timing cause.

The publication gate verifies the declared plan, complete attempt roster, source archive, installed dependencies, configuration, images, executable identity, profiles and result contracts. Annotations bind exact result IDs and digests. Packaging preserves raw samples and logs, checks every archived byte stream, and requires restored reports to regenerate identically. The package's archive index and restoration instructions remain available from its report directory.

[Post-collection reporting source and regeneration](../results/diagnostics/publication-reporting-source/README.md).
