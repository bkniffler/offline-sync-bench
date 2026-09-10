# Benchmark results

**Both 2 MiB objects upload and independent fresh and interrupted clients download the expected complete bytes.**

PowerSync has a measured native attachment path. The queue and Node file transport are experimental; upload excludes staging and includes queue startup.

Campaign `campaign-2026-09-10T11-43-03-468Z`: 1 independent trials per case, in seeded randomized order. Network: local service routes, no injected delay or loss. Host: Apple M4.

[Full tables and explanations](results/reports/campaign-2026-09-10T11-43-03-468Z/DETAILS.md) · [Raw measurements](archive/files/RESULTS.json.gz) · [Methodology](docs/methodology.md)

## Coverage and outcomes

| Suite | powersync | jazz-v2 | syncular |
| --- | --- | --- | --- |
| Startup | 2 not run | 2 not run | 2 not run |
| Collaboration | 1 not run | 1 not run | 1 not run |
| Offline recovery | 5 not run | 5 not run | 5 not run |
| Local screens | 2 not run | 2 not run | 2 not run |
| Client fanout and recovery | 2 not run | 2 not run | 2 not run |
| Access revocation | 1 not run | 1 not run | 1 not run |
| Attachments | 1 passed | 1 passed | 1 not run |

Counts describe the latest outcome per case. Failed-trial counts include every failed, invalid or timed-out attempt, even when a later trial passed. “Unsupported” applies only to the tested configuration; “not implemented” and “not run” make no product-capability claim.

Stacks outside this campaign: Syncular Rust Client, Electric, Electric + TanStack DB, Zero, Turso Sync.

## Findings

### Both 2 MiB objects upload and independent fresh and interrupted clients download the expected complete bytes.

Does PowerSync’s own attachment queue complete the file workflow?

