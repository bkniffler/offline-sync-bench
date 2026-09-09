# Benchmark results

Campaign `campaign-2026-09-08T22-58-56-419Z`. 3 independent trials per case, with seeded randomized order. Network: local service routes, no injected delay or loss. [Measurements and manifest](../../../archive/files/RESULTS.json.gz). [Methodology](../../../docs/methodology.md).

These measurements describe the listed runtime and workload profiles. A failed latest attempt remains failed; older successful attempts do not replace it. Confidence intervals resample independent trial medians. Results with fewer than five successful trials show the observed min–max range, not a confidence interval.

## Coverage and outcomes

| Stack | Case | Latest outcome | Passed / attempted | Comparison |
| --- | --- | --- | --- | --- |
| powersync | permission-change | completed | 3 / 3 | powersync-persistent-file |
| syncular | bootstrap | completed | 3 / 3 | bun:sqlite-file |
| turso | reconnect-storm | completed | 2 / 3 | turso-file |
| powersync | offline-restart | invalid | 0 / 3 | Scenario has not yet passed the RFC measurement-contract migration. |
| powersync | replica-reopen | timed-out | 0 / 3 | Scenario has not yet passed the RFC measurement-contract migration. |
| syncular | online-propagation | completed | 3 / 3 | bun:sqlite-memory |
| powersync | deep-relationship-query | completed | 3 / 3 | native-sql |
| syncular | deep-relationship-query | completed | 3 / 3 | native-sql |
| syncular-rust | connected-fanout | completed | 3 / 3 | rusqlite-file |
| turso | permission-change | unsupported | 0 / 3 | The local Turso Sync server replicates a whole database and does not expose benchmark-equivalent row-level revocation. |
| turso | offline-replay | completed | 3 / 3 | turso-file |
| syncular-rust | conflict-update-update | completed | 3 / 3 | rusqlite-file |
| powersync | conflict-update-delete | invalid | 0 / 3 | Scenario has not yet passed the RFC measurement-contract migration. |
| syncular-rust | reconnect-storm | completed | 3 / 3 | rusqlite-file |
| syncular | conflict-update-delete | completed | 3 / 3 | bun:sqlite-file |
| turso | bootstrap | completed | 3 / 3 | turso-file |
| powersync | reconnect-storm | invalid | 0 / 3 | Adapter executed this case. |
| turso | offline-restart | completed | 3 / 3 | turso-file |
| syncular | large-offline-queue | completed | 3 / 3 | bun:sqlite-file |
| syncular | local-query | completed | 3 / 3 | native-sql |
| syncular-rust | conflict-update-delete | completed | 3 / 3 | rusqlite-file |
| turso | large-offline-queue | completed | 3 / 3 | turso-file |
| syncular | conflict-update-update | completed | 3 / 3 | bun:sqlite-file |
| turso | deep-relationship-query | completed | 3 / 3 | native-sql |
| powersync | online-propagation | completed | 3 / 3 | powersync-node-sqlite-file |
| turso | replica-reopen | completed | 2 / 3 | turso-file |
| syncular | connected-fanout | completed | 3 / 3 | bun:sqlite-file |
| syncular-rust | deep-relationship-query | completed | 3 / 3 | native-sql |
| syncular | reconnect-storm | completed | 3 / 3 | bun:sqlite-file |
| syncular-rust | blob-flow | timed-out | 0 / 3 | Scenario has not yet passed the RFC measurement-contract migration. |
| turso | local-query | completed | 3 / 3 | native-sql |
| syncular-rust | replica-reopen | completed | 3 / 3 | rusqlite-file |
| syncular-rust | large-offline-queue | completed | 3 / 3 | rusqlite-file |
| turso | conflict-update-delete | completed | 3 / 3 | turso-file |
| powersync | conflict-update-update | invalid | 0 / 3 | Scenario has not yet passed the RFC measurement-contract migration. |
| powersync | offline-replay | invalid | 0 / 3 | Scenario has not yet passed the RFC measurement-contract migration. |
| syncular-rust | bootstrap | completed | 3 / 3 | rusqlite-file |
| syncular | blob-flow | completed | 3 / 3 | bun:sqlite-file |
| syncular | replica-reopen | completed | 3 / 3 | bun:sqlite-file |
| turso | blob-flow | unsupported | 0 / 3 | Turso Sync does not provide a native blob transport. |
| powersync | connected-fanout | invalid | 0 / 3 | Adapter executed this case. |
| syncular | offline-replay | completed | 3 / 3 | bun:sqlite-file |
| turso | online-propagation | completed | 3 / 3 | turso-sqlite-file |
| syncular-rust | permission-change | completed | 3 / 3 | syncular-rust-persistent-file |
| powersync | blob-flow | unsupported | 0 / 3 | Blob flow benchmarking is not implemented for PowerSync in this harness yet. |
| syncular-rust | local-query | completed | 3 / 3 | native-sql |
| syncular | offline-restart | completed | 3 / 3 | bun:sqlite-file |
| powersync | large-offline-queue | invalid | 0 / 3 | Scenario has not yet passed the RFC measurement-contract migration. |
| powersync | bootstrap | timed-out | 0 / 3 | Scenario has not yet passed the RFC measurement-contract migration. |
| turso | conflict-update-update | completed | 3 / 3 | turso-file |
| syncular-rust | offline-replay | completed | 3 / 3 | rusqlite-file |
| syncular-rust | online-propagation | completed | 3 / 3 | rusqlite-memory |
| syncular-rust | offline-restart | completed | 3 / 3 | rusqlite-file |
| powersync | local-query | completed | 3 / 3 | native-sql |
| syncular | permission-change | completed | 3 / 3 | syncular-persistent-file |
| turso | connected-fanout | completed | 2 / 3 | turso-file |

