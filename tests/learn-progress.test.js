// learn-progress.js: the local progress store, merging two copies (this
// browser and the account's cloud row), streaks, and cloud sync against a
// fake Supabase client.

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearnProgress: P, LearnCurriculum: C } = require('./helpers/learn-env');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    data,
  };
}

function clockAt(iso) {
  let t = new Date(iso).getTime();
  const now = () => new Date(t);
  now.advance = ms => { t += ms; };
  return now;
}

test('normalize repairs anything into a valid progress object', () => {
  assert.deepEqual(P.normalize(null), P.emptyProgress());
  assert.deepEqual(P.normalize('garbage'), P.emptyProgress());
  const p = P.normalize({
    lessons: { b01: { status: 'weird', attempts: '3', hintsUsed: -2, firstTry: true }, b02: null },
    activity: { '2026-10-01': 2, 'not-a-day': 5 },
    lastLessonId: 7,
  });
  assert.equal(p.lessons.b01.status, 'not_started');
  assert.equal(p.lessons.b01.attempts, 3);
  assert.equal(p.lessons.b01.hintsUsed, 0);
  assert.equal(p.lessons.b01.firstTry, false, 'firstTry only counts on a completed lesson');
  assert.ok(!('b02' in p.lessons));
  assert.deepEqual(p.activity, { '2026-10-01': 2 });
  assert.equal(p.lastLessonId, null);
});

test('store: a wrong attempt, then a right one', () => {
  const storage = memoryStorage();
  const store = P.createStore({ storage, now: clockAt('2026-10-04T10:00:00') });
  const wrong = store.recordAttempt('b01', { correct: false, sql: 'SELECT 1' });
  assert.equal(wrong.firstCompletion, false);
  assert.equal(store.lesson('b01').status, 'attempted');
  const right = store.recordAttempt('b01', { correct: true, sql: 'SELECT * FROM t' });
  assert.equal(right.firstCompletion, true);
  const rec = store.lesson('b01');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.attempts, 2);
  assert.equal(rec.firstTry, false);
  assert.equal(rec.draft, 'SELECT * FROM t');
  assert.ok(rec.completedAt);
  // Persisted.
  assert.equal(JSON.parse(storage.data[P.STORAGE_KEY]).lessons.b01.status, 'completed');
  // Solving again isn't a second completion.
  assert.equal(store.recordAttempt('b01', { correct: true }).firstCompletion, false);
});

test('store: first try only without hints or a peek at the solution', () => {
  const store = P.createStore({ storage: memoryStorage(), now: clockAt('2026-10-04T10:00:00') });
  store.recordAttempt('b01', { correct: true });
  assert.equal(store.lesson('b01').firstTry, true);
  store.recordHint('b02', 1);
  store.recordAttempt('b02', { correct: true });
  assert.equal(store.lesson('b02').firstTry, false);
  store.recordSolutionView('b03');
  store.recordAttempt('b03', { correct: true });
  assert.equal(store.lesson('b03').firstTry, false);
});

test('store: drafts and last lesson are saved but not "meaningful" for sync', () => {
  const store = P.createStore({ storage: memoryStorage() });
  const events = [];
  store.subscribe((state, info) => events.push(info.meaningful));
  store.saveDraft('b01', 'SELECT');
  store.saveDraft('b01', 'SELECT'); // unchanged: no event
  store.setLastLesson('b01');
  store.setLastLesson('b01'); // unchanged: no event
  store.recordHint('b01', 1);
  assert.deepEqual(events, [false, false, true]);
  assert.equal(store.lesson('b01').draft, 'SELECT');
  assert.equal(store.get().lastLessonId, 'b01');
});

test('store: survives broken or unavailable storage', () => {
  const broken = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
  const store = P.createStore({ storage: broken });
  assert.deepEqual(store.get(), P.emptyProgress());
  assert.doesNotThrow(() => store.recordAttempt('b01', { correct: true }));
  assert.equal(store.lesson('b01').status, 'completed');
  const none = P.createStore({});
  assert.doesNotThrow(() => none.recordAttempt('b01', { correct: false }));
});

test('store: reload restores progress, reset clears it', () => {
  const storage = memoryStorage();
  P.createStore({ storage }).recordAttempt('i03', { correct: true });
  const again = P.createStore({ storage });
  assert.equal(again.lesson('i03').status, 'completed');
  again.reset();
  assert.deepEqual(P.createStore({ storage }).get().lessons, {});
});

