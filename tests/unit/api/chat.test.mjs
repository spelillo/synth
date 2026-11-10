// Unit tests for api/chat.js, the Groq proxy. Groq itself is mocked by
// replacing global fetch.

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, signedInUser, backend } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let handler;
let fetchMock;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/chat.js'));
  fetchMock = mock.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'SELECT 1' } }] }), { status: 200 }));
  globalThis.fetch = fetchMock;
});
afterEach(() => { globalThis.fetch = realFetch; });

const body = { model: 'llama', messages: [{ role: 'user', content: 'hi' }] };

test('rejects non-POST with 405', async () => {
  const res = await call(handler, { method: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('rejects anonymous callers with 401 and never calls Groq', async () => {
  const res = await call(handler, { body });
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error.message, /Sign in required/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('returns 429 with the limiter message when rate-limited', async () => {
  const { user, headers } = signedInUser();
  const at = new Date().toISOString();
  backend.seed('ai_usage_events', Array.from({ length: 15 }, () => ({ user_id: user.id, created_at: at })));
  const res = await call(handler, { headers, body });
  assert.equal(res.statusCode, 429);
  assert.match(res.body.error.message, /faster than the assistant/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('returns 400 when messages is missing or not an array', async () => {
  const { headers } = signedInUser();
  for (const bad of [undefined, {}, { messages: 'hi' }, { messages: null }]) {
    const res = await call(handler, { headers, body: bad });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
  }
});

test('returns 500 when GROQ_API_KEY is not configured', async () => {
  resetAll({ GROQ_API_KEY: undefined });
  ({ default: handler } = await importFresh('api/chat.js'));
  const { headers } = signedInUser();
  const res = await call(handler, { headers, body });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error.message, /GROQ_API_KEY/);
});

test('forwards the body to Groq with the server key and relays the reply', async () => {
  const { headers } = signedInUser();
  const res = await call(handler, { headers, body });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body), { choices: [{ message: { content: 'SELECT 1' } }] });
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer gsk_test');
  assert.deepEqual(JSON.parse(init.body), body);
});

test('the user\'s Supabase token is never forwarded to Groq', async () => {
  const { headers, token } = signedInUser();
  await call(handler, { headers, body });
  const [, init] = fetchMock.mock.calls[0].arguments;
  assert.ok(!JSON.stringify(init).includes(token));
});

test('relays Groq error statuses unchanged (e.g. 429 from Groq)', async () => {
  globalThis.fetch = async () => new Response('{"error":{"message":"rate limited upstream"}}', { status: 429 });
  const { headers } = signedInUser();
  const res = await call(handler, { headers, body });
  assert.equal(res.statusCode, 429);
  assert.match(res.body, /rate limited upstream/);
});

test('a network failure reaching Groq becomes a 500 with the error message', async () => {
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  const { headers } = signedInUser();
  const res = await call(handler, { headers, body });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.message, 'ECONNRESET');
});

test('every allowed request is metered (one ai_usage_events row each)', async () => {
  const { user, headers } = signedInUser();
  await call(handler, { headers, body });
  await call(handler, { headers, body });
  assert.equal(backend.rows('ai_usage_events').filter(e => e.user_id === user.id).length, 2);
});
