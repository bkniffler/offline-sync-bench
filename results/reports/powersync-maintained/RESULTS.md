# Benchmark results

**Native bucket compaction fixes the reproduced fresh-client setup failure.**

Fixture resets must include server-history maintenance. This campaign waits for replication and compacts before opening clients; it retains server volumes and keeps preparation outside client timing.

Campaign `campaign-2026-09-09T22-08-38-711Z`: 3 independent trials per case, in seeded randomized order. Network: local service routes, no injected delay or loss. Host: Apple M4.

[Full tables and explanations](results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md) · [Raw measurements](archive/files/RESULTS.json.gz) · [Methodology](docs/methodology.md)

## Coverage and outcomes

| Suite | powersync |
| --- | --- |
| Startup | 2 passed |
| Collaboration | 1 passed |
| Offline recovery | 5 passed |
| Local screens | 2 passed |
| Client fanout and recovery | 2 passed |
| Access revocation | 1 passed |
| Attachments | 1 not implemented |

Counts describe the latest outcome per case. Failed-trial counts include every failed, invalid or timed-out attempt, even when a later trial passed. “Unsupported” applies only to the tested configuration; “not implemented” and “not run” make no product-capability claim.

Stacks outside this campaign: Syncular, Syncular Rust Client, Electric, Electric + TanStack DB, Zero, Turso Sync, Jazz v2 (experimental).

## Findings

### Native bucket compaction fixes the reproduced fresh-client setup failure.

How long does a fresh client take when previous fixture history has been compacted?

Fresh clients at 1,000, 10,000, 100,000 tasks, against restarted and warm sync services. Profile: stable native host; fresh product file. [Full configuration](results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | First correct screen (ms) | Complete dataset (ms) |
| --- | --- | --- | --- | --- |
| powersync / powersync-node-sqlite-file | 3 / 3 | completed | 2652 [2586–3322] | 2844 [2777–3531] |

Evidence: **confirmed**. The follow-up reproduced the initial-writer timeout with 2,000 current tasks and 5,980,513 global bucket operations. After native compaction, the same task fixture synchronized on direct and relayed fresh clients in about 755 ms and passed full-row validation. The bucket then contained 2,002 PUTs and one CLEAR. Those probes are diagnostic evidence, separate from the startup measurements below.

Fixture resets must include server-history maintenance. This campaign waits for replication and compacts before opening clients; it retains server volumes and keeps preparation outside client timing.

- [Original fixture and operation counts](archive/files/evidence/history/BEFORE.json.gz)
- [Reproduced setup failure](archive/files/evidence/history/reproduction-before.json.gz)
- [Direct client after compaction with full-row validation](evidence/history/after-direct.jsonl)
- [Relayed client after compaction with full-row validation](evidence/history/after-relay.jsonl)
- [One-time cleanup using the pinned native compactor](evidence/history/compact-large-batches.mjs)

### Crash recovery now reaches the intended queue-survival test.

Do queued writes survive killing the writer and reopening its store offline?

2,000 tasks per client; the selected metric identifies the queue size or convergence milestone. Profile: stable native host; product queue; persisted cache and queue; SIGKILL recovery; network restored after 20s outage. [Full configuration](results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Reopen offline (ms) | Queue completed (ms) | Reader visible (ms) |
| --- | --- | --- | --- | --- | --- |
| powersync / powersync-node-sqlite-file | 3 / 3 | completed | 194 [193–196] | 5112 [3566–6436] | 5167 [3616–6878] |

Evidence: **confirmed**. The harness queues 1,000 edits, kills the writer process, reopens the same SQLite store without connectivity, and checks the pending queue and every task before and after reconnection. Completed attempts validate all intended edits and untouched rows on the independent reader. Earlier setup failures never reached this work.

The table measures the configured persistent store and product-managed queue. Reopen and post-reconnection visibility have separate timing boundaries; queue completion alone does not establish reader visibility.

- [Every trial outcome, preparation record, result digest and metric](archive/files/evidence/trial-checks.json.gz)

### The 25-reader median is lower, but the observed ranges overlap.

Does adding connected readers change delivery delay?

2,000 tasks per connected reader; deliver one update. Profile: stable native host; product persisted cache; live delivery, no process-restart guarantee. [Full configuration](results/reports/campaign-2026-09-09T22-08-38-711Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Five readers (ms) | 25 readers (ms) |
| --- | --- | --- | --- | --- |
| powersync / powersync-node-sqlite-file | 3 / 3 | completed | 724 [646–803] | 595 [558–1868] |

Evidence: **unexplained**. Five-reader observations range from about 646 to 803 ms; 25-reader observations range from about 558 to 1,868 ms. Every run validates the update on every reader. These three-trial samples show variability and do not establish that adding readers makes delivery faster. They do not isolate server scheduling, checkpoint publication or client application costs.

Compare the observed ranges as well as the medians. The metric ends when the slowest reader is correct; this is not a throughput or capacity test.

- [Every fanout observation and its bound trial outcome](archive/files/evidence/trial-checks.json.gz)

Next experiment: Trace server commit, checkpoint publication and each reader’s apply time at both scales to distinguish scheduling delay from the cost of delivering to more readers.

## Reading these results

Server volumes and writable layers are retained under the declared preparation policy. Physical-state observations are linked in the full report; logical fixture resets do not establish fresh storage.

Cells summarize independent trial values: median and observed min–max range with fewer than five successes, or median and 95% bootstrap interval with at least five. † marks an interval wider than 25% of the median; treat that estimate as imprecise. Operation percentiles remain distinct from trial counts. A failed latest attempt has no speed estimate; earlier failures remain in the coverage summary and full tables. Different profiles appear in separate tables.

Stopping rule: Run exactly three independent attempts per PowerSync case, including failures and unavailable cases. Replace the prior PowerSync campaign as a whole; never pool its samples with these runs. Wait for fixture replication and run native bucket compaction before opening measured clients. Retain persistent server volumes. No selective retries. Report medians and observed ranges.

[Exact benchmark source snapshot](archive/files/results/sources/210b590c47cb9b3420db5248da6bb7c300fa6d9a5b9ff357441fa2b9841e0217/SOURCE.json.gz). [Installed dependency inventory](archive/files/results/dependencies/8fcfee81dbc5a09251577cb486a4540bd61c224166ba85b347284c442ed6472e/DEPENDENCIES.json.gz) records host package and native addon checksums. [Runtime and service configuration](archive/files/results/configurations/ba64b0a84a134de0e20719b779af5225344556c33b1bf1e193c20ce8dd4bbd2e/CONFIGURATION.json.gz) records overrides, resolved services and mounted configuration inputs. Raw operation samples, resource windows, output checks and configuration are in the measurements. Source revision: `dd376f7b4dbe50f81305dbbf44e2ebcf677366ab`; dirty: true.

Historical measurements predating the shared contracts remain in [the archive](results/history/2026-09-05/README.md).
