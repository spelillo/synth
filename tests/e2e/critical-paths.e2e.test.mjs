// End-to-end tests of the critical user paths, in a real browser:
//
//   UI (synth.html + app JS) -> /api/* (real handlers) -> business logic
//   -> database (shared in-memory Supabase) -> what the user sees.
//
//   npm run test:e2e
//
// Covers: sign up (with email-code confirmation), sign in, bad credentials,
// password reset, sign out clearing in-memory data; CSV/JSON upload, query,
// SQL errors, wrong file type; save to cloud, reopen after reload, delete
// (rows + storage files), per-user isolation; AI assistant round trip;
// Premium purchase via the HTTP API + signed Stripe webhook.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, backend, signedStripeEvent, silenceConsole } from '../helpers/api-harness.mjs';
import { startServer, stubGroq } from './support/server.mjs';
import { loadPlaywright, openPage, squash } from './support/browser.mjs';

installApiMocks(mock);
const playwright = loadPlaywright();
const skip = !playwright && 'Playwright is not installed';

let browser; let app; let groq;
before(async () => {
  if (skip) return;
  resetAll();
  app = await startServer();
  browser = await playwright.chromium.launch();
  groq = stubGroq(body => {
    const last = body.messages.at(-1).content;
    return /count/i.test(last)
      ? 'Here you go:\n\n```sql\nSELECT COUNT(*) AS n FROM people;\n```'
      : 'I can only help with questions about your data.';
  });
});
after(async () => {
  if (skip) return;
  groq.restore();
  await browser.close();
  await app.close();
});

const PEOPLE_CSV = 'name,age,city\nAda,36,London\nGrace,85,"New York, NY"\nAlan,41,Wilmslow\n';

async function ready(page, url = '/') {
  await page.goto(app.base + url);
  await page.waitForSelector('#home-view:not([hidden])');
  await page.waitForFunction(() => typeof SQL !== 'undefined' && SQL);
}

async function upload(page, name, text, mimeType = 'text/csv') {
  await page.setInputFiles('#file-upload', { name, mimeType, buffer: Buffer.from(text) });
}

async function runQuery(page, sql) {
  await page.fill('#query-input', sql);
  await page.click('.run-btn');
  await page.waitForFunction(() => !document.querySelector('#results .loading'));
}

async function signUpViaUi(page, email, password = 'correct-horse-9') {
  await page.click('#sign-in-btn');
  await page.waitForSelector('#account-modal:not([hidden])');
  await page.click('#auth-tab-signup');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-panel-submit-btn');
  await page.waitForSelector('#auth-confirm-step:not([hidden])');
  const code = backend.mail.filter(m => m.to === email && m.kind === 'confirm').at(-1).code;
  await page.fill('#auth-confirm-code', code);
  await page.click('#auth-confirm-submit-btn');
  await page.waitForFunction(e => document.getElementById('sign-in-btn').textContent.trim() === e, email);
}

async function signInViaUi(page, email, password) {
  await page.click('#sign-in-btn');
  await page.waitForSelector('#account-modal:not([hidden])');
  await page.click('#auth-tab-signin');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-panel-submit-btn');
}

