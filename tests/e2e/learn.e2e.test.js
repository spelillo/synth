// Browser test of the Learn page: overview, a lesson attempt with wrong
// and right answers, the AI tutor's lock, keyboard shortcuts, history
// navigation, and that the main SQL workspace still works alongside it.
//
//   npm run test:e2e
//
// Needs Playwright with a Chromium build (`npm i -D playwright` and
// `npx playwright install chromium`, or a global install). Skips itself
// when Playwright isn't available. Runs fully offline: sql.js is served
// from node_modules, Supabase is replaced by a fake signed-in client, the
// AI endpoint returns a canned reply, and every other third-party request
// (fonts, icons, Stripe, analytics) gets an empty response.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SQLJS_DIST = path.join(ROOT, 'node_modules', 'sql.js', 'dist');

function loadPlaywright() {
  const candidates = ['playwright', '@playwright/test'];
  for (const name of candidates) {
    try { return require(name); } catch (err) { /* try the next one */ }
  }
  try {
    const globalRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  } catch (err) {
    return null;
  }
}

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.json': 'application/json', '.wasm': 'application/wasm' };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = decodeURIComponent(url.pathname);
    if (file === '/' || file === '/learn') file = '/synth.html';
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A stand-in for supabase-js: one signed-in user, empty tables, and
// learn_progress writes recorded on window.__learnUpserts.
const FAKE_SUPABASE = `
window.__learnUpserts = [];
window.supabase = { createClient: function () {
  var session = { user: { id: 'user-1', email: 'learner@example.com' }, access_token: 'test-token' };
  function query(table) {
    var result = { data: table === 'learn_progress' ? null : [], error: null };
    var q = {
      select: function () { return q; }, eq: function () { return q; }, neq: function () { return q; },
      order: function () { return q; }, limit: function () { return q; }, in: function () { return q; },
      insert: function () { return q; }, update: function () { return q; }, delete: function () { return q; },
      maybeSingle: function () { return Promise.resolve(result); }, single: function () { return Promise.resolve(result); },
      upsert: function (row) { if (table === 'learn_progress') window.__learnUpserts.push(row); return Promise.resolve({ error: null }); },
      then: function (ok, fail) { return Promise.resolve(result).then(ok, fail); }
    };
    return q;
  }
  return {
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: window.__signedOut ? null : session } }); },
      getUser: function () { return Promise.resolve({ data: { user: session.user } }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; }
    },
    from: query,
    rpc: function () { return Promise.resolve({ data: null, error: null }); },
    functions: { invoke: function () { return Promise.resolve({ data: null, error: null }); } }
  };
} };`;

const playwright = loadPlaywright();