test('merge keeps the furthest progress from either copy', () => {
  const laptop = P.normalize({
    lessons: {
      b01: { status: 'completed', attempts: 1, firstTry: true, completedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z' },
      b02: { status: 'attempted', attempts: 2, draft: 'SELECT laptop', updatedAt: '2026-10-03T10:00:00.000Z' },
    },
    activity: { '2026-10-01': 1 },
    lastLessonId: 'b02',
    updatedAt: '2026-10-03T10:00:00.000Z',
  });
  const phone = P.normalize({
    lessons: {
      b01: { status: 'completed', attempts: 3, firstTry: false, completedAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z' },
      b02: { status: 'completed', attempts: 1, draft: 'SELECT phone', completedAt: '2026-10-02T09:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z' },
      b03: { status: 'attempted', attempts: 1, hintsUsed: 2, solutionViewed: true },
    },
    activity: { '2026-10-02': 2 },
    lastLessonId: 'b03',
    updatedAt: '2026-10-02T10:00:00.000Z',
  });
  const m = P.merge(laptop, phone);
  assert.equal(m.lessons.b01.status, 'completed');
  assert.equal(m.lessons.b01.attempts, 3);
  assert.equal(m.lessons.b01.firstTry, true, 'first try belongs to the earlier completion');
  assert.equal(m.lessons.b01.completedAt, '2026-10-01T10:00:00.000Z');
  assert.equal(m.lessons.b02.status, 'completed', 'completed beats attempted');
  assert.equal(m.lessons.b02.draft, 'SELECT laptop', 'the newer draft wins');
  assert.equal(m.lessons.b03.hintsUsed, 2);
  assert.equal(m.lessons.b03.solutionViewed, true);
  assert.deepEqual(m.activity, { '2026-10-01': 1, '2026-10-02': 2 });
  assert.equal(m.lastLessonId, 'b02', 'last lesson comes from the more recently updated copy');
  // Order doesn't matter.
  assert.deepEqual(P.merge(phone, laptop).lessons, m.lessons);
});

test('streak counts consecutive days, and today can still be pending', () => {
  const p = P.normalize({ activity: { '2026-10-01': 1, '2026-10-02': 3, '2026-10-03': 1 } });
  assert.equal(P.streak(p, new Date(2026, 9, 3, 12)), 3);
  assert.equal(P.streak(p, new Date(2026, 9, 4, 12)), 3, 'yesterday still counts before today is done');
  assert.equal(P.streak(p, new Date(2026, 9, 5, 12)), 0);
  assert.equal(P.streak(P.emptyProgress(), new Date()), 0);
});

test('levelStats and resumeLesson', () => {
  const level = C.getLevel('beginner');
  const p = P.normalize({ lessons: {
    b01: { status: 'completed', firstTry: true },
    b02: { status: 'completed' },
    b03: { status: 'attempted' },
  } });
  const s = P.levelStats(level, p);
  assert.deepEqual(s, { total: 21, completed: 2, attempted: 1, firstTry: 1, percent: 10 });
  assert.equal(P.resumeLesson(level, p).id, 'b03');
  const done = P.normalize({ lessons: Object.fromEntries(level.lessons.map(l => [l.id, { status: 'completed' }])) });
  assert.equal(P.resumeLesson(level, done).id, 'b01');
});

test('localDay uses the local calendar date', () => {
  assert.equal(P.localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

function fakeSupabase({ row = null, error = null, upsertError = null, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const q = {
        select(cols) { calls.push(['select', table, cols]); return q; },
        eq(col, val) { calls.push(['eq', col, val]); return q; },
        async maybeSingle() { if (throws) throw new Error('network'); return { data: row, error }; },
        async upsert(values, opts) { calls.push(['upsert', table, values, opts]); if (throws) throw new Error('network'); return { error: upsertError }; },
      };
      return q;
    },
  };
}

test('cloud sync pulls and pushes the user row', async () => {
  const sb = fakeSupabase({ row: { progress: { lessons: { b01: { status: 'completed' } } } } });
  const sync = P.createCloudSync({ sb });
  const pulled = await sync.pull('user-1');
  assert.equal(pulled.lessons.b01.status, 'completed');
  assert.deepEqual(sb.calls.slice(0, 2), [['select', 'learn_progress', 'progress'], ['eq', 'user_id', 'user-1']]);
  assert.equal(await sync.push('user-1', P.emptyProgress()), true);
  const upsert = sb.calls.find(c => c[0] === 'upsert');
  assert.equal(upsert[2].user_id, 'user-1');
  assert.deepEqual(upsert[3], { onConflict: 'user_id' });
  assert.equal(sync.available, true);
});

test('cloud sync with no row returns null', async () => {
  const sync = P.createCloudSync({ sb: fakeSupabase({ row: null }) });
  assert.equal(await sync.pull('user-1'), null);
});

test('cloud sync turns itself off when the table is missing', async () => {
  for (const code of ['42P01', 'PGRST205']) {
    let told = 0;
    const sb = fakeSupabase({ error: { code, message: 'relation "public.learn_progress" does not exist' } });
    const sync = P.createCloudSync({ sb, onUnavailable: () => told++ });
    assert.equal(await sync.pull('user-1'), null);
    assert.equal(sync.available, false);
    assert.equal(told, 1);
    assert.equal(await sync.push('user-1', P.emptyProgress()), false);
    assert.ok(!sb.calls.some(c => c[0] === 'upsert'), 'no writes once disabled');
  }
});

test('cloud sync shrugs off other errors and network failures', async () => {
  const flaky = P.createCloudSync({ sb: fakeSupabase({ error: { code: '500', message: 'boom' }, upsertError: { code: '500' } }) });
  assert.equal(await flaky.pull('u'), null);
  assert.equal(await flaky.push('u', P.emptyProgress()), false);
  assert.equal(flaky.available, true, 'a transient error does not disable sync');
  const offline = P.createCloudSync({ sb: fakeSupabase({ throws: true }) });
  assert.equal(await offline.pull('u'), null);
  assert.equal(await offline.push('u', P.emptyProgress()), false);
  const none = P.createCloudSync({ sb: null });
  assert.equal(none.available, false);
  assert.equal(await none.pull('u'), null);
  assert.equal(await P.createCloudSync({ sb: fakeSupabase() }).pull(null), null, 'signed out: nothing to pull');
});
