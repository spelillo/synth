    // learn.js — the Learn page (/learn): course overview, lesson player,
    // answer checking, progress, and the gated AI tutor.
    //
    // Lives inside synth.html as a third view next to #home-view and
    // #app-view (see setActiveView in app.js), so it shares the header,
    // account modal, styles, and AI plumbing with the rest of the app.
    // It never touches the workspace's own `db`: each lesson gets a fresh
    // in-memory sql.js database with just that lesson's tables, built by
    // learn-datasets.js and graded by learn-grader.js.
    //
    // Routes: /learn (overview) and /learn?lesson=<id>. Served by a
    // vercel.json rewrite to synth.html. On a plain static server, where
    // that rewrite doesn't exist, synth.html?view=learn works the same.

    const LEARN_TUTOR_HISTORY_LIMIT = 10;
    const LEARN_SOLUTION_AFTER_ATTEMPTS = 2;

    const learn = {
      store: null,
      cloud: null,
      cloudPushTimer: null,
      cloudUserId: null,
      initialized: false,
      lesson: null,          // current lesson object
      db: null,              // sql.js Database for the current lesson
      expected: null,        // { columns, rows } from the reference solution
      ctx: null,             // { tables: [{ name, columns }] } for error messages
      lastGrade: null,
      lastSql: '',
      loadToken: 0,          // guards against a slow lesson load finishing after the user moved on
      hintsShown: 0,
      solutionShown: false,
      pane: 'lesson',        // 'lesson' | 'tutor'
      tutor: new Map(),      // lessonId -> [{ role, content }]
      tutorSending: false,
      draftTimer: null,
      activeTableTab: null,
    };

    // ---- Routing ----

    function learnPrettyRoutes() {
      // Production and `vercel dev` serve synth.html at "/" and "/learn";
      // a plain static server serves it as /synth.html.
      return !/\.html$/i.test(window.location.pathname);
    }

    window.isLearnRoute = function() {
      const path = window.location.pathname.replace(/\/+$/, '');
      if (path === '/learn') return true;
      return new URLSearchParams(window.location.search).get('view') === 'learn';
    };

    function learnUrl(lessonId) {
      if (learnPrettyRoutes()) return '/learn' + (lessonId ? `?lesson=${encodeURIComponent(lessonId)}` : '');
      const params = new URLSearchParams();
      params.set('view', 'learn');
      if (lessonId) params.set('lesson', lessonId);
      return `${window.location.pathname}?${params.toString()}`;
    }

    function learnSetUrl(lessonId, push) {
      const url = learnUrl(lessonId);
      if (window.location.pathname + window.location.search === url) return;
      window.history[push ? 'pushState' : 'replaceState']({ learn: true, lesson: lessonId || null }, '', url);
    }

    // synth.html's own <title>; on /learn the head script has already
    // replaced document.title, so it can't be read back from there.
    const LEARN_DEFAULT_TITLE = 'Synth: Instantly query any CSV file with SQL';

    function learnSetTitle(text) {
      document.title = text ? `${text} · Learn SQL · Synth` : 'Learn SQL: free interactive SQL courses · Synth';
    }

    // Called by setActiveView (app.js) whenever another view takes over.
    window.onLeaveLearnView = function() {
      document.title = LEARN_DEFAULT_TITLE;
      const canonical = document.querySelector('link[rel="canonical"]');
      if (canonical) canonical.href = 'https://synth-sql.com/';
      if (window.isLearnRoute()) {
        const home = learnPrettyRoutes() ? '/' : window.location.pathname;
        window.history.pushState({}, '', home);
      }
      document.getElementById('learn-nav-btn')?.classList.remove('is-active');
    };

    // Header "Learn" link and the home page promo: a normal link (so
    // middle-click / open-in-new-tab work), handled in-page otherwise.
    window.openLearnFromNav = function(event) {
      if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1)) return true;
      if (event) event.preventDefault();
      openLearn({ push: true });
      return false;
    };

    function openLearn({ lessonId = null, push = false } = {}) {
      learnInit();
      setActiveView('learn');
      document.getElementById('learn-nav-btn')?.classList.add('is-active');
      if (lessonId && LearnCurriculum.getLesson(lessonId)) learnOpenLesson(lessonId, { push });
      else showLearnOverview({ push });
    }

    window.addEventListener('popstate', () => {
      if (window.isLearnRoute()) {
        const id = new URLSearchParams(window.location.search).get('lesson');
        learnInit();
        setActiveView('learn');
        if (id && LearnCurriculum.getLesson(id)) learnOpenLesson(id, { push: false, fromHistory: true });
        else showLearnOverview({ push: false, fromHistory: true });
      } else if (!document.getElementById('learn-view').hidden) {
        setActiveView(hasLoadedWorkspace() ? 'app' : 'home');
      }
    });

    // Runs before sql.js has loaded: the overview needs no database, so a
    // visitor landing on /learn sees it immediately.
    window.addEventListener('DOMContentLoaded', () => {
      wireLearnDom();
      if (window.isLearnRoute()) {
        const id = new URLSearchParams(window.location.search).get('lesson');
        openLearn({ lessonId: id, push: false });
      }
    });

    function learnSqlReady() {
      if (SQL) return Promise.resolve(SQL);
      return new Promise(resolve => document.addEventListener('synth:sql-ready', () => resolve(SQL), { once: true }));
    }

    // ---- Init, progress, and cloud sync ----

    function learnInit() {
      if (learn.initialized) return;
      learn.initialized = true;
      let storage = null;
      try { storage = window.localStorage; } catch (err) { storage = null; }
      learn.store = LearnProgress.createStore({ storage });
      learn.cloud = LearnProgress.createCloudSync({
        sb: typeof sb !== 'undefined' ? sb : null,
        onUnavailable: () => renderLearnSyncNote(),
      });
      learn.store.subscribe((state, info) => {
        if (info && info.meaningful) scheduleLearnCloudPush();
      });
      if (currentUser) window.onLearnAuthChange(currentUser);
    }

    function scheduleLearnCloudPush() {
      if (!learn.cloudUserId || !learn.cloud.available) return;
      clearTimeout(learn.cloudPushTimer);
      learn.cloudPushTimer = setTimeout(() => {
        learn.cloud.push(learn.cloudUserId, learn.store.get());
      }, 1500);
    }

    // Called from handleAuthChange (auth.js) on every sign-in/out.
    window.onLearnAuthChange = async function(user) {
      if (!learn.initialized) return;
      const userId = user ? user.id : null;
      const changed = userId !== learn.cloudUserId;
      learn.cloudUserId = userId;
      if (userId && changed) {
        const remote = await learn.cloud.pull(userId);
        if (learn.cloudUserId !== userId) return; // signed out meanwhile
        const local = learn.store.get();
        const merged = remote ? LearnProgress.merge(local, remote) : local;
        if (remote) learn.store.replace(merged);
        if (!remote || JSON.stringify(merged) !== JSON.stringify(remote)) learn.cloud.push(userId, merged);
        if (!document.getElementById('learn-overview').hidden) renderLearnOverview();
        else if (learn.lesson) { renderLearnChrome(); renderLearnGuideStatus(); }
      }
      renderLearnSyncNote();
      renderLearnTutor();
    };

    function renderLearnSyncNote() {
      const el = document.getElementById('learn-sync-note');
      if (!el) return;
      if (currentUser && learn.cloud && learn.cloud.available) {
        el.innerHTML = '<i class="ph ph-cloud-check" aria-hidden="true"></i> Progress is saved to your account.';
      } else if (currentUser) {
        el.innerHTML = '<i class="ph ph-hard-drives" aria-hidden="true"></i> Progress is saved in this browser.';
      } else {
        el.innerHTML = '<i class="ph ph-hard-drives" aria-hidden="true"></i> Progress is saved in this browser. <a href="#" onclick="openAccountModal(\'signin\'); return false;">Sign in</a> to keep it across devices and use the AI tutor.';
      }
    }

    // ---- Small helpers ----

    // Plain text with `backticks` → escaped HTML with <code>. Used for
    // hints, takeaways, and grader feedback (all authored by us, but
    // escaped anyway since grader messages quote learner identifiers).
    function learnFmt(text) {
      return escapeHtml(String(text || '')).replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    function learnPlainText(html) {
      const div = document.createElement('div');
      div.innerHTML = html;
      return (div.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function learnLevelOf(lesson) {
      return LearnCurriculum.getLevel(lesson.levelId);
    }

    function learnTotalLessons() {
      return LearnCurriculum.LESSONS.length;
    }

    function learnStatusIcon(status) {
      if (status === 'completed') return '<i class="ph ph-check-circle learn-status-icon is-done" aria-label="Completed"></i>';
      if (status === 'attempted') return '<i class="ph ph-circle-half learn-status-icon is-started" aria-label="In progress"></i>';
      return '<i class="ph ph-circle learn-status-icon" aria-label="Not started"></i>';
    }

    function learnRenderTable(result, { limit = 200, emptyText = 'No rows' } = {}) {
      if (!result || !result.columns.length) return `<div class="empty">${emptyText}</div>`;
      const head = result.columns.map(c => `<th>${escapeHtml(String(c))}</th>`).join('');
      const rows = result.rows.slice(0, limit).map(r => '<tr>' + r.map(v =>
        `<td>${v === null || v === undefined ? '<span class="null">NULL</span>' : escapeHtml(String(v))}</td>`).join('') + '</tr>').join('');
      const more = result.rows.length > limit ? `<div class="learn-table-more">Showing the first ${limit} of ${result.rows.length.toLocaleString()} rows.</div>` : '';
      const none = result.rows.length === 0 ? `<tr><td colspan="${result.columns.length}" class="learn-table-empty">${emptyText}</td></tr>` : '';
      return `<table class="learn-table"><thead><tr>${head}</tr></thead><tbody>${rows}${none}</tbody></table>${more}`;
    }

    // ---- Overview ----

    function showLearnOverview({ push = false } = {}) {
      learnInit();
      document.getElementById('learn-overview').hidden = false;
      document.getElementById('learn-lesson').hidden = true;
      learnSetUrl(null, push);
      learnSetTitle(null);
      renderLearnOverview();
      document.getElementById('learn-view').scrollTop = 0;
      document.getElementById('learn-overview').scrollTop = 0;
    }
    window.learnShowOverview = () => showLearnOverview({ push: true });

    function learnContinueTarget() {
      const p = learn.store.get();
      if (p.lastLessonId && LearnCurriculum.getLesson(p.lastLessonId)) {
        const last = LearnCurriculum.getLesson(p.lastLessonId);
        if ((p.lessons[last.id] || {}).status !== 'completed') return last;
        const { next } = LearnCurriculum.neighbors(last.id);
        if (next) return next;
      }
      for (const level of LearnCurriculum.LEVELS) {
        const stats = LearnProgress.levelStats(level, p);
        if (stats.completed < stats.total) return LearnProgress.resumeLesson(level, p);
      }
      return LearnCurriculum.LESSONS[0];
    }

    function renderLearnOverview() {
      const p = learn.store.get();
      const total = learnTotalLessons();
      const completed = LearnCurriculum.LESSONS.filter(l => (p.lessons[l.id] || {}).status === 'completed').length;
      const firstTry = LearnCurriculum.LESSONS.filter(l => (p.lessons[l.id] || {}).firstTry).length;
      const streak = LearnProgress.streak(p);
      const pct = total ? Math.round((completed / total) * 100) : 0;
      const started = completed > 0 || Object.keys(p.lessons).length > 0;
      const target = learnContinueTarget();
      const circumference = 2 * Math.PI * 52;

      const levelCards = LearnCurriculum.LEVELS.map((level, i) => {
        const s = LearnProgress.levelStats(level, p);
        const minutes = level.lessons.reduce((n, l) => n + (l.minutes || 5), 0);
        const cta = s.completed === s.total ? 'Review' : s.completed || s.attempted ? 'Continue' : 'Start';
        return `
          <article class="learn-level-card" data-level="${level.id}">
            <div class="learn-level-card-head">
              <div class="learn-level-icon"><i class="ph ${level.icon}" aria-hidden="true"></i></div>
              <div>
                <div class="learn-level-kicker">Level ${i + 1} · ${escapeHtml(level.level)}</div>
                <h2 class="learn-level-title">${escapeHtml(level.title)}</h2>
              </div>
            </div>
            <p class="learn-level-tagline">${escapeHtml(level.tagline)}</p>
            <ul class="learn-topic-list">${level.topics.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
            <div class="learn-level-meta"><span><i class="ph ph-book-open" aria-hidden="true"></i> ${s.total} lessons</span><span><i class="ph ph-clock" aria-hidden="true"></i> ~${Math.round(minutes / 5) * 5} min</span></div>
            <div class="learn-level-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${s.total}" aria-valuenow="${s.completed}" aria-label="${escapeHtml(level.level)} progress">
              <div class="learn-progress-track"><div class="learn-progress-fill" style="width:${s.percent}%"></div></div>
              <span>${s.completed}/${s.total}</span>
            </div>
            <button type="button" class="run-btn learn-level-cta" onclick="learnStartLevel('${level.id}')">${cta} <span aria-hidden="true">▶</span></button>
          </article>`;
      }).join('');

      const syllabus = LearnCurriculum.LEVELS.map((level, i) => {
        const s = LearnProgress.levelStats(level, p);
        const modules = LearnCurriculum.modulesOf(level).map(mod => `
          <div class="learn-syllabus-module">
            <div class="learn-syllabus-module-title">${escapeHtml(mod.title)}</div>
            <ol class="learn-syllabus-lessons">
              ${mod.lessons.map(l => `
                <li><button type="button" class="learn-syllabus-lesson" onclick="learnGoToLesson('${l.id}')">
                  ${learnStatusIcon((p.lessons[l.id] || {}).status)}
                  <span class="learn-syllabus-num">${l.number}</span>
                  <span class="learn-syllabus-name">${escapeHtml(l.title)}</span>
                  <span class="learn-syllabus-min">${l.minutes} min</span>
                </button></li>`).join('')}
            </ol>
          </div>`).join('');
        return `
          <details class="learn-syllabus-level"${i === 0 && !started ? ' open' : ''}>
            <summary><span class="learn-syllabus-level-name">Level ${i + 1}: ${escapeHtml(level.title)}</span><span class="learn-syllabus-level-count">${s.completed}/${s.total} complete</span></summary>
            <div class="learn-syllabus-body">${modules}</div>
          </details>`;
      }).join('');

      const datasets = LearnDatasets.DATASET_GROUPS.map(g => `
        <div class="learn-data-group">
          <div class="learn-data-group-title">${escapeHtml(g.title)}</div>
          <ul>${g.tables.map(t => {
            const ds = LearnDatasets.DATASETS[t];
            return `<li><code>${t}</code><span>${escapeHtml(ds.description)}</span></li>`;
          }).join('')}</ul>
        </div>`).join('');

      document.getElementById('learn-overview').innerHTML = `
        <section class="learn-hero">
          <div class="learn-hero-text">
            <p class="learn-eyebrow"><i class="ph ph-graduation-cap" aria-hidden="true"></i> Synth Learn</p>
            <h1 class="learn-hero-title">Learn SQL by writing it.</h1>
            <p class="learn-hero-sub">Three hands-on courses, ${total} short lessons, from your first <code>SELECT</code> to window functions. Read a concept, write a real query against real tables, and get instant, specific feedback. When you're stuck, an AI tutor helps, once you've given it a try yourself.</p>
            <div class="learn-hero-actions">
              <button type="button" class="run-btn" onclick="learnGoToLesson('${target.id}')">
                <span>${started ? `Continue: ${escapeHtml(target.title)}` : 'Start the first lesson'}</span><span aria-hidden="true">▶</span>
              </button>
              <a class="load-query-btn learn-hero-secondary" href="#learn-syllabus" onclick="document.getElementById('learn-syllabus').scrollIntoView({ behavior: 'smooth' }); return false;">See all ${total} lessons</a>
            </div>
            <p class="learn-sync-note" id="learn-sync-note"></p>
          </div>
          <div class="learn-hero-stats" aria-label="Your progress">
            <svg class="learn-ring" viewBox="0 0 120 120" role="img" aria-label="${pct}% of all lessons complete">
              <circle class="learn-ring-track" cx="60" cy="60" r="52"/>
              <circle class="learn-ring-fill" cx="60" cy="60" r="52" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - pct / 100)}"/>
              <text class="learn-ring-pct" x="60" y="60" text-anchor="middle" dominant-baseline="central">${pct}%</text>
            </svg>
            <dl class="learn-stat-list">
              <div><dt>Lessons done</dt><dd>${completed}<span>/${total}</span></dd></div>
              <div><dt>Solved first try</dt><dd>${firstTry}</dd></div>
              <div><dt>Day streak</dt><dd>${streak}${streak ? ' <i class="ph ph-fire" aria-hidden="true"></i>' : ''}</dd></div>
            </dl>
          </div>
        </section>

        <section class="learn-levels" aria-label="Courses">${levelCards}</section>

        <section class="learn-how" aria-labelledby="learn-how-title">
          <h2 id="learn-how-title" class="home-section-title">How each lesson works</h2>
          <ol class="learn-how-steps">
            <li><span class="home-flow-num">1</span><i class="ph ph-book-open-text" aria-hidden="true"></i><strong>Read the concept</strong><span>A short explanation and an example you can run.</span></li>
            <li><span class="home-flow-num">2</span><i class="ph ph-code" aria-hidden="true"></i><strong>Write your query</strong><span>In the same editor as the main app, against real tables.</span></li>
            <li><span class="home-flow-num">3</span><i class="ph ph-check-square-offset" aria-hidden="true"></i><strong>Check your answer</strong><span>Your result is compared to the right one, with feedback on exactly what's off.</span></li>
            <li><span class="home-flow-num">4</span><i class="ph ph-sparkle" aria-hidden="true"></i><strong>Unlock the tutor</strong><span>After your first attempt, ask the AI tutor for a nudge. It won't just hand you the answer.</span></li>
          </ol>
        </section>

        <section id="learn-syllabus" class="learn-syllabus" aria-labelledby="learn-syllabus-title">
          <h2 id="learn-syllabus-title" class="home-section-title">Syllabus</h2>
          ${syllabus}
        </section>

        <section class="learn-data" aria-labelledby="learn-data-title">
          <h2 id="learn-data-title" class="home-section-title">Practice data</h2>
          <p class="help-text">Every lesson runs on small, realistic tables, loaded into a SQLite database in this tab. Nothing you type leaves your browser unless you ask the AI tutor a question.</p>
          <div class="learn-data-groups">${datasets}</div>
        </section>

        <div class="learn-overview-footer">
          <button type="button" class="learn-link-btn" onclick="learnOpenResetModal()">Reset my progress</button>
        </div>`;
      renderLearnSyncNote();
    }

    window.learnStartLevel = function(levelId) {
      const level = LearnCurriculum.getLevel(levelId);
      if (!level) return;
      learnGoToLesson(LearnProgress.resumeLesson(level, learn.store.get()).id);
    };

    window.learnGoToLesson = function(id) {
      closeLearnOutline();
      closeLearnLevelModal();
      learnOpenLesson(id, { push: true });
    };

    // ---- Lesson player ----

    async function learnOpenLesson(id, { push = false } = {}) {
      learnInit();
      const lesson = LearnCurriculum.getLesson(id);
      if (!lesson) { showLearnOverview({ push }); return; }

      saveLearnDraftNow();
      const token = ++learn.loadToken;
      learn.lesson = lesson;
      learn.lastGrade = null;
      learn.expected = null;
      learn.hintsShown = learn.store.lesson(id).hintsUsed;
      learn.solutionShown = learn.store.lesson(id).solutionViewed;
      learn.activeTableTab = lesson.tables[0];

      document.getElementById('learn-overview').hidden = true;
      document.getElementById('learn-lesson').hidden = false;
      learnSetUrl(id, push);
      learnSetTitle(lesson.title);
      learn.store.setLastLesson(id);
      learnSelectTab('lesson');
      learnSelectPane('lesson');

      renderLearnChrome();
      renderLearnGuide();
      renderLearnTutor();
      learnSetFeedback(null);
      document.getElementById('learn-expected-btn').hidden = true;
      document.getElementById('learn-results').innerHTML = '<div class="empty">Run your query to see its results here.</div>';
      document.getElementById('learn-results-label').textContent = 'Query Results';
      document.getElementById('learn-results-count').textContent = '';

      const draft = learn.store.lesson(id).draft;
      learnSetEditor(draft !== null && draft !== undefined && draft.trim() !== '' ? draft : lesson.starter);
      document.getElementById('learn-guide').scrollTop = 0;

      learnSetBusy(true);
      try {
        await learnSqlReady();
        const db = new SQL.Database();
        await LearnDatasets.loadInto(db, lesson.tables, { fetchText: learnFetchText });
        if (token !== learn.loadToken) { db.close(); return; }
        if (learn.db) learn.db.close();
        learn.db = db;
        learn.ctx = { tables: lesson.tables.map(t => ({ name: t, columns: LearnDatasets.DATASETS[t].columns.map(c => c.name) })) };
        learn.expected = LearnGrader.runQuery(db, lesson.solution);
        renderLearnSchema();
        renderLearnTablesTab();
        renderLearnExpectedShape();
      } catch (err) {
        if (token !== learn.loadToken) return;
        console.error('Lesson load failed:', err);
        learnSetFeedback({ kind: 'error', title: 'This lesson\'s data didn\'t load', message: `${learnFmt(err.message)}. Check your connection, then <a href="#" onclick="learnGoToLesson('${id}'); return false;">try again</a>.`, html: true });
      } finally {
        if (token === learn.loadToken) learnSetBusy(false);
      }
    }

    async function learnFetchText(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status})`);
      return res.text();
    }

    function learnSetBusy(busy) {
      ['learn-run-btn', 'learn-check-btn'].forEach(idName => {
        const el = document.getElementById(idName);
        if (el) el.disabled = busy;
      });
      document.getElementById('learn-lesson').classList.toggle('is-loading', busy);
    }

    function renderLearnChrome() {
      const lesson = learn.lesson;
      if (!lesson) return;
      const level = learnLevelOf(lesson);
      const p = learn.store.get();
      const stats = LearnProgress.levelStats(level, p);
      const { prev, next } = LearnCurriculum.neighbors(lesson.id);

      document.getElementById('learn-level-pill').textContent = level.level;
      document.getElementById('learn-lesson-heading').textContent = `${lesson.number}. ${lesson.title}`;
      document.getElementById('learn-progress-fill').style.width = `${stats.percent}%`;
      document.getElementById('learn-progress-text').textContent = `${stats.completed} of ${stats.total} complete`;
      const bar = document.getElementById('learn-progress');
      bar.setAttribute('aria-valuenow', stats.completed);
      bar.setAttribute('aria-valuemax', stats.total);

      const prevBtn = document.getElementById('learn-prev-btn');
      const nextBtn = document.getElementById('learn-next-btn');
      prevBtn.disabled = !prev;
      nextBtn.disabled = !next;
      prevBtn.title = prev ? `Previous: ${prev.title}` : 'This is the first lesson';
      nextBtn.title = next ? `Next: ${next.title}` : 'This is the last lesson in this level';

      document.getElementById('learn-stepper').innerHTML = level.lessons.map(l => {
        const st = (p.lessons[l.id] || {}).status || 'not_started';
        const current = l.id === lesson.id;
        return `<button type="button" class="learn-step is-${st}${current ? ' is-current' : ''}" onclick="learnGoToLesson('${l.id}')" title="${l.number}. ${escapeHtml(l.title)}" aria-label="Lesson ${l.number}: ${escapeHtml(l.title)}${st === 'completed' ? ' (completed)' : ''}"${current ? ' aria-current="step"' : ''}>${st === 'completed' ? '<i class="ph ph-check" aria-hidden="true"></i>' : l.number}</button>`;
      }).join('');
      const currentStep = document.querySelector('#learn-stepper .is-current');
      if (currentStep && currentStep.scrollIntoView) currentStep.scrollIntoView({ block: 'nearest', inline: 'center' });
    }

    function renderLearnGuide() {
      const lesson = learn.lesson;
      const level = learnLevelOf(lesson);
      document.getElementById('learn-lesson-meta').textContent = `~${lesson.minutes} min`;
      document.getElementById('learn-guide').innerHTML = `
        <div class="learn-guide-kicker">${escapeHtml(level.level)} · ${escapeHtml(lesson.module)} · Lesson ${lesson.number} of ${level.lessons.length}</div>
        <h2 class="learn-guide-title">${escapeHtml(lesson.title)}</h2>
        <div class="learn-concept">${lesson.concept}</div>

        <div class="learn-example">
          <div class="learn-example-head">
            <span class="learn-card-label"><i class="ph ph-play-circle" aria-hidden="true"></i> Example</span>
            <div class="learn-example-actions">
              <button type="button" class="save-btn" onclick="learnRunExample()">Run example</button>
            </div>
          </div>
          <pre class="learn-code"><code>${highlightSQL(lesson.example.sql)}</code></pre>
          ${lesson.example.caption ? `<p class="learn-example-caption">${escapeHtml(lesson.example.caption)}</p>` : ''}
        </div>

        <div class="learn-task" id="learn-task">
          <div class="learn-task-head">
            <span class="learn-card-label"><i class="ph ph-target" aria-hidden="true"></i> Your task</span>
            <span class="learn-task-status" id="learn-task-status"></span>
          </div>
          <div class="learn-task-body">${lesson.task}</div>
          <div class="learn-expected-shape" id="learn-expected-shape"></div>
        </div>

        <div class="learn-help">
          <div class="learn-hints" id="learn-hints"></div>
          <div class="learn-help-actions">
            <button type="button" class="save-btn" id="learn-hint-btn" onclick="learnShowHint()"></button>
            <button type="button" class="save-btn" id="learn-solution-btn" onclick="learnShowSolution()"></button>
          </div>
          <div id="learn-solution" class="learn-solution" hidden></div>
        </div>

        <div class="learn-takeaway" id="learn-takeaway" hidden>
          <span class="learn-card-label"><i class="ph ph-lightbulb" aria-hidden="true"></i> Key takeaway</span>
          <p>${learnFmt(lesson.takeaway)}</p>
        </div>`;
      renderLearnGuideStatus();
    }

    function renderLearnExpectedShape() {
      const el = document.getElementById('learn-expected-shape');
      if (!el || !learn.expected) return;
      const cols = learn.expected.columns;
      const rows = learn.expected.rows.length;
      el.innerHTML = `<span class="learn-shape-chip"><i class="ph ph-columns" aria-hidden="true"></i> ${cols.length} column${cols.length === 1 ? '' : 's'}</span><span class="learn-shape-chip"><i class="ph ph-rows" aria-hidden="true"></i> ${rows} row${rows === 1 ? '' : 's'}</span>`;
    }

    // Hint/solution buttons, takeaway visibility, and the task badge, all
    // derived from stored progress so they're right after a reload too.
    function renderLearnGuideStatus() {
      const lesson = learn.lesson;
      if (!lesson || !document.getElementById('learn-hints')) return;
      const rec = learn.store.lesson(lesson.id);
      const total = lesson.hints.length;
      const shown = Math.min(learn.hintsShown, total);

      document.getElementById('learn-hints').innerHTML = lesson.hints.slice(0, shown).map((h, i) => `
        <div class="learn-hint"><span class="learn-hint-num">Hint ${i + 1}</span><p>${learnFmt(h)}</p></div>`).join('');

      const hintBtn = document.getElementById('learn-hint-btn');
      hintBtn.hidden = shown >= total;
      hintBtn.innerHTML = `<i class="ph ph-lightbulb" aria-hidden="true"></i> ${shown === 0 ? 'Get a hint' : 'Another hint'} <span class="learn-count">${shown}/${total}</span>`;

      const solBtn = document.getElementById('learn-solution-btn');
      const unlocked = learnSolutionUnlocked(lesson, rec);
      solBtn.hidden = learn.solutionShown;
      solBtn.disabled = !unlocked;
      solBtn.innerHTML = unlocked
        ? '<i class="ph ph-eye" aria-hidden="true"></i> Show solution'
        : `<i class="ph ph-lock-simple" aria-hidden="true"></i> Solution unlocks after ${LEARN_SOLUTION_AFTER_ATTEMPTS} attempts`;

      const sol = document.getElementById('learn-solution');
      sol.hidden = !learn.solutionShown;
      if (learn.solutionShown) {
        sol.innerHTML = `
          <div class="learn-example-head">
            <span class="learn-card-label"><i class="ph ph-key" aria-hidden="true"></i> Solution</span>
            <button type="button" class="save-btn" onclick="learnUseSolution()">Copy to editor</button>
          </div>
          <pre class="learn-code"><code>${highlightSQL(lesson.solution)}</code></pre>
          <p class="learn-example-caption">Any query that returns the same result counts as correct. This is just one way to write it.</p>`;
      }

      document.getElementById('learn-takeaway').hidden = rec.status !== 'completed';
      const badge = document.getElementById('learn-task-status');
      badge.className = 'learn-task-status';
      if (rec.status === 'completed') {
        badge.classList.add('is-done');
        badge.innerHTML = `<i class="ph ph-check-circle" aria-hidden="true"></i> ${rec.firstTry ? 'Solved first try' : 'Solved'}`;
      } else if (rec.attempts) {
        badge.innerHTML = `${rec.attempts} attempt${rec.attempts === 1 ? '' : 's'}`;
      } else {
        badge.textContent = '';
      }
      document.getElementById('learn-task').classList.toggle('is-done', rec.status === 'completed');
    }

    window.learnShowHint = function() {
      const lesson = learn.lesson;
      if (!lesson) return;
      learn.hintsShown = Math.min(learn.hintsShown + 1, lesson.hints.length);
      learn.store.recordHint(lesson.id, learn.hintsShown);
      renderLearnGuideStatus();
      const hints = document.querySelectorAll('#learn-hints .learn-hint');
      const last = hints[hints.length - 1];
      if (last) { last.classList.add('is-new'); last.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    };

    // The solution opens after 2 attempts or every hint, like DataCamp's
    // "show answer", so a learner always tries before they peek.
    function learnSolutionUnlocked(lesson, rec) {
      return rec.attempts >= LEARN_SOLUTION_AFTER_ATTEMPTS || learn.hintsShown >= lesson.hints.length
        || rec.status === 'completed' || rec.solutionViewed;
    }

    window.learnShowSolution = function() {
      const lesson = learn.lesson;
      if (!lesson || !learnSolutionUnlocked(lesson, learn.store.lesson(lesson.id))) return;
      learn.solutionShown = true;
      learn.store.recordSolutionView(lesson.id);
      renderLearnGuideStatus();
      document.getElementById('learn-solution').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    window.learnUseSolution = function() {
      if (!learn.lesson) return;
      learnSetEditor(learn.lesson.solution);
      document.getElementById('learn-query-input').focus();
    };

    // ---- Editor ----

    function learnSetEditor(value) {
      const ta = document.getElementById('learn-query-input');
      ta.value = value;
      learnRefreshEditor(true);
    }

    function learnRefreshEditor(resetScroll) {
      const ta = document.getElementById('learn-query-input');
      const lines = ta.value.split('\n').length;
      document.getElementById('learn-line-numbers').innerHTML = Array.from({ length: lines }, (_, i) => i + 1).join('<br>');
      let html = highlightSQL(ta.value);
      if (ta.value.endsWith('\n')) html += '\n';
      document.getElementById('learn-query-highlight-code').innerHTML = html;
      ta.style.height = 'auto';
      ta.style.height = Math.min(Math.max(ta.scrollHeight, 120), 400) + 'px';
      if (resetScroll) {
        ta.scrollTop = 0;
        document.getElementById('learn-line-numbers').scrollTop = 0;
        document.getElementById('learn-query-highlight').scrollTop = 0;
      }
    }

    function saveLearnDraftNow() {
      clearTimeout(learn.draftTimer);
      if (!learn.lesson || !learn.store) return;
      const ta = document.getElementById('learn-query-input');
      if (ta) learn.store.saveDraft(learn.lesson.id, ta.value);
    }

    window.learnResetEditor = function() {
      if (!learn.lesson) return;
      const ta = document.getElementById('learn-query-input');
      if (ta.value.trim() && ta.value !== learn.lesson.starter && !confirm('Reset the editor to the starter code? Your current query will be cleared.')) return;
      learnSetEditor(learn.lesson.starter);
      saveLearnDraftNow();
      ta.focus();
    };

    function renderLearnSchema() {
      const lesson = learn.lesson;
      const summary = document.getElementById('learn-schema-summary');
      const body = document.getElementById('learn-schema-body');
      summary.textContent = `Tables (${lesson.tables.length}): ${lesson.tables.join(', ')}`;
      body.innerHTML = lesson.tables.map(t => {
        const ds = LearnDatasets.DATASETS[t];
        return `<div class="query-schema-table-name">${t}</div>
          <div class="query-schema-columns">${ds.columns.map(c => `<span class="query-schema-col" title="${escapeHtml(c.desc)}">${escapeHtml(c.name)} <span class="learn-col-type">${c.type.toLowerCase()}</span></span>`).join('')}</div>`;
      }).join('');
    }

    window.toggleLearnSchemaPanel = function() {
      const btn = document.getElementById('learn-schema-toggle');
      const body = document.getElementById('learn-schema-body');
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open);
      body.hidden = !open;
    };

    // ---- Running and checking ----

    function learnCurrentSql() {
      return document.getElementById('learn-query-input').value;
    }

    function learnShowResult(result, label) {
      document.getElementById('learn-results-label').textContent = label;
      document.getElementById('learn-results-count').textContent = result && result.columns.length
        ? `${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? '' : 's'}`
        : '';
      document.getElementById('learn-results').innerHTML = learnRenderTable(result, { emptyText: 'Your query returned no rows.' });
    }

    window.learnRunQuery = function() {
      if (!learn.db || !learn.lesson) return;
      const sql = learnCurrentSql();
      if (!LearnGrader.maskSql(sql).trim()) { learnSetFeedback({ kind: 'info', title: 'Nothing to run yet', message: 'Write a query in the editor first.' }); return; }
      saveLearnDraftNow();
      try {
        const result = LearnGrader.runQuery(learn.db, sql);
        if (window.synthTrack) window.synthTrack('query_run');
        learnShowResult(result, 'Query Results');
        learnSetFeedback({ kind: 'info', title: 'Query ran', message: 'Looks good? Press <strong>Check Answer</strong> to see if it solves the task.', html: true });
      } catch (err) {
        const ex = err.learnReadOnly ? { title: 'Read queries only', message: err.message, tip: null } : LearnGrader.explainError(err.message, sql, learn.ctx);
        learnShowResult(null, 'Query Results');
        document.getElementById('learn-results').innerHTML = '<div class="empty">Fix the error above, then run again.</div>';
        learnSetFeedback({ kind: 'error', title: ex.title, message: learnFmt(ex.message), tip: ex.tip, raw: err.learnReadOnly ? null : err.message, html: true });
      }
    };

    window.learnRunExample = function() {
      if (!learn.db || !learn.lesson) return;
      try {
        const result = LearnGrader.runQuery(learn.db, learn.lesson.example.sql);
        learnShowResult(result, 'Example result');
        learnSetFeedback({ kind: 'info', title: 'Example ran', message: 'That\'s the example\'s output. Your editor is untouched: now write the query for the task.' });
      } catch (err) {
        learnSetFeedback({ kind: 'error', title: 'Example failed', message: learnFmt(err.message), html: true });
      }
    };

    window.learnCheckAnswer = function() {
      const lesson = learn.lesson;
      if (!learn.db || !lesson || !learn.expected) return;
      const sql = learnCurrentSql();
      const grade = LearnGrader.grade(learn.db, sql, lesson, learn.expected, learn.ctx);
      if (grade.code === 'empty') {
        learnSetFeedback({ kind: 'info', title: grade.title, message: grade.message });
        return;
      }
      if (window.synthTrack) window.synthTrack('query_run');

      const wasLocked = learn.store.lesson(lesson.id).attempts === 0;
      const { firstCompletion, record } = learn.store.recordAttempt(lesson.id, { correct: grade.ok, sql });
      learn.lastGrade = grade;
      learn.lastSql = sql;

      if (grade.userResult) learnShowResult(grade.userResult, 'Your result');
      else document.getElementById('learn-results').innerHTML = '<div class="empty">Fix the error above, then check again.</div>';
      document.getElementById('learn-expected-btn').hidden = false;
      document.getElementById('learn-expected-btn').setAttribute('aria-pressed', 'false');

      if (grade.ok) {
        const { next } = LearnCurriculum.neighbors(lesson.id);
        const level = learnLevelOf(lesson);
        const levelDone = LearnProgress.levelStats(level, learn.store.get()).completed === level.lessons.length;
        const praise = record.firstTry && firstCompletion ? 'First try. Nicely done.' : firstCompletion ? 'You got it.' : 'Still correct.';
        learnSetFeedback({
          kind: 'success',
          title: 'Correct!',
          message: `${praise} ${learnFmt(lesson.takeaway)}`,
          html: true,
          actions: next
            ? `<button type="button" class="run-btn learn-next-cta" onclick="learnGoToLesson('${next.id}')"><span>Next: ${escapeHtml(next.title)}</span><span aria-hidden="true">▶</span></button>`
            : `<button type="button" class="run-btn learn-next-cta" onclick="learnOpenLevelModal('${level.id}')"><span>Finish ${escapeHtml(level.level)}</span><span aria-hidden="true">▶</span></button>`,
        });
        if (firstCompletion) learnCelebrate();
        if (firstCompletion && levelDone) setTimeout(() => learnOpenLevelModal(level.id), 900);
      } else {
        const tips = [grade.tip, ...(grade.tips || [])].filter(Boolean);
        const tutorLine = currentUser
          ? '<button type="button" class="learn-link-btn" onclick="learnAskTutorWhy()"><i class="ph ph-sparkle" aria-hidden="true"></i> Ask the AI tutor why</button>'
          : '<button type="button" class="learn-link-btn" onclick="openAccountModal(\'signin\')"><i class="ph ph-sparkle" aria-hidden="true"></i> Sign in to ask the AI tutor</button>';
        learnSetFeedback({
          kind: grade.code === 'missing_construct' || grade.code === 'forbidden_construct' ? 'warn' : 'error',
          title: grade.title,
          message: learnFmt(grade.message),
          tipsHtml: tips.map(learnFmt),
          raw: grade.rawError || null,
          html: true,
          actions: tutorLine,
        });
      }

      renderLearnChrome();
      renderLearnGuideStatus();
      if (wasLocked) {
        renderLearnTutor();
        const btn = document.getElementById('learn-pane-tutor-btn');
        btn.classList.add('is-unlocked-now');
        setTimeout(() => btn.classList.remove('is-unlocked-now'), 2400);
      } else {
        renderLearnTutorContext();
      }
    };

    window.learnToggleExpected = function() {
      const btn = document.getElementById('learn-expected-btn');
      const showing = btn.getAttribute('aria-pressed') === 'true';
      if (showing) {
        btn.setAttribute('aria-pressed', 'false');
        btn.textContent = 'Show expected result';
        if (learn.lastGrade && learn.lastGrade.userResult) learnShowResult(learn.lastGrade.userResult, 'Your result');
        else document.getElementById('learn-results').innerHTML = '<div class="empty">Run your query to see its results here.</div>';
      } else {
        btn.setAttribute('aria-pressed', 'true');
        btn.textContent = 'Show your result';
        learnShowResult(learn.expected, 'Expected result');
      }
    };

    // Renders the feedback card under the editor. `message` is HTML when
    // `html` is set (already escaped by learnFmt), else plain text.
    function learnSetFeedback(fb) {
      const el = document.getElementById('learn-feedback');
      if (!fb) { el.hidden = true; el.innerHTML = ''; el.className = 'learn-feedback'; return; }
      const icon = { success: 'ph-check-circle', error: 'ph-x-circle', warn: 'ph-info', info: 'ph-info' }[fb.kind] || 'ph-info';
      const message = fb.html ? fb.message : escapeHtml(fb.message);
      const tips = fb.tipsHtml || (fb.tip ? [learnFmt(fb.tip)] : []);
      el.className = `learn-feedback is-${fb.kind}`;
      el.hidden = false;
      el.innerHTML = `
        <div class="learn-feedback-head"><i class="ph ${icon}" aria-hidden="true"></i><strong>${escapeHtml(fb.title)}</strong></div>
        <div class="learn-feedback-body">${message}</div>
        ${tips.length ? `<ul class="learn-feedback-tips">${tips.map(t => `<li><i class="ph ph-lightbulb" aria-hidden="true"></i><span>${t}</span></li>`).join('')}</ul>` : ''}
        ${fb.raw ? `<details class="learn-feedback-raw"><summary>SQLite's exact message</summary><code>${escapeHtml(fb.raw)}</code></details>` : ''}
        ${fb.actions ? `<div class="learn-feedback-actions">${fb.actions}</div>` : ''}`;
    }

    function learnCelebrate() {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const host = document.getElementById('learn-feedback');
      const burst = document.createElement('div');
      burst.className = 'learn-confetti';
      burst.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 26; i++) {
        const s = document.createElement('span');
        s.style.setProperty('--x', `${Math.round((Math.random() - 0.5) * 320)}px`);
        s.style.setProperty('--y', `${Math.round(-60 - Math.random() * 140)}px`);
        s.style.setProperty('--r', `${Math.round(Math.random() * 540)}deg`);
        s.style.setProperty('--d', `${Math.round(Math.random() * 120)}ms`);
        s.className = `c${i % 4}`;
        burst.appendChild(s);
      }
      host.appendChild(burst);
      setTimeout(() => burst.remove(), 1600);
    }

    // ---- Tabs and panes ----

    function learnSelectTab(tab) {
      document.querySelectorAll('[data-learn-tab]').forEach(btn => {
        const on = btn.dataset.learnTab === tab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on);
      });
      document.getElementById('learn-tab-lesson').classList.toggle('active', tab === 'lesson');
      document.getElementById('learn-tab-tables').classList.toggle('active', tab === 'tables');
    }

    function learnSelectPane(pane) {
      learn.pane = pane;
      document.getElementById('learn-pane-lesson-btn').classList.toggle('is-active', pane === 'lesson');
      document.getElementById('learn-pane-tutor-btn').classList.toggle('is-active', pane === 'tutor');
      document.getElementById('learn-pane-lesson-btn').setAttribute('aria-selected', pane === 'lesson');
      document.getElementById('learn-pane-tutor-btn').setAttribute('aria-selected', pane === 'tutor');
      document.getElementById('learn-guide').hidden = pane !== 'lesson';
      document.getElementById('learn-tutor').hidden = pane !== 'tutor';
      if (pane === 'tutor') {
        const input = document.getElementById('learn-chat-input');
        if (!input.disabled) input.focus();
        const msgs = document.getElementById('learn-chat-messages');
        msgs.scrollTop = msgs.scrollHeight;
      }
    }
    window.learnSelectPane = learnSelectPane;

    function renderLearnTablesTab() {
      const lesson = learn.lesson;
      if (!lesson || !learn.db) return;
      const chips = document.getElementById('learn-table-chips');
      chips.innerHTML = lesson.tables.map(t => {
        const count = learn.db.exec(`SELECT COUNT(*) FROM ${LearnDatasets.quoteIdent(t)}`)[0].values[0][0];
        return `<button type="button" class="table-chip${t === learn.activeTableTab ? ' active' : ''}" onclick="learnShowTable('${t}')"><span class="chip-name">${t}</span><span class="chip-rows">${count}</span></button>`;
      }).join('');
      const t = learn.activeTableTab;
      const ds = LearnDatasets.DATASETS[t];
      const res = LearnGrader.runQuery(learn.db, `SELECT * FROM ${LearnDatasets.quoteIdent(t)}`);
      document.getElementById('learn-table-info').innerHTML = `
        <p class="help-text">${escapeHtml(ds.description)}</p>
        <ul class="learn-column-docs">${ds.columns.map(c => `<li><code>${escapeHtml(c.name)}</code><span class="learn-col-type">${c.type.toLowerCase()}${c.pk ? ' · primary key' : ''}${c.fk ? ` · → ${escapeHtml(c.fk)}` : ''}</span><span>${escapeHtml(c.desc)}</span></li>`).join('')}</ul>`;
      document.getElementById('learn-table-preview').innerHTML = learnRenderTable(res, { limit: 500 });
    }

    window.learnShowTable = function(t) {
      learn.activeTableTab = t;
      renderLearnTablesTab();
    };

    // ---- Outline drawer, level modal, reset ----

    window.learnOpenOutline = function() {
      const lesson = learn.lesson;
      const p = learn.store.get();
      const levelId = lesson ? lesson.levelId : LearnCurriculum.LEVELS[0].id;
      const body = document.getElementById('learn-outline-body');
      body.innerHTML = LearnCurriculum.LEVELS.map(level => {
        const s = LearnProgress.levelStats(level, p);
        return `<details class="learn-outline-level"${level.id === levelId ? ' open' : ''}>
          <summary><span>${escapeHtml(level.level)}: ${escapeHtml(level.title)}</span><span class="learn-syllabus-level-count">${s.completed}/${s.total}</span></summary>
          ${LearnCurriculum.modulesOf(level).map(mod => `
            <div class="learn-syllabus-module-title">${escapeHtml(mod.title)}</div>
            <ol class="learn-syllabus-lessons">${mod.lessons.map(l => `
              <li><button type="button" class="learn-syllabus-lesson${lesson && l.id === lesson.id ? ' is-current' : ''}" onclick="learnGoToLesson('${l.id}')">
                ${learnStatusIcon((p.lessons[l.id] || {}).status)}
                <span class="learn-syllabus-num">${l.number}</span>
                <span class="learn-syllabus-name">${escapeHtml(l.title)}</span>
              </button></li>`).join('')}</ol>`).join('')}
        </details>`;
      }).join('');
      document.getElementById('learn-outline-modal').hidden = false;
    };

    window.closeLearnOutline = function() {
      const m = document.getElementById('learn-outline-modal');
      if (m) m.hidden = true;
    };

    window.learnOpenLevelModal = function(levelId) {
      const level = LearnCurriculum.getLevel(levelId);
      if (!level) return;
      const p = learn.store.get();
      const s = LearnProgress.levelStats(level, p);
      const i = LearnCurriculum.LEVELS.indexOf(level);
      const nextLevel = LearnCurriculum.LEVELS[i + 1];
      const hints = level.lessons.reduce((n, l) => n + ((p.lessons[l.id] || {}).hintsUsed || 0), 0);
      const done = s.completed === s.total;
      document.getElementById('learn-level-modal-body').innerHTML = `
        <div class="learn-trophy" aria-hidden="true"><i class="ph ${done ? 'ph-trophy' : 'ph-flag-checkered'}"></i></div>
        <h2 class="learn-level-modal-title">${done ? `${escapeHtml(level.level)} complete!` : `${escapeHtml(level.level)}: ${s.completed} of ${s.total} done`}</h2>
        <p class="help-text">${done
          ? `You finished <strong>${escapeHtml(level.title)}</strong>. ${nextLevel ? `Up next: ${escapeHtml(nextLevel.title)}.` : 'That\'s the whole path. You can write real analytics SQL now.'}`
          : 'A few lessons in this level are still open. Finish them from the lesson list whenever you like.'}</p>
        <dl class="learn-stat-list learn-stat-list-row">
          <div><dt>Lessons</dt><dd>${s.completed}<span>/${s.total}</span></dd></div>
          <div><dt>First try</dt><dd>${s.firstTry}</dd></div>
          <div><dt>Hints used</dt><dd>${hints}</dd></div>
        </dl>
        <div class="modal-actions">
          <button type="button" class="modal-cancel-btn" onclick="closeLearnLevelModal(); learnShowOverview();">All courses</button>
          ${nextLevel
            ? `<button type="button" class="modal-save-btn" onclick="learnStartLevel('${nextLevel.id}')">Start ${escapeHtml(nextLevel.level)} ▶</button>`
            : `<button type="button" class="modal-save-btn" onclick="closeLearnLevelModal()">Done</button>`}
        </div>`;
      document.getElementById('learn-level-modal').hidden = false;
    };

    window.closeLearnLevelModal = function() {
      const m = document.getElementById('learn-level-modal');
      if (m) m.hidden = true;
    };

    window.learnOpenResetModal = function() {
      document.getElementById('learn-reset-modal').hidden = false;
    };

    window.closeLearnResetModal = function() {
      document.getElementById('learn-reset-modal').hidden = true;
    };

    window.confirmLearnReset = function() {
      learn.store.reset();
      learn.tutor.clear();
      closeLearnResetModal();
      renderLearnOverview();
    };

    // ---- AI tutor ----
    // Same /api/chat endpoint, model, and per-account rate limit as the
    // workspace assistant (chat.js). Locked per lesson until the learner
    // has pressed Check Answer at least once, so it supports attempts
    // rather than replacing them.

    function learnTutorState() {
      if (!learn.lesson) return 'locked';
      const attempted = learn.store.lesson(learn.lesson.id).attempts > 0;
      if (!attempted) return 'locked';
      if (!currentUser) return 'signed_out';
      return 'ready';
    }

    function renderLearnTutor() {
      if (!learn.lesson || !document.getElementById('learn-tutor')) return;
      const state = learnTutorState();
      const lockIcon = document.getElementById('learn-tutor-lock');
      lockIcon.className = `ph ${state === 'ready' ? 'ph-sparkle' : 'ph-lock-simple'}`;
      document.getElementById('learn-pane-tutor-btn').title = state === 'ready' ? 'Ask the AI tutor' : state === 'locked' ? 'Unlocks after your first Check Answer' : 'Sign in to use the AI tutor';

      const locked = document.getElementById('learn-tutor-locked');
      const chat = document.getElementById('learn-tutor-chat');
      locked.hidden = state === 'ready';
      chat.hidden = state !== 'ready';
      if (state === 'locked') {
        locked.innerHTML = `
          <div class="learn-lock-icon"><i class="ph ph-lock-simple" aria-hidden="true"></i></div>
          <h3>Give it a shot first</h3>
          <p>The AI tutor unlocks for this question after you press <strong>Check Answer</strong> once. Wrong answers are fine. They're how this works.</p>
          <button type="button" class="save-btn" onclick="learnSelectPane('lesson')">Back to the lesson</button>`;
      } else if (state === 'signed_out') {
        locked.innerHTML = `
          <div class="learn-lock-icon"><i class="ph ph-sparkle" aria-hidden="true"></i></div>
          <h3>Sign in to use the AI tutor</h3>
          <p>The tutor is unlocked for this question. It's free with a Synth account, which also syncs your course progress across devices.</p>
          <button type="button" class="auth-btn auth-btn-primary" onclick="openAccountModal('signin')">Sign in</button>`;
      }

      const messages = learn.tutor.get(learn.lesson.id) || [];
      const msgEl = document.getElementById('learn-chat-messages');
      if (state === 'ready') {
        msgEl.innerHTML = messages.length
          ? messages.map(m => m.role === 'user'
            ? `<div class="chat-message user">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>`
            : `<div class="chat-turn assistant-turn"><div class="chat-message assistant${m.error ? ' learn-chat-error' : ''}">${m.error ? escapeHtml(m.content) : formatMessage(m.content)}</div></div>`).join('')
          : `<div class="chat-message assistant learn-tutor-hello">I've seen the task and your last attempt. Ask me anything about it, or pick a question below. I'll help you get there without just handing over the answer.</div>`;
        msgEl.scrollTop = msgEl.scrollHeight;
        renderLearnTutorContext();
      }
      document.getElementById('learn-chat-input').disabled = state !== 'ready' || learn.tutorSending;
      document.getElementById('learn-chat-send').disabled = state !== 'ready' || learn.tutorSending;
    }

    function renderLearnTutorContext() {
      const el = document.getElementById('learn-tutor-context');
      if (!el || !learn.lesson) return;
      const g = learn.lastGrade;
      el.innerHTML = g
        ? `<span class="learn-tutor-context-label">Last check:</span> <span class="${g.ok ? 'is-ok' : 'is-bad'}">${escapeHtml(g.ok ? 'Correct' : g.title)}</span>`
        : `<span class="learn-tutor-context-label">Task:</span> ${escapeHtml(learnPlainText(learn.lesson.task)).slice(0, 140)}`;
    }

    function buildLearnTutorPrompt() {
      const lesson = learn.lesson;
      const level = learnLevelOf(lesson);
      const rec = learn.store.lesson(lesson.id);
      const g = learn.lastGrade;
      const lastSql = learn.lastSql || learnCurrentSql();
      const allowFull = rec.attempts >= 2;
      const checkLine = g
        ? (g.ok ? 'Their last check was CORRECT.' : `Their last check was WRONG. The grader said: "${g.title}: ${g.message}${g.tip ? ' ' + g.tip : ''}"`)
        : 'They have not run Check Answer since opening this lesson.';
      return `You are a friendly, encouraging SQL tutor inside Synth Learn, an interactive SQL course. The learner is on the ${level.level} lesson "${lesson.title}" (module: ${lesson.module}).

Concept taught in this lesson:
${learnPlainText(lesson.concept)}

The learner's task:
${learnPlainText(lesson.task)}

Database: SQLite 3.39 (supports window functions, RIGHT and FULL OUTER JOIN; no CONCAT, use ||). Tables in this lesson:
${LearnDatasets.schemaText(lesson.tables)}

Reference solution (confidential, for your understanding only; any query with the same result is correct):
\`\`\`sql
${lesson.solution}
\`\`\`

The learner's most recent query:
\`\`\`sql
${lastSql.trim() || '(empty)'}
\`\`\`
${checkLine}
Attempts so far: ${rec.attempts}. Hints revealed: ${Math.min(learn.hintsShown, lesson.hints.length)} of ${lesson.hints.length}. Solution already revealed: ${rec.solutionViewed ? 'yes' : 'no'}.

How to help:
1. Guide, don't solve. Point at the specific clause or idea that's off, ask a leading question, or show a tiny example on a different column or table.
2. ${allowFull ? 'The learner has made 2+ attempts, so if they explicitly ask for the full answer you may give it, explained line by line.' : 'Do NOT write the complete solution query, even if asked. The learner has not made enough attempts yet; say they can unlock the solution after 2 attempts and give a hint instead.'}
3. Never paste the reference solution verbatim unless rule 2 allows it.
4. Only use the tables and columns listed above. Never invent columns.
5. Keep replies short: 2 to 5 sentences or a short list. Use \`inline code\` for SQL keywords and column names, and \`\`\`sql fences only for short snippets.
6. If their answer is already correct, congratulate them briefly and explain why it works or show an alternative approach.
7. If they ask about something unrelated to SQL or this lesson, gently steer back to the lesson.`;
    }

    async function learnSendTutorMessage(text) {
      const lesson = learn.lesson;
      const message = String(text || '').trim();
      if (!lesson || !message || learn.tutorSending || learnTutorState() !== 'ready') return;
      const history = learn.tutor.get(lesson.id) || [];
      history.push({ role: 'user', content: message });
      learn.tutor.set(lesson.id, history);
      learn.tutorSending = true;
      renderLearnTutor();
      const msgEl = document.getElementById('learn-chat-messages');
      msgEl.insertAdjacentHTML('beforeend', '<div class="chat-turn assistant-turn" id="learn-tutor-thinking"><div class="chat-message assistant">Thinking...</div></div>');
      msgEl.scrollTop = msgEl.scrollHeight;

      try {
        const { data: { session } } = sb ? await sb.auth.getSession() : { data: { session: null } };
        if (!session) throw new Error('Please sign in to use the AI tutor.');
        const turns = history.filter(m => !m.error).slice(-LEARN_TUTOR_HISTORY_LIMIT).map(m => ({ role: m.role, content: m.content }));
        const response = await fetch(CHAT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [{ role: 'system', content: buildLearnTutorPrompt() }, ...turns],
            temperature: 0.3,
          }),
        });
        if (response.status === 429) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.error?.message || "You've used today's AI messages. Try again later.");
        }
        if (response.status === 401) throw new Error('Your session expired. Sign in again to keep using the AI tutor.');
        if (!response.ok) throw new Error(`The tutor couldn't answer right now (${response.status}).`);
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);
        history.push({ role: 'assistant', content: data.choices[0].message.content });
      } catch (err) {
        const msg = /Failed to fetch/.test(err.message) ? `Can't reach ${CHAT_ENDPOINT}. If you're running locally, start \`vercel dev\`.` : err.message;
        history.push({ role: 'assistant', content: msg, error: true });
      } finally {
        learn.tutorSending = false;
        if (learn.lesson === lesson) renderLearnTutor();
      }
    }

    window.learnSendTutor = function() {
      const input = document.getElementById('learn-chat-input');
      const text = input.value;
      input.value = '';
      input.style.height = 'auto';
      learnSendTutorMessage(text);
    };

    window.learnTutorChip = function(kind) {
      const prompts = {
        why: 'Why is my answer wrong?',
        hint: 'Can you give me a hint for the next step?',
        explain: 'Can you explain the concept in this lesson another way?',
      };
      learnSendTutorMessage(prompts[kind]);
    };

    window.learnAskTutorWhy = function() {
      learnSelectPane('tutor');
      const input = document.getElementById('learn-chat-input');
      if (!input.disabled && !input.value) input.value = 'Why is my answer wrong?';
      input.focus();
    };

    // ---- DOM wiring (once) ----

    function wireLearnDom() {
      const ta = document.getElementById('learn-query-input');
      if (!ta) return;
      ta.addEventListener('input', () => {
        learnRefreshEditor(false);
        clearTimeout(learn.draftTimer);
        learn.draftTimer = setTimeout(saveLearnDraftNow, 500);
      });
      ta.addEventListener('scroll', () => {
        document.getElementById('learn-line-numbers').scrollTop = ta.scrollTop;
        const hl = document.getElementById('learn-query-highlight');
        hl.scrollTop = ta.scrollTop;
        hl.scrollLeft = ta.scrollLeft;
      });

      document.querySelectorAll('[data-learn-tab]').forEach(btn => {
        btn.addEventListener('click', () => learnSelectTab(btn.dataset.learnTab));
      });
      document.getElementById('learn-pane-lesson-btn').addEventListener('click', () => learnSelectPane('lesson'));
      document.getElementById('learn-pane-tutor-btn').addEventListener('click', () => learnSelectPane('tutor'));
      document.getElementById('learn-prev-btn').addEventListener('click', () => {
        const { prev } = LearnCurriculum.neighbors(learn.lesson.id);
        if (prev) learnGoToLesson(prev.id);
      });
      document.getElementById('learn-next-btn').addEventListener('click', () => {
        const { next } = LearnCurriculum.neighbors(learn.lesson.id);
        if (next) learnGoToLesson(next.id);
      });

      const chatInput = document.getElementById('learn-chat-input');
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); learnSendTutor(); }
      });
      chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
      });

      document.getElementById('learn-workspace-resizer').addEventListener('mousedown', (e) => startPaneDrag(e, 'v'));
      document.getElementById('learn-editor-results-resizer').addEventListener('mousedown', (e) => startPaneDrag(e, 'h'));

      // ⌘/Ctrl+Enter runs, ⌘/Ctrl+Shift+Enter checks. The app view has its
      // own ⌘/Ctrl+Enter handler (app.js), scoped to when it's visible.
      document.addEventListener('keydown', (e) => {
        if (document.getElementById('learn-view').hidden || document.getElementById('learn-lesson').hidden) return;
        if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
        if (document.querySelector('.modal-overlay:not([hidden])')) return;
        if (document.activeElement === chatInput) return;
        e.preventDefault();
        if (e.shiftKey) learnCheckAnswer();
        else learnRunQuery();
      });

      window.addEventListener('pagehide', saveLearnDraftNow);
    }
