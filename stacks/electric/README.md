# Electric stack

Services:

- `postgres` on host port `55433`
- `electric` on host port `3213`
- `admin` on host port `3212`

This stack uses the current official Electric Docker image plus a local Postgres configured with `wal_level=logical`.

Current routes:

- `http://localhost:3213/v1/shape`
- `http://localhost:3212/health`
- `http://localhost:3212/admin/*`

Important benchmark note:

- `offline-replay` is currently marked unsupported for Electric in this benchmark repo until we explicitly add and label a separate client outbox layer.

