// Unit tests for api/stripe-webhook.js: signature verification, personal
// Premium fulfilment, Enterprise org creation (with idempotency), renewal
// bookkeeping and teardown. Signatures are produced and verified with the
// real Stripe library; only Supabase and the Stripe API calls are faked.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, backend, stripeState, signedStripeEvent, silenceConsole } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let handler;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/stripe-webhook.js'));
});

async function deliver(type, object, opts) {
  const { payload, header } = signedStripeEvent(type, object, opts);
  return call(handler, { headers: { 'stripe-signature': header }, rawBody: payload });
}

const unix = d => Math.floor(new Date(d).getTime() / 1000);

test('exports bodyParser:false so the raw body reaches signature verification', async () => {
  const mod = await importFresh('api/stripe-webhook.js');
  assert.deepEqual(mod.config, { api: { bodyParser: false } });
});

test('rejects non-POST with 405', async () => {
  assert.equal((await call(handler, { method: 'GET' })).statusCode, 405);
});

test('refuses to process anything when STRIPE_WEBHOOK_SECRET is missing (500, no DB writes)', async (t) => {
  silenceConsole(t);
  resetAll({ STRIPE_WEBHOOK_SECRET: undefined });
  ({ default: handler } = await importFresh('api/stripe-webhook.js'));
  const res = await deliver('checkout.session.completed', { id: 'cs_1', client_reference_id: 'u1' });
  assert.equal(res.statusCode, 500);
  assert.equal(backend.rows('profiles').length, 0);
});

