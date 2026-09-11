# Uploading and downloading a 500 MB file

Transfer one 500,000,000-byte file linked to a task in a 50-task fixture. Download it in a new process with an empty client cache and verify the complete SHA-256 hash. All services are local; OS and server caches are retained. This measures neither internet bandwidth nor interrupted-transfer recovery, which the smaller attachment benchmark covers.

[Numbers in the main README](../../README.md#uploading-and-downloading-a-500-mb-file) · [Publication manifest](RESULTS.json) · [Controlled comparison and raw samples](../investigations/syncular-018-019-blobs/README.md)

**Syncular JS and Rust 0.19.0 report medians of all three runs per client (n=3)** from the September 11 controlled alternating comparison against released 0.18.0, with the same 0.19.0 server. Each pair uses fresh writer/reader processes and stores, a reset task fixture and a removed remote object. All 12 attempts, including the baseline, passed byte/hash and metadata checks. Upload is the median of the three complete staging-plus-transfer durations, not a sum of separate phase medians. Download is independently the median of the three fresh-download durations. No favorable n=1 run was selected; no samples from the separate 0.17 comparison are pooled into these rows.

**PowerSync and Jazz retain their September 10 single runs (n=1).** They were not rerun or included in the controlled pairs. Their run-to-run variability is unknown. Other benchmark tables and browser-size measurements retain their earlier versions.

Upload includes native staging but excludes reading the prepared source file. Syncular uses its native SQLite attachment cache and waits for the linked metadata commit to be accepted. **PowerSync's retained upload ends before the final metadata-acceptance wait**, so its endpoint differs from Syncular's. It uses its experimental attachment queue and filesystem transport. Jazz creates 1,908 native 256 KiB parts and waits for edge durability. This is not a transport-only ranking.

JS metering forwards the original finite upload body. Rust calls the public `fetch_blob_bytes()` API and sends only a byte count and digest through the harness. Both use the released SQLite blob implementation; no SDK patch, custom filesystem layer or accelerated-hash flag was introduced. Fresh download includes materializing complete bytes and native cache writes; independent final hash verification is outside the timer. Syncular and PowerSync use MinIO.

## Fixture and reproduction

`.cache/attachments/` is gitignored. The default file is deterministic high-entropy data generated once; every run verifies its length and SHA-256 before timing. An optional `--url` downloads a demo file only if it is absent, rejects interrupted or wrong-sized downloads, and records the source and hash. File preparation is outside the clock.

```sh
# Ordinary collection: one attempt per selected client, preserved in a new output directory.
bun run bench:large-files --stack syncular,syncular-rust

# Reproduce the published three-pair design using this revision's exact pins.
BLOB_PAIR_BASELINE=0.18.0 python3 scripts/blob-pairs/prepare.py
BLOB_PAIR_BASELINE=0.18.0 bun scripts/blob-pairs/run.ts .results/new-018-019-pairs

# Publish the already archived controlled collection; recompute both medians from all samples.
bun scripts/publish-large-files.ts --controlled results/investigations/syncular-018-019-blobs/PAIRS.json
python3 scripts/audit-large-files.py
```

Every complete client phase has a 600,000 ms deadline including setup and validation. Failed attempts remain in raw collections; the median publisher rejects incomplete or failed paired collections. Libraries without a native attachment feature are marked **Not supported**. Temporary client stores and the declared MinIO object are removed after each attempt; the payload and client databases are not committed.

The publication manifest records the sampling design per client, binds original collection/source hashes and the aggregation code, and retains PowerSync/Jazz's original receipts unchanged. The TypeScript validator and independent Python audit recompute the medians and verify all paired receipts. The earlier [excluded validation collection](EXCLUDED-RUN.json.gz), which overlapped tests, remains excluded. Publication was authorized after the controlled collection completed and uses every candidate sample; the raw pre-collection plan is unchanged.
