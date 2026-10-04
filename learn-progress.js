// learn-progress.js — lesson progress for the Learn courses.
//
// Progress always lives in localStorage, so the courses work signed out
// and offline. When someone is signed in, it's also synced to one row of
// public.learn_progress in Supabase (see the 20261004000000_learn_progress
// migration), so it follows them across devices. If that table doesn't
// exist yet, sync quietly turns itself off and nothing else changes.
//
// Local and cloud copies are merged per lesson, never overwritten
// wholesale, so finishing a lesson on a phone and another on a laptop
// keeps both.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LearnProgress = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'synth_learn_progress_v1';
  const CLOUD_TABLE = 'learn_progress';
  const STATUS_RANK = { not_started: 0, attempted: 1, completed: 2 };
  const MAX_DRAFT_LENGTH = 4000;

  function emptyProgress() {
    return { version: 1, lessons: {}, lastLessonId: null, activity: {}, updatedAt: null };
  }

  function emptyLesson() {
    return { status: 'not_started', attempts: 0, hintsUsed: 0, solutionViewed: false, firstTry: false, completedAt: null, draft: null, updatedAt: null };
  }

  function localDay(date) {
    const d = date instanceof Date ? date : new Date(date);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Accepts anything (corrupt storage, an older shape, a cloud row from a
  // future version) and returns a well-formed progress object.
  function normalize(raw) {
    const out = emptyProgress();
    if (!raw || typeof raw !== 'object') return out;
    if (raw.lessons && typeof raw.lessons === 'object') {
      for (const [id, rec] of Object.entries(raw.lessons)) {
        if (!rec || typeof rec !== 'object') continue;
        const l = emptyLesson();
        l.status = STATUS_RANK[rec.status] !== undefined ? rec.status : 'not_started';
        l.attempts = Math.max(0, parseInt(rec.attempts, 10) || 0);
        l.hintsUsed = Math.max(0, parseInt(rec.hintsUsed, 10) || 0);
        l.solutionViewed = !!rec.solutionViewed;
        l.firstTry = !!rec.firstTry && l.status === 'completed';
        l.completedAt = typeof rec.completedAt === 'string' ? rec.completedAt : null;
        l.draft = typeof rec.draft === 'string' ? rec.draft.slice(0, MAX_DRAFT_LENGTH) : null;
        l.updatedAt = typeof rec.updatedAt === 'string' ? rec.updatedAt : null;
        out.lessons[id] = l;
      }
    }
    if (typeof raw.lastLessonId === 'string') out.lastLessonId = raw.lastLessonId;
    if (raw.activity && typeof raw.activity === 'object') {
      for (const [day, n] of Object.entries(raw.activity)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day)) out.activity[day] = Math.max(0, parseInt(n, 10) || 0);
      }
    }
    if (typeof raw.updatedAt === 'string') out.updatedAt = raw.updatedAt;
    return out;
  }

  function later(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a >= b ? a : b;
  }

  function earlier(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a <= b ? a : b;
  }

  function mergeLesson(a, b) {
    a = a || emptyLesson();
    b = b || emptyLesson();
    const out = emptyLesson();
    out.status = STATUS_RANK[a.status] >= STATUS_RANK[b.status] ? a.status : b.status;
    out.attempts = Math.max(a.attempts, b.attempts);
    out.hintsUsed = Math.max(a.hintsUsed, b.hintsUsed);
    out.solutionViewed = a.solutionViewed || b.solutionViewed;
    out.completedAt = earlier(a.completedAt, b.completedAt);
    // "First try" belongs to whichever copy completed first.
    if (a.status === 'completed' && b.status === 'completed') {
      out.firstTry = out.completedAt === a.completedAt ? a.firstTry : b.firstTry;
    } else {
      out.firstTry = a.status === 'completed' ? a.firstTry : b.status === 'completed' ? b.firstTry : false;
    }
    const newer = (a.updatedAt || '') >= (b.updatedAt || '') ? a : b;
    out.draft = newer.draft !== null ? newer.draft : (a.draft !== null ? a.draft : b.draft);
    out.updatedAt = later(a.updatedAt, b.updatedAt);
    return out;
  }

  function merge(a, b) {
    a = normalize(a);
    b = normalize(b);
    const out = emptyProgress();
    const ids = new Set([...Object.keys(a.lessons), ...Object.keys(b.lessons)]);
    ids.forEach(id => { out.lessons[id] = mergeLesson(a.lessons[id], b.lessons[id]); });
    const days = new Set([...Object.keys(a.activity), ...Object.keys(b.activity)]);
    days.forEach(d => { out.activity[d] = Math.max(a.activity[d] || 0, b.activity[d] || 0); });
    out.lastLessonId = (a.updatedAt || '') >= (b.updatedAt || '') ? (a.lastLessonId || b.lastLessonId) : (b.lastLessonId || a.lastLessonId);
    out.updatedAt = later(a.updatedAt, b.updatedAt);
    return out;
  }

  // Consecutive days with at least one solved lesson, ending today (or
  // yesterday, so a streak isn't shown as broken before today's lesson).
  function streak(progress, now) {
    const today = now ? new Date(now) : new Date();
    const has = d => (progress.activity[localDay(d)] || 0) > 0;
    const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (!has(cursor)) cursor.setDate(cursor.getDate() - 1);
    let n = 0;
    while (has(cursor)) { n++; cursor.setDate(cursor.getDate() - 1); }
    return n;
  }

  function levelStats(level, progress) {
    const total = level.lessons.length;
    let completed = 0;
    let attempted = 0;
    let firstTry = 0;
    level.lessons.forEach(l => {
      const rec = progress.lessons[l.id];
      if (!rec) return;
      if (rec.status === 'completed') { completed++; if (rec.firstTry) firstTry++; }
      else if (rec.status === 'attempted') attempted++;
    });
    return { total, completed, attempted, firstTry, percent: total ? Math.round((completed / total) * 100) : 0 };
  }

  // First lesson in the level that isn't completed, else the first lesson.
  function resumeLesson(level, progress) {
    const next = level.lessons.find(l => (progress.lessons[l.id] || {}).status !== 'completed');
    return next || level.lessons[0];
  }

  function createStore({ storage, now } = {}) {
    const clock = now || (() => new Date());
    const listeners = new Set();
    let state = load();

    function load() {
      if (!storage) return emptyProgress();
      try {
        return normalize(JSON.parse(storage.getItem(STORAGE_KEY) || 'null'));
      } catch (err) {
        return emptyProgress();
      }
    }

    function persist() {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (err) {
        // Private mode or a full quota: progress still works for this visit.
      }
    }

    function touch(id, meaningful = true) {
      const stamp = clock().toISOString();
      if (id) state.lessons[id].updatedAt = stamp;
      state.updatedAt = stamp;
      persist();
      listeners.forEach(fn => fn(state, { meaningful }));
    }

    function ensure(id) {
      if (!state.lessons[id]) state.lessons[id] = emptyLesson();
      return state.lessons[id];
    }

    return {
      get: () => state,
      lesson: id => state.lessons[id] || emptyLesson(),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

      recordAttempt(id, { correct, sql }) {
        const rec = ensure(id);
        rec.attempts++;
        if (typeof sql === 'string') rec.draft = sql.slice(0, MAX_DRAFT_LENGTH);
        let firstCompletion = false;
        if (correct && rec.status !== 'completed') {
          firstCompletion = true;
          rec.status = 'completed';
          rec.completedAt = clock().toISOString();
          rec.firstTry = rec.attempts === 1 && !rec.solutionViewed && rec.hintsUsed === 0;
          const day = localDay(clock());
          state.activity[day] = (state.activity[day] || 0) + 1;
        } else if (!correct && rec.status === 'not_started') {
          rec.status = 'attempted';
        }
        touch(id);
        return { firstCompletion, record: rec };
      },

      recordHint(id, shownCount) {
        const rec = ensure(id);
        rec.hintsUsed = Math.max(rec.hintsUsed, shownCount);
        touch(id);
      },

      recordSolutionView(id) {
        const rec = ensure(id);
        rec.solutionViewed = true;
        touch(id);
      },

      // Drafts save often (every pause in typing); listeners are told the
      // change isn't "meaningful" so cloud sync can wait for a real event.
      saveDraft(id, sql) {
        const rec = ensure(id);
        const next = String(sql || '').slice(0, MAX_DRAFT_LENGTH);
        if (rec.draft === next) return;
        rec.draft = next;
        touch(id, false);
      },

      setLastLesson(id) {
        if (state.lastLessonId === id) return;
        state.lastLessonId = id;
        touch(null, false);
      },

      replace(progress) {
        state = normalize(progress);
        persist();
        listeners.forEach(fn => fn(state, { meaningful: false, replaced: true }));
      },

      reset() {
        state = emptyProgress();
        touch(null);
      },
    };
  }

  // Cloud sync against public.learn_progress (one row per user, RLS:
  // owner only). `sb` is a supabase-js client. Every failure is swallowed
  // and reported through `onUnavailable`, so a missing table or a network
  // blip never breaks a lesson.
  function createCloudSync({ sb, onUnavailable } = {}) {
    let disabled = !sb;

    function missingTable(error) {
      if (!error) return false;
      const code = String(error.code || '');
      return code === '42P01' || code === 'PGRST205' || code === 'PGRST202' || /does not exist|could not find the table/i.test(error.message || '');
    }

    function giveUp(error) {
      disabled = true;
      if (onUnavailable) onUnavailable(error);
    }

    return {
      get available() { return !disabled; },

      async pull(userId) {
        if (disabled || !userId) return null;
        try {
          const { data, error } = await sb.from(CLOUD_TABLE).select('progress').eq('user_id', userId).maybeSingle();
          if (error) { if (missingTable(error)) giveUp(error); return null; }
          return data ? normalize(data.progress) : null;
        } catch (err) {
          return null;
        }
      },

      async push(userId, progress) {
        if (disabled || !userId) return false;
        try {
          const { error } = await sb.from(CLOUD_TABLE).upsert({ user_id: userId, progress, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
          if (error) { if (missingTable(error)) giveUp(error); return false; }
          return true;
        } catch (err) {
          return false;
        }
      },
    };
  }

  return { STORAGE_KEY, emptyProgress, normalize, merge, mergeLesson, streak, levelStats, resumeLesson, createStore, createCloudSync, localDay };
});
