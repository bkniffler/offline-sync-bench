# Benchmark results

**Electric and Jazz now both return the required project detail and organization totals for the complete 100,000-task fixture.**

The measured gap describes these implementations. One run does not establish a stable ratio or an inherent product limit.

Campaign `campaign-2026-09-10T07-02-43-467Z`: 1 independent trials per case, in seeded randomized order. Network: local service routes, no injected delay or loss. Host: Apple M4.

[Full tables and explanations](results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md) · [Raw measurements](archive/files/RESULTS.json.gz) · [Methodology](docs/methodology.md)

## Coverage and outcomes

| Suite | electric | jazz-v2 | zero | electric-tanstack | syncular-rust |
| --- | --- | --- | --- | --- | --- |
| Startup | 1 not run; 1 passed | 2 not run | 1 not run; 1 passed | 2 not run | 2 not run |
| Collaboration | 1 not run | 1 not run | 1 not run | 1 not run | 1 not run |
| Offline recovery | 5 not run | 5 not run | 5 not run | 4 not run; 1 passed | 5 not run |
| Local screens | 1 not run; 1 passed | 1 not run; 1 passed | 2 not run | 2 not run | 2 not run |
| Client fanout and recovery | 2 not run | 2 not run | 2 not run | 2 not run | 2 not run |
| Access revocation | 1 not run | 1 not run | 1 not run | 1 not run | 1 not run |
| Attachments | 1 not run | 1 not run | 1 not run | 1 not run | 1 passed |

Counts describe the latest outcome per case. Failed-trial counts include every failed, invalid or timed-out attempt, even when a later trial passed. “Unsupported” applies only to the tested configuration; “not implemented” and “not run” make no product-capability claim.

Stacks outside this campaign: Syncular, PowerSync, Turso Sync.

## Findings

### Electric and Jazz now both return the required project detail and organization totals for the complete 100,000-task fixture.

What work produces the two relationship screens?

