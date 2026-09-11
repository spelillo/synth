-- Workspace persistence: replaces the "one dataset = one table = one save"
-- model with workspaces owning many datasets (tables), so multi-table
-- workspaces (2+ tables) can finally be saved/reloaded — today "Save to
-- cloud" is disabled entirely past 1 table. See the Workspace Dashboard
-- spec for full context.

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspaces enable row level security;

create policy "workspaces: owner full access"
  on public.workspaces for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Extend datasets: each dataset (one table's worth of data) now belongs to
-- a workspace, and remembers its in-app SQLite table name (which can differ
-- from the original uploaded filename once renamed — nothing captured that
-- before this migration).
alter table public.datasets add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;
alter table public.datasets add column if not exists table_name text;

-- Backfill: every dataset saved before workspaces existed gets wrapped in
-- its own implicit single-dataset workspace, named after its original
-- filename, so it still shows up on the new dashboard instead of being
-- orphaned. table_name is backfilled from a slugified filename, matching
-- the client's own slugifyTableName() so it lines up with what the app
-- would have called that table.
do $$
declare
  d record;
  new_ws_id uuid;
begin
  for d in select * from public.datasets where workspace_id is null loop
    insert into public.workspaces (user_id, name, created_at)
      values (d.user_id, d.filename, d.created_at)
      returning id into new_ws_id;

    update public.datasets
      set workspace_id = new_ws_id,
          table_name = coalesce(
            table_name,
            nullif(regexp_replace(lower(regexp_replace(d.filename, '\.[^.]*$', '')), '[^a-z0-9]+', '_', 'g'), '')
          )
      where id = d.id;
  end loop;
end $$;

-- table_name can still be null if a filename backfilled to an empty
-- string (e.g. a filename that was all punctuation) — fall back to a
-- generic name rather than leaving it null before the NOT NULL below.
update public.datasets set table_name = 'table' where table_name is null or table_name = '';

alter table public.datasets alter column workspace_id set not null;
alter table public.datasets alter column table_name set not null;

-- chat_sessions moves from pointing at a single dataset to pointing at a
-- whole workspace (a saved chat is about the workspace, not one arbitrary
-- table inside it). dataset_id is left in place, unused by new code, since
-- dropping it isn't necessary and keeps this migration additive/reversible.
alter table public.chat_sessions add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;

update public.chat_sessions cs
set workspace_id = d.workspace_id
from public.datasets d
where cs.dataset_id = d.id and cs.workspace_id is null;

-- Confirmed foreign-key relationships between tables in a workspace.
-- Metadata only, by design — never enforced as real Postgres foreign keys,
-- matching the client's own decision never to enforce these as real SQLite
-- FOREIGN KEY constraints either (real CSVs have orphaned rows that would
-- just make saves start failing).
create table if not exists public.workspace_relationships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  from_table text not null,
  from_column text not null,
  to_table text not null,
  to_column text not null,
  confirmed boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, from_table, from_column, to_table, to_column)
);

alter table public.workspace_relationships enable row level security;

create policy "workspace_relationships: owner full access via workspace"
  on public.workspace_relationships for all
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_relationships.workspace_id
        and w.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_relationships.workspace_id
        and w.user_id = auth.uid()
    )
  );
