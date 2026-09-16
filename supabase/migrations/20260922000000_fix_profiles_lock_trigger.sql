-- Fix for a real bug found during an end-to-end walkthrough: the
-- profiles_lock_org_columns trigger (20260917000000_organizations.sql)
-- checked current_setting('request.jwt.claim.role', true) = 'service_role'
-- to detect a service-role write, but this GUC is null in this project's
-- PostgREST version — so the trigger's ELSE/INSERT branches fired even for
-- genuine service-role requests (api/stripe-webhook.js's org-creation
-- upsert, api/enterprise/member-actions.js's join case), silently
-- resetting org_id to null and premium_via to 'purchase' on every
-- org-granted premium row, even though is_premium correctly landed as
-- true. Confirmed live: after a real test Enterprise checkout, profiles
-- showed is_premium=true but premium_via='purchase', org_id=null instead
-- of 'org'/the new org's id.
--
-- Root cause, confirmed by direct introspection of a live service-role
-- request in this project: `current_user` correctly shows 'service_role'
-- but is unusable here since this function is SECURITY DEFINER (current_user
-- reflects the function OWNER in that context, not the caller); `session_user`
-- shows 'authenticator' (PostgREST's fixed pooled role, useless for this);
-- the flat GUC `request.jwt.claim.role` is null. The one reliable signal is
-- Supabase's own auth.role() helper, which reads the `request.jwt.claims`
-- JSON blob (confirmed populated with role=service_role) rather than the
-- unpopulated flat per-claim GUC.
create or replace function public.profiles_lock_org_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
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

-- Clean up the diagnostic function used to find the root cause above.
drop function if exists public.__debug_role_context();
