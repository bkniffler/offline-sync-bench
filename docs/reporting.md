# Running and publishing

The README is the public entry point: explain the workload, show the latest numerical comparison, put short caveats beside it, and link to complete results. Do not add attempt-count tables, audit transcripts or implementation history to that page.

## Run a case or campaign

Install Bun, start Docker and install the pinned packages:

```sh
bun install --frozen-lockfile
bun run stacks
bun run scenarios
bun run bench:run -- --stack syncular --scenario local-query
bun run bench:campaign -- --config campaigns/smoke.json --plan
bun run bench:campaign -- --config campaigns/smoke.json
```

The harness resets benchmark fixtures in the selected services. Use a smoke campaign for development. Publication needs an explicit configuration, fresh processes and independent trials; the current configurations cap each case at three attempts, including failures. A predeclared `replication: "single-run"` campaign may collect exactly one attempt, with n=1 disclosed beside the results; it cannot estimate run-to-run variability. An optional `cases` list selects exact client/case pairs instead of the stack/scenario cross product. Never append selective retries or pool samples from different campaigns.

PowerSync fixture preparation triggers a no-op organization update as a replication barrier, waits for the seeded source checkpoint, then runs the pinned service's native bucket compactor before opening measured clients. Server volumes remain in place. This prevents previous fixture resets from accumulating download history; it is not part of client latency. The first cleanup of an existing installation can take much longer than subsequent seeds. Each result records the preparation policy and checkpoint. See [PowerSync's compaction guidance](https://docs.powersync.com/maintenance-ops/compacting-buckets).

`campaigns/publication-native-files.json` collects native PowerSync/Jazz attachments once each; Syncular is included only to capture the shared MinIO backend. `campaigns/publication-coverage-fixes.json` collects the six repaired cases once each, sequentially. The full configurations are `campaigns/publication-tuned-sql.json` and `campaigns/publication-tuned-zero.json`. `campaigns/publication-powersync-maintained.json` replaces PowerSync’s results after fixing fixture-history maintenance. [Benchmark definitions](./benchmarks.md) describe their cases. [Browser setup](../src/browser/README.md) has additional runtime requirements.

For code changes, run `bun test src` and `bun run typecheck`. These verify implementation; they do not replace an actual campaign.

## Review and package

A completed manifest retains every raw result and log. Before publication, validate exact outputs, profile compatibility, failed outcomes and measured-source provenance. Investigate useful gaps and failures; distinguish confirmed causes, supported hypotheses and unexplained observations.

Annotations bind `sourceHash`, every affected `resultId` and its `resultDigest`, including failures. Each includes an observation, explanation, practical implication, evidence links and a next experiment for uncertain causes. Component reports select three to five annotation IDs in `report.findingIds`. Their table specification names a case and at most three measured metrics. See [annotation validation](../src/campaign-report.ts) and [selection rules](../src/report-editorial.ts).

Prepare a separate assets directory containing the linked methods, investigations and supporting evidence at their report-relative paths. Publish to a new directory:

```sh
bun scripts/publish-results.ts --campaign .results/<campaign-id>/CAMPAIGN.json --assets .tmp/publication-assets --output .tmp/publication-ready
```

The publisher validates source, dependency, build and configuration artifacts; copies raw trials/logs; and compresses, restores and regenerates the report. It requires byte-identical regeneration and complete local links. Missing evidence fails publication. Component packages retain their own complete tables and explanations.

Optional charts use `scripts/export-finding-chart.ts` and `scripts/render-finding-chart.py`. Keep units, workload, profiles, independent trial counts and ranges visible. Inspect the rendered figure and include its data and receipt. Detailed charts belong in the linked evidence when the README table already shows the numbers.

## Update the README

`SUMMARY.json` binds the packaged SQL, Zero, PowerSync, repaired-case and native-attachment manifests, archives and complete coverage. The coverage index selects one source per client/case; `SUMMARY.json` also declares the native-feature exclusions, which override displayed timings without rewriting archived results; the earlier PowerSync samples remain archived and are excluded from current tables. The `clientSize` binding adds the separately built browser-JavaScript size table. Its `readme-benchmarks-v1` presentation gives each of the 14 latency benchmarks a short explanation, results table, relevant caveats and links to details. It also verifies the retained September 7 archive and includes Electric, TanStack, Jazz and the other Zero cases in the comparison tables. Collection dates and provenance live in the linked details; relevant differences in guarantees stay beside the numbers. Samples stay within their source campaign. Python 3 reads the historical archive during rendering; a generated historical companion retains ranges and sample sizes.

```sh
bun scripts/render-publication-summary.ts SUMMARY.json README.md
bun scripts/audit-publication.ts
python3 scripts/audit-readme-tables.py
python3 scripts/audit-client-size.py
python3 scripts/audit-publication-links.py
```

`RESULTS.json` is the machine-readable index; its report target is `README.md`. `RESULTS.md` is only a compatibility link. The complete coverage table and raw artifacts remain generated files. Update the index's summary and renderer hashes when changing its inputs. Inspect the tables and caveats before committing.

## Reproduction and provenance

Each package includes `ARCHIVE.json`, `RESTORE.py` and `README-ARCHIVE.md`. Follow those restoration instructions to recover the original file layout and verify checksums. `SOURCE.json` stores measured file bytes, modes and dirty state. `DEPENDENCIES.json` inventories installed package/native-addon bytes; it is not a copy of those packages. Configuration records identify services, images, relevant environment and mounted inputs, with opaque values fingerprinted rather than published.

Rust publication also binds a freshly built driver, Cargo sources/configuration, selected compiler and native toolchain/SDK inventory. Restoring source and a lockfile does not recreate unarchived credentials, custom environments or an entire OS image. Use the package's recorded reporting patch when regenerating from the measured checkout.

Older implementation plans, detailed provenance notes and the RFC are retained in the [documentation archive](./history/README.md). They are historical evidence, not additional setup instructions.

The `largeFiles` binding in `SUMMARY.json` adds the separate 500 MB attachment table. Its source archive, per-process receipts and fixture hash live in `results/large-files/`; the payload stays in gitignored `.cache/attachments/`. Collect with `bun run bench:large-files`; publish the chosen output with `bun scripts/publish-large-files.ts .results/your-run-directory`. Validate it with `python3 scripts/audit-large-files.py`.
