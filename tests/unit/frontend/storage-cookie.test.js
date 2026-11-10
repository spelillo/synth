// Unit tests for storage-cookie.js: the cookie-backed Supabase session
// store that is shared across synth-sql.com subdomains.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('../../helpers/browser-env');

function store(url = 'https://synth-sql.com/') {
  const env = loadBrowserScripts(['storage-cookie.js'], { url });
  return { env, s: env.window.sharedAuthStorage, cookies: () => env.document.cookie };
}

test('getItem returns null for a missing key', async () => {
  assert.equal(await store().s.getItem('sb-auth'), null);
});

test('a small value round-trips through one cookie, URL-encoded', async () => {
  const { s, cookies } = store();
  await s.setItem('sb-auth', '{"a":"b c;d"}');
  assert.equal(await s.getItem('sb-auth'), '{"a":"b c;d"}');
  assert.match(cookies(), /sb-auth=%7B/);
});

test('a large session (> 3600 encoded chars) is chunked and reassembled', async () => {
  const { s, cookies } = store();
  const big = JSON.stringify({ access_token: 'x'.repeat(5000), refresh_token: 'y'.repeat(3000) });
  await s.setItem('sb-auth', big);
  assert.match(cookies(), /sb-auth\.0=/);
  assert.match(cookies(), /sb-auth\.2=/);
  assert.equal(await s.getItem('sb-auth'), big);
});

test('shrinking from chunked to small clears the old chunks', async () => {
  const { s, cookies } = store();
  await s.setItem('sb-auth', 'z'.repeat(8000));
  await s.setItem('sb-auth', 'small');
  assert.doesNotMatch(cookies(), /sb-auth\.0=/);
  assert.equal(await s.getItem('sb-auth'), 'small');
});

test('removeItem clears plain and chunked values (sign-out leaves no session)', async () => {
  const { s, cookies } = store();
  await s.setItem('sb-auth', 'q'.repeat(8000));
  await s.removeItem('sb-auth');
  assert.equal(await s.getItem('sb-auth'), null);
  assert.doesNotMatch(cookies(), /sb-auth/);
});

test('keys do not collide (prefix of another key)', async () => {
  const { s } = store();
  await s.setItem('sb', 'one');
  await s.setItem('sb-auth', 'two');
  assert.equal(await s.getItem('sb'), 'one');
  assert.equal(await s.getItem('sb-auth'), 'two');
});

test('unicode values survive', async () => {
  const { s } = store();
  await s.setItem('k', 'café ✓ 日本');
  assert.equal(await s.getItem('k'), 'café ✓ 日本');
});

test('works on non-synth hosts (preview deploys) as a per-origin cookie', async () => {
  const { s } = store('https://synth-git-branch.vercel.app/');
  await s.setItem('k', 'v');
  assert.equal(await s.getItem('k'), 'v');
});
