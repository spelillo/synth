create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_events_user_time_idx
  on public.ai_usage_events (user_id, created_at desc);

alter table public.ai_usage_events enable row level security;

-- No policies: this table is only ever read/written by api/chat.js using the
-- service-role key (see api/_supabaseAuth.js), the same pattern
-- api/stripe-webhook.js already uses for profiles. RLS stays enabled with
-- zero policies so the anon/authenticated roles get nothing even if a
-- future change starts querying this table from the client by mistake.