Two 2 MiB objects linked to 50-task fixtures; native upload and independent fresh/retry clients. Profile: stable native host; native-files-v1. [Full configuration](results/reports/campaign-2026-09-10T11-43-03-468Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Upload (ms) | Fresh download (ms) | Download retry (ms) |
| --- | --- | --- | --- | --- | --- |
| powersync / native-sqlite-and-filesystem | 1 / 1 | completed | 21.06 [21.06–21.06] | 53.15 [53.15–53.15] | 10.91 [10.91–10.91] |

Two 2 MiB objects linked to 50-task fixtures; native upload and independent fresh/retry clients. Profile: experimental native host; native-files-v1. [Full configuration](results/reports/campaign-2026-09-10T11-43-03-468Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Upload (ms) | Fresh download (ms) | Download retry (ms) |
| --- | --- | --- | --- | --- | --- |
| jazz-v2 / native-fjall-file-parts | 1 / 1 | completed | 201 [201–201] | 206 [206–206] | 685 [685–685] |

Evidence: **confirmed**. The SDK AttachmentQueue owns persistence, state transitions and retries. Its NodeFileSystemTransportAdapter streams bytes directly to the same MinIO service used by Syncular. The harness supplies signed URLs and task metadata integration. A truncated HTTP response leaves QUEUED_DOWNLOAD with hasSynced false; restoration produces SYNCED and the correct hash. Setup verifies active sync rules and fixture-history maintenance before timing.

PowerSync has a measured native attachment path. The queue and Node file transport are experimental; upload excludes staging and includes queue startup.

- [Native result identities, metrics, profiles and interpretation](archive/files/evidence/powersync-native-files.json.gz)

### The native file helpers create eight 256 KiB parts per object, and both independent download processes reconstruct the correct 2 MiB hash.

Can Jazz’s native chunked files recover after interruption?

Two 2 MiB objects linked to 50-task fixtures; native upload and independent fresh/retry clients. Profile: stable native host; native-files-v1. [Full configuration](results/reports/campaign-2026-09-10T11-43-03-468Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Upload (ms) | Fresh download (ms) | Download retry (ms) |
| --- | --- | --- | --- | --- | --- |
| powersync / native-sqlite-and-filesystem | 1 / 1 | completed | 21.06 [21.06–21.06] | 53.15 [53.15–53.15] | 10.91 [10.91–10.91] |

Two 2 MiB objects linked to 50-task fixtures; native upload and independent fresh/retry clients. Profile: experimental native host; native-files-v1. [Full configuration](results/reports/campaign-2026-09-10T11-43-03-468Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Upload (ms) | Fresh download (ms) | Download retry (ms) |
| --- | --- | --- | --- | --- | --- |
| jazz-v2 / native-fjall-file-parts | 1 / 1 | completed | 201 [201–201] | 206 [206–206] | 685 [685–685] |

Evidence: **confirmed**. The public backend context uses the native local-tier runtime. createFileFromBlob waits for edge durability; loadFileAsBlob queries the native parts. After the first delivered chunk, the TCP connection is blocked and the stream cancelled. An offline native read rejects the incomplete file before restoration. The retry retains SDK-cached parts and includes native reconnection delay.

Jazz has a measured native file path. Its upload includes chunk creation and persistence; its retry is chunked sync, so these timings have different boundaries from object-store clients.

- [Native result identities, metrics, profiles and interpretation](archive/files/evidence/jazz-native-files.json.gz)

### The two SDKs expose different upload and retry operations despite transferring the same deterministic payloads.

What explains the timing difference between these native file paths?

Two 2 MiB objects linked to 50-task fixtures; native upload and independent fresh/retry clients. Profile: stable native host; native-files-v1. [Full configuration](results/reports/campaign-2026-09-10T11-43-03-468Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Upload (ms) | Fresh download (ms) | Download retry (ms) |
| --- | --- | --- | --- | --- | --- |
| powersync / native-sqlite-and-filesystem | 1 / 1 | completed | 21.06 [21.06–21.06] | 53.15 [53.15–53.15] | 10.91 [10.91–10.91] |

Two 2 MiB objects linked to 50-task fixtures; native upload and independent fresh/retry clients. Profile: experimental native host; native-files-v1. [Full configuration](results/reports/campaign-2026-09-10T11-43-03-468Z/DETAILS.md).

| Stack / client path | Passed / attempted | Latest outcome | Upload (ms) | Fresh download (ms) | Download retry (ms) |
| --- | --- | --- | --- | --- | --- |
| jazz-v2 / native-fjall-file-parts | 1 / 1 | completed | 201 [201–201] | 206 [206–206] | 685 [685–685] |

Evidence: **unexplained**. PowerSync runs an object-store queue; Jazz persists and syncs file-part rows. The receipts establish their executed paths and correctness, but do not isolate chunking, local persistence, scheduling, HTTP transport or native sync costs.

Use the numbers to understand these integrations, with the table caveats. One run cannot establish a stable product speed ratio.

- [Native result identities, metrics, profiles and interpretation](archive/files/evidence/native-file-comparison.json.gz)

Next experiment: Instrument native staging, persistence, transport and reconnection separately while preserving complete byte validation.

## Reading these results

Server volumes and writable layers are retained under the declared preparation policy. Physical-state observations are linked in the full report; logical fixture resets do not establish fresh storage.

Cells summarize independent trial values: median and observed min–max range with fewer than five successes, or median and 95% bootstrap interval with at least five. † marks an interval wider than 25% of the median; treat that estimate as imprecise. Operation percentiles remain distinct from trial counts. A failed latest attempt has no speed estimate; earlier failures remain in the coverage summary and full tables. Different profiles appear in separate tables.

Stopping rule: Run exactly one independent attempt for PowerSync native attachments and one for Jazz native files, sequentially. Syncular is included only to capture the shared MinIO service configuration; it has no trial in this campaign. Keep every outcome, including failures, without selective retries. Do not pool development checks or prior attempts. Label measurements n=1 and describe native staging, transfer and retry boundaries. No application-owned attachment queue is measured.

[Exact benchmark source snapshot](archive/files/results/sources/ffe73aa8bfe7511de9ceb2274ba36c468ea7c1ce8047ea512fb24063f7dd6d18/SOURCE.json.gz). [Installed dependency inventory](archive/files/results/dependencies/8fcfee81dbc5a09251577cb486a4540bd61c224166ba85b347284c442ed6472e/DEPENDENCIES.json.gz) records host package and native addon checksums. [Runtime and service configuration](archive/files/results/configurations/31293bac300fccc936927f05dd42092600ff070c30714b4ad29a8f907e71ce2b/CONFIGURATION.json.gz) records overrides, resolved services and mounted configuration inputs. Raw operation samples, resource windows, output checks and configuration are in the measurements. Source revision: `9c9cea2b11b5c100b02b038340f4da2468773c28`; dirty: true.

Historical measurements predating the shared contracts remain in [the archive](results/history/2026-09-05/README.md).