[Individual trial files and logs](../../../archive/files/results/reports/campaign-2026-09-08T22-58-56-419Z/TRIALS.json.gz). The index includes every attempt and its outcome.

## Server storage preparation

retain existing server volumes and writable layers; scenario-specific logical fixture preparation.

Each attempt retains before/after Docker writable-layer bytes and mounted-path allocated KiB in its raw metadata. Startup additionally records each client boundary after fixture preparation. These are live observations, not logical payload sizes or evidence of normalized server state. Missing counters remain unavailable. Read-only configuration mounts are covered by the configuration artifact. In-memory caches, deleted-file storage and OS caches are outside these disk observations.


Outside this campaign: . These cases remain visible as coverage work; omission does not establish a missing product capability.

## Findings

### Across the four tuned SQL clients, median list p50 spans 0.02–0.11 ms; aggregate-query p50 spans 3.54–13.82 ms.

Evidence: **confirmed**. Recorded plans use matching indexes without temporary list ordering. A separate controlled Bun SQLite experiment changed only the indexes and reduced list time from 10.44 to 0.0103 ms. That establishes the index benefit in that fixture; remaining cross-client gaps are unisolated.

Inspect plans for the actual filters and ordering. The list differences here fall below the declared 1 ms practical threshold. Aggregation has a larger absolute gap and deserves attention when it sits on an application’s critical path.

- [Controlled index experiment and its scope](../../../docs/investigations/screen-index-effect.md)
- [Six diagnostic attempts, samples and plans](../../../archive/files/results/diagnostics/screen-index-effect/VERIFICATION.json.gz)
- [All 30 screen trials: exact outputs, samples and execution paths](../../../archive/files/results/diagnostics/publication-screen-review/FINAL.json.gz)
- [Reviewed comparison chart](../../diagnostics/publication-charts/final/tuned-local-screens.svg)
- [Chart values and exact result bindings](../../../archive/files/results/diagnostics/publication-charts/final/tuned-local-screens-data.json.gz)
- [Chart generation checksums](../../../archive/files/results/diagnostics/publication-charts/final/tuned-local-screens.json.gz)

Next experiment: Profile aggregation SQL execution and row materialization under matched storage conditions to distinguish the remaining costs.

### Syncular JS, Syncular Rust and Turso completed all three startup attempts through 100,000 tasks. PowerSync timed out in all three attempts at the first 1,000-task client.

Evidence: **unexplained**. PowerSync recorded 18 zero-row progress checks per attempt while response traffic crossed the open connection. The captured evidence does not establish why received data failed to become queryable. Startup preserves server storage history; restarting a service does not establish cold OS caches. Screen and full-copy milestones are observed independently.

