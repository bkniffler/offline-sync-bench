# Benchmark results

Campaign `campaign-2026-09-10T07-02-43-467Z`. 1 independent trials per case, with seeded randomized order. Network: local service routes, no injected delay or loss. [Measurements and manifest](../../../archive/files/RESULTS.json.gz). [Methodology](../../../docs/methodology.md).

These measurements describe the listed runtime and workload profiles. A failed latest attempt remains failed; older successful attempts do not replace it. Confidence intervals resample independent trial medians. Results with fewer than five successful trials show the observed min–max range, not a confidence interval.

## Coverage and outcomes

| Stack | Case | Latest outcome | Passed / attempted | Comparison |
| --- | --- | --- | --- | --- |
| zero | replica-reopen | completed | 1 / 1 | zero-native-sqlite-store |
| electric | deep-relationship-query | completed | 1 / 1 | application-processing |
| syncular-rust | blob-flow | completed | 1 / 1 | rusqlite-file |
| electric-tanstack | offline-restart | completed | 1 / 1 | tanstack-node-sqlite-cache |
| jazz-v2 | deep-relationship-query | completed | 1 / 1 | mixed-native-and-application |
| electric | replica-reopen | completed | 1 / 1 | benchmark-sqlite-cache |

[Individual trial files and logs](../../../archive/files/results/reports/campaign-2026-09-10T07-02-43-467Z/TRIALS.json.gz). The index includes every attempt and its outcome.

## Server storage preparation

retain existing server volumes and writable layers; scenario-specific logical fixture preparation.

Each attempt retains before/after Docker writable-layer bytes and mounted-path allocated KiB in its raw metadata. Startup additionally records each client boundary after fixture preparation. These are live observations, not logical payload sizes or evidence of normalized server state. Missing counters remain unavailable. Read-only configuration mounts are covered by the configuration artifact. In-memory caches, deleted-file storage and OS caches are outside these disk observations.


Outside this campaign: bootstrap, online-propagation, offline-replay, large-offline-queue, conflict-update-update, conflict-update-delete, local-query, connected-fanout, reconnect-storm, permission-change. These cases remain visible as coverage work; omission does not establish a missing product capability.

## Findings

### Electric and Jazz now both return the required project detail and organization totals for the complete 100,000-task fixture.

Evidence: **unexplained**. Electric prepares application lookup and ordering indexes over native shapes. Jazz uses indexed native UUID references and nested includes for detail, then materializes native rows for JavaScript dashboard aggregation. These are different application execution paths; the individual costs have not been isolated. Query p50 metrics are rounded to 0.01 ms: a recorded zero means below 0.005 ms, and the raw operation samples retain higher precision.

The measured gap describes these implementations. One run does not establish a stable ratio or an inherent product limit.

- [Validated result identities, metrics and implementation accounting](../../../archive/files/evidence/related-records.json.gz)

Next experiment: Measure native query, row materialization and JavaScript aggregation separately with identical output checks.

### Electric and Zero reopen the complete 2,000-task replica and correct screen in a fresh process with both network routes blocked.

Evidence: **confirmed**. Electric uses the application SQLite cache with lazy shape transport. Zero uses its public native SQLiteStore through a Bun platform delegate. Zero preparation waits two seconds for scheduled persistence before closing the client; that wait is outside the reopened-process timing. This is a clean-close read test, not a pending-write crash test.

Both paths support the tested offline reads. Application-owned and SDK-owned persistence are identified separately; n=1 leaves timing variability unknown.

- [Validated result identities, metrics and implementation accounting](../../../archive/files/evidence/offline-reopen.json.gz)

### All 1,000 TanStack edits survive SIGKILL and reach the independent reader after reconnecting.

Evidence: **confirmed**. An application-provided SQLite StorageAdapter persists opaque native executor records using WAL and synchronous FULL. The SDK restores and replays original transaction identities and idempotency keys; validation checks queue identity, payloads and final receipts. The harness does not reconstruct transactions.

This establishes the tested durable executor configuration in one run, not durability of the previous memory-only setup or a variability estimate.

- [Validated result identities, metrics and implementation accounting](../../../archive/files/evidence/queued-crash-recovery.json.gz)

### The Rust client completes upload, metadata delivery, retained upload retry, fresh download and interrupted-download recovery with exact byte hashes.

Evidence: **confirmed**. The server now buffers early WebSocket frames while asynchronous session setup completes. Regression tests verify ordering, close-before-ready and a bounded buffer. The previous timeout has no frame trace, so this passing run does not prove the cause of every historical failure.

