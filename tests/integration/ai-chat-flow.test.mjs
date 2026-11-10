// Integration: sign-in -> AI chat -> metering -> limits -> org admin
// controls, through the real handlers (chat.js, enterprise/admin.js,
// stripe-webhook.js), the real auth and rate-limit helpers, and one
// shared in-memory database. Only Groq (fetch) is stubbed.

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, signedInUser, backend, signedStripeEvent, silenceConsole } from '../helpers/api-harness.mjs';

installApiMocks(mock);

let chat; let admin; let webhook;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  resetAll();
  chat = (await importFresh('api/chat.js')).default;
  admin = (await importFresh('api/enterprise/admin.js')).default;
  webhook = (await importFresh('api/stripe-webhook.js')).default;
  globalThis.fetch = async () => new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 });
});
afterEach(() => { globalThis.fetch = realFetch; });

const ask = (who) => call(chat, { headers: who.headers, body: { messages: [{ role: 'user', content: 'hi' }] } });

test('a user can send 15 messages in a burst; the 16th is throttled; others are unaffected', async () => {
  const ada = signedInUser('ada@example.com');
  const bob = signedInUser('bob@example.com');
  for (let i = 0; i < 15; i++) assert.equal((await ask(ada)).statusCode, 200, `message ${i + 1}`);
  assert.equal((await ask(ada)).statusCode, 429);
  assert.equal((await ask(bob)).statusCode, 200);
});

test('a signed-out token (after sign-out) can no longer reach the AI', async () => {
  const ada = signedInUser('ada@example.com');
  assert.equal((await ask(ada)).statusCode, 200);
  backend.auth('signOut', { access_token: ada.token });
  assert.equal((await ask(ada)).statusCode, 401);
});

test('buying Premium (webhook) lifts the daily cap from 60 to 300', async (t) => {
  silenceConsole(t);
  const ada = signedInUser('ada@example.com');
  const yesterdayish = new Date(Date.now() - 3 * 3600e3).toISOString();
  backend.seed('ai_usage_events', Array.from({ length: 60 }, () => ({ user_id: ada.user.id, created_at: yesterdayish })));
  assert.equal((await ask(ada)).statusCode, 429, 'free cap reached');

  const { payload, header } = signedStripeEvent('checkout.session.completed', { id: 'cs_1', client_reference_id: ada.user.id });
  assert.equal((await call(webhook, { headers: { 'stripe-signature': header }, rawBody: payload })).statusCode, 200);
  assert.equal((await ask(ada)).statusCode, 200, 'premium cap applies');
});

test('an org admin turning AI off blocks every member immediately, and turning it on restores it', async () => {
  const boss = signedInUser('boss@acme.edu');
  const kid = signedInUser('kid@acme.edu');
  backend.seed('organizations', [{ id: 'o1', domain: 'acme.edu', ai_enabled: true }]);
  backend.seed('org_members', [{ org_id: 'o1', user_id: boss.user.id, role: 'admin' }, { org_id: 'o1', user_id: kid.user.id, role: 'member' }]);
  backend.seed('profiles', [{ id: boss.user.id, org_id: 'o1', is_premium: true }, { id: kid.user.id, org_id: 'o1', is_premium: true }]);

  assert.equal((await ask(kid)).statusCode, 200);
  assert.equal((await call(admin, { headers: kid.headers, body: { op: 'toggle_ai', enabled: false } })).statusCode, 403, 'members cannot flip it');
  assert.equal((await call(admin, { headers: boss.headers, body: { op: 'toggle_ai', enabled: false } })).statusCode, 200);
  const blocked = await ask(kid);
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.body.error.message, /disabled by your organization admin/);
  assert.equal((await ask(boss)).statusCode, 429, 'admins are members too');
  await call(admin, { headers: boss.headers, body: { op: 'toggle_ai', enabled: true } });
  assert.equal((await ask(kid)).statusCode, 200);
});
