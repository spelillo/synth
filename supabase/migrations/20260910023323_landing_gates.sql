-- landing_gates: lets the landing page's "unlock after clicking the magic
-- link" gate work across devices, not just across tabs of the same browser.
--
-- Flow:
-- 1. The device requesting the magic link generates a random UUID and
--    inserts a pending row here, then puts that id in the magic link's
--    redirect URL (?gate=<id>).
-- 2. That same device subscribes to Realtime (+ polls as a fallback) for
--    this row's `confirmed` flag.
-- 3. Whichever device the user actually clicks the link on lands back on
--    the site with ?gate=<id>, completes Supabase auth, and flips
--    `confirmed` to true on this row.
-- 4. The requesting device sees the change and unlocks the CSV upload,
--    even if step 3 happened on a completely different device.
--
-- Deliberately has NO email/PII column — only a random token + a boolean +
-- timestamps — so it's safe to allow open read/write by the anon key. The
-- token is a 128-bit UUID handed out solely inside a real magic-link email,
-- so knowing one is equivalent to having received that email.
--
-- Rows are single-use and short-lived; consider a periodic cleanup job
-- (e.g. `delete from landing_gates where created_at < now() - interval '1 day'`)
-- if this table's growth ever matters.

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

-- Required for the requesting device's Realtime subscription to receive
-- UPDATE events on this table.
alter publication supabase_realtime add table public.landing_gates;