100,000 local tasks and their related tables; five warmups and 25 measured operations per trial. Profile: stable native host; equivalent local screen output. [Full configuration](results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Project detail (ms) | Organization dashboard (ms) |
| --- | --- | --- | --- | --- |
| electric / application-processing | 1 / 1 | completed | 0.00 [0.00–0.00] | 0.12 [0.12–0.12] |

100,000 local tasks and their related tables; five warmups and 25 measured operations per trial. Profile: experimental native host; equivalent local screen output. [Full configuration](results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Project detail (ms) | Organization dashboard (ms) |
| --- | --- | --- | --- | --- |
| jazz-v2 / mixed-native-and-application | 1 / 1 | completed | 7476 [7476–7476] | 2685 [2685–2685] |

Evidence: **unexplained**. Electric prepares application lookup and ordering indexes over native shapes. Jazz uses indexed native UUID references and nested includes for detail, then materializes native rows for JavaScript dashboard aggregation. These are different application execution paths; the individual costs have not been isolated. Query p50 metrics are rounded to 0.01 ms: a recorded zero means below 0.005 ms, and the raw operation samples retain higher precision.

The measured gap describes these implementations. One run does not establish a stable ratio or an inherent product limit.

- [Validated result identities, metrics and implementation accounting](archive/files/evidence/related-records.json.gz)

Next experiment: Measure native query, row materialization and JavaScript aggregation separately with identical output checks.

### Electric and Zero reopen the complete 2,000-task replica and correct screen in a fresh process with both network routes blocked.

Can the complete replica reopen without a network?

A fresh process reopens 2,000 persisted tasks while offline. Profile: stable native host; existing product store, offline reopen. [Full configuration](results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | First screen (ms) | All rows (ms) |
| --- | --- | --- | --- | --- |
| electric / benchmark-sqlite-cache | 1 / 1 | completed | 25.29 [25.29–25.29] | 26.78 [26.78–26.78] |

A fresh process reopens 2,000 persisted tasks while offline. Profile: stable native host; existing product store, offline reopen. [Full configuration](results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | First screen (ms) | All rows (ms) |
| --- | --- | --- | --- | --- |
| zero / zero-native-sqlite-store | 1 / 1 | completed | 90.87 [90.87–90.87] | 92.55 [92.55–92.55] |

Evidence: **confirmed**. Electric uses the application SQLite cache with lazy shape transport. Zero uses its public native SQLiteStore through a Bun platform delegate. Zero preparation waits two seconds for scheduled persistence before closing the client; that wait is outside the reopened-process timing. This is a clean-close read test, not a pending-write crash test.

Both paths support the tested offline reads. Application-owned and SDK-owned persistence are identified separately; n=1 leaves timing variability unknown.

- [Validated result identities, metrics and implementation accounting](archive/files/evidence/offline-reopen.json.gz)

### All 1,000 TanStack edits survive SIGKILL and reach the independent reader after reconnecting.

Do queued TanStack edits survive process death?

2,000 tasks per client; the selected metric identifies the queue size or convergence milestone. Profile: stable native host; product queue; persisted cache and queue; SIGKILL recovery; network restored after 20s outage. [Full configuration](results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Offline reopen (ms) | Queue completed (ms) | Reader visible (ms) |
| --- | --- | --- | --- | --- | --- |
| electric-tanstack / tanstack-node-sqlite-cache | 1 / 1 | completed | 330 [330–330] | 18092 [18092–18092] | 18096 [18096–18096] |

Evidence: **confirmed**. An application-provided SQLite StorageAdapter persists opaque native executor records using WAL and synchronous FULL. The SDK restores and replays original transaction identities and idempotency keys; validation checks queue identity, payloads and final receipts. The harness does not reconstruct transactions.

This establishes the tested durable executor configuration in one run, not durability of the previous memory-only setup or a variability estimate.

- [Validated result identities, metrics and implementation accounting](archive/files/evidence/queued-crash-recovery.json.gz)

### The Rust client completes upload, metadata delivery, retained upload retry, fresh download and interrupted-download recovery with exact byte hashes.

Does the Rust client complete the attachment workflow?

Two 2 MiB objects, 50 tasks and four distinct client stores. Profile: stable native host; attachments-v1. [Full configuration](results/reports/campaign-2026-09-10T07-02-43-467Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Upload (ms) | Fresh download (ms) | Download retry (ms) |
| --- | --- | --- | --- | --- | --- |
| syncular-rust / rusqlite-file | 1 / 1 | completed | 20.08 [20.08–20.08] | 47.96 [47.96–47.96] | 38.90 [38.90–38.90] |

Evidence: **confirmed**. The server now buffers early WebSocket frames while asynchronous session setup completes. Regression tests verify ordering, close-before-ready and a bounded buffer. The previous timeout has no frame trace, so this passing run does not prove the cause of every historical failure.

The table now has validated attachment timings for this configuration. Download recovery retries the full object; n=1 leaves run-to-run variability unknown.

- [Validated result identities, metrics and implementation accounting](archive/files/evidence/rust-attachments.json.gz)

## Reading these results

Server volumes and writable layers are retained under the declared preparation policy. Physical-state observations are linked in the full report; logical fixture resets do not establish fresh storage.

Cells summarize independent trial values: median and observed min–max range with fewer than five successes, or median and 95% bootstrap interval with at least five. † marks an interval wider than 25% of the median; treat that estimate as imprecise. Operation percentiles remain distinct from trial counts. A failed latest attempt has no speed estimate; earlier failures remain in the coverage summary and full tables. Different profiles appear in separate tables.

Stopping rule: Run exactly one independent attempt for each of the six selected repaired cases. Retain every outcome, including failures; no selective retries and no pooling with development checks or previous campaigns. Label these measurements n=1: run-to-run variability is unknown. Retain persistent server volumes and run cases sequentially.

[Exact benchmark source snapshot](archive/files/results/sources/2fc51c484824652b8174015fa3b04f1796102e8c4761db1092ad38b78c32d1fc/SOURCE.json.gz). [Installed dependency inventory](archive/files/results/dependencies/8fcfee81dbc5a09251577cb486a4540bd61c224166ba85b347284c442ed6472e/DEPENDENCIES.json.gz) records host package and native addon checksums. [Runtime and service configuration](archive/files/results/configurations/f2cc8533f8d71f393d510d79a4e9eccd51a45849aa1f10796a76e8f5ac4ca727/CONFIGURATION.json.gz) records overrides, resolved services and mounted configuration inputs. Raw operation samples, resource windows, output checks and configuration are in the measurements. Source revision: `dd376f7b4dbe50f81305dbbf44e2ebcf677366ab`; dirty: true.

Historical measurements predating the shared contracts remain in [the archive](results/history/2026-09-05/README.md).