test('Learn page end to end', { skip: !playwright && 'Playwright is not installed', timeout: 120000 }, async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch();
  const errors = [];
  let chatRequest = null;

  async function newPage({ signedIn = true, viewport = { width: 1440, height: 900 } } = {}) {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.endsWith('/api/chat')) {
        chatRequest = JSON.parse(route.request().postData());
        return route.fulfill({ json: { choices: [{ message: { content: 'Check which table you are reading from.\n\n```sql\nSELECT description FROM bank_statement;\n```' } }] } });
      }
      if (url.endsWith('/api/track')) return route.fulfill({ status: 204, body: '' });
      if (url.startsWith(base)) return route.continue();
      const sqljs = url.match(/sql\.js@1\.8\.0\/dist\/(.+)$/);
      if (sqljs) return route.fulfill({ body: fs.readFileSync(path.join(SQLJS_DIST, sqljs[1])), contentType: TYPES[path.extname(sqljs[1])] });
      if (signedIn && url.includes('supabase-js')) return route.fulfill({ body: FAKE_SUPABASE, contentType: 'application/javascript' });
      return route.fulfill({ body: '', contentType: url.endsWith('.css') ? 'text/css' : 'application/javascript' });
    });
    return page;
  }

  const text = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();

  try {
    await t.test('the overview opens straight from ?view=learn', async () => {
      const page = await newPage({ signedIn: false });
      await page.goto(`${base}/synth.html?view=learn`);
      await page.waitForSelector('.learn-level-card');
      assert.equal(await page.isVisible('#home-view'), false);
      assert.equal(await page.locator('.learn-level-card').count(), 3);
      assert.match(await page.title(), /Learn SQL/);
      assert.equal(await page.getAttribute('link[rel="canonical"]', 'href'), 'https://synth-sql.com/learn');
      await page.close();
    });

    await t.test('a lesson: wrong answer, feedback, right answer, progress', async () => {
      const page = await newPage({ signedIn: false });
      await page.goto(`${base}/synth.html?view=learn`);
      await page.click('.learn-level-cta >> nth=0');
      await page.waitForSelector('#learn-lesson:not([hidden])');
      assert.match(page.url(), /lesson=b01/);
      await page.waitForFunction(() => !document.getElementById('learn-check-btn').disabled);

      await page.fill('#learn-query-input', 'SELECT product_name FROM grocery_store_data');
      await page.click('#learn-check-btn');
      await page.waitForSelector('#learn-feedback.is-error');
      assert.match(await text(page, '#learn-feedback'), /Missing columns/);
      assert.match(await text(page, '#learn-results-count'), /140/);

      await page.fill('#learn-query-input', 'select * from grocery_store_data');
      await page.click('#learn-check-btn');
      await page.waitForSelector('#learn-feedback.is-success');
      assert.match(await text(page, '#learn-progress-text'), /1 of 21/);
      assert.match(await page.getAttribute('.learn-step >> nth=0', 'class'), /is-completed/);

      const stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), 'synth_learn_progress_v1');
      assert.equal(stored.lessons.b01.status, 'completed');
      assert.equal(stored.lessons.b01.attempts, 2);

      // Progress survives a reload.
      await page.reload();
      await page.waitForSelector('#learn-lesson:not([hidden])');
      assert.match(await text(page, '#learn-progress-text'), /1 of 21/);
      await page.close();
    });

    await t.test('hints and the solution unlock step by step', async () => {
      const page = await newPage({ signedIn: false });
      await page.goto(`${base}/synth.html?view=learn&lesson=b05`);
      await page.waitForFunction(() => !document.getElementById('learn-check-btn').disabled);
      await page.evaluate(() => learnShowHint());
      assert.equal(await page.locator('.learn-hint').count(), 1);
      const solutionLocked = await page.evaluate(() => { learnShowSolution(); return document.getElementById('learn-solution').hidden; });
      assert.equal(solutionLocked, true, 'solution stays hidden before 2 attempts');
      for (let i = 0; i < 2; i++) {
        await page.fill('#learn-query-input', 'SELECT team FROM nfl_team_stats');
        await page.click('#learn-check-btn');
        await page.waitForSelector('#learn-feedback:not([hidden])');
      }
      await page.evaluate(() => learnShowSolution());
      assert.equal(await page.isVisible('#learn-solution'), true);
      await page.close();
    });

    await t.test('the AI tutor is locked until the first Check Answer', async () => {
      const page = await newPage({ signedIn: true });
      await page.goto(`${base}/synth.html?view=learn&lesson=b06`);
      await page.waitForFunction(() => !document.getElementById('learn-check-btn').disabled);
      await page.click('#learn-pane-tutor-btn');
      assert.equal(await page.isVisible('#learn-tutor-locked'), true);
      assert.equal(await page.isVisible('#learn-tutor-chat'), false);

      await page.click('#learn-pane-lesson-btn');
      await page.fill('#learn-query-input', 'SELECT * FROM customers');
      await page.click('#learn-check-btn');
      await page.waitForSelector('#learn-feedback:not([hidden])');
      assert.match(await text(page, '#learn-feedback'), /Unknown table/);

      await page.click('#learn-pane-tutor-btn');
      assert.equal(await page.isVisible('#learn-tutor-chat'), true);
      await page.fill('#learn-chat-input', 'What am I missing?');
      await page.click('#learn-chat-send');
      await page.waitForSelector('#learn-chat-messages .use-query-btn');
      const system = chatRequest.messages[0];
      assert.equal(system.role, 'system');
      assert.match(system.content, /Do NOT write the complete solution/);
      assert.match(system.content, /SELECT \* FROM customers/, 'the tutor sees the latest attempt');
      assert.equal(chatRequest.messages.at(-1).content, 'What am I missing?');

      // "Use Query" in the tutor fills the lesson editor, not the main one.
      await page.click('#learn-chat-messages .use-query-btn');
      assert.equal(await page.inputValue('#learn-query-input'), 'SELECT description FROM bank_statement;');

      // Signed-in progress is pushed to the learn_progress table.
      await page.waitForFunction(() => window.__learnUpserts.length > 0, null, { timeout: 5000 });
      const row = await page.evaluate(() => window.__learnUpserts.at(-1));
      assert.equal(row.user_id, 'user-1');
      assert.equal(row.progress.lessons.b06.status, 'attempted');
      await page.close();
    });

    await t.test('the main workspace still works next to Learn', async () => {
      const page = await newPage({ signedIn: false });
      await page.goto(`${base}/synth.html`);
      await page.waitForSelector('#home-view:not([hidden])');
      assert.equal(await page.isVisible('#learn-view'), false);
      await page.waitForFunction(() => typeof SQL !== 'undefined' && SQL);
      await page.click('.preview-dataset-card >> nth=0');
      await page.click('#preview-dataset-modal .modal-save-btn');
      await page.waitForSelector('#app-view:not([hidden])');
      const table = await page.evaluate(() => tables[0].name);
      await page.fill('#query-input', `SELECT COUNT(*) AS n FROM ${table}`);
      await page.keyboard.press('Control+Enter');
      await page.waitForFunction(() => /\d/.test(document.getElementById('results').textContent));
      const mainResult = await text(page, '#results');

      // Workspace tabs only touch the workspace's own panels.
      await page.click('#app-view .tab-btn[data-tab="table"]');
      assert.equal(await page.isVisible('#tab-table'), true);
      await page.click('#app-view .tab-btn[data-tab="query"]');

      // Into Learn from the header, and Cmd/Ctrl+Enter there runs the lesson query only.
      await page.click('#learn-nav-btn');
      await page.waitForSelector('#learn-overview:not([hidden])');
      assert.equal(await page.isVisible('#app-view'), false);
      await page.evaluate(() => learnGoToLesson('b02'));
      await page.waitForFunction(() => !document.getElementById('learn-check-btn').disabled);
      await page.fill('#learn-query-input', 'SELECT 41 + 1 AS answer');
      await page.focus('#learn-query-input');
      await page.keyboard.press('Control+Enter');
      await page.waitForFunction(() => /42/.test(document.getElementById('learn-results').textContent));
      assert.equal(await text(page, '#results'), mainResult);

      // Ctrl+Shift+Enter checks the answer.
      await page.keyboard.press('Control+Shift+Enter');
      await page.waitForSelector('#learn-feedback:not([hidden])');

      // Back, back: lesson → overview → workspace.
      await page.goBack();
      await page.waitForSelector('#learn-overview:not([hidden])');
      await page.goBack();
      await page.waitForSelector('#app-view:not([hidden])');
      assert.equal(await page.isVisible('#learn-view'), false);
      await page.close();
    });

    await t.test('phone layout stacks the lesson', async () => {
      const page = await newPage({ signedIn: false, viewport: { width: 390, height: 844 } });
      await page.goto(`${base}/synth.html?view=learn&lesson=i07`);
      await page.waitForFunction(() => !document.getElementById('learn-check-btn').disabled);
      const guide = await page.locator('.learn-guide-pane').boundingBox();
      const editor = await page.locator('.learn-code-pane').boundingBox();
      assert.ok(editor.y > guide.y, 'editor sits below the lesson text');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
      await page.close();
    });

    assert.deepEqual(errors, [], 'no uncaught page errors');
  } finally {
    await browser.close();
    server.close();
  }
});
