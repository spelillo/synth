// The Learn section of the weekly email (api/_learnReport.js and
// api/cron/weekly-marketing-report.js): the numbers, and that the email
// still sends when the Learn events or learn_progress migrations haven't run.

const test = require('node:test');
const assert = require('node:assert/strict');

const now = new Date('2026-10-11T13:47:00Z');
const weekStart = new Date('2026-10-04T13:47:00Z');
const prevStart = new Date('2026-09-27T13:47:00Z');

const ev = (event, visitor_id, day, extra = {}) => ({ event, visitor_id, created_at: `2026-10-${day}T15:00:00Z`, path: '/learn', ...extra });

const events = [
  // last week: v1 started learning
  { ...ev('learn_open', 'v1', '01'), created_at: '2026-10-01T15:00:00Z' },
  { ...ev('learn_lesson_done', 'v1', '01', { detail: 'b01' }) },
  // this week
  ev('learn_open', 'v1', '05'),
  ev('learn_attempt', 'v1', '05'),
  ev('learn_lesson_done', 'v1', '05', { detail: 'b02' }),
  ev('learn_lesson_done', 'v1', '05', { detail: 'b03' }),
  ev('learn_open', 'v2', '06'),
  ev('learn_attempt', 'v2', '06'),
  ev('learn_lesson_done', 'v2', '06', { detail: 'b01' }),
  ev('learn_lesson_done', 'v2', '07', { detail: 'i01' }),
  ev('learn_course_done', 'v2', '07', { detail: 'intermediate' }),
  ev('learn_tutor', 'v2', '07'),
  ev('signup', 'v2', '07'),
  ev('signup', 'v3', '07', { path: '/' }),
  ev('learn_open', 'v3', '08'),
];

test('summarizeLearnEvents counts this week against the one before', async () => {
  const { summarizeLearnEvents } = await import('../api/_learnReport.js');
  const s = summarizeLearnEvents(events, { now, weekStart, prevStart });
  assert.equal(s.openers, 3);
  assert.equal(s.prevOpeners, 1);
  assert.equal(s.attempters, 2);
  assert.equal(s.lessonsCompleted, 4);
  assert.equal(s.prevLessonsCompleted, 1);
  assert.equal(s.completers, 2);
  assert.equal(s.tutorUsers, 1);
  assert.equal(s.returning, 1);
  assert.equal(s.signupsFromLearn, 1);
  assert.deepEqual(s.byCourse, [
    { label: 'Beginner', lessons: 3, people: 2, finished: 0 },
    { label: 'Intermediate', lessons: 1, people: 1, finished: 1 },
    { label: 'Advanced', lessons: 0, people: 0, finished: 0 },
  ]);
});

test('summarizeLearnProgress counts signed-in learners from saved progress', async () => {
  const { summarizeLearnProgress } = await import('../api/_learnReport.js');
  const rows = [
    { progress: { lessons: { b01: { status: 'completed', completedAt: '2026-10-05T10:00:00Z' }, b02: { status: 'completed', completedAt: '2026-09-01T10:00:00Z' } } } },
    { progress: { lessons: { b01: { status: 'completed', completedAt: '2026-09-02T10:00:00Z' } } } },
    { progress: { lessons: { b01: { status: 'attempted' } } } },
    { progress: {} },
  ];
  assert.deepEqual(summarizeLearnProgress(rows, { weekStart }), { accounts: 2, activeThisWeek: 1, lessonsThisWeek: 1, lessonsTotal: 3 });
});

function baseReport(extra) {
  return {
    weekLabel: 'Oct 4', trackingMissing: false, visitors: 10, prevVisitors: 5, queriers: 4, prevQueriers: 2,
    returning: 1, newAccounts: 2, prevNewAccounts: 1, totalAccounts: 9, referrers: [], refs: [], pages: [],
    learn: null, learnProgress: null, ...extra,
  };
}

test('the email shows a Learn section with per-course numbers', async () => {
  const { summarizeLearnEvents } = await import('../api/_learnReport.js');
  const { buildEmail } = await import('../api/cron/weekly-marketing-report.js');
  const learn = summarizeLearnEvents(events, { now, weekStart, prevStart });
  const email = buildEmail(baseReport({ learn, learnProgress: { accounts: 2, activeThisWeek: 1, lessonsThisWeek: 1, lessonsTotal: 3 } }));
  assert.match(email.subject, /4 Learn lessons$/);
  assert.match(email.text, /Opened Learn: 3 \(\+200% vs last week\)/);
  assert.match(email.text, /Lessons completed: 4 \(\+300% vs last week\), by 2 people/);
  assert.match(email.text, /Intermediate: 1 lesson by 1, 1 finished the course/);
  assert.doesNotMatch(email.text, /Advanced:/);
  assert.match(email.text, /Signed-in learners with progress: 2 \(1 completed a lesson this week\)/);
  assert.doesNotMatch(email.text, /isn't on yet|isn't available/);
  assert.match(email.html, /<h3[^>]*>Learn<\/h3>/);
});

test('the email explains which Learn migration is missing instead of failing', async () => {
  const { buildEmail } = await import('../api/cron/weekly-marketing-report.js');
  const email = buildEmail(baseReport({}));
  assert.doesNotMatch(email.subject, /Learn/);
  assert.match(email.text, /20261005000000_learn_usage_events\.sql/);
  assert.match(email.text, /20261004000000_learn_progress\.sql/);
  assert.match(email.text, /Signed-in learners with progress: unavailable/);
  assert.doesNotMatch(email.text, /Opened Learn/);
});

test('the email leaves Learn out when usage tracking is missing altogether', async () => {
  const { buildEmail } = await import('../api/cron/weekly-marketing-report.js');
  const email = buildEmail(baseReport({ trackingMissing: true }));
  assert.doesNotMatch(email.text, /Learn/);
  assert.doesNotMatch(email.html, /Learn/);
});