Include initial readiness and the complete offline dataset in an application evaluation. A setup timeout provides no successful startup latency, and these retained-storage measurements cannot predict a fresh production deployment.

- [Startup failures and their limits](../../../docs/investigations/tuned-publication-failures.md)
- [Raw-result-bound failure reviews](../../../archive/files/results/diagnostics/tuned-v017-publication-failures/campaign-2026-09-08T22-58-56-419Z/CASE-REVIEWS.json.gz)
- [Recorded service and storage history](../../../docs/investigations/collection-interruptions.md)
- [Reviewed comparison chart](../../diagnostics/publication-charts/final/startup-readiness.svg)
- [Chart values and exact result bindings](../../../archive/files/results/diagnostics/publication-charts/final/startup-readiness-data.json.gz)
- [Chart generation checksums](../../../archive/files/results/diagnostics/publication-charts/final/startup-readiness.json.gz)

Next experiment: Trace receive, apply and checkpoint readiness, then compare separately declared fresh and retained storage conditions.

### Local-commit p50 medians are below 0.4 ms for every client; reader-visible p50 medians span 6.22–1,005.13 ms.

Evidence: **supported hypothesis**. PowerSync uses the installed SDK’s default 1,000 ms upload throttle. The delay overlaps upload work, making scheduling a plausible contributor rather than an additive one-second cost. No per-phase trace establishes its contribution or explains the other client gaps.

Use reader visibility to assess collaboration responsiveness. Local commit answers when the writer’s local data changes. The tested memory/file storage paths remain labeled; this case supplies no process-crash durability guarantee.

- [Upload scheduling inspection and next experiment](../../../docs/investigations/powersync-collaboration.md)
- [Installed source and raw trial bindings](../../../archive/files/results/diagnostics/powersync-collaboration-throttle/INSPECTION.json.gz)
- [Reviewed comparison chart](../../diagnostics/publication-charts/final/collaboration-milestones.svg)
- [Chart values and exact result bindings](../../../archive/files/results/diagnostics/publication-charts/final/collaboration-milestones-data.json.gz)
- [Chart generation checksums](../../../archive/files/results/diagnostics/publication-charts/final/collaboration-milestones.json.gz)

Next experiment: Trace upload scheduling, backend response, checkpoint receipt and reader apply; vary only the supported throttle setting in a separate diagnostic.

### Syncular JS completed all three attachment flows. Syncular Rust timed out during reader preparation in all three; the tested PowerSync and Turso adapters mark this extension unavailable.

Evidence: **supported hypothesis**. The Rust failures occurred before any upload variant. Source inspection found a possible WebSocket-readiness race: native connect can return before the server hello, while early frames can arrive before session assignment. No frame trace proves that sequence occurred.

These results support transfer timings for the tested JS flow and expose a native preparation failure. They cannot rank attachment engines or establish that an unavailable adapter lacks product-level attachment support.

- [Attachment setup failures and causal limits](../../../docs/investigations/tuned-publication-failures.md)
- [Readiness-race inspection with copied source](../../../archive/files/results/diagnostics/tuned-v017-publication-failures/campaign-2026-09-08T22-58-56-419Z/0030/INSPECTION.json.gz)
- [Final failed attachment attempt](../../../archive/files/results/diagnostics/tuned-v017-publication-failures/campaign-2026-09-08T22-58-56-419Z/0118/INSPECTION.json.gz)

Next experiment: Trace server session assignment, hello receipt and the first sync frame; test buffering in a separately declared diagnostic.

## Conflicting edits

A stale writer reconnects only after a third client confirms the competing operation. These are policy checks, not a shared speed ranking. Every task is validated on all three clients; native rejection is an expected outcome when the declared policy requires it.

| Stack | Case | Declared write policy | Expected outcome | Latest check |
| --- | --- | --- | --- | --- |
| syncular-rust | update-update | Native upsert with the original local row version as baseVersion | reject-stale-update | completed |
| powersync | update-delete | Benchmark application backend PATCH uses SQL UPDATE by primary key without a version predicate | delete-retained | invalid |
| syncular | update-delete | Native upsert with the original local row version as baseVersion | delete-retained | completed |
| syncular-rust | update-delete | Native upsert with the original local row version as baseVersion | delete-retained | completed |
| syncular | update-update | Native upsert with the original local row version as baseVersion | reject-stale-update | completed |
| turso | update-delete | Native CDC replays changed columns with SQL UPDATE by primary key | delete-retained | completed |
| powersync | update-update | Benchmark application backend PATCH uses SQL UPDATE by primary key without a version predicate | last-arriving-patch | invalid |
| turso | update-update | Native CDC replays changed columns with SQL UPDATE by primary key | last-arriving-patch | completed |

