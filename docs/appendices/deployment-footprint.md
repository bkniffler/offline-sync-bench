# Deployment footprint appendix

The current bundle command measures JavaScript emitted for selected import entrypoints. It does not build equivalent working offline applications, so these numbers cannot establish which product has the smallest complete client deployment.

The [2026-09-09 entrypoint report](../../results/diagnostics/deployment-entrypoints-v017/BUNDLE_SIZES.md) uses the installed dependencies, including Syncular 0.17.0. All ten targets built. [Verification and archived build artifacts](../../results/diagnostics/deployment-entrypoints-v017/VERIFICATION.json) preserve exact entry sources, emitted files and gzip accounting. Two builds reproduced the same report; both ran while publication timing was paused.

```sh
bun run bundle:size
```

The command writes `.results/BUNDLE_SIZES.json` and `.results/BUNDLE_SIZES.md`. It builds minified browser-targeted ESM with splitting and no sourcemaps. The `retained-entry` profile exposes a library namespace; `named-import` references selected exports. The exact target definitions live in [the measurement source](../../src/bundle-size.ts).

Only emitted `.js` files count toward the totals. Workers, storage engines, WASM, runtime downloads and application assets can require additional files. Gzip totals add the size of each file compressed separately at level 9. The legacy `rawKb`/`gzipKb` JSON fields use a 1,024-byte divisor. Generated table headings now say KiB and state the entrypoint-only scope.

Entrypoint sizes remain separate from sync latency and correctness findings. A failed browser bundle indicates a problem with that tested entrypoint/configuration; it does not prove the product cannot run in a browser. Native Rust driver size answers a different deployment question and is not part of this browser bundle comparison.

A future complete-application footprint case should implement the same working screen, sync flow and storage guarantees, inventory every deployed or fetched asset, distinguish initial from deferred downloads, and validate the app before measuring it. That extension is separate from the RFC's current entrypoint appendix.