test('rejects a forged event (wrong signing secret) with 400 and grants nothing', async (t) => {
  silenceConsole(t);
  const res = await deliver('checkout.session.completed', { id: 'cs_1', client_reference_id: 'u1' }, { secret: 'whsec_attacker' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /Webhook Error/);
  assert.equal(backend.rows('profiles').length, 0);
});

test('rejects a missing signature header with 400', async (t) => {
  silenceConsole(t);
  const res = await call(handler, { rawBody: JSON.stringify({ type: 'checkout.session.completed' }) });
  assert.equal(res.statusCode, 400);
});

test('rejects a tampered body (valid header for a different payload)', async (t) => {
  silenceConsole(t);
  const { header } = signedStripeEvent('checkout.session.completed', { id: 'cs_1', client_reference_id: 'u1' });
  const tampered = JSON.stringify({ id: 'evt', type: 'checkout.session.completed', data: { object: { id: 'cs_1', client_reference_id: 'attacker' } } });
  const res = await call(handler, { headers: { 'stripe-signature': header }, rawBody: tampered });
  assert.equal(res.statusCode, 400);
  assert.equal(backend.rows('profiles').length, 0);
});

test('personal checkout.session.completed grants Premium to client_reference_id', async (t) => {
  silenceConsole(t);
  const res = await deliver('checkout.session.completed', { id: 'cs_9', client_reference_id: 'u1', customer: 'cus_1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  const [p] = backend.rows('profiles');
  assert.equal(p.id, 'u1');
  assert.equal(p.is_premium, true);
  assert.equal(p.stripe_checkout_session_id, 'cs_9');
});

test('personal checkout upgrades an existing profile in place (upsert, no duplicate)', async (t) => {
  silenceConsole(t);
  backend.seed('profiles', [{ id: 'u1', is_premium: false }]);
  await deliver('checkout.session.completed', { id: 'cs_9', client_reference_id: 'u1' });
  const rows = backend.rows('profiles');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_premium, true);
});

test('redelivery of the same personal event is harmless', async (t) => {
  silenceConsole(t);
  await deliver('checkout.session.completed', { id: 'cs_9', client_reference_id: 'u1' });
  await deliver('checkout.session.completed', { id: 'cs_9', client_reference_id: 'u1' });
  assert.equal(backend.rows('profiles').length, 1);
});

test('checkout without client_reference_id grants nothing but still acks 200', async (t) => {
  const logs = silenceConsole(t);
  const res = await deliver('checkout.session.completed', { id: 'cs_9' });
  assert.equal(res.statusCode, 200);
  assert.equal(backend.rows('profiles').length, 0);
  assert.ok(logs.some(([lvl, m]) => lvl === 'error' && /no client_reference_id/.test(m)));
});

test('a database error while granting is logged and acked (no 500 retry storm)', async (t) => {
  const logs = silenceConsole(t);
  backend.failNext('profiles', 'upsert', 'connection reset');
  const res = await deliver('checkout.session.completed', { id: 'cs_9', client_reference_id: 'u1' });
  assert.equal(res.statusCode, 200);
  assert.ok(logs.some(([, m]) => /Failed to grant premium/.test(m)));
});

function seedPendingOrg() {
  backend.seed('pending_organizations', [{ id: 'po1', domain: 'acme.edu', admin_user_id: 'admin1', status: 'pending' }]);
  stripeState.subscriptions.sub_1 = { id: 'sub_1', items: { data: [{ current_period_end: unix('2027-11-01T00:00:00Z') }] } };
}

test('enterprise checkout creates the org, the admin membership, admin Premium, and fulfils the pending row', async (t) => {
  silenceConsole(t);
  seedPendingOrg();
  const res = await deliver('checkout.session.completed', {
    id: 'cs_ent', client_reference_id: 'po1', customer: 'cus_ent', subscription: 'sub_1', metadata: { type: 'enterprise', domain: 'acme.edu' },
  });
  assert.equal(res.statusCode, 200);
  const [org] = backend.rows('organizations');
  assert.equal(org.domain, 'acme.edu');
  assert.equal(org.stripe_customer_id, 'cus_ent');
  assert.equal(org.stripe_subscription_id, 'sub_1');
  assert.equal(new Date(org.current_period_end).toISOString(), '2027-11-01T00:00:00.000Z', 'reads per-item current_period_end');
  assert.deepEqual(backend.rows('org_members').map(m => [m.org_id, m.user_id, m.role]), [[org.id, 'admin1', 'admin']]);
  const [p] = backend.rows('profiles');
  assert.equal(p.is_premium, true);
  assert.equal(p.premium_via, 'org');
  assert.equal(p.org_id, org.id);
  assert.equal(backend.rows('pending_organizations')[0].status, 'fulfilled');
});

test('enterprise checkout reads a top-level current_period_end (older API shape)', async (t) => {
  silenceConsole(t);
  seedPendingOrg();
  stripeState.subscriptions.sub_1 = { id: 'sub_1', current_period_end: unix('2027-05-05T00:00:00Z') };
  await deliver('checkout.session.completed', { id: 'cs', client_reference_id: 'po1', subscription: 'sub_1', metadata: { type: 'enterprise' } });
  assert.equal(new Date(backend.rows('organizations')[0].current_period_end).toISOString(), '2027-05-05T00:00:00.000Z');
});

test('enterprise redelivery is idempotent: a fulfilled pending row creates no second org', async (t) => {
  silenceConsole(t);
  seedPendingOrg();
  const obj = { id: 'cs_ent', client_reference_id: 'po1', subscription: 'sub_1', metadata: { type: 'enterprise' } };
  await deliver('checkout.session.completed', obj);
  await deliver('checkout.session.completed', obj);
  assert.equal(backend.rows('organizations').length, 1);
  assert.equal(backend.rows('org_members').length, 1);
});

test('enterprise checkout for an unknown pending row does nothing', async (t) => {
  silenceConsole(t);
  await deliver('checkout.session.completed', { id: 'cs', client_reference_id: 'nope', metadata: { type: 'enterprise' } });
  assert.equal(backend.rows('organizations').length, 0);
});

test('enterprise checkout without client_reference_id does nothing', async (t) => {
  silenceConsole(t);
  seedPendingOrg();
  await deliver('checkout.session.completed', { id: 'cs', metadata: { type: 'enterprise' } });
  assert.equal(backend.rows('organizations').length, 0);
});

test('enterprise checkout still creates the org if the subscription lookup fails (null period end)', async (t) => {
  silenceConsole(t);
  seedPendingOrg();
  stripeState.failNext('subscriptions.retrieve', 'Stripe down');
  await deliver('checkout.session.completed', { id: 'cs', client_reference_id: 'po1', subscription: 'sub_1', metadata: { type: 'enterprise' } });
  const [org] = backend.rows('organizations');
  assert.equal(org.stripe_subscription_id, null);
  assert.equal(org.current_period_end, null);
});

test('enterprise: if the org insert fails, no membership or Premium is granted and the pending row stays pending', async (t) => {
  silenceConsole(t);
  seedPendingOrg();
  backend.failNext('organizations', 'insert', 'boom');
  await deliver('checkout.session.completed', { id: 'cs', client_reference_id: 'po1', subscription: 'sub_1', metadata: { type: 'enterprise' } });
  assert.equal(backend.rows('org_members').length, 0);
  assert.equal(backend.rows('profiles').length, 0);
  assert.equal(backend.rows('pending_organizations')[0].status, 'pending');
});

test('enterprise: a domain that already has an org (unique violation) is not double-created', async (t) => {
  silenceConsole(t);
  seedPendingOrg();
  backend.seed('organizations', [{ id: 'existing', domain: 'acme.edu' }]);
  await deliver('checkout.session.completed', { id: 'cs', client_reference_id: 'po1', subscription: 'sub_1', metadata: { type: 'enterprise' } });
  assert.equal(backend.rows('organizations').length, 1);
  assert.equal(backend.rows('pending_organizations')[0].status, 'pending');
});

test('subscription.updated with a later period end resets the three renewal notices', async (t) => {
  silenceConsole(t);
  backend.seed('organizations', [{ id: 'o1', domain: 'acme.edu', stripe_subscription_id: 'sub_1', current_period_end: '2026-11-01T00:00:00.000Z', notice_3mo_sent_at: 'x', notice_1mo_sent_at: 'y', notice_1wk_sent_at: 'z' }]);
  await deliver('customer.subscription.updated', { id: 'sub_1', cancel_at_period_end: false, items: { data: [{ current_period_end: unix('2027-11-01T00:00:00Z') }] } });
  const [org] = backend.rows('organizations');
  assert.equal(new Date(org.current_period_end).toISOString(), '2027-11-01T00:00:00.000Z');
  assert.equal(org.notice_3mo_sent_at, null);
  assert.equal(org.notice_1mo_sent_at, null);
  assert.equal(org.notice_1wk_sent_at, null);
});

test('subscription.updated without a renewal (auto-renew toggled off) keeps notices and records cancel_at_period_end', async (t) => {
  silenceConsole(t);
  backend.seed('organizations', [{ id: 'o1', domain: 'acme.edu', stripe_subscription_id: 'sub_1', current_period_end: '2027-11-01T00:00:00.000Z', notice_3mo_sent_at: 'x' }]);
  await deliver('customer.subscription.updated', { id: 'sub_1', cancel_at_period_end: true, items: { data: [{ current_period_end: unix('2027-11-01T00:00:00Z') }] } });
  const [org] = backend.rows('organizations');
  assert.equal(org.cancel_at_period_end, true);
  assert.equal(org.notice_3mo_sent_at, 'x');
});

test('subscription.updated for a non-Enterprise subscription is a no-op', async (t) => {
  silenceConsole(t);
  const res = await deliver('customer.subscription.updated', { id: 'sub_unknown', cancel_at_period_end: true });
  assert.equal(res.statusCode, 200);
  assert.equal(backend.log.filter(q => q.action === 'update').length, 0);
});

function seedLiveOrg() {
  backend.seed('organizations', [{ id: 'o1', domain: 'acme.edu', stripe_subscription_id: 'sub_1' }, { id: 'o2', domain: 'other.edu', stripe_subscription_id: 'sub_2' }]);
  backend.seed('org_members', [{ org_id: 'o1', user_id: 'a', role: 'admin' }, { org_id: 'o1', user_id: 'b', role: 'member' }, { org_id: 'o2', user_id: 'c', role: 'admin' }]);
  backend.seed('org_join_links', [{ org_id: 'o1', token: 't1' }]);
  backend.seed('profiles', [
    { id: 'a', is_premium: true, premium_via: 'org', org_id: 'o1' },
    { id: 'b', is_premium: true, premium_via: 'org', org_id: 'o1' },
    { id: 'c', is_premium: true, premium_via: 'org', org_id: 'o2' },
    { id: 'd', is_premium: true, premium_via: 'purchase' },
  ]);
}

test('subscription.deleted revokes org Premium, deletes the org and cascades members/join links', async (t) => {
  silenceConsole(t);
  seedLiveOrg();
  await deliver('customer.subscription.deleted', { id: 'sub_1' });
  assert.deepEqual(backend.rows('organizations').map(o => o.id), ['o2']);
  assert.deepEqual(backend.rows('org_members').map(m => m.user_id), ['c']);
  assert.equal(backend.rows('org_join_links').length, 0);
  const p = Object.fromEntries(backend.rows('profiles').map(r => [r.id, r]));
  assert.equal(p.a.is_premium, false);
  assert.equal(p.a.org_id, null);
  assert.equal(p.b.is_premium, false);
  assert.equal(p.c.is_premium, true, 'other orgs untouched');
  assert.equal(p.d.is_premium, true, 'personal purchasers untouched');
});

test('subscription.deleted keeps the org if revoking Premium fails (no half-teardown)', async (t) => {
  silenceConsole(t);
  seedLiveOrg();
  backend.failNext('profiles', 'update', 'timeout');
  await deliver('customer.subscription.deleted', { id: 'sub_1' });
  assert.equal(backend.rows('organizations').length, 2);
});

test('subscription.deleted for an already-removed org is a no-op 200', async (t) => {
  silenceConsole(t);
  assert.equal((await deliver('customer.subscription.deleted', { id: 'sub_gone' })).statusCode, 200);
});

test('invoice.paid / invoice.payment_failed / unknown events are acknowledged without writes', async (t) => {
  silenceConsole(t);
  for (const type of ['invoice.paid', 'invoice.payment_failed', 'charge.refunded']) {
    const res = await deliver(type, { id: 'in_1', customer: 'cus_1' });
    assert.equal(res.statusCode, 200, type);
  }
  assert.equal(backend.log.length, 0);
});

test('without Supabase configured, a valid event is acked but nothing is granted', async (t) => {
  silenceConsole(t);
  resetAll({ SUPABASE_SERVICE_ROLE_KEY: undefined });
  ({ default: handler } = await importFresh('api/stripe-webhook.js'));
  const res = await deliver('checkout.session.completed', { id: 'cs', client_reference_id: 'u1' });
  assert.equal(res.statusCode, 200);
  assert.equal(backend.log.length, 0);
});
