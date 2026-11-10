// Real-service smoke test against a DEPLOYED build (a Vercel preview, or
// production for a post-deploy check): real CDN scripts, real Supabase,
// real API routes, real network. Read-mostly, and safe to run repeatedly.
//
//   E2E_BASE_URL=https://synth-git-my-branch.vercel.app npm run test:real
//
// Optional, for the signed-in checks (use a dedicated test account):
//   E2E_TEST_EMAIL, E2E_TEST_PASSWORD
//
// Skips itself when E2E_BASE_URL is not set.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = (process.env.E2E_BASE_URL || '').replace(/\/$/, '');
const EMAIL = process.env.E2E_TEST_EMAIL;
const PASSWORD = process.env.E2E_TEST_PASSWORD;
let playwright = null;
try { playwright = require('playwright'); } catch { /* skip below */ }
const skip = (!BASE && 'E2E_BASE_URL not set') || (!playwright && 'Playwright is not installed');
const skipSignedIn = skip || ((!EMAIL || !PASSWORD) && 'E2E_TEST_EMAIL / E2E_TEST_PASSWORD not set');

// Real network: the 2s budget applies to the app being usable, measured
// from navigation start, over a real CDN.
const PAGE_BUDGET_MS = 2000;

let browser;
before(async () => { if (!skip) browser = await playwright.chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

async function open() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.__errors = [];
  page.on('pageerror', e => page.__errors.push(e.message));
  page.on('dialog', d => d.accept());
  const t0 = Date.now();
  await page.goto(BASE + '/');
  await page.waitForSelector('#home-view:not([hidden])');
  await page.waitForFunction(() => typeof SQL !== 'undefined' && SQL, null, { timeout: 15000 });
  page.__readyMs = Date.now() - t0;
  return page;
}

test('home loads and is usable within budget, with no page errors', { skip, timeout: 60000 }, async () => {
  const page = await open();
  assert.ok(page.__readyMs <= PAGE_BUDGET_MS, `ready in ${page.__readyMs}ms over the real network`);
  assert.deepEqual(page.__errors, []);
  await page.close();
});

test('upload a CSV and query it (client-side, real sql.js from the CDN)', { skip, timeout: 60000 }, async () => {
  const page = await open();
  await page.setInputFiles('#file-upload', { name: 'smoke.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n3,4\n') });
  await page.waitForSelector('#app-view:not([hidden])');
  await page.fill('#query-input', 'SELECT SUM(a) + SUM(b) AS total FROM smoke');
  await page.click('.run-btn');
  await page.waitForFunction(() => /\b10\b/.test(document.getElementById('results').textContent));
  assert.deepEqual(page.__errors, []);
  await page.close();
});

test('every public route in vercel.json returns 200', { skip, timeout: 60000 }, async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8'));
  for (const { source } of vercel.rewrites) {
    const res = await fetch(BASE + source, { redirect: 'manual' });
    assert.equal(res.status, 200, source);
  }
});

test('protected API routes refuse anonymous callers', { skip, timeout: 30000 }, async () => {
  const post = (p, body = '{}', headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post('/api/chat', '{"messages":[]}')).status, 401);
  assert.equal((await post('/api/create-checkout-session')).status, 401);
  assert.equal((await post('/api/enterprise/admin', '{"op":"toggle_ai","enabled":false}')).status, 401);
  assert.equal((await fetch(BASE + '/api/enterprise/status')).status, 401);
  const wh = await post('/api/stripe-webhook', '{"type":"checkout.session.completed"}', { 'stripe-signature': 't=1,v1=forged' });
  assert.equal(wh.status, 400, 'unsigned webhook is rejected');
  assert.equal((await fetch(BASE + '/api/cron/enterprise-renewal-notices')).status, 401);
});

test('internal helper modules are not exposed as routes', { skip, timeout: 30000 }, async () => {
  for (const p of ['/api/_supabaseAuth', '/api/_aiRateLimit', '/api/_mailer']) {
    const res = await fetch(BASE + p, { method: 'POST' });
    assert.notEqual(res.status, 200, `${p} answered 200; files starting with _ must not be routes`);
  }
});

test('signed in: real Supabase sign-in, AI assistant answers, sign out', { skip: skipSignedIn, timeout: 90000 }, async () => {
  const page = await open();
  await page.click('#sign-in-btn');
  await page.click('#auth-tab-signin');
  await page.fill('#auth-email', EMAIL);
  await page.fill('#auth-password', PASSWORD);
  await page.click('#auth-panel-submit-btn');
  await page.waitForFunction(e => document.getElementById('sign-in-btn').textContent.trim() === e, EMAIL, { timeout: 15000 });

  await page.setInputFiles('#file-upload', { name: 'smoke.csv', mimeType: 'text/csv', buffer: Buffer.from('city,sales\nAustin,10\nBoston,20\n') });
  await page.waitForSelector('#app-view:not([hidden])');
  await page.click('label.toggle-switch:has(#ai-toggle)');
  await page.fill('#chat-input', 'Which city has the most sales?');
  const t0 = Date.now();
  await page.click('#chat-send');
  await page.waitForFunction(() => document.querySelectorAll('#chat-messages .chat-message.assistant').length >= 2, null, { timeout: 30000 });
  const aiMs = Date.now() - t0;
  // An LLM round trip is outside Synth's control; flagged, not failed, past 2s.
  if (aiMs > 2000) console.log(`SLOW (flag): AI reply took ${aiMs}ms`);

  await page.click('#sign-in-btn');
  await page.click('#settings-modal button:has-text("Sign out")');
  await page.waitForFunction(() => document.getElementById('sign-in-btn').textContent.trim() === 'Sign in');
  assert.equal(await page.evaluate(() => tables.length), 0);
  assert.deepEqual(page.__errors, []);
  await page.close();
});
