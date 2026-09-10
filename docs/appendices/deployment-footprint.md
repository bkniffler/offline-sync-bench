# Browser client size

The [README table](../../README.md#browser-client-size) counts the assets loaded by working browser clients, including their storage engines. [Captured inputs, runtime checks and asset inventory](../../results/client-size/README.md) make each total inspectable.

Each client starts in a fresh Chromium profile. Persistent clients write or receive one task, close, reload and read it back through their native APIs. Plain Electric reads a real server shape again after reload. TanStack additionally reopens with its shape endpoint blocked, proving that its row came from the native local cache.

| Client | Tested configuration |
| --- | --- |
| Syncular JS | SQLite WASM in a worker, persisted in OPFS |
| PowerSync | Web SDK, wa-sqlite AccessHandlePoolVFS, dedicated worker, single-tab sync |
| Zero | Native IndexedDB persistence |
| Electric | Native ShapeStream/Shape, in-memory read-only cache |
| Electric + TanStack DB | Official browser SQLite/OPFS persistence plus native IndexedDB outbox |
| Jazz v2 | Persistent WASM runtime with worker and broker, backed by OPFS |

The Chromium network log includes page and worker requests and must match the server's asset inventory. Each requested JavaScript or WASM file counts once, including shared chunks and workers; unused backend variants do not count. Each cell shows `raw/gzip KiB`. Core includes SDK code and shared adapters; Storage includes separate engine loaders, workers and WASM. Integrated storage code remains in Core. Syncular’s SQLite loader gets its own chunk. Jazz’s WASM combines database and sync logic, so this is an asset split rather than a pure database-size ranking. JavaScript is minified with esbuild. Gzip level 9 compresses each complete file separately, and one KiB is 1,024 bytes. TanStack's packaged worker embeds WASM in its JavaScript; that is included once, inside the worker's size.

These are **storage-ready startup sizes**. They do not establish equivalent multitab behavior, measure an end-to-end sync session, or exercise every optional SDK feature. HTML, server data, HTTP headers and the browser installation are excluded. Electric's memory-only reader is not equivalent to a persistent offline client. Syncular Rust and Turso use native-host clients in the latency harness and therefore have no browser size here. PowerSync uses its Web SDK here and Node in the latency benchmarks.

Run `bun run bundle:size` with Docker and Chromium available; set `BENCH_CHROMIUM` to your executable when the browser-smoke configuration's path does not apply. This rebuilds and executes all six probes, seeds the local Electric fixture, and updates the result package and README. It does not repeat latency rounds. Run `python3 scripts/audit-client-size.py` to independently verify archived bytes, WASM, browser receipts and displayed totals.