PowerSync’s result describes this repository’s SQL mutation backend. Syncular uses an explicit version precondition in these cases. A different application policy requires a new profile; successful queue drain cannot substitute for the declared user-visible outcome.

## Attachments

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

Two deterministic 2 MiB objects, 50 validated tasks and four distinct client stores. Upload receipt, native metadata acceptance and independent reader visibility begin at sync invocation; fresh-download and interrupted-download recovery use their own clocks. Staging and queue-failure details remain in the artifact. Resource windows are declared separately. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | initial upload | initial server accepted | initial metadata visible | fresh download | download interruption recovery |
| --- | --- | --- | --- | --- | --- |
| syncular-rust / stable-native-host | timed-out | timed-out | timed-out | timed-out | timed-out |
| turso / stable-native-host | unsupported | unsupported | unsupported | unsupported | unsupported |
| powersync / stable-native-host | unsupported | unsupported | unsupported | unsupported | unsupported |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Attachments

Profile: `98315ff748020fcc4ce391b691fc292f271bef9d9c697b261b2073f5f6545daf` (stable-native-host).

Two deterministic 2 MiB objects, 50 validated tasks and four distinct client stores. Upload receipt, native metadata acceptance and independent reader visibility begin at sync invocation; fresh-download and interrupted-download recovery use their own clocks. Staging and queue-failure details remain in the artifact. Resource windows are declared separately. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | initial upload | initial server accepted | initial metadata visible | fresh download | download interruption recovery |
| --- | --- | --- | --- | --- | --- |
| syncular / stable-native-host | 30.53 [26.60–38.01] (n=3) | 62.53 [47.78–66.45] (n=3) | 58.85 [41.77–60.77] (n=3) | 28.57 [26.28–34.27] (n=3) | 18.52 [16.76–20.32] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Access revocation: native purge

Profile: `acac722d5a4354e71532480c06104bffd61496ad90177a5f0a076ed49083e9c4` (stable-native-host).

Two 500-task projects. The declared native-purge or application-refresh strategy removes exactly one project from the active client cache; different strategies and persistence guarantees appear in separate tables. Online timing includes the revoke request; offline recovery timing begins at route restoration. Fresh-client checks verify narrowed access and preservation for an unaffected actor. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | online convergence | offline reconnect convergence |
| --- | --- | --- |
| powersync / stable-native-host | 1057 [1002–2920] (n=3) | 6497 [5126–8360] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Access revocation: unverified profile

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

Two 500-task projects. The declared native-purge or application-refresh strategy removes exactly one project from the active client cache; different strategies and persistence guarantees appear in separate tables. Online timing includes the revoke request; offline recovery timing begins at route restoration. Fresh-client checks verify narrowed access and preservation for an unaffected actor. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | online convergence | offline reconnect convergence |
| --- | --- | --- |
| turso / stable-native-host | unsupported | unsupported |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Access revocation: native purge

Profile: `9a7000777eab17e0a4fb512635750c8ca6b99898f73144a971557effae8d9f78` (stable-native-host).

Two 500-task projects. The declared native-purge or application-refresh strategy removes exactly one project from the active client cache; different strategies and persistence guarantees appear in separate tables. Online timing includes the revoke request; offline recovery timing begins at route restoration. Fresh-client checks verify narrowed access and preservation for an unaffected actor. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | online convergence | offline reconnect convergence |
| --- | --- | --- |
| syncular-rust / stable-native-host | 18.35 [17.35–31.38] (n=3) | 13.30 [12.62–104] (n=3) |
| syncular / stable-native-host | 14.25 [13.52–17.24] (n=3) | 10.04 [9.80–11.67] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Connected client fanout

Profile: `3bf0ab4909f01a240a64778f4899e5e646525924d5be0fcf1599718ec1de545a` (stable-native-host).

