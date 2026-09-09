# What the screen indexes change

Status: six controlled attempts passed; separate from product timings.

Matching the filter and ordering changes these SQLite reads substantially. The original list and prefix-search plans used temporary ordering trees even though an index was present. Adding the two screen indexes removed those sorts. Grouped counts switched from a temporary grouping tree to a covering index.

| Query | Original indexes: median [min–max], ms | Tuned indexes: median [min–max], ms |
| --- | --- | --- |
| Filtered list | 10.44 [10.43–10.66] | 0.01033 [0.01033–0.01133] |
| Prefix search | 10.94 [10.74–10.95] | 0.01083 [0.01025–0.01133] |
| Grouped counts | 21.91 [21.84–21.96] | 3.762 [3.69–3.792] |

Each value summarizes three fresh processes, with five warmups and 25 recorded operations per query in each process. Ranges are the observed minimum and maximum of the three per-process medians, not confidence intervals. Every output matched. [Chart](../../results/diagnostics/screen-index-effect/index-effect.svg) · [Raw samples, plans and verification](../../results/diagnostics/screen-index-effect/VERIFICATION.json).

The [controlled reduction](../../scripts/diagnose-screen-index-effect.ts) loads the canonical 100,000-task fixture into Bun SQLite in memory. Queries, data and runtime stay fixed. Both conditions retain the original `(project_id, completed, updated_at_ms)` and `(owner_id)` indexes; the tuned condition adds `(project_id, owner_id, completed, id)` and `(project_id, id)`. The recorded SQLite version is 3.54.0.

The practical lesson is to check the plan for the actual screen: an existing index can still leave expensive ordering and grouping work. This experiment establishes the effect of these two indexes within the tested SQLite fixture. It does not measure Syncular API overhead, replication, ingestion or index construction, and cannot explain the 0.17.0 upgrade or differences between products. The unused `updated_at_ms` field is held at zero; this does not reconstruct an archived client database.

The main campaign was [paused between attempts](../../results/diagnostics/publication-index-review/SPACE-GUARD-PAUSE.json) throughout the diagnostic. The six diagnostic attempts do not enter publication counts. Their seeded order, input copies, executable hash, exact fixture/output checks and individual outcomes are retained.

To reproduce into a new directory with no publication trial active:

```sh
bun scripts/diagnose-screen-index-effect.ts .tmp/screen-index-effect-reproduction
```
