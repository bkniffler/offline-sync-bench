# Benchmark results

Campaign `campaign-2026-09-09T11-26-05-626Z`. 3 independent trials per case, with seeded randomized order. Network: local service routes, no injected delay or loss. [Measurements and manifest](../../../archive/files/RESULTS.json.gz). [Methodology](../../../docs/methodology.md).

These measurements describe the listed runtime and workload profiles. A failed latest attempt remains failed; older successful attempts do not replace it. Confidence intervals resample independent trial medians. Results with fewer than five successful trials show the observed min–max range, not a confidence interval.

## Coverage and outcomes

| Stack | Case | Latest outcome | Passed / attempted | Comparison |
| --- | --- | --- | --- | --- |
| zero | local-query | completed | 3 / 3 | mixed-native-and-application |
| zero | deep-relationship-query | completed | 3 / 3 | mixed-native-and-application |

[Individual trial files and logs](../../../archive/files/results/reports/campaign-2026-09-09T11-26-05-626Z/TRIALS.json.gz). The index includes every attempt and its outcome.

## Server storage preparation

retain existing server volumes and writable layers; scenario-specific logical fixture preparation.

Each attempt retains before/after Docker writable-layer bytes and mounted-path allocated KiB in its raw metadata. Startup additionally records each client boundary after fixture preparation. These are live observations, not logical payload sizes or evidence of normalized server state. Missing counters remain unavailable. Read-only configuration mounts are covered by the configuration artifact. In-memory caches, deleted-file storage and OS caches are outside these disk observations.


Outside this campaign: bootstrap, replica-reopen, online-propagation, offline-replay, large-offline-queue, offline-restart, conflict-update-update, conflict-update-delete, connected-fanout, reconnect-storm, permission-change, blob-flow. These cases remain visible as coverage work; omission does not establish a missing product capability.

## Findings

### Zero’s list p50 median is 0.11 ms and prefix-search p50 median is 0.14 ms over 100,000 locally available tasks.

Evidence: **unexplained**. The adapter calls native filter, order and limit queries, then projects their output. All three trials return the exact expected rows. This establishes correct native-query execution, but no phase trace isolates query construction, cache work and result projection.

These small loaded-screen latencies answer interaction cost after data is available. They do not measure initial synchronization, and differences below 1 ms do not support a practical superiority claim here.

- [Exact output, sample and native-execution checks for all six Zero trials](../../../archive/files/results/diagnostics/publication-screen-review/FINAL.json.gz)
- [Measured source copies and execution-path inspection; no phase attribution](../../../archive/files/results/diagnostics/zero-native-screen-inspection/INSPECTION.json.gz)

Next experiment: Trace construction, local query execution and projection separately while retaining identical fixture and output checks.

### In Zero’s three native-screen trials, aggregate p50 has a 63.87 ms median and a 63.56–75.30 ms observed range; list p50 has a 0.11 ms median.

Evidence: **supported hypothesis**. The aggregate path asks Zero for project tasks and then groups and sorts them in JavaScript. The list uses native filtering, ordering and a limit. Source inspection confirms the different work, but does not separate row materialization from grouping cost or establish their individual contribution.

Evaluate the actual aggregate screen before choosing an implementation. A fast limited list does not predict the cost of processing a larger result. These measurements describe this adapter’s composition and cannot rank Zero’s query engine against SQL engines.

- [Exact output, sample and native-execution checks for all six Zero trials](../../../archive/files/results/diagnostics/publication-screen-review/FINAL.json.gz)
- [Measured source copies and execution-path inspection; no phase attribution](../../../archive/files/results/diagnostics/zero-native-screen-inspection/INSPECTION.json.gz)
- [Reviewed comparison chart](../../diagnostics/publication-charts/final/zero-application-aggregation.svg)
- [Chart values and exact result bindings](../../../archive/files/results/diagnostics/publication-charts/final/zero-application-aggregation-data.json.gz)
- [Chart generation checksums](../../../archive/files/results/diagnostics/publication-charts/final/zero-application-aggregation.json.gz)

Next experiment: Measure native result materialization and application grouping separately; compare a supported precomputed aggregate with the same output in a distinct profile.

### Zero’s detail-query p50 median is 0.21 ms, while the dashboard p50 median is 47.96 ms across the same three trials.

Evidence: **supported hypothesis**. Detail uses native relationships, ordering and a limit before projection. The dashboard fetches projects with their task relationships, then counts tasks and sorts projects in JavaScript. Both outputs pass exact checks. The cost split between relationship materialization and application processing remains unmeasured.

Treat detail and dashboard as distinct application workloads even when they share a data model. The dashboard gap exceeds the declared practical threshold, but these observations do not identify a single optimization.

- [Exact output, sample and native-execution checks for all six Zero trials](../../../archive/files/results/diagnostics/publication-screen-review/FINAL.json.gz)
- [Measured source copies and execution-path inspection; no phase attribution](../../../archive/files/results/diagnostics/zero-native-screen-inspection/INSPECTION.json.gz)

Next experiment: Trace relationship materialization and task counting, then test a supported aggregate representation under unchanged correctness checks.

## Task screens

Profile: `86458ccebc4760a01326a0784b7130da8554afb86849cf588255fbe7e28d565c` (stable-native-host).

100,000 validated local tasks. Each trial runs five warmups and 25 measured operations. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | list | search | aggregate |
| --- | --- | --- | --- |
| zero / stable-native-host | 0.11 [0.10–0.28] (n=3) | 0.14 [0.08–0.23] (n=3) | 63.87 [63.56–75.30] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Relationship screens

Profile: `acb281730b225ffcf5a6f8d1590f5e5bafcd7f78631b646071026244fd0dced0` (stable-native-host).

100,000 validated local tasks. Each trial runs five warmups and 25 measured operations. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | dashboard | detail join |
| --- | --- | --- |
| zero / stable-native-host | 47.96 [46.82–51.73] (n=3) | 0.21 [0.20–0.29] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Interpretation

External resource samples, raw operation timings, output digests, runtime versions, source fingerprints, and image identities are included in the measurements. Sampled RSS is process-tree memory and can count shared pages more than once. Each contract records its measurement window; recovery excludes setup and queue construction.

[Exact benchmark source snapshot](../../../archive/files/results/sources/8ecde51941dc281ad277fea9b6a28b7165e0c72cc9202d1fbb71c64201ca9a03/SOURCE.json.gz) includes file bytes, modes, symlinks and deleted paths. Source revision: `5c8131394c20cba5a575b24dfe7053e99b25d7b7`; dirty: true.

Stopping rule: Run exactly three independent attempts per configured adapter/case, counting failures and unavailable cases. User capped the replacement runs at three on 2026-09-08. Use published Syncular 0.17.0 for both JS and Rust. No selective retries or pooling pre-tuning, old-version or smoke results. Report medians and observed ranges; confidence intervals remain unavailable with fewer than five successful independent trials.

Historical measurements predating the shared contracts are preserved in [the archive](../../history/2026-09-05/README.md). They are excluded from these comparisons.
