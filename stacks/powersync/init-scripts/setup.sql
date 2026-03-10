create table if not exists public.organizations (
  id text primary key,
  name text not null
);

create table if not exists public.projects (
  id text primary key,
  org_id text not null default '',
  name text not null
);

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

do $$
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'powersync'
  ) then
    create publication powersync for table public.organizations, public.projects, public.tasks;
  else
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'powersync'
        and schemaname = 'public'
        and tablename = 'organizations'
    ) then
      alter publication powersync add table public.organizations;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'powersync'
        and schemaname = 'public'
        and tablename = 'projects'
    ) then
      alter publication powersync add table public.projects;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'powersync'
        and schemaname = 'public'
        and tablename = 'tasks'
    ) then
      alter publication powersync add table public.tasks;
    end if;
  end if;
end
$$;
