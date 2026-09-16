-- Synth Enterprise — Child 4: dataset library.
-- A "template" is 3-4 related tables bundled with pre-confirmed join
-- relationships (not a single flat CSV) — see SYNTH_ENTERPRISE_SPEC.md §7/§8.
-- v1 ships exactly one template (university vertical); this schema
-- supports more without changes.

create table public.dataset_library_templates (
  id uuid primary key default gen_random_uuid(),
  vertical text not null,              -- 'university', 'hospital', 'sports', 'bank', 'real_estate'
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

alter table public.dataset_library_templates enable row level security;
-- Every signed-in user can browse what templates exist (metadata only —
-- no data). Whether a given org can actually LOAD one is a separate check
-- in api/enterprise/load-template.js against org_enabled_templates below.
create policy "dataset_library_templates: any signed-in user can read"
  on public.dataset_library_templates for select
  using (auth.role() = 'authenticated');

create table public.dataset_library_tables (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.dataset_library_templates(id) on delete cascade,
  table_name text not null,
  storage_path text not null,          -- path in the private 'dataset-library' bucket, not user-scoped
  row_count integer,
  columns jsonb
);

alter table public.dataset_library_tables enable row level security;
-- No client-facing policy: storage_path is only ever resolved into a
-- signed URL server-side (api/enterprise/load-template.js, service role,
-- after checking org_enabled_templates) — the client never queries this
-- table directly, so it doesn't need read access.

create table public.dataset_library_relationships (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.dataset_library_templates(id) on delete cascade,
  from_table text not null,
  from_column text not null,
  to_table text not null,
  to_column text not null
);

alter table public.dataset_library_relationships enable row level security;
-- Same reasoning as dataset_library_tables — served through
-- load-template.js's response, not queried directly by the client.

create table public.org_enabled_templates (
  org_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.dataset_library_templates(id) on delete cascade,
  enabled_at timestamptz not null default now(),
  primary key (org_id, template_id)
);

alter table public.org_enabled_templates enable row level security;
-- Members can read which templates are enabled for their own org (needed
-- so the client can show what's available to load); only
-- api/enterprise/enable-template.js (admin-only, service role) writes it.
create policy "org_enabled_templates: members can read their org's enabled templates"
  on public.org_enabled_templates for select
  using (
    exists (
      select 1 from public.org_members m
      where m.org_id = org_enabled_templates.org_id
        and m.user_id = auth.uid()
    )
  );