2,000 tasks per reader. One update reaches already-connected native subscriptions. Cells summarize the time until every reader converges; per-reader distributions and server resource windows remain in the artifact. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | 5 readers | 25 readers |
| --- | --- | --- |
| syncular-rust / stable-native-host | 16.50 [14.27–23.45] (n=3) | 28.13 [16.29–37.53] (n=3) |
| syncular / stable-native-host | 16.43 [13.19–22.24] (n=3) | 17.26 [16.53–17.90] (n=3) |
| powersync / stable-native-host | invalid | invalid |
| turso / stable-native-host | 39.08 [35.61–42.55] (n=2) | 534 [55.51–1013] (n=2) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Reconnect with backlog

Profile: `c2e5fe2d68ba36c4558fa641063ee0225ef393d4db734b86369033ef43fc97be` (stable-native-host).

2,000 tasks per reader. 100 updates accumulate behind blocked reader routes before simultaneous restoration and native reconnect. Cells summarize the time until every reader converges; per-reader distributions and server resource windows remain in the artifact. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | 5 readers | 25 readers |
| --- | --- | --- |
| turso / stable-native-host | 51.55 [50.11–53.00] (n=2) | 120 [103–136] (n=2) |
| syncular-rust / stable-native-host | 78.96 [73.19–91.93] (n=3) | 281 [274–683] (n=3) |
| powersync / stable-native-host | invalid | invalid |
| syncular / stable-native-host | 87.17 [83.01–145] (n=3) | 292 [279–1141] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 1,000 tasks

Profile: `4cfe7ec097a2b3ed8c45884e2ddcd1178712303f9dfbb3f48d62c8e2ebb55d9a` (stable-native-host).

1,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| syncular / stable-native-host | 145 [121–146] (n=3) | 145 [121–147] (n=3) | 97.48 [95.81–106] (n=3) | 97.96 [96.27–107] (n=3) |
| turso / stable-native-host | 3520 [2462–5345] (n=3) | 3522 [2464–5347] (n=3) | 3142 [2155–3431] (n=3) | 3144 [2157–3433] (n=3) |
| syncular-rust / stable-native-host | 112 [110–121] (n=3) | 106 [103–124] (n=3) | 93.81 [90.30–109] (n=3) | 86.83 [83.86–102] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 1,000 tasks

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

1,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| powersync / stable-native-host | timed-out | timed-out | timed-out | timed-out |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 10,000 tasks

Profile: `4cfe7ec097a2b3ed8c45884e2ddcd1178712303f9dfbb3f48d62c8e2ebb55d9a` (stable-native-host).

10,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| syncular / stable-native-host | 198 [185–238] (n=3) | 204 [189–244] (n=3) | 121 [112–135] (n=3) | 127 [115–140] (n=3) |
| turso / stable-native-host | 2561 [1805–3107] (n=3) | 2580 [1826–3127] (n=3) | 2744 [1572–2793] (n=3) | 2762 [1591–2811] (n=3) |
| syncular-rust / stable-native-host | 265 [231–268] (n=3) | 288 [224–290] (n=3) | 151 [148–191] (n=3) | 179 [144–210] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 10,000 tasks

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

10,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| powersync / stable-native-host | timed-out | timed-out | timed-out | timed-out |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 100,000 tasks

Profile: `4cfe7ec097a2b3ed8c45884e2ddcd1178712303f9dfbb3f48d62c8e2ebb55d9a` (stable-native-host).

100,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| syncular / stable-native-host | 1277 [1072–1374] (n=3) | 1310 [1102–1409] (n=3) | 370 [363–467] (n=3) | 404 [395–499] (n=3) |
| turso / stable-native-host | 2656 [2319–2955] (n=3) | 2847 [2517–3169] (n=3) | 2626 [2125–2912] (n=3) | 2828 [2321–3109] (n=3) |
| syncular-rust / stable-native-host | 1649 [1612–2178] (n=3) | 1643 [1605–2171] (n=3) | 954 [926–1004] (n=3) | 947 [918–1308] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Initial startup: 100,000 tasks

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

100,000-task startup milestones for fresh clients against process-cold and warm sync services. Full snapshots and the first task screen pass exact validation; persistent server storage and OS caches are retained. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | first screen (process cold) | full data (process cold) | first screen (warm) | full data (warm) |
| --- | --- | --- | --- | --- |
| powersync / stable-native-host | timed-out | timed-out | timed-out | timed-out |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Persisted replica startup

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

