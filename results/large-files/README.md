# Uploading and downloading a 500 MB file

One file, 500,000,000 bytes (500 MB), linked to a task in a 50-task fixture. Each native attachment client runs once, sequentially, against local services. The download opens a new process and empty product store; it must retrieve and verify the complete file. OS and server caches are retained. This does not measure internet bandwidth or interrupted-transfer recovery; the smaller attachment benchmark covers retry behavior.

[Numbers in the main README](../../README.md#uploading-and-downloading-a-500-mb-file) · [Raw timing and byte receipts](./RESULTS.json)

Syncular JS and Rust use released **0.18.0** packages in the September 11 rerun. PowerSync and Jazz retain their September 10 results. Each displayed row is bound to its original collection and source archive in [RESULTS.json](./RESULTS.json); samples are never pooled. Other benchmark tables and the browser-size table still describe their earlier versions.

Upload sums native staging and transfer durations, excluding reading the prepared source file. Syncular stages into its native SQLite blob cache and waits for the task-linked commit to be accepted. PowerSync uses its experimental attachment queue and filesystem transport; its retained clock stops before the final metadata-acceptance wait. Jazz creates native 256 KiB parts and waits for edge durability. These endpoints differ, so the table is not a transport-only ranking.

The new Syncular JS run forwards finite upload bodies without the benchmark meter buffering them again. Rust calls the public `fetch_blob_bytes()` API and returns only a byte count and digest through the harness; no hex encoding of the payload is involved. Both clients still use their native SQLite attachment cache. Downloads use a new process and empty cache, include materializing all bytes, and receive independent full SHA-256 validation after the timer. Syncular and PowerSync use MinIO. Jazz uses 1,908 default-sized parts, which its native helper inserts sequentially. One run does not establish variability or isolate a release-only speedup from the corrected harness.

The September 11 run recorded slower uploads for both Syncular clients, concentrated in local staging. Both completed without SDK errors or hash failures. The cause of the slowdown is unconfirmed; these separate single runs do not establish a release regression. The confirmed Rust harness incompatibility was the removed `fetch_blob()` method, replaced here with `fetch_blob_bytes()` without restoring the removed private switch.

## Cached fixture

```sh
bun run bench:large-files
# Optional: download a demo file instead of generating the default fixture.
# The URL must return exactly 500,000,000 bytes.
bun run bench:large-files --url https://example.com/demo-500mb.bin --output .tmp/demo-file-results
```

`.cache/attachments/` is gitignored. The default is deterministic high-entropy data generated once, so the benchmark needs no public download host and does not benefit from compressing repeated zero bytes. A supplied URL is downloaded only when its fixture is absent. Interrupted or wrong-sized downloads are rejected. Every run verifies the cached byte count and SHA-256; cache corruption fails before measurement. File preparation and this check are never timed. The manifest records the exact source and hash.

By default, each run writes a new timestamped directory under gitignored `.results/`. Existing result directories are never overwritten. Choose a new `--output` directory for subsequent runs, or `--bytes 1048576 --output .tmp/large-file-smoke` for development. The published run uses 500 MB, one attempt per supported client, and a 600,000 ms deadline for each complete client phase (including setup and validation). Failures remain in the raw results and receive a short explanation in the table. Clients without a native attachment feature are marked **Not supported**.

The [collection manifest](./RESULTS.json) links each selected run to its captured source hashes and archive. The payload and temporary native client databases are not committed. An [excluded validation collection](./EXCLUDED-RUN.json.gz) overlapped the full test suite; none of its timings are used in the table. Each run removes its temporary client stores and declared MinIO object; Jazz retains its server-side native file history. Run `python3 scripts/audit-large-files.py` to verify the published table and receipts.

To rerun only Syncular, use `bun run bench:large-files --stack syncular,syncular-rust`. To publish a selected collection, run `bun scripts/publish-large-files.ts .results/your-run-directory`. This replaces only the selected client rows, retains other clients with their original provenance, binds the hashes into `SUMMARY.json` and rebuilds the README table.
