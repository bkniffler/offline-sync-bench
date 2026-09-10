# Client size measurement

The [README table](../../README.md#client-javascript-size) compares minified and gzipped browser JavaScript for six installed client entrypoints. The [build report](../../results/client-size/README.md) preserves exact imports, SDK versions, emitted files and checksums.

```sh
bun scripts/publish-client-size.ts
python3 scripts/audit-client-size.py
```

Each entrypoint exports selected public APIs so the bundler must retain them. Bun emits minified browser ESM with splitting and no sourcemaps. All emitted JavaScript chunks count; gzip totals sum each file compressed separately at level 9. One KiB is 1,024 bytes. This deterministic build does not require repeated sync benchmark rounds.

**These are JavaScript sizes, not complete installed or downloaded client sizes.** WASM, runtime-loaded workers, storage engines and application code can add substantial bytes. Syncular needs an application-selected storage integration; PowerSync and Jazz can load additional runtime assets. The selected imports do not implement equivalent working applications. PowerSync uses its Web SDK for this build, while the latency benchmarks use Node.

Syncular Rust and Turso use native clients in this harness. Their installed native libraries or executables would answer a different size question and are not represented by a browser-JavaScript number.

A complete application-footprint comparison would need equivalent functioning applications and an inventory of every initial and deferred asset. The current table makes the narrower measurement explicit.
