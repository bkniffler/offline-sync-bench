# Benchmark results

Campaign `campaign-2026-09-10T11-43-03-468Z`. 1 independent trials per case, with seeded randomized order. Network: local service routes, no injected delay or loss. [Measurements and manifest](../../../archive/files/RESULTS.json.gz). [Methodology](../../../docs/methodology.md).

These measurements describe the listed runtime and workload profiles. A failed latest attempt remains failed; older successful attempts do not replace it. Confidence intervals resample independent trial medians. Results with fewer than five successful trials show the observed min–max range, not a confidence interval.

## Coverage and outcomes

| Stack | Case | Latest outcome | Passed / attempted | Comparison |
| --- | --- | --- | --- | --- |
| jazz-v2 | blob-flow | completed | 1 / 1 | native-fjall-file-parts |
| powersync | blob-flow | completed | 1 / 1 | native-sqlite-and-filesystem |

[Individual trial files and logs](../../../archive/files/results/reports/campaign-2026-09-10T11-43-03-468Z/TRIALS.json.gz). The index includes every attempt and its outcome.

## Server storage preparation

retain existing server volumes and writable layers; scenario-specific logical fixture preparation.

Each attempt retains before/after Docker writable-layer bytes and mounted-path allocated KiB in its raw metadata. Startup additionally records each client boundary after fixture preparation. These are live observations, not logical payload sizes or evidence of normalized server state. Missing counters remain unavailable. Read-only configuration mounts are covered by the configuration artifact. In-memory caches, deleted-file storage and OS caches are outside these disk observations.


Outside this campaign: bootstrap, replica-reopen, online-propagation, offline-replay, large-offline-queue, offline-restart, conflict-update-update, conflict-update-delete, local-query, deep-relationship-query, connected-fanout, reconnect-storm, permission-change. These cases remain visible as coverage work; omission does not establish a missing product capability.

## Findings

### Both 2 MiB objects upload and independent fresh and interrupted clients download the expected complete bytes.

Evidence: **confirmed**. The SDK AttachmentQueue owns persistence, state transitions and retries. Its NodeFileSystemTransportAdapter streams bytes directly to the same MinIO service used by Syncular. The harness supplies signed URLs and task metadata integration. A truncated HTTP response leaves QUEUED_DOWNLOAD with hasSynced false; restoration produces SYNCED and the correct hash. Setup verifies active sync rules and fixture-history maintenance before timing.

PowerSync has a measured native attachment path. The queue and Node file transport are experimental; upload excludes staging and includes queue startup.

- [Native result identities, metrics, profiles and interpretation](../../../archive/files/evidence/powersync-native-files.json.gz)

### The native file helpers create eight 256 KiB parts per object, and both independent download processes reconstruct the correct 2 MiB hash.

Evidence: **confirmed**. The public backend context uses the native local-tier runtime. createFileFromBlob waits for edge durability; loadFileAsBlob queries the native parts. After the first delivered chunk, the TCP connection is blocked and the stream cancelled. An offline native read rejects the incomplete file before restoration. The retry retains SDK-cached parts and includes native reconnection delay.

Jazz has a measured native file path. Its upload includes chunk creation and persistence; its retry is chunked sync, so these timings have different boundaries from object-store clients.

- [Native result identities, metrics, profiles and interpretation](../../../archive/files/evidence/jazz-native-files.json.gz)

### The two SDKs expose different upload and retry operations despite transferring the same deterministic payloads.

Evidence: **unexplained**. PowerSync runs an object-store queue; Jazz persists and syncs file-part rows. The receipts establish their executed paths and correctness, but do not isolate chunking, local persistence, scheduling, HTTP transport or native sync costs.

Use the numbers to understand these integrations, with the table caveats. One run cannot establish a stable product speed ratio.

- [Native result identities, metrics, profiles and interpretation](../../../archive/files/evidence/native-file-comparison.json.gz)

Next experiment: Instrument native staging, persistence, transport and reconnection separately while preserving complete byte validation.

## Attachments

Profile: `29a3f0c519a7ddd3635695b2a02d59189d2ccc3fe4f7c8a7a74fa7ca30c7a426` (experimental-native-host).

Two deterministic 2 MiB objects linked to tasks, with separate fresh and interrupted-download clients. SDK-specific profiles record staging, upload, native metadata and retry boundaries; those boundaries differ between object-store queues and chunked sync. Complete byte hashes are validated. Resource windows and protocol-specific interruption receipts remain in the artifact. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | initial upload | initial server accepted | initial metadata visible | fresh download | download interruption recovery |
| --- | --- | --- | --- | --- | --- |
| jazz-v2 / experimental-native-host | 201 [201–201] (n=1) | not-measured | not-measured | 206 [206–206] (n=1) | 685 [685–685] (n=1) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Attachments

Profile: `abe88cdf1aa7d3cb968572658854c8eb2ef569b332e1a0731282d89448becc8a` (stable-native-host).

Two deterministic 2 MiB objects linked to tasks, with separate fresh and interrupted-download clients. SDK-specific profiles record staging, upload, native metadata and retry boundaries; those boundaries differ between object-store queues and chunked sync. Complete byte hashes are validated. Resource windows and protocol-specific interruption receipts remain in the artifact. Cells show the median of successful trial durations in milliseconds, with a 95% bootstrap interval where available. Failure counts remain in the coverage table.

| Stack / lane | initial upload | initial server accepted | initial metadata visible | fresh download | download interruption recovery |
| --- | --- | --- | --- | --- | --- |
| powersync / stable-native-host | 21.06 [21.06–21.06] (n=1) | not-measured | not-measured | 53.15 [53.15–53.15] (n=1) | 10.91 [10.91–10.91] (n=1) |

† Interval width exceeds 25% of the median. Treat this estimate as imprecise.

## Interpretation

External resource samples, raw operation timings, output digests, runtime versions, source fingerprints, and image identities are included in the measurements. Sampled RSS is process-tree memory and can count shared pages more than once. Each contract records its measurement window; recovery excludes setup and queue construction.

[Exact benchmark source snapshot](../../../archive/files/results/sources/ffe73aa8bfe7511de9ceb2274ba36c468ea7c1ce8047ea512fb24063f7dd6d18/SOURCE.json.gz) includes file bytes, modes, symlinks and deleted paths. Source revision: `9c9cea2b11b5c100b02b038340f4da2468773c28`; dirty: true.

Stopping rule: Run exactly one independent attempt for PowerSync native attachments and one for Jazz native files, sequentially. Syncular is included only to capture the shared MinIO service configuration; it has no trial in this campaign. Keep every outcome, including failures, without selective retries. Do not pool development checks or prior attempts. Label measurements n=1 and describe native staging, transfer and retry boundaries. No application-owned attachment queue is measured.

Historical measurements predating the shared contracts are preserved in [the archive](../../history/2026-09-05/README.md). They are excluded from these comparisons.
