// Unit tests for api/create-checkout-session.js (personal Premium, $9.99
// one-time). The critical property: the Stripe session is tied to the
// *verified* user, never a client-supplied id.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, signedInUser, stripeState } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let handler;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/create-checkout-session.js'));
});

test('rejects non-POST with 405', async () => {
  assert.equal((await call(handler, { method: 'GET' })).statusCode, 405);
});

test('returns 500 when STRIPE_SECRET_KEY is missing', async () => {
  resetAll({ STRIPE_SECRET_KEY: undefined });
  ({ default: handler } = await importFresh('api/create-checkout-session.js'));
  const { headers } = signedInUser();
  const res = await call(handler, { headers });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error.message, /STRIPE_SECRET_KEY/);
});

test('returns 401 for anonymous callers and creates no Stripe session', async () => {
  const res = await call(handler, {});
  assert.equal(res.statusCode, 401);
  assert.equal(stripeState.calls.length, 0);
});

test('creates a one-time payment session for the verified user', async () => {
  const { user, headers } = signedInUser();
  const res = await call(handler, { headers, body: { client_reference_id: 'attacker-id' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.client_secret, /^cs_test_\d+_secret/);
  const { method, args } = stripeState.calls[0];
  assert.equal(method, 'checkout.sessions.create');
  assert.equal(args.mode, 'payment');
  assert.equal(args.client_reference_id, user.id, 'body-supplied id is ignored');
  assert.deepEqual(args.line_items, [{ price: 'price_1UGhnpRsooZUyqKON1Pm4aXY', quantity: 1 }]);
});

test('return_url is built from the request host and protocol', async () => {
  const { headers } = signedInUser();
  await call(handler, { headers: { ...headers, host: 'preview.vercel.app', 'x-forwarded-proto': 'http' } });
  assert.equal(stripeState.calls[0].args.return_url, 'http://preview.vercel.app/?checkout=success');
});

test('return_url defaults to https', async () => {
  const { headers } = signedInUser();
  await call(handler, { headers });
  assert.match(stripeState.calls[0].args.return_url, /^https:\/\//);
});

test('a Stripe API error becomes a 500 with Stripe\'s message', async () => {
  const { headers } = signedInUser();
  stripeState.failNext('checkout.sessions.create', 'No such price');
  const res = await call(handler, { headers });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, 'No such price');
});

test('pins the Stripe API version the embedded form needs', async () => {
  assert.match(stripeState.instances.at(-1).options.apiVersion, /^2026-03-25\.dahlia/);
});
