-- Learn page (synth-sql.com/learn): lesson progress for signed-in users,
-- so it follows them across devices. One row per user holding the same
-- JSON the browser keeps in localStorage (see learn-progress.js).
--
-- Optional: until this runs, Learn keeps progress in the browser only and
-- quietly skips cloud sync (learn-progress.js treats a missing table as
-- "sync unavailable"). Safe to run more than once.

create table if not exists public.learn_progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  progress jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.learn_progress enable row level security;

drop policy if exists "learn_progress: owner full access" on public.learn_progress;
create policy "learn_progress: owner full access"
  on public.learn_progress
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
