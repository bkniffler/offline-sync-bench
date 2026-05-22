create table organizations (
  id text primary key,
  name text not null,
  server_version integer not null default 0
);

create table projects (
  id text primary key,
  org_id text not null,
  name text not null,
  server_version integer not null default 0
);

create table tasks (
  id text primary key,
  org_id text not null,
  project_id text not null,
  owner_id text not null,
  title text not null,
  completed integer not null default 0,
  server_version integer not null default 0,
  updated_at text not null
);

create index if not exists idx_tasks_project_owner_completed_updated_at
  on tasks (project_id, owner_id, completed, updated_at desc);

create index if not exists idx_tasks_project_owner_completed
  on tasks (project_id, owner_id, completed);

create index if not exists idx_tasks_project_id_id
  on tasks (project_id, id);

create index if not exists idx_projects_org_id
  on projects (org_id);
