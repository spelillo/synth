// Unit tests for api/_supabaseAuth.js: the only thing standing between an
// API route and a client-supplied user id.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, mockReq, backend, signedInUser } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let getVerifiedUserId;
beforeEach(async () => {
  resetAll();
  ({ getVerifiedUserId } = await importFresh('api/_supabaseAuth.js'));
});

test('returns the user id for a valid Bearer token', async () => {
  const { user, headers } = signedInUser();
  assert.equal(await getVerifiedUserId(mockReq({ headers })), user.id);
});

test('returns null when there is no Authorization header', async () => {
  assert.equal(await getVerifiedUserId(mockReq()), null);
});

test('returns null for a non-Bearer scheme (Basic auth)', async () => {
  signedInUser();
  assert.equal(await getVerifiedUserId(mockReq({ headers: { authorization: 'Basic dXNlcjpwYXNz' } })), null);
});

test('returns null for "Bearer " with an empty token', async () => {
  assert.equal(await getVerifiedUserId(mockReq({ headers: { authorization: 'Bearer ' } })), null);
});

test('returns null for a token Supabase rejects (forged / expired)', async () => {
  signedInUser();
  assert.equal(await getVerifiedUserId(mockReq({ headers: { authorization: 'Bearer forged.jwt.token' } })), null);
});

test('is case-sensitive about the scheme, matching the implementation ("bearer" is refused)', async () => {
  const { token } = signedInUser();
  assert.equal(await getVerifiedUserId(mockReq({ headers: { authorization: `bearer ${token}` } })), null);
});

test('returns null (never throws) when Supabase env vars are missing', async () => {
  resetAll({ SUPABASE_URL: undefined });
  ({ getVerifiedUserId } = await importFresh('api/_supabaseAuth.js'));
  const { headers } = signedInUser();
  assert.equal(await getVerifiedUserId(mockReq({ headers })), null);
});

test('returns null when Supabase Auth itself errors', async () => {
  const { headers } = signedInUser();
  backend.failNext('auth', 'getUser', 'upstream 503');
  assert.equal(await getVerifiedUserId(mockReq({ headers })), null);
});

test('ignores a user id smuggled in the body', async () => {
  const { user, headers } = signedInUser();
  const req = mockReq({ headers, body: { user_id: 'someone-else' } });
  assert.equal(await getVerifiedUserId(req), user.id);
});