2,000 persisted tasks, a fresh process and blocked client routes. Cumulative milestones cover initialization, a correct 50-row task screen and all local rows. The OS file cache is not cleared. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | reopen process | reopen first screen | reopen all rows |
| --- | --- | --- | --- |
| powersync / stable-native-host | timed-out | timed-out | timed-out |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Persisted replica startup

Profile: `896ae7cc1dc5f5910770a9ccb616ea8beedad6cc046dced2ab8c4024c8687cb1` (stable-native-host).

2,000 persisted tasks, a fresh process and blocked client routes. Cumulative milestones cover initialization, a correct 50-row task screen and all local rows. The OS file cache is not cleared. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | reopen process | reopen first screen | reopen all rows |
| --- | --- | --- | --- |
| turso / stable-native-host | 40.47 [34.90–46.04] (n=2) | 40.95 [35.41–46.50] (n=2) | 46.32 [40.93–51.70] (n=2) |
| syncular-rust / stable-native-host | 46.60 [46.06–49.39] (n=3) | 46.89 [46.33–49.71] (n=3) | 52.74 [52.19–56.19] (n=3) |
| syncular / stable-native-host | 52.86 [51.88–58.32] (n=3) | 53.14 [52.15–58.70] (n=3) | 55.48 [53.92–60.72] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Collaboration

Profile: `8bc41752a2277e40602a61de453f7ad43ea70def17b6d7899a6f81610ef9dd92` (stable-native-host).

200 validated local tasks, five warmups and 50 measured writes. Local commit may be unavailable for a tested write path. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | local commit | server accepted | mirror visible |
| --- | --- | --- | --- |
| syncular / stable-native-host | 0.11 [0.11–0.12] (n=3) | 10.03 [9.29–10.35] (n=3) | 6.22 [5.77–6.88] (n=3) |
| powersync / stable-native-host | 0.35 [0.27–0.40] (n=3) | 323 [311–442] (n=3) | 1005 [983–1014] (n=3) |
| turso / stable-native-host | 0.12 [0.11–0.13] (n=3) | 24.23 [23.68–24.45] (n=3) | 25.93 [25.48–26.34] (n=3) |
| syncular-rust / stable-native-host | 0.15 [0.15–0.17] (n=3) | 11.67 [9.56–12.18] (n=3) | 7.31 [6.23–7.46] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Offline replay

Profile: `0e65beeb97b479510f60ea0d5d437c6f911840e46c3c5185781deacf35fc091f` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 10 drain | queue 10 mirror visible |
| --- | --- | --- |
| turso / stable-native-host | 43.04 [40.69–54.15] (n=3) | 46.97 [45.70–72.18] (n=3) |
| syncular / stable-native-host | 70.72 [69.01–81.99] (n=3) | 71.79 [66.96–83.65] (n=3) |
| syncular-rust / stable-native-host | 94.52 [59.05–131] (n=3) | 97.18 [58.76–123] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Offline replay

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 10 drain | queue 10 mirror visible |
| --- | --- | --- |
| powersync / stable-native-host | invalid | invalid |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Replay scaling

Profile: `0e65beeb97b479510f60ea0d5d437c6f911840e46c3c5185781deacf35fc091f` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 100 mirror visible | queue 500 mirror visible | queue 1000 mirror visible |
| --- | --- | --- | --- |
| syncular / stable-native-host | 407 [296–433] (n=3) | 1562 [1421–1651] (n=3) | 2985 [2851–3268] (n=3) |
| turso / stable-native-host | 35.63 [35.32–43.62] (n=3) | 38.30 [35.07–51.37] (n=3) | 92.48 [78.51–93.68] (n=3) |
| syncular-rust / stable-native-host | 394 [386–411] (n=3) | 1603 [1403–3526] (n=3) | 3058 [2670–3236] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Replay scaling

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 100 mirror visible | queue 500 mirror visible | queue 1000 mirror visible |
| --- | --- | --- | --- |
| powersync / stable-native-host | invalid | invalid | invalid |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Offline process recovery

