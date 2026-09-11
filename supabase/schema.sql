-- Synth Supabase schema
--
-- HOW TO RUN:
-- 1. Create a project at https://supabase.com (free tier)
-- 2. Open Project -> SQL Editor -> New query
-- 3. Paste this whole file and click "Run"
-- 4. Then follow the Storage bucket steps at the bottom (dashboard step, not SQL)
--
-- Auth is handled entirely by Supabase's built-in `auth.users` table —
-- no separate "users" table needed. Magic-link sign-in is configured
-- in the dashboard: Authentication -> Providers -> Email -> enable
-- "Magic Link" (password sign-in can stay off).

create extension if not exists "pgcrypto";

-- A workspace groups one or more datasets (tables) that were loaded
-- together in the app — see supabase/migrations/20260910180000_workspaces.sql
-- for the authoritative version (already applied via `supabase db push`),
-- including the backfill that wraps any pre-workspace datasets rows in an
-- implicit single-dataset workspace so nothing existing gets orphaned.
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per table (CSV) belonging to a workspace. The actual file bytes
-- live in Storage (bucket "csvs"); this table is just the metadata +
-- pointer to that file. table_name is the in-app SQLite table name (can
-- differ from the original filename once renamed) — distinct from
-- filename, which just records what was originally uploaded.
create table if not exists public.datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  filename text not null,
  table_name text not null,
  storage_path text not null,
  row_count integer,
  columns jsonb,
  created_at timestamptz not null default now()
);

-- Confirmed foreign-key relationships between tables in a workspace.
-- Metadata only — never enforced as a real Postgres foreign key, matching
-- the client's own decision never to enforce these as real SQLite FOREIGN
-- KEY constraints either (real CSVs have orphaned rows that would just
-- make saves start failing).
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

-- One row per saved AI chat session, tied to the workspace it was about
-- (not one arbitrary table inside it). dataset_id is kept for backward
-- compatibility with pre-workspace rows but unused by new code.
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dataset_id uuid references public.datasets(id) on delete set null,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  title text not null default 'Untitled session',
  created_at timestamptz not null default now()
);

-- Individual messages within a chat session.
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Row Level Security: every user can only ever see/touch their own rows.
alter table public.workspaces enable row level security;
alter table public.datasets enable row level security;
alter table public.workspace_relationships enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;

create policy "workspaces: owner full access"
  on public.workspaces for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

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

create policy "datasets: owner full access"
  on public.datasets for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "chat_sessions: owner full access"
  on public.chat_sessions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "chat_messages: owner full access via session"
  on public.chat_messages for all
  using (
    exists (
      select 1 from public.chat_sessions s
      where s.id = chat_messages.session_id
        and s.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.chat_sessions s
      where s.id = chat_messages.session_id
        and s.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────
-- Storage bucket setup (do this in the dashboard, not SQL Editor):
-- 1. Storage -> New bucket -> name it "csvs" -> Public: OFF
-- 2. Storage -> csvs -> Policies -> New policy, and add these 2
--    (or paste as SQL in the SQL Editor, same effect):
-- ─────────────────────────────────────────────────────────────

create policy "csvs: owner can read own files"
  on storage.objects for select
  using (bucket_id = 'csvs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "csvs: owner can write own files"
  on storage.objects for insert
  with check (bucket_id = 'csvs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "csvs: owner can delete own files"
  on storage.objects for delete
  using (bucket_id = 'csvs' and (storage.foldername(name))[1] = auth.uid()::text);

-- Files should be uploaded to path: `${user.id}/${filename}` so the
-- folder-name check above matches. The app does this automatically.

-- ─────────────────────────────────────────────────────────────
-- profiles: premium status per user. See
-- supabase/migrations/20260910153000_profiles_premium.sql for the
-- authoritative version (already applied via `supabase db push`).
-- is_premium is only ever set TRUE server-side by the Stripe webhook
-- (api/stripe-webhook.js) using the service-role key — RLS below blocks
-- a signed-in user from granting it to themselves, only revoking it.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_premium boolean not null default false,
  stripe_checkout_session_id text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: owner can read own row"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: owner can insert own row (not premium)"
  on public.profiles for insert
  with check (auth.uid() = id and is_premium = false);

create policy "profiles: owner can revoke their own premium"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and is_premium = false);

-- ─────────────────────────────────────────────────────────────
-- landing_gates: cross-device confirmation for the landing page's
-- "unlock the CSV upload once the magic link is clicked" gate.
-- See supabase/migrations/20260910023323_landing_gates.sql for the
-- authoritative version (already applied via `supabase db push`).
-- No email/PII is stored here — just a random token + a boolean — so
-- open anon read/write is intentional and safe.
-- ─────────────────────────────────────────────────────────────

create table if not exists public.landing_gates (
  id uuid primary key,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

alter table public.landing_gates enable row level security;

create policy "landing_gates: anyone can create a gate"
  on public.landing_gates for insert
  with check (true);

create policy "landing_gates: anyone can read a gate by id"
  on public.landing_gates for select
  using (true);

create policy "landing_gates: anyone can confirm a gate"
  on public.landing_gates for update
  using (true)
  with check (true);

alter publication supabase_realtime add table public.landing_gates;
