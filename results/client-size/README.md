# Client JavaScript size

Build one minified browser entrypoint per client and count all emitted JavaScript chunks. Public exports stay exported so tree shaking cannot replace the entrypoint with an array length. Gzip uses level 9 on each file separately; 1 KiB is 1,024 bytes. This is a code-size measurement, not another latency round.

| Client | SDK version | Minified JS | Gzip JS |
| --- | --- | ---: | ---: |
| Syncular Client | 0.17.0 | 116.89 KiB | 34.57 KiB |
| Electric Client | 1.5.27 | 55.47 KiB | 17.42 KiB |
| Zero | 1.9.0 | 302.94 KiB | 94.90 KiB |
| PowerSync Web | 2.3.0 | 525.36 KiB | 160.46 KiB |
| Electric + TanStack DB | 0.8.7 | 240.21 KiB | 68.42 KiB |
| Jazz v2 (experimental) | 2.0.0-alpha.53 | 289.98 KiB | 83.04 KiB |

**Scope:** browser JavaScript only. SDKs can fetch additional WASM, workers or storage engines; those assets are not included. PowerSync uses its browser SDK, while its latency tests use Node. Syncular Rust and Turso use native clients in this harness and are not browser-bundle measurements. Imports do not establish equivalent application functionality.

[Exact entrypoints, dependency versions, inputs and file hashes](./RESULTS.json). The adjacent `artifacts/` directory contains the actual gzip-compressed emitted JS. `inputs/` preserves the builder, publication script, package manifest and lockfile. Build once with `bun scripts/publish-client-size.ts`; verify with `python3 scripts/audit-client-size.py`.

[How these sizes differ from a full client installation](../../docs/appendices/deployment-footprint.md) · [Benchmark overview](../../README.md#client-javascript-size)
