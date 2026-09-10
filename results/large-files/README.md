# Uploading and downloading a 500 MB file

One file, 500,000,000 bytes (500 MB), linked to a task in a 50-task fixture. Each native attachment client runs once, sequentially, against local services. The download opens a new process and empty product store; it must retrieve and verify the complete file. OS and server caches are retained. This does not measure internet bandwidth or interrupted-transfer recovery; the smaller attachment benchmark covers retry behavior.

[Numbers in the main README](../../README.md#uploading-and-downloading-a-500-mb-file) · [Raw timing and byte receipts](./RESULTS.json)

Upload sums native staging and transfer durations, excluding reading the prepared source file. Syncular stages into its native blob cache and syncs the task-linked commit; PowerSync uses its experimental attachment queue and filesystem transport; Jazz creates native 256 KiB parts and waits for edge durability. Syncular and PowerSync use MinIO. Download includes materializing the complete bytes; final SHA-256 validation follows the clock. The Rust API itself returns hex-encoded bytes internally, which is included in its timing, but those bytes do not cross the harness JSON/stdio bridge. At the default 256 KiB chunk size, Jazz creates 1,908 parts and its native helper awaits each insertion; the SDK also permits other chunk sizes, which this run does not compare. These are native file workflows with different storage and metadata boundaries, not a transport-only ranking. One run does not establish variability.

## Cached fixture

```sh
bun run bench:large-files
# Optional: download a demo file instead of generating the default fixture.
# The URL must return exactly 500,000,000 bytes.
bun run bench:large-files --url https://example.com/demo-500mb.bin --output .tmp/demo-file-results
```

`.cache/attachments/` is gitignored. The default is deterministic high-entropy data generated once, so the benchmark needs no public download host and does not benefit from compressing repeated zero bytes. A supplied URL is downloaded only when its fixture is absent. Interrupted or wrong-sized downloads are rejected. Every run verifies the cached byte count and SHA-256; cache corruption fails before measurement. File preparation and this check are never timed. The manifest records the exact source and hash.

By default, each run writes a new timestamped directory under gitignored `.results/`. Existing result directories are never overwritten. Choose a new `--output` directory for subsequent runs, or `--bytes 1048576 --output .tmp/large-file-smoke` for development. The published run uses 500 MB, one attempt per supported client, and a 600,000 ms deadline for each complete client phase (including setup and validation). Failures remain in the raw results and receive a short explanation in the table. Clients without a native attachment feature are marked **Not supported**.

[Captured source hashes](./SOURCE.json) · [Source archive](./SOURCE.tar.gz). The payload and temporary native client databases are not committed. An [excluded validation collection](./EXCLUDED-RUN.json.gz) overlapped the full test suite; none of its timings are used in the table. Each run removes its temporary client stores and declared MinIO object; Jazz retains its server-side native file history. Run `python3 scripts/audit-large-files.py` to verify the published table and receipts.

To publish a selected complete collection, run `bun scripts/publish-large-files.ts .results/your-run-directory`. This updates the result package, binds its hashes into `SUMMARY.json` and rebuilds the README table.
