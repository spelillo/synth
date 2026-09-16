-- org_members' primary key is (org_id, user_id), which allows the same
-- user_id to appear under multiple orgs at the schema level. Nothing else
-- in the app supports that: api/enterprise/org-status.js does
-- `.eq('user_id', userId).maybeSingle()` (throws if more than one row
-- comes back), and profiles.org_id is a single nullable column, not a
-- list. api/enterprise/join.js checks for this in application code, but
-- that alone can't close a race between two simultaneous join requests —
-- this constraint is what actually guarantees it.
alter table public.org_members
  add constraint org_members_user_id_unique unique (user_id);
