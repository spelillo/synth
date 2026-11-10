// Real-service test: Row Level Security on a REAL Supabase project.
//
// The in-memory database used by the other suites only *models* RLS. This
// suite checks the actual Postgres policies in supabase/schema.sql and
// migrations, which are what really keep one user's files and workspaces
// away from another's.
//
// Runs only when pointed at a disposable test project (never production):
//   SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_ROLE_KEY
// It creates two throwaway users, exercises the policies, and deletes the
// users (and, by cascade, their rows) afterwards. Skips itself otherwise.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_TEST_URL;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const skip = !(URL && ANON && SERVICE) && 'SUPABASE_TEST_* env vars not set (needs a disposable test project)';
if (URL && /gukxpikthryasymfuhgl/.test(URL)) throw new Error('Refusing to run RLS tests against the production Supabase project');

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
let admin; const users = {};

async function makeUser(label) {
  const email = `rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = `pw-${Math.random().toString(36).slice(2)}-X9`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(URL, ANON, opts);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw signInError;
  return { id: data.user.id, client };
}

before(async () => {
  if (skip) return;
  admin = createClient(URL, SERVICE, opts);
  users.a = await makeUser('a');
  users.b = await makeUser('b');
});
after(async () => {
  if (skip) return;
  for (const u of Object.values(users)) {
    await admin.storage.from('csvs').remove([`${u.id}/rls-test/t.csv`]);
    await admin.auth.admin.deleteUser(u.id);
  }
});

test('workspaces: owner can create and read; another user cannot read, update or delete', { skip }, async () => {
  const { a, b } = users;
  const { data: ws, error } = await a.client.from('workspaces').insert({ user_id: a.id, name: 'secret' }).select().single();
  assert.equal(error, null);

  const { data: seenByB } = await b.client.from('workspaces').select('*').eq('id', ws.id);
  assert.deepEqual(seenByB, []);

  await b.client.from('workspaces').update({ name: 'hijacked' }).eq('id', ws.id);
  await b.client.from('workspaces').delete().eq('id', ws.id);
  const { data: still } = await admin.from('workspaces').select('name').eq('id', ws.id).single();
  assert.equal(still.name, 'secret', 'B could neither rename nor delete it');
});

test('workspaces: a user cannot create a row owned by someone else', { skip }, async () => {
  const { error } = await users.b.client.from('workspaces').insert({ user_id: users.a.id, name: 'planted' });
  assert.ok(error, 'insert with another user_id must be rejected');
});

test('anonymous (signed-out) clients see no workspaces at all', { skip }, async () => {
  const anon = createClient(URL, ANON, opts);
  const { data } = await anon.from('workspaces').select('id');
  assert.deepEqual(data || [], []);
});

test('storage: files under another user\'s folder cannot be read, written or deleted', { skip }, async () => {
  const { a, b } = users;
  const path = `${a.id}/rls-test/t.csv`;
  const up = await a.client.storage.from('csvs').upload(path, new Blob(['x,y\n1,2']), { upsert: true, contentType: 'text/csv' });
  assert.equal(up.error, null);
  const read = await b.client.storage.from('csvs').download(path);
  assert.ok(read.error, 'B cannot download A\'s file');
  const write = await b.client.storage.from('csvs').upload(`${a.id}/rls-test/evil.csv`, new Blob(['evil']), { contentType: 'text/csv' });
  assert.ok(write.error, 'B cannot write into A\'s folder');
  await b.client.storage.from('csvs').remove([path]);
  const stillThere = await a.client.storage.from('csvs').download(path);
  assert.equal(stillThere.error, null, 'B\'s delete had no effect');
});

test('profiles: a user cannot grant themselves Premium', { skip }, async () => {
  const { a } = users;
  await a.client.from('profiles').upsert({ id: a.id, is_premium: true });
  await a.client.from('profiles').update({ is_premium: true }).eq('id', a.id);
  const { data } = await admin.from('profiles').select('is_premium').eq('id', a.id).maybeSingle();
  assert.notEqual(data && data.is_premium, true);
});

test('profiles: a user cannot attach themselves to an organization', { skip }, async () => {
  const { a } = users;
  await a.client.from('profiles').upsert({ id: a.id, org_id: '00000000-0000-0000-0000-000000000000', premium_via: 'org' });
  const { data } = await admin.from('profiles').select('org_id, premium_via').eq('id', a.id).maybeSingle();
  assert.equal(data ? data.org_id : null, null);
});

test('service role (API routes) can still write profiles (the webhook path)', { skip }, async () => {
  const { error } = await admin.from('profiles').upsert({ id: users.b.id, is_premium: true, updated_at: new Date().toISOString() });
  assert.equal(error, null);
  const { data } = await users.b.client.from('profiles').select('is_premium').eq('id', users.b.id).single();
  assert.equal(data.is_premium, true, 'and the owner can read their own row');
});
