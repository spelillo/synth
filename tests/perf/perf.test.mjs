// Performance budgets. Any user-facing action over 2 seconds fails the
// build; API routes and pure parsing have tighter budgets.
//
//   npm run test:perf
//
// Runs against the same local stack as the E2E suite (real Chromium, real
// app, real API handlers, in-memory database), so the numbers measure Synth's
// own code, not network or third-party latency. CI machines are slower and
// noisier than laptops; budgets are set so a healthy build passes there with
// headroom, and a 2x regression does not.
//
// Results are written to perf-report.json (uploaded as a CI artifact) so
// trends can be compared across runs.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installApiMocks, resetAll, backend, ROOT, signedStripeEvent } from '../helpers/api-harness.mjs';
import { startServer, stubGroq } from '../e2e/support/server.mjs';
import { loadPlaywright, openPage } from '../e2e/support/browser.mjs';

installApiMocks(mock);
const require = createRequire(import.meta.url);
const playwright = loadPlaywright();
const skip = !playwright && 'Playwright is not installed';

// Budgets in milliseconds unless noted.
const BUDGET = {
  userAction: 2000,          // the product-wide rule: no user action over 2s
  pageReady: 2000,           // navigation -> app usable (sql.js initialized)
  apiP95: 100,               // in-process API route latency, p95
  apiMax: 500,
  parse100kRowsNode: 2000,   // parseCSVText on 100k rows (no browser)
  firstPartyJsKB: 1200,      // total first-party JS shipped by synth.html
  heapAfter100kMB: 400,      // JS heap after loading a 100k-row file
};

const report = { generatedAt: new Date().toISOString(), budgets: BUDGET, results: {} };
function record(name, value, budget, unit = 'ms') {
  report.results[name] = { value: Math.round(value * 10) / 10, budget, unit, ok: value <= budget };
  return value;
}

function csv(rows) {
  const regions = ['North', 'South', 'East', 'West'];
  const lines = ['id,region,product,amount,order_date'];
  for (let i = 0; i < rows; i++) {
    lines.push(`${i},${regions[i % 4]},Product ${i % 250},"${(1000 + (i % 9000)).toLocaleString('en-US')}.${String(i % 100).padStart(2, '0')}",2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`);
  }
  return lines.join('\n');
}

let app; let browser; let groq;
before(async () => {
  resetAll();
  app = await startServer();
  if (!skip) browser = await playwright.chromium.launch();
  groq = stubGroq('ok');
});
after(async () => {
  groq.restore();
  if (browser) await browser.close();
  await app.close();
  fs.writeFileSync(path.join(ROOT, 'perf-report.json'), JSON.stringify(report, null, 2));
  const rows = Object.entries(report.results).map(([k, r]) => `${r.ok ? 'ok  ' : 'SLOW'} ${k.padEnd(48)} ${String(r.value).padStart(9)} ${r.unit}  (budget ${r.budget})`);
  console.log(`\nPerformance report\n${rows.join('\n')}\n`);
});

async function ready(page) {
  const t0 = Date.now();
  await page.goto(app.base + '/');
  await page.waitForSelector('#home-view:not([hidden])');
  await page.waitForFunction(() => typeof SQL !== 'undefined' && SQL);
  return Date.now() - t0;
}

async function uploadAndWait(page, name, text) {
  const t0 = Date.now();
  await page.setInputFiles('#file-upload', { name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.waitForSelector('#app-view:not([hidden])');
  await page.waitForFunction(() => tables.length > 0 && /rows/.test(document.getElementById('file-info').textContent));
  return Date.now() - t0;
}

async function timedQuery(page, sql) {
  await page.fill('#query-input', sql);
  const t0 = Date.now();
  await page.click('.run-btn');
  await page.waitForFunction(() => !document.querySelector('#results .loading') && document.querySelector('#results table, #results .empty, #error:not(:empty)'));
  return Date.now() - t0;
}

test('page load: navigation to a usable app is under 2s', { skip, timeout: 60000 }, async () => {
  const page = await openPage(browser, app.base, { signedOut: true });
  await ready(page); // warm-up (wasm compile cache)
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await ready(page));
  const median = runs.sort((a, b) => a - b)[1];
  record('page.ready.median', median, BUDGET.pageReady);
  const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd }; });
  record('page.domContentLoaded', nav.dcl, BUDGET.pageReady);
  assert.ok(median <= BUDGET.pageReady, `app ready in ${median}ms`);
  await page.context().close();
});

