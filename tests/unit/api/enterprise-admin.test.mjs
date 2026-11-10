// Unit tests for api/enterprise/admin.js: every op is admin-only.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, signedInUser, backend, stripeState } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let handler; let admin; let member;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/enterprise/admin.js'));
  admin = signedInUser('admin@acme.edu');
  member = signedInUser('member@acme.edu');
  backend.seed('organizations', [{ id: 'o1', domain: 'acme.edu', stripe_subscription_id: 'sub_1', ai_enabled: true }]);
  backend.seed('org_members', [{ org_id: 'o1', user_id: admin.user.id, role: 'admin' }, { org_id: 'o1', user_id: member.user.id, role: 'member' }]);
});

const post = (who, body) => call(handler, { headers: who.headers, body });

test('405 for GET', async () => {
  assert.equal((await call(handler, { method: 'GET', headers: admin.headers })).statusCode, 405);
});

test('401 when signed out', async () => {
  assert.equal((await call(handler, { body: { op: 'toggle_ai', enabled: false } })).statusCode, 401);
});

test('403 for a plain member on every op', async () => {
  for (const op of ['toggle_ai', 'toggle_auto_renew', 'enable_template', 'create_workroom', 'create_join_link']) {
    const res = await post(member, { op, enabled: false });
    assert.equal(res.statusCode, 403, op);
  }
  assert.equal(backend.rows('organizations')[0].ai_enabled, true);
});

test('403 for a user with no org at all', async () => {
  const outsider = signedInUser('x@elsewhere.com');
  assert.equal((await post(outsider, { op: 'toggle_ai', enabled: false })).statusCode, 403);
});

test('unknown op is a 400', async () => {
  assert.equal((await post(admin, { op: 'drop_org' })).statusCode, 400);
});

test('toggle_ai: turns AI off for the admin\'s org', async () => {
  const res = await post(admin, { op: 'toggle_ai', enabled: false });
  assert.deepEqual(res.body, { ai_enabled: false });
  assert.equal(backend.rows('organizations')[0].ai_enabled, false);
});

test('toggle_ai: "enabled" must be a real boolean', async () => {
  for (const enabled of ['false', 0, null, undefined]) {
    assert.equal((await post(admin, { op: 'toggle_ai', enabled })).statusCode, 400, String(enabled));
  }
});

test('toggle_ai: database error -> 500', async () => {
  backend.failNext('organizations', 'update', 'nope');
  assert.equal((await post(admin, { op: 'toggle_ai', enabled: false })).statusCode, 500);
});

test('toggle_auto_renew: off sets cancel_at_period_end in Stripe and the DB', async () => {
  const res = await post(admin, { op: 'toggle_auto_renew', enabled: false });
  assert.deepEqual(res.body, { cancel_at_period_end: true });
  assert.deepEqual(stripeState.calls[0], { method: 'subscriptions.update', args: { id: 'sub_1', params: { cancel_at_period_end: true } } });
  assert.equal(backend.rows('organizations')[0].cancel_at_period_end, true);
});

test('toggle_auto_renew: if Stripe fails, the DB is not changed', async () => {
  stripeState.failNext('subscriptions.update', 'stripe down');
  const res = await post(admin, { op: 'toggle_auto_renew', enabled: false });
  assert.equal(res.statusCode, 500);
  assert.equal(backend.rows('organizations')[0].cancel_at_period_end, false);
});

test('toggle_auto_renew: an org with no subscription id is a 500', async () => {
  backend.tables.organizations[0].stripe_subscription_id = null;
  assert.equal((await post(admin, { op: 'toggle_auto_renew', enabled: true })).statusCode, 500);
});

test('enable_template: enabling twice leaves one row; disabling removes it', async () => {
  await post(admin, { op: 'enable_template', template_id: 'tpl1', enabled: true });
  await post(admin, { op: 'enable_template', template_id: 'tpl1', enabled: true });
  assert.equal(backend.rows('org_enabled_templates').length, 1);
  await post(admin, { op: 'enable_template', template_id: 'tpl1', enabled: false });
  assert.equal(backend.rows('org_enabled_templates').length, 0);
});

test('enable_template: validates input', async () => {
  assert.equal((await post(admin, { op: 'enable_template', enabled: true })).statusCode, 400);
  assert.equal((await post(admin, { op: 'enable_template', template_id: 't', enabled: 'yes' })).statusCode, 400);
});

test('create_workroom: manager must be an org member', async () => {
  const outsider = signedInUser('x@elsewhere.com');
  const res = await post(admin, { op: 'create_workroom', name: 'Stats 101', manager_user_id: outsider.user.id });
  assert.equal(res.statusCode, 400);
  assert.equal(backend.rows('workrooms').length, 0);
});

test('create_workroom: creates the workroom in the admin\'s org', async () => {
  const res = await post(admin, { op: 'create_workroom', name: 'Stats 101', manager_user_id: member.user.id });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.workroom.name, 'Stats 101');
  assert.equal(backend.rows('workrooms')[0].org_id, 'o1');
});

test('create_workroom: requires a string name and a manager', async () => {
  assert.equal((await post(admin, { op: 'create_workroom', name: 42, manager_user_id: member.user.id })).statusCode, 400);
  assert.equal((await post(admin, { op: 'create_workroom', name: 'x' })).statusCode, 400);
});

test('create_join_link: returns an unguessable token and a URL on the request host', async () => {
  const res = await call(handler, { headers: { ...admin.headers, host: 'synth-sql.com' }, body: { op: 'create_join_link' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.body.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(res.body.url, `https://synth-sql.com/?join=${res.body.token}`);
  const res2 = await post(admin, { op: 'create_join_link' });
  assert.notEqual(res2.body.token, res.body.token);
  assert.equal(backend.rows('org_join_links').length, 2);
});
