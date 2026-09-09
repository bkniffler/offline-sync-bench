# Benchmark results: current measurements

Syncular JS and Rust now use **0.17.0**. The SQL clients have indexes matching the measured screens, and Zero uses native queries for filtering, ordering and relationships. All ten [screen preflight cases](./results/diagnostics/tuned-v017-preflight/README.md) passed with exact output checks and recorded SQL query plans.

<!-- tuned-collection-status -->
**Collection complete: 174/174 replacement attempts recorded.** 132 passed, 33 failed, invalid or timed out, and 9 unavailable. SQL finished at 11:25 UTC and Zero at 11:30 UTC on 2026-09-09. Every case used at most three attempts, including failures. Final publication review and packaging remain pending. [Current coverage](./results/diagnostics/publication-coverage/COVERAGE.md) · [Failure reviews](./docs/investigations/tuned-publication-failures.md) · [Interruption and recovery evidence](./docs/investigations/collection-interruptions.md).
<!-- /tuned-collection-status -->

<!-- current-measurements -->
**[All 14 SQL cases: current numbers, trial counts and ranges](./results/reports/tuned-v017-current/RESULTS.md)** · **[Zero: both native-screen cases](./results/reports/tuned-v017-zero-current/RESULTS.md)**

Selected medians from the completed collection, in **milliseconds**. Each displayed number summarizes three independent trials. Task and relationship screens use 100,000 tasks; collaboration uses 200 tasks and 50 measured writes. Full observed ranges and failures are in the linked reports.

| Client | List p50 | Aggregate p50 | Dashboard p50 | Reader visible p50 |
| --- | --- | --- | --- | --- |
| Syncular JS | 0.020 | 3.88 | 5.20 | 6.22 |
| Syncular Rust | 0.020 | 3.54 | 4.73 | 7.31 |
| PowerSync | 0.110 | 4.39 | 5.79 | 1005.13 |
| Turso | 0.070 | 13.82 | 23.58 | 25.93 |
| Zero | 0.110 | 63.87 | 47.96 | — |

Zero's numbers come from a separate campaign using native filtering, ordering and relationships, with aggregation in JavaScript. Its collaboration case was not rerun; the dash supplies no current timing. SQL clients use their configured native SQL stores. Small list differences are below the declared 1 ms practical threshold. These are observations pending final publication review; three trials do not support confidence intervals.
<!-- /current-measurements -->

The fixed collection runs three attempts per case, including failures: four SQL adapters across fourteen cases, plus Zero's two screen cases. The other products and unaffected Zero cases retain separately labeled historical coverage. Samples from different campaigns are not pooled.

A completed diagnostic shows why the index correction matters: with identical SQLite queries and outputs, the list median fell from **10.44 ms to 0.0103 ms**. The original indexed plan still needed a temporary sort; the matching index avoids it. This isolates the two added indexes in an in-memory SQLite fixture, excluding SDK and replication costs. [Investigation, ranges and raw evidence](./docs/investigations/screen-index-effect.md).

![Controlled SQLite index comparison: three fresh processes per condition; medians and observed ranges](./results/diagnostics/screen-index-effect/index-effect.svg)

The final report will select three to five findings after the remaining publication review. It will show medians and observed ranges; three attempts cannot support the declared confidence intervals. Query plans and controlled diagnostics will distinguish confirmed explanations from hypotheses. A setup failure supplies no workload latency.

The previous comparison was withdrawn because SQL indexes did not match the workload and Zero screen timings measured array operations. Its [historical report](./results/history/2026-09-09-withdrawn-interim/RESULTS.md), [compact index](./results/history/2026-09-09-withdrawn-interim/RESULTS.json) and [raw evidence](./results/reports/interim-2026-09-07-0270/README.md) remain available. Root RESULTS.json now points to the provisional current snapshot; the withdrawn index remains archived.

[Correction plan](./docs/implementation/query-index-correction.md) · [Methodology](./docs/methodology.md) · [Publication requirements](./docs/reporting.md)
