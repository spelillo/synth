-- Enforce one saved dataset ("project") per (user, filename) pair.
--
-- The app previously always INSERTed a new row on "Save to cloud", so
-- re-saving a CSV with the same name created a fresh duplicate row every
-- time instead of updating the existing one. This migration:
--   1. Collapses any existing duplicates down to the most recent row per
--      (user_id, filename), so users with duplicates from before this fix
--      see just one entry.
--   2. Adds a unique constraint so it can't happen again at the DB level,
--      matching the app's move to `upsert` (see synth.html saveCurrentCSV).
--
-- Storage objects belonging to the deleted duplicate rows are intentionally
-- left in place rather than deleted here (safer than best-effort deleting
-- files from a migration); they're small, orphaned, and harmless.

delete from public.datasets d
using (
  select id,
         row_number() over (
           partition by user_id, filename
           order by created_at desc, id desc
         ) as rn
  from public.datasets
) ranked
where d.id = ranked.id
  and ranked.rn > 1;

alter table public.datasets
  add constraint datasets_user_filename_unique unique (user_id, filename);
