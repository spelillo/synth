// Learn numbers for the weekly email (api/cron/weekly-marketing-report.js).
//
// Two sources, either of which may not exist yet:
//  - usage_events rows with learn_* events (analytics.js, learn.js), which
//    need the 20261005000000_learn_usage_events migration. Anonymous: they
//    cover everyone, signed in or not.
//  - public.learn_progress (20261004000000_learn_progress migration): the
//    saved progress of signed-in learners.

const COURSES = [
  { id: 'beginner', prefix: 'b', label: 'Beginner' },
  { id: 'intermediate', prefix: 'i', label: 'Intermediate' },
  { id: 'advanced', prefix: 'a', label: 'Advanced' },
];

const LEARN_EVENTS = new Set(['learn_open', 'learn_attempt', 'learn_lesson_done', 'learn_course_done', 'learn_tutor']);

function courseOfLesson(lessonId) {
  return COURSES.find(c => typeof lessonId === 'string' && lessonId.startsWith(c.prefix)) || null;
}

function inRange(e, start, end) {
  const t = new Date(e.created_at);
  return t >= start && t < end;
}

function visitorsWith(rows, event) {
  return new Set(rows.filter(e => e.event === event).map(e => e.visitor_id));
}

// `events` is every usage_events row the report read (90 days, with the
// detail column); the week is [weekStart, now), the one before it
// [prevStart, weekStart).
export function summarizeLearnEvents(events, { now, weekStart, prevStart }) {
  const week = events.filter(e => inRange(e, weekStart, now));
  const prev = events.filter(e => inRange(e, prevStart, weekStart));
  const done = week.filter(e => e.event === 'learn_lesson_done');

  const learnersThisWeek = new Set(week.filter(e => LEARN_EVENTS.has(e.event)).map(e => e.visitor_id));
  const earlierLearners = new Set(events
    .filter(e => LEARN_EVENTS.has(e.event) && new Date(e.created_at) < weekStart)
    .map(e => e.visitor_id));
  let returning = 0;
  for (const v of learnersThisWeek) if (earlierLearners.has(v)) returning++;

  const byCourse = COURSES.map(course => {
    const rows = done.filter(e => courseOfLesson(e.detail) === course);
    const finished = new Set(week
      .filter(e => e.event === 'learn_course_done' && e.detail === course.id)
      .map(e => e.visitor_id));
    return {
      label: course.label,
      lessons: rows.length,
      people: new Set(rows.map(e => e.visitor_id)).size,
      finished: finished.size,
    };
  });

  return {
    openers: visitorsWith(week, 'learn_open').size,
    prevOpeners: visitorsWith(prev, 'learn_open').size,
    attempters: visitorsWith(week, 'learn_attempt').size,
    lessonsCompleted: done.length,
    prevLessonsCompleted: prev.filter(e => e.event === 'learn_lesson_done').length,
    completers: new Set(done.map(e => e.visitor_id)).size,
    tutorUsers: visitorsWith(week, 'learn_tutor').size,
    returning,
    signupsFromLearn: week.filter(e => e.event === 'signup' && /^\/learn\b/.test(e.path || '')).length,
    byCourse,
  };
}

// `rows` are learn_progress rows ({ progress, updated_at }).
export function summarizeLearnProgress(rows, { weekStart }) {
  let accounts = 0;
  let activeThisWeek = 0;
  let lessonsThisWeek = 0;
  let lessonsTotal = 0;
  for (const row of rows) {
    const lessons = Object.values((row.progress && row.progress.lessons) || {});
    const completed = lessons.filter(l => l && l.status === 'completed');
    if (!completed.length) continue;
    accounts++;
    lessonsTotal += completed.length;
    const thisWeek = completed.filter(l => l.completedAt && new Date(l.completedAt) >= weekStart).length;
    lessonsThisWeek += thisWeek;
    if (thisWeek > 0) activeThisWeek++;
  }
  return { accounts, activeThisWeek, lessonsThisWeek, lessonsTotal };
}

// True when usage_events has the detail column, i.e. the Learn events
// migration has run.
export async function learnTrackingEnabled(supabase) {
  const { error } = await supabase.from('usage_events').select('detail').limit(1);
  return !error;
}

// null when the learn_progress table doesn't exist (or can't be read).
export async function fetchLearnProgress(supabase) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('learn_progress')
      .select('progress, updated_at')
      .order('user_id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return null;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}
