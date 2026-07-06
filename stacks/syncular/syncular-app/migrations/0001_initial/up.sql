-- Benchmark domain model (mirrors services/bench-admin's Postgres DDL, §2.4
-- shape only — the syncular server materializes its own per-app tables).
-- `updated_at_ms` replaces bench-admin's TIMESTAMPTZ (epoch ms integer);
-- `project_memberships.id` is the composite "<project_id>:<user_id>" since
-- synced tables key on a single primary column.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE app_users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE project_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  completed BOOLEAN NOT NULL,
  server_version INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- Blob-flow metadata rows: the blob ref syncs as a row column (§5.9); the
-- bytes travel through the /blobs endpoints (presigned when configured).
CREATE TABLE task_blob_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  blob BLOB_REF,
  created_at_ms INTEGER NOT NULL
);
