-- Tracks premium status per user. One row per signed-in user, created on
-- first grant/check (no signup trigger — the app upserts on demand).
--
-- is_premium is written in exactly two places by design:
-- 1. The Stripe webhook (api/stripe-webhook.js), using the service-role
--    key, sets it TRUE after a real checkout.session.completed event tied
--    to this user via client_reference_id. Never set true from the client
--    — that would let anyone grant themselves premium from devtools.
-- 2. The signed-in user themselves can set it back to FALSE (self-service
--    "Cancel Premium" in the settings page) — allowed under RLS because
--    revoking your own access is safe; granting it isn't.
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

-- Owner can insert/update their own row, but never set is_premium to true
-- themselves — only false. Granting premium happens server-side only
-- (webhook, using the service role key, which bypasses RLS entirely).
create policy "profiles: owner can insert own row (not premium)"
  on public.profiles for insert
  with check (auth.uid() = id and is_premium = false);

create policy "profiles: owner can revoke their own premium"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and is_premium = false);
