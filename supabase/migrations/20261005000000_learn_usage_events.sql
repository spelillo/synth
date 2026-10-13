-- Learn page (synth-sql.com/learn) usage, for the weekly email
-- (api/cron/weekly-marketing-report.js). Adds Learn events to
-- public.usage_events and a `detail` column that holds which lesson or
-- course an event is about (a curriculum id like 'b01' or 'beginner',
-- never anything the learner typed).
--
-- Until this runs, Learn events are rejected by the old check constraint
-- (api/track.js ignores the error) and the email's Learn section says
-- tracking isn't on yet. Safe to run more than once.

alter table public.usage_events add column if not exists detail text;

alter table public.usage_events drop constraint if exists usage_events_event_check;
alter table public.usage_events add constraint usage_events_event_check check (event in (
  'visit', 'query_run', 'signup',
  'learn_open',         -- opened Learn (overview or a lesson)
  'learn_attempt',      -- pressed Check Answer
  'learn_lesson_done',  -- solved a lesson for the first time; detail = lesson id
  'learn_course_done',  -- solved the last open lesson in a course; detail = course id
  'learn_tutor'         -- got an answer from the AI tutor
));
