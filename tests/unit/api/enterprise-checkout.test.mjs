// Unit tests for api/enterprise/create-checkout-session.js. Every guard
// here runs BEFORE money is taken, so each one is tested to stop the flow
// without creating a Stripe session.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, signedInUser, backend, stripeState } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let handler;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/enterprise/create-checkout-session.js'));
});

test('rejects non-POST with 405', async () => {
  assert.equal((await call(handler, { method: 'GET' })).statusCode, 405);
});

test('500 when the Enterprise price id is not configured', async () => {
  resetAll({ STRIPE_ENTERPRISE_PRICE_ID: undefined });
  ({ default: handler } = await importFresh('api/enterprise/create-checkout-session.js'));
  const { headers } = signedInUser('ada@acme.edu');
  assert.equal((await call(handler, { headers })).statusCode, 500);
});

test('401 for anonymous callers', async () => {
  assert.equal((await call(handler, {})).statusCode, 401);
});

test('409 when the caller already belongs to an org (no charge for an org they can\'t join)', async () => {
  const { user, headers } = signedInUser('ada@acme.edu');
  backend.seed('org_members', [{ org_id: 'o1', user_id: user.id, role: 'member' }]);
  const res = await call(handler, { headers });
  assert.equal(res.statusCode, 409);
  assert.equal(stripeState.calls.length, 0);
});

test('400 for a public email provider domain (gmail.com)', async () => {
  const { headers } = signedInUser('someone@gmail.com');
  const res = await call(handler, { headers });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /public email provider/);
  assert.equal(backend.rows('pending_organizations').length, 0);
});

test('409 when the domain already has an org', async () => {
  const { headers } = signedInUser('ada@acme.edu');
  backend.seed('organizations', [{ id: 'o1', domain: 'acme.edu' }]);
  const res = await call(handler, { headers });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error.message, /already has a Synth Enterprise organization/);
});

test('400 when the account email cannot be read back from Supabase Auth', async () => {
  const { headers } = signedInUser('ada@acme.edu');
  backend.failNext('auth', 'admin.getUserById', 'not found');
  assert.equal((await call(handler, { headers })).statusCode, 400);
});

test('happy path: creates a pending org and a yearly subscription session tagged enterprise', async () => {
  const { user, headers } = signedInUser('Ada@ACME.edu');
  const res = await call(handler, { headers: { ...headers, host: 'synth-sql.com' }, body: { domain: 'gmail.com' } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.client_secret);
  const [pending] = backend.rows('pending_organizations');
  assert.equal(pending.domain, 'acme.edu', 'domain comes from the verified email, not the body');
  assert.equal(pending.admin_user_id, user.id);
  const { args } = stripeState.calls[0];
  assert.equal(args.mode, 'subscription');
  assert.equal(args.client_reference_id, pending.id);
  assert.deepEqual(args.metadata, { type: 'enterprise', domain: 'acme.edu' });
  assert.deepEqual(args.line_items, [{ price: 'price_enterprise_test', quantity: 1 }]);
  assert.equal(args.return_url, 'https://synth-sql.com/enterprise?checkout=success');
  assert.equal(backend.rows('pending_organizations')[0].stripe_checkout_session_id, 'cs_test_1');
});

test('a Stripe failure returns 500 (the pending row is left for support to inspect)', async () => {
  const { headers } = signedInUser('ada@acme.edu');
  stripeState.failNext('checkout.sessions.create', 'card_declined');
  const res = await call(handler, { headers });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, 'card_declined');
});

test('a pending_organizations insert failure returns 500 before Stripe is called', async () => {
  const { headers } = signedInUser('ada@acme.edu');
  backend.failNext('pending_organizations', 'insert', 'db down');
  const res = await call(handler, { headers });
  assert.equal(res.statusCode, 500);
  assert.equal(stripeState.calls.length, 0);
});
