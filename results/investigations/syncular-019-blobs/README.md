# Syncular 0.19.0: 500 MB transfers

Exact published npm/crates.io 0.19.0 packages; native SQLite attachment APIs, unchanged staging/transfer/metadata-acceptance boundaries and full 500,000,000-byte SHA-256 verification. Twelve attempts completed: three alternating pairs per client against 0.17.0. Each attempt starts independent writer/reader processes and empty stores, resets the server fixture and removes the remote object. No retries or rejected samples.

The initially selected n=1 candidate was withheld when a controlled 0.18 baseline was requested. Its raw receipt remains in [UNPUBLISHED-CANDIDATE.json](UNPUBLISHED-CANDIDATE.json). No cross-run 0.18/0.19 improvement claim is made. Use the [separate controlled 0.18/0.19 comparison](../syncular-018-019-blobs/README.md) for the RFC's release baseline.

## Controlled comparison with 0.17.0

Both clients use the same 0.19 server and common HTTP meter. Three alternating pairs per client, on the same M4/24 GiB machine; medians below. OS/server caches and unrelated host activity are retained. Load, free memory, exact locks, binary hashes, source hashes and actual server versions are recorded.

| Measurement | 0.17.0 median | 0.19.0 median | Change |
| --- | ---: | ---: | ---: |
| JS upload | 2,979.60 ms | 3,022.08 ms | +1.4% |
| JS fresh download | 2,113.70 ms | 1,750.24 ms | -17.2% |
| Rust upload | 3,294.29 ms | 4,211.32 ms | +27.8% |
| Rust fresh download | 3,502.10 ms | 2,366.21 ms | -32.4% |

Downloads improved for both clients in every pair. JS upload differences varied in direction; Rust uploads remained slower than 0.17 in every pair. Three pairs support these observations, not a universal percentage claim.

The released 0.19 source removes stored reference-count maintenance from the blob cache while retaining native staging and integrity checks. This collection does not isolate that change's contribution. No custom filesystem transport, accelerated-hash build flag, SDK patch or removed validation was introduced. Input-file reading and final independent hash verification remain outside the published timers; SDK hashing and durable caching remain inside.

[All paired results](PAIRS.json) · [Predeclared plan](PLAN.json) · [Source archive](SOURCE.tar.gz) · [Source hashes](SOURCE.json)

Reproduce from this revision with `python3 scripts/blob-pairs/prepare.py`, then `bun scripts/blob-pairs/run.ts .results/new-019-pairs --publish-candidate`. This creates a publication candidate from the first 0.19 attempt per client; publishing is a separate audited step. The collection was made with the 0.19.0 release identified by tag `v0.19.0` / commit `a6d50930113706db745c89176b2d31541b77a820` supplied by the release task; dependency integrity is independently bound by the registry lockfiles.