Profile: `441894d212815de1ff1eb0b73752b5954d4f346a56bf0fc3b340e2a49841ef64` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 1000 reopen local | queue 1000 drain | queue 1000 mirror visible |
| --- | --- | --- | --- |
| powersync / stable-native-host | invalid | invalid | invalid |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Offline process recovery

Profile: `53c811704e9c669a791ce241a0f8a4689e09bfe01db4a810551bc54c9a38feb8` (stable-native-host).

2,000 validated tasks. A client-only outage keeps the service and reader healthy. Queue drain and reader visibility are measured independently from network restoration; process recovery also requires SIGKILL and offline reopen. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | queue 1000 reopen local | queue 1000 drain | queue 1000 mirror visible |
| --- | --- | --- | --- |
| turso / stable-native-host | 38.06 [34.70–44.55] (n=3) | 77.64 [72.43–77.70] (n=3) | 86.86 [83.96–87.51] (n=3) |
| syncular / stable-native-host | 56.35 [56.11–59.14] (n=3) | 3422 [3283–3588] (n=3) | 3368 [3236–3443] (n=3) |
| syncular-rust / stable-native-host | 62.79 [60.36–63.49] (n=3) | 3365 [3163–3555] (n=3) | 3297 [3103–3490] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Task screens

Profile: `8850ab728dce3abd25e0fe49db68b1e64cd8036d5b7d30e80e5aeb09c796f64c` (stable-native-host).

100,000 validated local tasks. Each trial runs five warmups and 25 measured operations. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | list | search | aggregate |
| --- | --- | --- | --- |
| syncular / stable-native-host | 0.02 [0.02–0.02] (n=3) | 0.01 [0.01–0.01] (n=3) | 3.88 [3.83–3.91] (n=3) |
| turso / stable-native-host | 0.07 [0.06–0.07] (n=3) | 0.10 [0.10–0.10] (n=3) | 13.82 [13.67–13.84] (n=3) |
| syncular-rust / stable-native-host | 0.02 [0.02–0.02] (n=3) | 0.02 [0.02–0.02] (n=3) | 3.54 [3.54–3.54] (n=3) |
| powersync / stable-native-host | 0.11 [0.10–0.36] (n=3) | 0.11 [0.11–0.14] (n=3) | 4.39 [4.21–5.29] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Relationship screens

Profile: `b24588eabfe1d4878a8c85bf6ed370455ea44b042fbda7a69a108ac18a1a9456` (stable-native-host).

100,000 validated local tasks. Each trial runs five warmups and 25 measured operations. Cells show the median of successful trial p50 values in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | dashboard | detail join |
| --- | --- | --- |
| powersync / stable-native-host | 5.79 [5.60–6.00] (n=3) | 0.17 [0.17–0.18] (n=3) |
| syncular / stable-native-host | 5.20 [5.20–5.61] (n=3) | 0.02 [0.02–0.02] (n=3) |
| turso / stable-native-host | 23.58 [22.60–23.79] (n=3) | 0.20 [0.20–0.20] (n=3) |
| syncular-rust / stable-native-host | 4.73 [4.54–4.90] (n=3) | 0.04 [0.04–0.04] (n=3) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Interpretation

External resource samples, raw operation timings, output digests, runtime versions, source fingerprints, and image identities are included in the measurements. Sampled RSS is process-tree memory and can count shared pages more than once. Each contract records its measurement window; recovery excludes setup and queue construction.

[Exact benchmark source snapshot](../../../archive/files/results/sources/8ecde51941dc281ad277fea9b6a28b7165e0c72cc9202d1fbb71c64201ca9a03/SOURCE.json.gz) includes file bytes, modes, symlinks and deleted paths. Source revision: `5c8131394c20cba5a575b24dfe7053e99b25d7b7`; dirty: true.

Stopping rule: Run exactly three independent attempts per configured adapter/case, counting failures and unavailable cases. User capped the replacement runs at three on 2026-09-08. Use published Syncular 0.17.0 for both JS and Rust. No selective retries or pooling pre-tuning, old-version or smoke results. Report medians and observed ranges; confidence intervals remain unavailable with fewer than five successful independent trials.

Historical measurements predating the shared contracts are preserved in [the archive](../../history/2026-09-05/README.md). They are excluded from these comparisons.