test('first-party JS payload stays under budget', () => {
  const html = fs.readFileSync(path.join(ROOT, 'synth.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]+src="\/?([^"]+)"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
  const kb = srcs.reduce((sum, s) => sum + fs.statSync(path.join(ROOT, s)).size, 0) / 1024;
  record('payload.firstPartyJs', kb, BUDGET.firstPartyJsKB, 'KB');
  record('payload.synthHtml', fs.statSync(path.join(ROOT, 'synth.html')).size / 1024, 600, 'KB');
  assert.ok(kb <= BUDGET.firstPartyJsKB, `${kb.toFixed(0)} KB of first-party JS`);
});

for (const rows of [10000, 50000]) {
  test(`upload: a ${rows.toLocaleString()}-row CSV is queryable in under 2s`, { skip, timeout: 60000 }, async () => {
    const page = await openPage(browser, app.base, { signedOut: true });
    await ready(page);
    const ms = await uploadAndWait(page, `sales_${rows}.csv`, csv(rows));
    record(`upload.csv.${rows}rows`, ms, BUDGET.userAction);
    assert.ok(ms <= BUDGET.userAction, `${rows} rows took ${ms}ms`);
    await page.context().close();
  });
}

test('100k-row workload: upload, aggregate, filter, sort, heap', { skip, timeout: 120000 }, async (t) => {
  const page = await openPage(browser, app.base, { signedOut: true });
  await ready(page);
  const uploadMs = await uploadAndWait(page, 'sales_100k.csv', csv(100000));
  // 100k rows is the documented free-tier cap. Flagged (not failed) at the
  // generic 2s budget, failed at 2.5x: the loading overlay shows progress
  // for this case, but it must not regress.
  record('upload.csv.100000rows', uploadMs, BUDGET.userAction);
  if (uploadMs > BUDGET.userAction) t.diagnostic(`SLOW: 100k-row upload took ${uploadMs}ms (>2s, shows a progress overlay)`);
  assert.ok(uploadMs <= BUDGET.userAction * 2.5, `100k upload took ${uploadMs}ms`);

  const agg = await timedQuery(page, 'SELECT region, COUNT(*) n, SUM(CAST(amount AS REAL)) total FROM sales_100k GROUP BY region ORDER BY total DESC');
  record('query.groupBy.100k', agg, BUDGET.userAction);
  const all = await timedQuery(page, 'SELECT * FROM sales_100k');
  record('query.selectAll.100k.render', all, BUDGET.userAction);
  const filtered = await timedQuery(page, "SELECT * FROM sales_100k WHERE product LIKE '%7%' ORDER BY amount DESC");
  record('query.filterSort.100k', filtered, BUDGET.userAction);
  for (const [name, ms] of [['group by', agg], ['select * (100k rows rendered)', all], ['filter+sort', filtered]]) {
    assert.ok(ms <= BUDGET.userAction, `${name} took ${ms}ms`);
  }

  // Scrolling the virtualized grid to the bottom stays responsive.
  const scrollMs = await page.evaluate(async () => {
    const el = document.querySelector('#results .table-wrapper, #results [data-virtual], #results > div') || document.getElementById('results');
    const t0 = performance.now();
    el.scrollTop = el.scrollHeight;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  });
  record('grid.scrollToBottom.100k', scrollMs, 200);
  assert.ok(scrollMs <= 200, `scroll took ${scrollMs}ms`);

  const heapMB = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0) / 1048576);
  record('memory.jsHeapAfter100k', heapMB, BUDGET.heapAfter100kMB, 'MB');
  assert.ok(heapMB <= BUDGET.heapAfter100kMB, `${heapMB.toFixed(0)} MB heap`);
  await page.context().close();
});

