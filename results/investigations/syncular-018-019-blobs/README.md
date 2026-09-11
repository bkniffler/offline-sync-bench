# Syncular 0.18.0 versus 0.19.0: controlled 500 MB comparison

**0.19 total upload improved in all three pairs for both clients. The Rust result agrees with the repository RFC's direction.** No release conclusion is drawn from earlier separate n=1 runs.

| Measurement | 0.18.0 median | 0.19.0 median | Median change | Paired geometric change |
| --- | ---: | ---: | ---: | ---: |
| JS total upload | 3,399.87 ms | 3,006.24 ms | -11.6% | -7.11% |
| JS upload after staging | 2,050.33 ms | 1,470.24 ms | -28.3% | -21.96% |
| JS fresh download | 1,901.62 ms | 1,890.02 ms | -0.6% | -5.19% |
| Rust total upload | 4,141.38 ms | 3,765.50 ms | -9.1% | -8.60% |
| Rust upload after staging | 2,329.18 ms | 1,989.28 ms | -14.6% | -15.50% |
| Rust fresh download | 2,972.79 ms | 2,202.15 ms | -25.9% | -22.93% |

Total upload is native staging plus upload and linked metadata acceptance. “Upload after staging” excludes staging and is the corresponding metric for the repository RFC. Median change is the ratio of medians; paired geometric change is the geometric mean of the three candidate/baseline ratios, matching the RFC's effect estimator. Three pairs do not reproduce the RFC's larger sample count or confidence gates.

Rust's individual total-upload changes were −4.7%, −9.3% and −11.7%; its post-stage changes were −10.5%, −16.5% and −19.3%. JS post-stage upload also improved in every pair. JS download changes were mixed; its near-zero median change does not establish a repeatable improvement. Rust downloads improved in every pair.

## Why the earlier comparison looked contradictory

The [previous collection](../syncular-019-blobs/README.md) compared **0.17 against 0.19**. The repository RFC compared **0.18 against its 0.19 candidate**. A regression against 0.17 does not contradict an improvement against 0.18: 0.18 added reliability work, including full pending-body validation.

The headline upload timers also differed. In Syncular's `bench/src/blob-lane.ts`, `staged = await measure(..., 'uploadBlob', ...)` completes before `uploadStarted` and `benchSync`. Its RFC reports that later upload-and-commit interval. This benchmark's headline adds staging. The post-stage row above puts those boundaries alongside each other. This harness's Rust interval includes the stdio round trip, while the repository reports its process's operation clock. Their absolute timings are not interchangeable.

The repository RFC reported paired Rust improvements of 8.99% and 6.80% across its two larger collections. This collection's corresponding paired improvement is 15.50%. It confirms the direction, not an identical effect size. No contradictory Rust regression against 0.18 remains to attribute. This experiment does not separately measure which 0.19 code change contributes how much.

## Protocol and evidence

Exact published npm and crates.io clients, no SDK patches or accelerated-hash flags, same verified 0.19.0 server for both versions, same M4/24 GiB machine. Three alternating pairs per client, with client order reversed between blocks. Every attempt uses new writer/reader processes and fresh SQLite stores, resets the server fixture and removes the remote MinIO object. Native attachment APIs, durable staging, metadata acceptance and complete SHA-256 validation remain intact. Fixture reading/preparation and final independent verification are outside operation clocks. OS/server caches and unrelated machine activity are retained; recorded load and free memory describe host conditions.

All 12 attempts completed with full 500,000,000-byte/hash, empty-cache, distinct-process and accepted-commit receipts. There were no retries, exclusions, builds or test suites during timing. Sources and release binary hashes were checked before and after. The published n=1 table is unchanged; no candidate was selected for publication from this collection.

[Every attempt](PAIRS.json) · [Declared order](PLAN.json) · [Calculated effects](COMPARISON.json) · [Captured source](SOURCE.tar.gz) · [Source hashes](SOURCE.json)

Reproduce with `BLOB_PAIR_BASELINE=0.18.0 python3 scripts/blob-pairs/prepare.py`, then `BLOB_PAIR_BASELINE=0.18.0 bun scripts/blob-pairs/run.ts .results/new-018-019-pairs`. Preparation obtains the 0.18 package and Cargo locks/driver from commit `ab758ec`, and the 0.19 pins from this revision. The previously completed 0.17/0.19 collection is preserved separately and never pooled with these samples.