The table now has validated attachment timings for this configuration. Download recovery retries the full object; n=1 leaves run-to-run variability unknown.

- [Validated result identities, metrics and implementation accounting](../../../archive/files/evidence/rust-attachments.json.gz)

## Attachments

Profile: `48b819c9bc0878bbe130c6ce7e3c3bb2d3504995c0aa07b9d9b4bbf72748027a` (stable-native-host).

Two deterministic 2 MiB objects, 50 validated tasks and four distinct client stores. Upload receipt, native metadata acceptance and independent reader visibility begin at sync invocation; fresh-download and interrupted-download recovery use their own clocks. Staging and queue-failure details remain in the artifact. Resource windows are declared separately. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | initial upload | initial server accepted | initial metadata visible | fresh download | download interruption recovery |
| --- | --- | --- | --- | --- | --- |
| syncular-rust / stable-native-host | 20.08 [20.08–20.08] (n=1) | 56.92 [56.92–56.92] (n=1) | 48.44 [48.44–48.44] (n=1) | 47.96 [47.96–47.96] (n=1) | 38.90 [38.90–38.90] (n=1) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Persisted replica startup

Profile: `1026e9cd90bbe42ac31808ac4e6c4c8cfcc5b4ef25822eb08b1797ed6e6044e7` (stable-native-host).

2,000 persisted tasks, a fresh process and blocked client routes. Cumulative milestones cover initialization, a correct 50-row task screen and all local rows. The OS file cache is not cleared. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | reopen process | reopen first screen | reopen all rows |
| --- | --- | --- | --- |
| zero / stable-native-host | 87.93 [87.93–87.93] (n=1) | 90.87 [90.87–90.87] (n=1) | 92.55 [92.55–92.55] (n=1) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Persisted replica startup

Profile: `f1997e4b129df3ed240875fed22b1684fc68407bf30c5b4d9d5504658da03528` (stable-native-host).

2,000 persisted tasks, a fresh process and blocked client routes. Cumulative milestones cover initialization, a correct 50-row task screen and all local rows. The OS file cache is not cleared. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | reopen process | reopen first screen | reopen all rows |
| --- | --- | --- | --- |
| electric / stable-native-host | 24.32 [24.32–24.32] (n=1) | 25.29 [25.29–25.29] (n=1) | 26.78 [26.78–26.78] (n=1) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Offline process recovery

Profile: `4f6fa8c47adbdae19c98cc2c421f6eee1f40746a412423099bd917066dcf3e2d` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 1000 reopen local | queue 1000 drain | queue 1000 mirror visible |
| --- | --- | --- | --- |
| electric-tanstack / stable-native-host | 330 [330–330] (n=1) | 18092 [18092–18092] (n=1) | 18096 [18096–18096] (n=1) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Relationship screens

Profile: `f98edee957350524c03f4f739a8dcebe7ebefc04045e3ba9974e84fa05522967` (stable-native-host).

100,000 validated local tasks. Each trial runs five warmups and 25 measured operations. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | dashboard | detail join |
| --- | --- | --- |
| electric / stable-native-host | 0.12 [0.12–0.12] (n=1) | 0.00 [0.00–0.00] (n=1) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Relationship screens

Profile: `265d2340f35c970278b86f068bb594f805ae84fea714c00e9ae3a82b8f406ab0` (experimental-native-host).

100,000 validated local tasks. Each trial runs five warmups and 25 measured operations. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | dashboard | detail join |
| --- | --- | --- |
| jazz-v2 / experimental-native-host | 2685 [2685–2685] (n=1) | 7476 [7476–7476] (n=1) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Interpretation

External resource samples, raw operation timings, output digests, runtime versions, source fingerprints, and image identities are included in the measurements. Sampled RSS is process-tree memory and can count shared pages more than once. Each contract records its measurement window; recovery excludes setup and queue construction.

[Exact benchmark source snapshot](../../../archive/files/results/sources/2fc51c484824652b8174015fa3b04f1796102e8c4761db1092ad38b78c32d1fc/SOURCE.json.gz) includes file bytes, modes, symlinks and deleted paths. Source revision: `dd376f7b4dbe50f81305dbbf44e2ebcf677366ab`; dirty: true.

Stopping rule: Run exactly one independent attempt for each of the six selected repaired cases. Retain every outcome, including failures; no selective retries and no pooling with development checks or previous campaigns. Label these measurements n=1: run-to-run variability is unknown. Retain persistent server volumes and run cases sequentially.

Historical measurements predating the shared contracts are preserved in [the archive](../../history/2026-09-05/README.md). They are excluded from these comparisons.