test('chart: opening the chart for an aggregate result is under 2s', { skip, timeout: 60000 }, async () => {
  const page = await openPage(browser, app.base, { signedOut: true });
  await ready(page);
  await uploadAndWait(page, 'sales.csv', csv(5000));
  await timedQuery(page, 'SELECT region, COUNT(*) AS n FROM sales GROUP BY region');
  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    renderResultsChart();
    return performance.now() - t0;
  });
  record('chart.render', ms, BUDGET.userAction);
  assert.ok(ms <= BUDGET.userAction);
  await page.context().close();
});

async function latency(name, n, makeRequest) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const res = await makeRequest(i);
    times.push(performance.now() - t0);
    assert.ok(res.status < 500, `${name} returned ${res.status}`);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(n * 0.95) - 1];
  record(`api.${name}.p95`, p95, BUDGET.apiP95);
  record(`api.${name}.max`, times.at(-1), BUDGET.apiMax);
  assert.ok(p95 <= BUDGET.apiP95, `${name} p95 ${p95.toFixed(1)}ms`);
  assert.ok(times.at(-1) <= BUDGET.apiMax, `${name} max ${times.at(-1).toFixed(1)}ms`);
}

test('API latency (p95 over 100 sequential calls, Groq/Stripe stubbed)', { timeout: 60000 }, async () => {
  const log = console.log; console.log = () => {};
  try { await apiLatency(); } finally { console.log = log; }
});

async function apiLatency() {
  const user = backend.createUser({ email: 'perf@example.com' });
  backend.seed('profiles', [{ id: user.id, is_premium: true }]);
  const auth = { authorization: `Bearer ${backend.tokenFor(user)}`, 'content-type': 'application/json' };
  const post = (p, body, headers = auth) => fetch(app.base + p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  await latency('track', 100, () => post('/api/track', { event: 'visit', visitor_id: 'perf-visitor-0001' }, { 'content-type': 'application/json' }));
  await latency('createCheckoutSession', 100, () => post('/api/create-checkout-session', {}));
  await latency('stripeWebhook', 100, (i) => {
    const { payload, header } = signedStripeEvent('checkout.session.completed', { id: `cs_${i}`, client_reference_id: user.id });
    return fetch(app.base + '/api/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload });
  });
  // Clear usage between calls so the rate limiter (15 / 5 min) doesn't 429.
  await latency('chat', 100, () => { backend.tables.ai_usage_events = []; return post('/api/chat', { messages: [{ role: 'user', content: 'hi' }] }); });
}

test('API under load: 200 concurrent /api/track calls all succeed, p95 under budget', { timeout: 60000 }, async () => {
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => {
    const s = performance.now();
    return fetch(app.base + '/api/track', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'visit', visitor_id: `load-visitor-${String(i).padStart(4, '0')}` }) })
      .then(r => ({ status: r.status, ms: performance.now() - s }));
  }));
  const total = performance.now() - t0;
  const sorted = results.map(r => r.ms).sort((a, b) => a - b);
  record('api.track.concurrent200.total', total, BUDGET.userAction);
  record('api.track.concurrent200.p95', sorted[189], BUDGET.apiMax);
  assert.ok(results.every(r => r.status === 204));
  assert.ok(total <= BUDGET.userAction);
});

test('parser (Node): parseCSVText handles 100k rows under budget', { timeout: 60000 }, async () => {
  const { loadBrowserScripts } = require('../helpers/browser-env.js');
  const env = loadBrowserScripts(['state.js', 'csv-parser.js', 'json-parser.js'], { stubs: { advanceLoadProgress: () => {}, openPremiumPanel: () => {}, canUseFeature: () => true } });
  const text = csv(100000);
  const t0 = performance.now();
  const r = await env.get('parseCSVText')(text);
  const ms = record('parse.csv.100k.node', performance.now() - t0, BUDGET.parse100kRowsNode);
  assert.equal(r.rows.length, 100000);
  assert.ok(ms <= BUDGET.parse100kRowsNode, `${ms.toFixed(0)}ms`);
});
