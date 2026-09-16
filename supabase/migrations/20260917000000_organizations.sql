-- Synth Enterprise — Child 1: org foundation.
-- See SYNTH_ENTERPRISE_SPEC.md for the full epic. This migration adds only
-- what Child 1 needs (org core + checkout fulfillment); workrooms and the
-- dataset library get their own migrations in later children.

-- One row per Enterprise checkout in flight. Created before the Stripe
-- Checkout Session so the webhook has something to fulfill against —
-- `client_reference_id` on the session is this row's id, not a user id
-- (that's how the webhook tells an Enterprise checkout apart from a
-- personal Premium checkout, alongside session.metadata.type).
create table public.pending_organizations (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  stripe_checkout_session_id text,
  status text not null default 'pending' check (status in ('pending', 'fulfilled')),
  created_at timestamptz not null default now()
);

alter table public.pending_organizations enable row level security;
-- No client-facing policies: written only by api/enterprise/create-checkout-session.js
-- and api/stripe-webhook.js, both using the service-role key. Same pattern
-- as ai_usage_events.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null unique, -- normalized lowercase, e.g. 'cornell.edu'
  ai_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;

-- Members can read their own org's row (needed so the client can show org
-- name / ai_enabled state) but never write it directly — writes go through
-- api/enterprise/toggle-ai.js using the service role, which also checks the
-- caller is that org's admin.
create policy "organizations: members can read their own org"
  on public.organizations for select
  using (
    exists (
      select 1 from public.org_members m
      where m.org_id = organizations.id
        and m.user_id = auth.uid()
    )
  );

create table public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

alter table public.org_members enable row level security;

-- A member can see the roster of their own org (needed for the admin
-- console and workroom roster pickers later). No client-facing write
-- policy — membership rows are only ever inserted by
-- api/enterprise/join.js and api/stripe-webhook.js via the service role.
create policy "org_members: members can read their org's roster"
  on public.org_members for select
  using (
    exists (
      select 1 from public.org_members self
      where self.org_id = org_members.org_id
        and self.user_id = auth.uid()
    )
  );

create table public.org_join_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  token text not null unique,
  created_by uuid not null references auth.users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.org_join_links enable row level security;
-- No client-facing policies: created by api/enterprise/create-join-link.js
-- (admin-only, checked in the route) and read by api/enterprise/join.js —
-- both via the service role. A join link's token must never be discoverable
-- by listing the table from the client; the app always accesses a specific
-- link via its token in the URL, resolved server-side.

-- Extend the existing premium flag so a profile can record *why* it's
-- premium, not just that it is. premium_via defaults to 'purchase' so every
-- existing row is unaffected. org_id is nullable — most users have none.
alter table public.profiles
  add column premium_via text not null default 'purchase' check (premium_via in ('purchase', 'org')),
  add column org_id uuid references public.organizations(id) on delete set null;

-- Guard: the existing profiles RLS policies (see
-- 20260910153000_profiles_premium.sql) only constrain is_premium in their
-- WITH CHECK clauses, so without this trigger a signed-in user could set
-- their own org_id/premium_via from the client. That alone can't grant real
-- premium (only the service role can flip is_premium true), but it could
-- point their own AI-usage gate at an org they don't belong to. Force both
-- columns back to their prior value (or their default, on insert) for any
-- write that isn't made by the service role.
create or replace function public.profiles_lock_org_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.org_id := null;
    new.premium_via := 'purchase';
  else
    new.org_id := old.org_id;
    new.premium_via := old.premium_via;
  end if;

  return new;
end;
$$;

create trigger profiles_lock_org_columns
  before insert or update on public.profiles
  for each row execute function public.profiles_lock_org_columns();
