# Did Syncular 0.18.0 make 500 MB transfers slower?

The earlier 2.4× upload increase is **not established as a release regression**. Three controlled pairs produced smaller median increases: 10% for JS and 14% for Rust, with substantial variation. Rust's additional pre-upload integrity check has a measurable cost; the cause of the original multi-second staging spike remains unknown.

## Same-machine comparison

Exact published clients, alternating order, three independent pairs per client. Each attempt uses new writer/reader processes and SQLite stores, resets the server fixture and removes the remote object. The server stays at 0.18.0 to isolate the client change. All 12 attempts passed complete 500,000,000-byte SHA-256 verification, empty-cache checks and metadata acceptance.

| Measurement | 0.17.0 median | 0.18.0 median | Change |
| --- | ---: | ---: | ---: |
| JS upload, including staging | 3,876.41 ms | 4,277.03 ms | +10.3% |
| Rust upload, including staging | 3,922.50 ms | 4,467.20 ms | +13.9% |
| JS fresh download | 2,985.61 ms | 2,439.60 ms | −18.3% |
| Rust fresh download | 3,997.47 ms | 3,595.27 ms | −10.1% |

Individual paired upload changes were **+10%, +34%, −20% for JS** and **+72%, +18%, +7% for Rust**. Three pairs on this shared M4/24 GiB machine cannot establish a stable percentage regression. OS/server caches and unrelated machine activity were not controlled; load and free memory are recorded. This does not test a server-release effect. Input-file reading and final independent hash verification are outside the timers, as in the published benchmark. The corrected common HTTP meter is identical for both releases.

[All pairs and provenance](PAIRS.json) · [Declared order](PLAN.json). The original published n=1 results and README tables are unchanged.

## Where the time goes

These are **separate diagnostic runs, one per release/client**, not replacement results. JS observers wrap public database, crypto and transport calls. Rust uses an archived timer-only source patch plus its shipped `bench-internals` feature. Nested spans overlap; do not add inclusive measurements twice.

| Diagnostic phase | JS 0.17 | JS 0.18 | Rust 0.17 | Rust 0.18 |
| --- | ---: | ---: | ---: | ---: |
| Input read / harness copy, outside upload | 588.47 ms | 192.10 ms | 79.69 ms | 82.96 ms |
| SDK stage hash | 726.03 ms | 376.57 ms | 902.31 ms | 888.63 ms |
| Stage SQLite insertion + durable commit | 3,096.81 ms | 1,345.91 ms | 1,155.47 ms | 1,042.03 ms |
| Read pending body from SQLite | 313.81 ms | 140.58 ms | 108.38 ms | 86.95 ms |
| Rehash pending body before upload | Not performed | 209.29 ms | Not performed | 890.34 ms |
| HTTP object PUT, including transport work | 1,982.14 ms | 1,396.26 ms | 1,097.06 ms | 1,143.06 ms |
| Metadata sync transport | 30.90 ms | 25.60 ms | 12.30 ms | 12.98 ms |

Metadata acceptance also includes local response application. In 0.18, the JS reference-count updates alone took 388.66 ms; Rust's blob reconciliation took 350.26 ms. Transport timing is not a complete acknowledgement timing.

The JS stage additionally copies the full body: 0.17 copies for hashing, while 0.18 copies at API entry to own the input. Those copies took 489.66 ms and 49.27 ms respectively in these noisy diagnostic runs; their times are outside the hash row. Native SQLite binding/materialization is included in the storage measurement. Both releases already use WAL and FULL durability. The separate 0.18 commit spans were 644.43 ms for JS and 361.59 ms for Rust; Rust 0.17 commits inside its individual SQL executions.

Fresh downloads also hash and durably cache the body. Rust 0.18 removes the public API's hex conversion: that conversion took 447.18 ms in the 0.17 diagnostic, nested in cache-read time. The benchmark uses `fetch_blob_bytes` on 0.18 and the available `fetch_blob` API on 0.17.

[Full phase measurements](DIAGNOSTICS.json) · [Exact source, probes and patch](SOURCE.tar.gz) · [Source hashes](SOURCE.json)

## What should change

1. **Enable accelerated Rust SHA-256 on supported targets.** The current ARM64 build uses `sha2` 0.10.9's software path ([resolved features](RUST-HASH-FEATURES.txt)). An isolated three-pair experiment with the same crate and file reduced median hashing from **876.77 ms to 193.57 ms** using its `asm` feature, with every digest verified. This is a 4.5× hash improvement, not a measured end-to-end SDK improvement. [Experiment](HASH-PAIRS.json)
2. **Separate blob bodies from frequently updated metadata.** SQL insertion, commit and reference-count updates are expensive in both releases. A file-backed body store is worth prototyping; these measurements do not yet prove its eventual gain or which internal SQLite operations cause every delay.
3. **Keep the reliability guarantees.** 0.18 validates pending bodies, owns JS input bytes, atomically stages native bodies with their upload record, and pins bodies until metadata acceptance. Preserve those guarantees while optimizing hashing and storage. Do not remove validation or weaken durability to improve a score.

No product optimization or published result was changed. Validation: 337 tests passed, repository and collector typechecks passed, 12 primary transfers and four diagnostic transfers verified, six hash experiments verified. Nothing was pushed.

To reproduce: run `python3 scripts/blob-pairs/prepare.py`, then `bun scripts/blob-pairs/run.ts <new-output-directory>`. Build diagnostics with `python3 scripts/blob-pairs/prepare-diagnostics.py`, then collect separately with `bun scripts/blob-pairs/run.ts <new-diagnostic-directory> --diagnostic`. Build both hash-probe variants before running `scripts/blob-pairs/hash-pairs.py`; its output path must be unused. Original generated environments are preserved in the source archive.
