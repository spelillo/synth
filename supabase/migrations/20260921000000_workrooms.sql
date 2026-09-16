-- Synth Enterprise — Child 5: workrooms (classes/teams with a manager role).
-- See SYNTH_ENTERPRISE_SPEC.md §5/§8. A workroom's manager is just a
-- regular org_members row (role='member') that happens to be referenced by
-- a workroom's manager_id — there is no 'manager' value in org_members.role,
-- so an admin-only route (toggle-ai.js, toggle-auto-renew.js, etc.) already
-- rejects a manager with no extra check needed.
--
-- Once this migration lands, api/stripe-webhook.js's customer.subscription.deleted
-- handler automatically cascades org deletion to these two tables too — see
-- the comment already in that file. No webhook code change needed.

create table public.workrooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  manager_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.workrooms enable row level security;
-- No client-facing policies: written only by api/enterprise/create-workroom.js
-- (admin-only) via the service role. Read access is served through
-- api/enterprise/workrooms-list.js, which applies its own
-- admin-sees-all/manager-sees-own scoping in code — simpler to reason about
-- than replicating that same role logic as an RLS policy.

create table public.workroom_members (
  workroom_id uuid not null references public.workrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (workroom_id, user_id)
);

alter table public.workroom_members enable row level security;
-- Same reasoning as workrooms: written only by
-- api/enterprise/workroom-roster.js (manager-of-that-workroom-only, checked
-- in code), read through workrooms-list.js.