test('auth: sign up -> emailed code -> signed in; validation errors; sign out wipes loaded data', { skip, timeout: 60000 }, async () => {
  const page = await openPage(browser, app.base);
  await ready(page);

  // Client-side validation never reaches Supabase.
  await page.click('#sign-in-btn');
  await page.click('#auth-tab-signup');
  await page.fill('#auth-email', 'not-an-email');
  await page.fill('#auth-password', 'whatever123');
  await page.click('#auth-panel-submit-btn');
  assert.equal(squash(await page.textContent('#auth-message')), 'Enter a valid email.');
  await page.fill('#auth-email', 'ada@example.com');
  await page.fill('#auth-password', 'short');
  await page.click('#auth-panel-submit-btn');
  assert.match(await page.textContent('#auth-message'), /at least 8 characters/);
  assert.equal(backend.users.length, 0);
  await page.evaluate(() => closeAccountModal());

  await signUpViaUi(page, 'ada@example.com');
  await page.waitForSelector('#account-modal', { state: 'hidden' });
  assert.equal(backend.users[0].confirmed, true);

  // Load data, then sign out: the in-memory tables must be gone.
  await upload(page, 'people.csv', PEOPLE_CSV);
  await page.waitForSelector('#app-view:not([hidden])');
  assert.equal(await page.evaluate(() => tables.length), 1);
  await page.click('#sign-in-btn');
  await page.waitForSelector('#settings-modal:not([hidden])');
  await page.click('#settings-modal button:has-text("Sign out")');
  await page.waitForFunction(() => document.getElementById('sign-in-btn').textContent.trim() === 'Sign in');
  assert.equal(await page.evaluate(() => tables.length), 0);
  assert.equal(await page.evaluate(() => db.exec("SELECT name FROM sqlite_master WHERE type='table'").length), 0, 'sql.js database is empty');
  assert.equal(await page.isVisible('#home-view'), true);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('auth: wrong password shows an error; right password signs in and survives reload', { skip, timeout: 60000 }, async () => {
  backend.createUser({ email: 'grace@example.com', password: 'cobol-forever-1' });
  const page = await openPage(browser, app.base);
  await ready(page);
  await signInViaUi(page, 'grace@example.com', 'wrong-password');
  await page.waitForFunction(() => /Invalid login credentials/.test(document.getElementById('auth-message').textContent));
  assert.equal(await page.isVisible('#account-modal'), true);

  await page.fill('#auth-password', 'cobol-forever-1');
  await page.click('#auth-panel-submit-btn');
  await page.waitForFunction(() => document.getElementById('sign-in-btn').textContent.trim() === 'grace@example.com');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('sign-in-btn').textContent.trim() === 'grace@example.com');
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('auth: forgot password -> reset email -> recovery link -> new password works, old one does not', { skip, timeout: 60000 }, async () => {
  const alan = backend.createUser({ email: 'alan@example.com', password: 'enigma-0000' });
  const page = await openPage(browser, app.base);
  await ready(page);
  await page.click('#sign-in-btn');
  await page.click('#auth-forgot-link');
  await page.waitForSelector('#forgot-step-request:not([hidden])');
  await page.fill('#forgot-email', 'alan@example.com');
  await page.click('#forgot-request-submit-btn');
  await page.waitForFunction(() => /Check your email/.test(document.getElementById('forgot-request-message').textContent));
  assert.equal(backend.mail.filter(m => m.to === 'alan@example.com' && m.kind === 'reset').length, 1);
  await page.evaluate(() => closeAccountModal());

  // Clicking the emailed link: supabase-js signs the user into a recovery
  // session and fires PASSWORD_RECOVERY.
  const session = backend.issueSession(alan);
  await page.evaluate(s => sb.__emitAuthEvent('PASSWORD_RECOVERY', s), session);
  await page.waitForSelector('#forgot-step-reset:not([hidden])');
  await page.fill('#forgot-new-password', 'short');
  await page.click('#forgot-step-reset button[type="submit"]');
  assert.match(await page.textContent('#forgot-reset-message'), /at least 8/);
  await page.fill('#forgot-new-password', 'bombe-1940-x');
  await page.click('#forgot-step-reset button[type="submit"]');
  await page.waitForFunction(() => /Password updated/.test(document.getElementById('forgot-reset-message').textContent));
  assert.equal(backend.users.find(u => u.id === alan.id).password, 'bombe-1940-x');
  assert.equal(backend.auth('signInWithPassword', { email: 'alan@example.com', password: 'enigma-0000' }).error.message, 'Invalid login credentials');
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('data submission: upload a CSV, query it, see a SQL error, reject a non-data file', { skip, timeout: 60000 }, async () => {
  const page = await openPage(browser, app.base, { signedOut: true });
  await ready(page);

  // Wrong file type from the home drop zone path.
  await page.evaluate(() => uploadFromHome([new File(['x'], 'photo.png', { type: 'image/png' })]));
  assert.match(await page.textContent('#home-upload-message'), /reads \.csv, \.json/);

  await upload(page, 'people.csv', PEOPLE_CSV);
  await page.waitForSelector('#app-view:not([hidden])');
  assert.match(await page.textContent('#file-info'), /3 rows/);

  await runQuery(page, "SELECT name FROM people WHERE city = 'New York, NY'");
  assert.match(squash(await page.textContent('#results')), /Grace/);

  await runQuery(page, 'SELEC oops');
  assert.match(await page.textContent('#error'), /syntax error/);

  // Ctrl/Cmd+Enter runs the query too.
  await page.fill('#query-input', 'SELECT COUNT(*) AS total FROM people');
  await page.focus('#query-input');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => /\b3\b/.test(document.getElementById('results').textContent));
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('data submission: a JSON file with nested objects becomes a queryable table', { skip, timeout: 60000 }, async () => {
  const page = await openPage(browser, app.base, { signedOut: true });
  await ready(page);
  await upload(page, 'users.json', JSON.stringify([{ id: 1, profile: { country: 'UK' } }, { id: 2, profile: { country: 'US' } }]), 'application/json');
  await page.waitForSelector('#app-view:not([hidden])');
  await runQuery(page, 'SELECT "profile.country" FROM users ORDER BY id');
  assert.match(squash(await page.textContent('#results')), /UK.*US/);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('cloud save -> reload -> reopen -> delete removes rows AND files; other users never see it', { skip, timeout: 90000 }, async () => {
  const page = await openPage(browser, app.base);
  await ready(page);
  await signUpViaUi(page, 'owner@example.com');
  const owner = backend.users.find(u => u.email === 'owner@example.com');

  await upload(page, 'people.csv', PEOPLE_CSV);
  await page.waitForSelector('#save-csv-btn:not([hidden])');
  await page.click('#save-csv-btn');
  await page.waitForFunction(() => currentWorkspaceId);
  const [ws] = backend.rows('workspaces');
  assert.equal(ws.user_id, owner.id);
  assert.deepEqual(backend.rows('datasets').map(d => d.table_name), ['people']);
  const storedPath = `${owner.id}/${ws.id}/people.csv`;
  assert.match(backend.storage.csvs[storedPath].body, /Grace,85,"New York, NY"/, 'uploaded CSV round-trips quoting');

  // A second user sees an empty home, not the owner's workspace.
  const intruder = await openPage(browser, app.base);
  await ready(intruder);
  await signUpViaUi(intruder, 'intruder@example.com');
  await intruder.waitForFunction(() => !document.querySelector('#dashboard-body .ws-skeleton'));
  assert.equal(await intruder.locator('.workspace-card').count(), 0);
  await intruder.context().close();

  // Reload: the workspace is listed and reopens with its data.
  await page.reload();
  await page.waitForSelector(`.workspace-card[data-workspace="${ws.id}"]`);
  await page.click(`.workspace-card[data-workspace="${ws.id}"] .workspace-open-btn`);
  await page.waitForSelector('#app-view:not([hidden])');
  await page.waitForFunction(() => tables.length === 1);
  await runQuery(page, 'SELECT COUNT(*) FROM people');
  assert.match(squash(await page.textContent('#results')), /\b3\b/);

  // Delete from the home dashboard (with confirmation).
  await page.click('#dashboard-nav-btn');
  await page.waitForSelector(`.workspace-card[data-workspace="${ws.id}"]`);
  await page.click(`.workspace-card[data-workspace="${ws.id}"] .workspace-delete-btn`);
  await page.waitForSelector('#delete-workspace-modal:not([hidden])');
  assert.match(await page.textContent('#delete-workspace-name'), /people\.csv/);
  await page.click('#delete-workspace-modal .modal-confirm-delete-btn');
  await page.waitForSelector(`.workspace-card[data-workspace="${ws.id}"]`, { state: 'detached' });
  assert.equal(backend.rows('workspaces').length, 0);
  assert.equal(backend.rows('datasets').length, 0, 'cascade');
  assert.equal(Object.keys(backend.storage.csvs).length, 0, 'no orphaned files in Storage');
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('AI assistant: signed-in question -> /api/chat -> Groq -> "Use Query" -> results', { skip, timeout: 60000 }, async () => {
  const page = await openPage(browser, app.base);
  await ready(page);
  await signUpViaUi(page, 'asker@example.com');
  await upload(page, 'people.csv', PEOPLE_CSV);
  await page.waitForSelector('#app-view:not([hidden])');
  await page.click('label.toggle-switch:has(#ai-toggle)');
  await page.waitForFunction(() => !document.getElementById('chat-input').disabled);
  await page.fill('#chat-input', 'count the people');
  await page.waitForFunction(() => !document.getElementById('chat-send').disabled);
  await page.click('#chat-send');
  await page.waitForSelector('#chat-messages .use-query-btn');

  const sent = groq.calls.at(-1);
  assert.equal(sent.messages.at(-1).content, 'count the people');
  assert.match(sent.messages[0].content, /people/, 'schema is in the system prompt');
  assert.doesNotMatch(JSON.stringify(sent), /Wilmslow/, 'row data is never sent to the AI');
  assert.equal(backend.rows('ai_usage_events').length, 1, 'metered');

  await page.click('#chat-messages .use-query-btn');
  assert.equal(await page.inputValue('#query-input'), 'SELECT COUNT(*) AS n FROM people;');
  await page.click('.run-btn');
  await page.waitForFunction(() => /\b3\b/.test(document.getElementById('results').textContent));
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('AI assistant: signed-out visitors cannot call /api/chat', { skip, timeout: 30000 }, async () => {
  const res = await fetch(`${app.base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
  assert.equal(res.status, 401);
});

test('payments: browser session -> /api/create-checkout-session -> signed webhook -> Premium shows in Settings', { skip, timeout: 60000 }, async (t) => {
  silenceConsole(t);
  const page = await openPage(browser, app.base);
  await ready(page);
  await signUpViaUi(page, 'payer@example.com');
  const payer = backend.users.find(u => u.email === 'payer@example.com');

  // The embedded Stripe form is switched off in production
  // (checkout.js: ALL_TIERS_UNLOCKED), so the purchase is driven through the
  // same HTTP calls the form makes, with the browser's real session token.
  const token = await page.evaluate(async () => (await sb.auth.getSession()).data.session.access_token);
  const res = await fetch(`${app.base}/api/create-checkout-session`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).client_secret);

  const forged = signedStripeEvent('checkout.session.completed', { id: 'cs_x', client_reference_id: payer.id }, { secret: 'whsec_wrong' });
  assert.equal((await fetch(`${app.base}/api/stripe-webhook`, { method: 'POST', headers: { 'stripe-signature': forged.header, 'content-type': 'application/json' }, body: forged.payload })).status, 400);
  assert.equal(backend.rows('profiles').filter(p => p.is_premium).length, 0, 'a forged webhook grants nothing');

  const real = signedStripeEvent('checkout.session.completed', { id: 'cs_real', client_reference_id: payer.id });
  const wh = await fetch(`${app.base}/api/stripe-webhook`, { method: 'POST', headers: { 'stripe-signature': real.header, 'content-type': 'application/json' }, body: real.payload });
  assert.equal(wh.status, 200);
  assert.equal(backend.rows('profiles').find(p => p.id === payer.id).is_premium, true);

  await page.reload();
  await page.waitForFunction(() => document.getElementById('sign-in-btn').textContent.trim() === 'payer@example.com');
  await page.waitForFunction(() => isPremium === true);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

test('mobile (390px): the home page has no sideways scroll', { skip, timeout: 60000 }, async () => {
  const page = await openPage(browser, app.base, { viewport: { width: 390, height: 844 }, signedOut: true });
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `home scrolls sideways by ${overflow}px`);
  assert.deepEqual(page.__errors, []);
  await page.context().close();
});

// Found by this suite: once a file is loaded, the header gains a
// "Workspaces" button and the row (Learn, BI, Workspaces, Sign in) is 91px
// wider than a 390px phone, pushing "Sign in" off-screen.
test.todo('KNOWN BUG: mobile (390px): the workspace header fits the screen (Sign in button is reachable)', async () => {
  const page = await openPage(browser, app.base, { viewport: { width: 390, height: 844 }, signedOut: true });
  try {
    await ready(page);
    await upload(page, 'people.csv', PEOPLE_CSV);
    await page.waitForSelector('#app-view:not([hidden])');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `workspace scrolls sideways by ${overflow}px`);
    const box = await page.locator('#sign-in-btn').boundingBox();
    assert.ok(box.x + box.width <= 390, 'Sign in button is on screen');
  } finally {
    await page.context().close();
  }
});
