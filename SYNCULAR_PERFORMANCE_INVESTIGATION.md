# Syncular performance investigation — 2026-09-05

The upgrade introduces measurable server overhead. The clearest cold-bootstrap cause is smaller Postgres scan pages interacting with a full-table join plan. Push serialization also adds database round trips. The original single-run 88% large-queue slowdown was not reproduced, and a controlled client comparison shows no consistent JS-client regression.

Source: the [Syncular repository](https://github.com/syncular/syncular), using a checkout that was clean before and after investigation. Compared `v0.15.18` (`bec8c6d1`, July 18) with `v0.16.1` (`1620b10a`, September 5): 110 commits. The final release commit changes Rust generator compatibility; relevant runtime changes precede it.

## Cold bootstrap: smaller pages cause repeated full-table scans

Commit `08ea8d05` (September 5, “Fix sync correctness and consolidate client snapshots”) changes SQLite image generation from collecting 50,000-row scan pages to consuming asynchronous 5,000-row batches. It also coalesces simultaneous builds. These changes target memory and concurrent bootstrap efficiency.

For 100,000 rows, including the initial 1,001-row eligibility probe, the image path now makes 21 storage scans instead of 3. In an isolated Postgres reproduction, `EXPLAIN (ANALYZE, BUFFERS)` on a 5,000-row page showed:

```text
Hash Right Join
  Hash Cond: (r._sync_row_id = sync_row_scopes.row_id)
  Seq Scan on tasks r (actual rows=100000 loops=1)
    Filter: (_sync_partition = 'image')
  ... Limit (actual rows=5000)
      Index Only Scan using sync_row_scopes_pkey
```

The scope index finds the page efficiently, but Postgres scans all task rows to join their payloads. Smaller pages repeat that work more often. This is a measured plan choice for this fixture, not a claim that every deployment chooses this plan.

Five alternating runs over the same 100,000-row fixture:

| Image-building path | Median | Range | Storage scans |
| --- | ---: | ---: | ---: |
| 0.15.18 builder, 50k pages | 258.0 ms | 248.7–269.0 ms | 3 |
| 0.16.1 builder, 5k pages | 398.6 ms | 396.6–409.1 ms | 21 |
| 0.16.1 builder, 50k pages, diagnostic only | 260.6 ms | 258.9–262.2 ms | 3 |

All images contained exactly 100,000 rows and were 6,938,624 bytes. Returning only the page size to 50k removes almost all the measured difference. This isolates the scan strategy from the new SQLite builder. It does not measure HTTP, client materialization, concurrent build coalescing, or memory savings; the synthetic rows are smaller than the full benchmark's rows.

The original 100k warm-bootstrap result was almost unchanged: 164.38 → 165.80 ms. That is consistent with an image-construction cost, because the warm run reuses the cached image.

Source: `packages/server/src/pull.ts:303`, `packages/server/src/relational-rows.ts:388`.

## Push replay: four additional SQL calls per commit

Commit `2899d592` (July 18, “fix(server): serialize overlapping push delivery”) makes partition serialization and the locked idempotency recheck mandatory, including when no whole-commit validator is configured. Each successful commit gains:

1. Ensure the partition row exists.
2. Lock it with `SELECT ... FOR UPDATE`.
3. Create a candidate savepoint.
4. Recheck the cached push result while holding the lock.

These protect concurrent delivery, validation and atomic rejection. They should not simply be removed.

An instrumented `PgExecutor` confirmed 10 → 14 SQL calls per one-operation commit, excluding the driver's BEGIN/COMMIT. A 1,000-commit replay therefore adds 4,000 calls. Four alternating runs per variant, truncating the dedicated database before every fixture:

| Server push implementation | Median for 1,000 commits | Range | Executed SQL calls |
| --- | ---: | ---: | ---: |
| 0.15.18 | 1,991 ms | 1,867–2,073 ms | 10,000 |
| 0.16.1 | 2,221 ms | 2,125–2,503 ms | 14,000 |
| 0.16.1 with those four calls bypassed, diagnostic only | 2,066 ms | 1,952–2,195 ms | 10,000 |

The bypass exists only in a temporary single-writer profiling script; no product or running-server code was changed. These measurements exclude the HTTP handler, authorization, realtime delivery and client work. They establish extra push cost, not an exact attribution of the full end-to-end delta.

Source: `packages/server/src/push.ts:905`, `packages/server/src/postgres-storage.ts:229`, `packages/server/src/postgres-storage.ts:668`.

## Log epochs add an initial request

Commit `d8f34180` (August 8, “Add production restore and client lifecycle support”) adds log epochs so clients can detect a restored/replaced server history. A fresh client first acquires its epoch before normal sync. The request handler also touches the partition registry in Postgres.

The original 100k bootstrap recorded 3 → 4 HTTP requests and exactly 400 additional request/response body bytes. This protocol cost is confirmed; its isolated wall-clock contribution was not measured.

Source: `packages/server/src/handler.ts:230`, `packages/server/src/handler.ts:719`, `packages/server/src/postgres-storage.ts:1021`.

## No consistent JS replay regression in the client comparison

Ran the existing 1,000-write replay helper with both client versions against the same 0.16.1 Docker server, alternating order, three runs per client. Used the original title prefix, dataset size, metering, SQLite database, two sync rounds, and final server verification.

| Client | Median replay | Range | Body bytes |
| --- | ---: | ---: | ---: |
| 0.15.18 | 2,404 ms | 2,115–2,434 ms | 583,350 |
| 0.16.1 | 2,206 ms | 2,148–2,453 ms | 583,514 |

Every run applied all 1,000 writes without conflicts. Updated-client runs did not reproduce the original 3,621.86 ms result. The earlier 1,922.94 → 3,621.86 ms comparison is a valid pair of observations, but insufficient evidence of a stable 88% regression. These three repetitions also do not establish a client speedup. The precise cause of the original run's additional delay remains unproven.

## Suggested next changes

First investigate the Postgres page join so bounded pages fetch only their selected payloads, preserving the memory benefit of smaller batches. Then reduce SQL round trips in serialized push setup while retaining the lock, idempotency and rejection guarantees. Validate both with repeated end-to-end workloads and concurrency tests.

No changes were made to the Syncular checkout or its running server. The dedicated profiling database was removed. Local raw measurements are in `.results/upgrade-2026-09-05/syncular-investigation/`; temporary reproduction scripts and isolated old npm packages are in `.tmp/syncular-investigation/`. These local artifact directories are excluded from Git. Preliminary push trials that accumulated data across cases were discarded in favor of the reset-per-case measurements above. Timed experiments ran sequentially on macOS arm64, Bun 1.4.0, against the existing Postgres 16 container; the full replay's Docker server uses Bun 1.3.14. This was a local development machine, not an isolated performance host.
