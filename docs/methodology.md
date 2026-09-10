# How to read the benchmark

The [README](../README.md#latest-results) shows the latest numbers. [Benchmark definitions](./benchmarks.md) describe the work behind each column and the additional cases. [Running and publishing](./reporting.md) covers reproduction.

## What a comparison means

We compare application outcomes: the same expected records, query output, timing boundary and required guarantees. Different supported implementations can deliver that outcome, but the result identifies the client runtime, storage, query execution, subscriptions and server/network configuration.

SQL, native reactive queries and JavaScript processing are distinct execution paths. Plain Electric participates only in read workloads. Client-write benchmarks are Not supported; no custom outbox or HTTP writer is supplied. Electric + TanStack DB is a separate application whose write queue comes from TanStack. Experimental Jazz, browser clients and incompatible access/conflict guarantees remain separate. Zero's current screens and PowerSync's current results come from separate campaigns; no samples are pooled across campaigns. There is no overall product score. For attachments, only SDK-native file storage and transfer features participate; application-provided uploaders are excluded. The [attachment definition](./benchmarks.md#attachments) identifies the different object-store and chunked-sync timing boundaries.

The current collection uses Syncular JS/Rust 0.17.0, up to three attempts per changed case, fresh processes and seeded randomized order. A failed attempt counts toward that limit. The six repaired cases in `publication-coverage-fixes.json` and two native attachment cases in `publication-native-files.json` use one predeclared run each (n=1), with no estimate of run-to-run variability. Unchanged Electric, TanStack, Jazz and Zero cases use retained September 7 results; their companion report identifies that collection. The earlier untuned SQL and array-based Zero screen comparisons were withdrawn.

## Timing and correctness

The harness owns fixtures, warmups, repetitions, fault timing and validation. It checks complete records and exact query outputs; a matching row count is insufficient. Validation stays outside timed operations where the contract permits. Each case records its actual observation boundary, including IPC or query polling where used.

The README shows current and retained historical results together, with collection dates in the linked details. September 7 rows come from unchanged cases in a stopped, withdrawn campaign and are not a newly completed comparison. It reports medians across independent runs within each case and source. A query p50 is the median operation time inside one run; it is not another independent trial. Full reports retain observed ranges and samples. Three attempts provide no confidence interval; the statistics code requires at least five successful trials to compute one.

A failed latest attempt supplies no latency estimate, even if an earlier attempt passed. Earlier failures remain visible after later success. Missing measurements are unavailable, never zero. An unimplemented adapter case does not imply a missing product capability. See [all outcomes](../COVERAGE.md).

Local commit, server acceptance and reader visibility answer different questions. They may overlap. Startup's first-screen and full-copy observers are also independent. Subtracting their medians does not establish an internal processing phase.

## Conditions and limits

The current runs use local services on one Apple M4 host. SQL screen indexes match the measured queries. Syncular's query/collaboration paths use in-memory SQL; PowerSync and Turso use file-backed stores. Startup uses the declared fresh local stores, with server data and OS caches retained. PowerSync's replacement campaign waits for fixture replication and compacts bucket history before client timing. Restarting a service does not establish a cold machine.

External samplers record client process trees and declared workload windows. Polling can miss short peaks, CPU counters have limited resolution, and summed RSS can double-count shared pages. HTTP payload counts and TCP-relay counts have different scopes; neither is automatically total wire traffic. The [meter experiment](../results/diagnostics/http-meter-audit.json) measures instrumentation overhead within its recorded scope.

[Recorded interruptions](./investigations/collection-interruptions.md) affect service/cache history. The recovered campaign retained every saved attempt and documented one narrow Docker empty-DNS serialization equivalence. Recovery did not recreate uninterrupted conditions.

Browser and packet latency/loss integrations have separate diagnostics. Browser collaboration measures SDK behavior through Chromium/CDP, not rendered UI responsiveness. Those diagnostic samples are not part of the native comparison.

## Explanations and evidence

A confirmed explanation needs a controlled experiment or direct accounting. A supported hypothesis has evidence but unresolved alternatives. An unexplained observation has no established cause. Hypotheses name a next experiment rather than claiming an optimization will fix the result.

Current investigations: [index effect](./investigations/screen-index-effect.md), [PowerSync edit latency](./investigations/powersync-collaboration.md), [failed cases](./investigations/tuned-publication-failures.md), and [collection interruptions](./investigations/collection-interruptions.md). Each links to its raw evidence. Earlier investigations and the RFC are in the [documentation archive](./history/README.md).

[Browser client size](../README.md#browser-client-size) is a separate browser measurement. It verifies native storage across reloads and counts requested JavaScript, workers and WASM, including embedded WASM. Plain Electric is labeled as a memory-only reader; native-host binaries are outside this browser comparison. [Scope and exact definitions](./appendices/deployment-footprint.md).
