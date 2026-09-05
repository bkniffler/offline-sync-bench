# Syncular coverage and measurement notes

Both published Syncular 0.16.1 clients now run bootstrap at 1k, 10k, 100k,
250k and 500k rows, and reconnect sweeps at 25, 100, 250, 500 and 1,000 clients.
Blob flow includes an injected upload outage, retained-queue checks, recovery,
byte verification, body-transfer overhead and local SQLite allocation growth.
The Rust relationship-query case also records native-process memory.

The published measurements are in [RESULTS.md](./RESULTS.md) and
[RESULTS.json](./RESULTS.json). These are individual measurements on the same
Apple M4 machine, not statistically established rankings.

## Completed runs

All nine scenarios passed for each client: **18 completed, zero failed**.
The final report contains no missing Syncular table cells.

| Client | 250k bootstrap | 500k bootstrap | 1,000-client catch-up | Blob retry recovery |
| --- | ---: | ---: | ---: | ---: |
| JS | 3.47 s | 9.94 s | 1.28 s | 42.16 ms |
| Rust | 2.99 s | 10.89 s | 2.52 s | 61.13 ms |

JS's 500-client result was 5.45 seconds, slower than its 1,000-client result.
These single samples do not establish a monotonic scaling curve.

Validation: TypeScript typecheck, nine harness tests, the strict publication
coverage check, exact bootstrap row counts, and blob queue/content checks.
The setup-only database index was confirmed absent after the runs.

## Measurement corrections

- Concurrent reconnect runs with the original Bun SQL executor produced
  malformed client records (missing client ID and actor), false actor-binding
  errors and stalled requests. [The recorded failed sweep](./results/diagnostics/syncular-bun-sql-reconnect-storm.json)
  captures those failures. The server wiring now uses the already-pinned Postgres.js 3.4.9
  package with a 10-connection pool. A storage read-contract check rejects
  malformed records explicitly. The published suites were rerun with this
  configuration; medians do not mix database driver profiles. The specific
  defect inside the Bun SQL integration has not been isolated to a minimal
  reproduction.
- Docker resource polling previously used synchronous subprocesses. A poll
  could block the harness event loop for about two seconds and inflate storm
  convergence times. Polling is now asynchronous and cannot overlap. A live
  check recorded 481 timer ticks during polling, with a largest gap of 18 ms.
  Electric's affected storm case was rerun too. Different storm implementation
  versions are excluded from each other's repeat summaries.
- Cloning upload requests for body metering changed Bun's S3 PUT framing to
  chunked transfer. In the observed JS blob run this caused a fallback upload
  and an extra 2 MiB of counted request data. Syncular HTTP metering now preserves
  Content-Length; the corrected run sent one payload and measured about 2.9 KB
  of body overhead.
- Large fixture setup temporarily indexes row-scope lookups, avoiding repeated
  full-table scans while seeding through the product's normal storage API.
  That index is dropped before seed readiness. Neither the index nor setup
  time is part of a timed sync measurement.
- Reconnect fixtures reset engine state and restart the server before client
  bootstrap. The measured interval covers one changed row reaching all
  already-bootstrapped clients against the running service.

## Interpretation

A failed reconnect tier stays `failed`, with its reason, while successful
smaller tiers keep their measured values. A failure is an attempted test,
not a latency result. Missing measurements and unsupported scenarios are
labeled separately. `--require-syncular-coverage` refuses to publish an
unattempted required Syncular tier or an absent required metric.

Blob retry injects an outage before sending the PUT body. It tests the
product's pending-upload retry path; it does not test partial-byte resumability
or process-restart recovery. Transfer overhead excludes HTTP headers and
network framing. Rust's native counters omit grant/redirect JSON bodies, so
its overhead is labeled as a lower bound.

SQLite overhead is page allocation growth minus one payload. Zero means the
observed allocation grew by exactly the payload size; existing free space and
page allocation granularity can absorb metadata. It does not mean all blob
handling has zero storage cost. Rust memory is native-client RSS; JS memory is
the Bun suite process, including allocations retained from earlier cases.
