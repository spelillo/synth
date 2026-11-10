// Integration: money paths, end to end through the real handlers.
//   Personal:   create-checkout-session -> (Stripe) -> signed webhook -> profiles.is_premium
//   Enterprise: checkout -> webhook creates org -> join link -> members join
//               -> auto-renew off -> renewal notices -> subscription ends -> teardown

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, signedInUser, backend, stripeState, mailState, signedStripeEvent, silenceConsole } from '../helpers/api-harness.mjs';

installApiMocks(mock);

let h;
beforeEach(async () => {
  resetAll();
  h = {
    checkout: (await importFresh('api/create-checkout-session.js')).default,
    entCheckout: (await importFresh('api/enterprise/create-checkout-session.js')).default,
    webhook: (await importFresh('api/stripe-webhook.js')).default,
    admin: (await importFresh('api/enterprise/admin.js')).default,
    member: (await importFresh('api/enterprise/member-actions.js')).default,
    status: (await importFresh('api/enterprise/status.js')).default,
    renewals: (await importFresh('api/cron/enterprise-renewal-notices.js')).default,
  };
});

// What Stripe does after the customer pays: deliver the session it created,
// signed, to the webhook.
async function stripeCompletes(sessionArgs, extra = {}) {
  const obj = { id: `cs_${Math.random().toString(36).slice(2)}`, client_reference_id: sessionArgs.client_reference_id, metadata: sessionArgs.metadata, ...extra };
  const { payload, header } = signedStripeEvent('checkout.session.completed', obj);
  return call(h.webhook, { headers: { 'stripe-signature': header }, rawBody: payload });
}
async function stripeSends(type, object) {
  const { payload, header } = signedStripeEvent(type, object);
  return call(h.webhook, { headers: { 'stripe-signature': header }, rawBody: payload });
}

test('personal Premium: checkout session is bound to the signed-in user and the webhook upgrades exactly that user', async (t) => {
  silenceConsole(t);
  const ada = signedInUser('ada@example.com');
  const eve = signedInUser('eve@example.com');
  const res = await call(h.checkout, { headers: ada.headers, body: { client_reference_id: eve.user.id } });
  assert.equal(res.statusCode, 200);
  const session = stripeState.calls.at(-1).args;
  assert.equal((await stripeCompletes(session)).statusCode, 200);
  const profiles = Object.fromEntries(backend.rows('profiles').map(p => [p.id, p]));
  assert.equal(profiles[ada.user.id].is_premium, true);
  assert.equal(profiles[eve.user.id], undefined, 'nobody else is upgraded');
});

test('personal Premium: an unpaid (abandoned) checkout grants nothing', async () => {
  const ada = signedInUser('ada@example.com');
  await call(h.checkout, { headers: ada.headers });
  assert.equal(backend.rows('profiles').length, 0);
});

test('Enterprise: full lifecycle from purchase to teardown', async (t) => {
  silenceConsole(t);
  const boss = signedInUser('boss@acme.edu');

  // 1. Purchase
  const res = await call(h.entCheckout, { headers: boss.headers });
  assert.equal(res.statusCode, 200);
  const session = stripeState.calls.at(-1).args;
  const periodEnd = Math.floor((Date.now() + 80 * 86400e3) / 1000);
  stripeState.subscriptions.sub_acme = { id: 'sub_acme', items: { data: [{ current_period_end: periodEnd }] } };
  await stripeCompletes(session, { subscription: 'sub_acme', customer: 'cus_acme' });

  const status = await call(h.status, { method: 'GET', headers: boss.headers, query: { op: 'org_status' } });
  assert.equal(status.body.role, 'admin');
  assert.equal(status.body.org.domain, 'acme.edu');

  // 2. A second checkout for the same domain is refused before payment.
  const copycat = signedInUser('copy@acme.edu');
  assert.equal((await call(h.entCheckout, { headers: copycat.headers })).statusCode, 409);

  // 3. Join link -> a same-domain member joins; an outsider can't.
  const link = await call(h.admin, { headers: boss.headers, body: { op: 'create_join_link' } });
  const kid = signedInUser('kid@acme.edu');
  assert.equal((await call(h.member, { headers: kid.headers, body: { op: 'join', token: link.body.token } })).statusCode, 200);
  const outsider = signedInUser('x@gmail.com');
  assert.equal((await call(h.member, { headers: outsider.headers, body: { op: 'join', token: link.body.token } })).statusCode, 403);
  const roster = await call(h.status, { method: 'GET', headers: kid.headers, query: { op: 'org_roster' } });
  assert.deepEqual(roster.body.members.map(m => m.email).sort(), ['boss@acme.edu', 'kid@acme.edu']);

  // 4. Renewal notice cron emails the admin once.
  await call(h.renewals, { method: 'GET', headers: { authorization: 'Bearer cron-secret-test' } });
  await call(h.renewals, { method: 'GET', headers: { authorization: 'Bearer cron-secret-test' } });
  assert.equal(mailState.sent.length, 1);
  assert.equal(mailState.sent[0].to, 'boss@acme.edu');

  // 5. Admin turns off auto-renew -> Stripe updated -> webhook mirrors it.
  await call(h.admin, { headers: boss.headers, body: { op: 'toggle_auto_renew', enabled: false } });
  assert.deepEqual(stripeState.calls.at(-1), { method: 'subscriptions.update', args: { id: 'sub_acme', params: { cancel_at_period_end: true } } });
  await stripeSends('customer.subscription.updated', { id: 'sub_acme', cancel_at_period_end: true, items: { data: [{ current_period_end: periodEnd }] } });

  // 6. Period ends -> teardown.
  await stripeSends('customer.subscription.deleted', { id: 'sub_acme' });
  assert.equal(backend.rows('organizations').length, 0);
  assert.equal(backend.rows('org_members').length, 0);
  assert.ok(backend.rows('profiles').every(p => p.is_premium === false && p.org_id === null));
  assert.equal((await call(h.member, { headers: kid.headers, body: { op: 'join', token: link.body.token } })).statusCode, 404, 'old join links die with the org');

  // 7. The domain can be bought again.
  assert.equal((await call(h.entCheckout, { headers: copycat.headers })).statusCode, 200);
});

// Data-loss risk found while writing the lifecycle test: joining an org
// overwrites premium_via with 'org', so a member who had *bought* personal
// Premium before joining loses it when the org's subscription ends.
test.todo('KNOWN BUG: a personal Premium purchaser keeps Premium after their org is torn down', async (t) => {
  silenceConsole(t);
  const ada = signedInUser('ada@acme.edu');
  await call(h.checkout, { headers: ada.headers });
  await stripeCompletes(stripeState.calls.at(-1).args);
  backend.seed('organizations', [{ id: 'o1', domain: 'acme.edu', stripe_subscription_id: 'sub_1' }]);
  backend.seed('org_join_links', [{ org_id: 'o1', token: 'tok' }]);
  await call(h.member, { headers: ada.headers, body: { op: 'join', token: 'tok' } });
  await stripeSends('customer.subscription.deleted', { id: 'sub_1' });
  assert.equal(backend.rows('profiles')[0].is_premium, true);
});
