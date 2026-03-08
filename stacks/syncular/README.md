# Syncular stack

Services:

- `postgres` on host port `55432`
- `syncular` on host port `3210`
- `admin` on host port `3211`

The Syncular benchmark server runs directly against the local sibling checkout at `../syncular`, not from a published package.

Current routes:

- `http://localhost:3210/health`
- `http://localhost:3210/api/sync/*`
- `ws://localhost:3210/api/sync/realtime`
- `http://localhost:3210/benchmark/config`
- `http://localhost:3211/health`
- `http://localhost:3211/admin/*`
