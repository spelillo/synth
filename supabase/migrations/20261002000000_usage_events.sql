-- Anonymous launch analytics written by api/track.js (see analytics.js).
-- One row per visitor per event per day at most; no user ids, no data.

create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  event text not null check (event in ('visit', 'query_run', 'signup')),
  visitor_id text not null,
  ref text,
  referrer text,
  path text,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_created_at_idx on public.usage_events (created_at);
create index if not exists usage_events_visitor_idx on public.usage_events (visitor_id);

alter table public.usage_events enable row level security;
-- No client-facing policy: only the service role (api/track.js) writes,
-- and the numbers are read from the Supabase SQL editor.

-- Weekly launch scorecard: run `select * from public.launch_metrics_weekly;`
-- "returning" = visitors who ran a query on 2+ different days, counted in
-- the week of their second such day.
create or replace view public.launch_metrics_weekly
with (security_invoker = true) as
with q as (
  select visitor_id, created_at::date as day
  from public.usage_events where event = 'query_run'
  group by 1, 2
),
second_day as (
  select date_trunc('week', day)::date as week, count(*) as returning_queriers
  from (
    select day, row_number() over (partition by visitor_id order by day) as n from q
  ) t
  where n = 2
  group by 1
),
weekly as (
  select
    date_trunc('week', created_at)::date as week,
    count(distinct visitor_id) filter (where event = 'visit') as visitors,
    count(distinct visitor_id) filter (where event = 'query_run') as ran_a_query,
    count(distinct visitor_id) filter (where event = 'signup') as signups
  from public.usage_events
  group by 1
)
select w.week, w.visitors, w.ran_a_query,
       coalesce(s.returning_queriers, 0) as returning_queriers, w.signups
from weekly w
left join second_day s using (week)
order by w.week desc;

-- Which channels bring people who actually use it.
create or replace view public.launch_metrics_by_ref
with (security_invoker = true) as
select
  f.ref,
  count(distinct e.visitor_id) as visitors,
  count(distinct e.visitor_id) filter (where e.event = 'query_run') as ran_a_query
from public.usage_events e
join (
  select distinct on (visitor_id) visitor_id, coalesce(ref, '(direct)') as ref
  from public.usage_events order by visitor_id, created_at
) f using (visitor_id)
group by 1
order by ran_a_query desc, visitors desc;
