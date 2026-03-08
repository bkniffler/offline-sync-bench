create table if not exists public.tasks (
  id text primary key,
  org_id text not null default '',
  project_id text not null default '',
  owner_id text not null default '',
  title text not null,
  completed boolean not null default false,
  server_version integer not null default 0,
  updated_at timestamptz not null default now()
);
