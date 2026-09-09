# Entrypoint JavaScript sizes

Browser-targeted minified JavaScript emitted for declared import entrypoints. `retained-entry` exposes the public namespace; `named-import` references selected exports. These imports do not implement equivalent working applications. Only emitted .js files are counted; storage/WASM assets and runtime downloads may be absent. Gzip totals sum each file compressed separately at level 9. Values are KiB (1,024 bytes), not a complete deployment footprint.

| Library | Import path | Profile | Version | Status | Raw KiB | Gzip KiB | Artifacts | Notes |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| Syncular Client | `@syncular/client` | retained-entry | 0.17.0 | completed | 176.96 | 51.45 | 3 |  |
| Syncular Client | `@syncular/client` | named-import | 0.17.0 | completed | 116.95 | 34.6 | 3 |  |
| Electric Client | `@electric-sql/client` | retained-entry | 1.5.27 | completed | 58.57 | 18.46 | 1 |  |
| Electric Client | `@electric-sql/client` | named-import | 1.5.27 | completed | 55.54 | 17.44 | 1 |  |
| Zero | `@rocicorp/zero` | retained-entry | 1.9.0 | completed | 312.43 | 97.88 | 3 |  |
| Zero | `@rocicorp/zero` | named-import | 1.9.0 | completed | 303.02 | 94.94 | 3 |  |
| PowerSync Web | `@powersync/web` | retained-entry | 2.3.0 | completed | 546.98 | 166.26 | 14 |  |
| PowerSync Web | `@powersync/web` | named-import | 2.3.0 | completed | 525.43 | 160.49 | 14 |  |
| Electric + TanStack DB | `@tanstack/db + @tanstack/electric-db-collection + @tanstack/offline-transactions` | named-import | 0.8.7 | completed | 240.23 | 68.42 | 1 |  |
| Jazz v2 (experimental) | `jazz-tools` | named-import | 2.0.0-alpha.53 | completed | 290.05 | 83.07 | 9 |  |

