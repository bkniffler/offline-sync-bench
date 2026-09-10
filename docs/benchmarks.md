# Benchmark definitions

All cases validate expected data and retain raw timing samples, configuration and outcomes. The [methods](./methodology.md) explain comparison rules and limitations. Exact implementation details live in the linked contracts rather than being duplicated here.

## Local screens

`local-query` loads 100,000 tasks in one project with two users. It measures a filtered task list, prefix search and grouped counts. `deep-relationship-query` loads one organization, four projects, ten users and 25,000 tasks per project; it measures a project detail and organization dashboard.

Both cases validate the entire local fixture, run five warmups and 25 measured operations, and check exact projected fields, ordering, limits and aggregate values. SQL indexes are installed before ingestion. Query execution includes the declared application processing. Jazz uses a separate durable seeder that exits before the measured reader. [Contract and exact outputs](../src/contracts/screens.ts).

## Startup

`bootstrap` starts fresh clients at 1,000, 10,000 and 100,000 tasks. Each size has a restarted sync-service condition followed by a warm-service condition. Both retain server storage and OS caches. Explicit configurations can select larger sizes without silently extending deadlines.

Timing begins before client launch. Initialization, first correct 50-row screen and complete offline dataset have separate observed milestones. Complete snapshots are validated; a count or sync-completion signal cannot certify the dataset. Persistent and memory-only startup paths remain distinct. [Contract](../src/contracts/startup.ts).

`replica-reopen` first populates and closes a persistent 2,000-task replica. A new process opens the same store with all client routes blocked. It must serve the first screen and every expected row without network data. The OS file cache remains warm; this is not pending-write crash recovery. Memory-only configurations are ineligible. [Contract](../src/contracts/reopen.ts).

## Collaboration

`online-propagation` starts with 200 validated tasks on independent writer and reader clients. Five warmups precede 50 title updates. Each sample records local commit when exposed, client-observed server acceptance, and independently observed reader visibility.

The reader does not wait for the writer acknowledgment. Native delivery, local polling and IPC boundaries are recorded; their overhead is included. These milestones do not establish crash durability and cannot be added as sequential phases. [Contract](../src/contracts/collaboration.ts).

## Offline recovery

All recovery cases use 2,000 tasks and keep the service and independent reader healthy while blocking only writer routes.

| Case | Offline work | Required recovery |
| --- | --- | --- |
| `offline-replay` | 10 queued writes | Queue completion and correct reader data |
| `large-offline-queue` | 100, 500 and 1,000 writes with fresh clients per scale | Complete writer/reader convergence at each scale |
| `offline-restart` | 1,000 locally acknowledged writes, then SIGKILL | Reopen the same store offline, recover pending work, then converge |

The default outage is 20 seconds from the monotonic blocking anchor. Offline preparation must finish before the declared restoration deadline; missed readiness or excessive restoration lateness invalidates the case. Blocked-route probes and an unchanged reader prove the outage. Full records, including untouched rows, are checked after recovery. Queue completion and reader visibility have independent timers from restoration.

A persistent read cache alone does not prove durable queued writes. Zero's retained memory profile does not prove process-restart durability. TanStack's crash-recovery case uses its native executor with a durable SQLite storage adapter. Plain Electric is excluded from client-write workloads; no custom outbox is supplied. Native queue counters and scoped mutation receipts are identified rather than treated as interchangeable. [Workload](../src/contracts/recovery.ts) · [Validation](../src/contracts/recovery-validation.ts).

## Conflicting edits

`conflict-update-update` and `conflict-update-delete` start three clients with 2,000 tasks. A queues an isolated edit; B changes or deletes that task. The third client must observe B before A reconnects. All clients must then converge according to the predeclared policy, with unchanged records intact.

| Tested write path | Expected behavior |
| --- | --- |
| Syncular with explicit version precondition | Reject the stale update; retain B's edit or deletion |
| PowerSync SQL PATCH, TanStack application SQL, Turso SQL UPDATE, Zero title-only mutator | Apply A's later title update to an existing row; preserve a missing row as deleted |
| Jazz timestamp-ordered update / soft delete | Retain B's later-written title; deletion retention remains an explicitly tested requirement with historical failures |

These are configured application paths, not universal product conflict policies. Different outcomes are not combined into a latency ranking. One ordered race does not cover every possible interleaving. [Contract and policies](../src/contracts/conflicts.ts).

## Connected clients and reconnecting clients

`connected-fanout` starts a writer and five or 25 independent readers with 2,000 tasks each. After a readiness update, time one live update reaching every reader, without controller catch-up requests.

`reconnect-storm` blocks the reader routes and accumulates 100 updates. A healthy witness must confirm the backlog while each disconnected reader still has the old snapshot. Restore routes together, perform the declared native recovery, and measure every reader reaching the complete correct dataset. Service restart is excluded.

The result retains per-reader completion and time until all readers converge. Readers within one run are not independent campaign trials. Fresh cache identities, blocked-route evidence, unchanged rows and server/client resource scopes are checked. [Contract](../src/contracts/fanout.ts).

## Access revocation

`permission-change` starts with two 500-task projects. Revoke one actor's access to one project and verify that the affected client retains exactly the still-authorized data. Test online and offline/reconnect behavior, plus fresh clients for affected and unaffected actors.

Native purge of the existing store and application cache replacement are distinct guarantees. Electric and TanStack use declared application refresh paths. Zero's tested cache is memory-only. The tested Turso whole-database profile has no equivalent row-revocation case. Removing local rows does not erase previously copied data, and an offline client cannot receive a revocation before reconnecting. [Contract](../src/contracts/access.ts).

## Attachments

`blob-flow` uses 50 tasks and two deterministic 2 MiB objects. Independent writer/reader processes and fresh stores measure staging, upload, metadata acceptance and reader visibility. Validate exact metadata, object hashes and empty queues.

An upload failure must retain queued work without publishing metadata to the reader. A fresh client downloads an uncached object. Another download is interrupted after 65,536 bytes, then retried and validated after transport restoration. This establishes full-object retry, not byte-range resume or writer crash durability. Resource windows and byte counters remain distinct from completion latency. [Contract](../src/contracts/attachments.ts).
