// Unit tests for api/enterprise/status.js: read endpoints with per-op access.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, signedInUser, backend } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let handler; let admin; let manager; let student; let other;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/enterprise/status.js'));
  admin = signedInUser('admin@acme.edu');
  manager = signedInUser('m@acme.edu');
  student = signedInUser('s@acme.edu');
  other = signedInUser('t@acme.edu');
  backend.seed('organizations', [{ id: 'o1', name: 'Acme', domain: 'acme.edu', ai_enabled: true }]);
  backend.seed('org_members', [
    { org_id: 'o1', user_id: admin.user.id, role: 'admin' },
    { org_id: 'o1', user_id: manager.user.id, role: 'member' },
    { org_id: 'o1', user_id: student.user.id, role: 'member' },
    { org_id: 'o1', user_id: other.user.id, role: 'member' },
  ]);
  backend.seed('workrooms', [{ id: 'w1', org_id: 'o1', name: 'Stats', manager_id: manager.user.id }]);
  backend.seed('workroom_members', [{ workroom_id: 'w1', user_id: student.user.id }]);
  backend.seed('dataset_library_templates', [{ id: 'tpl', name: 'University', vertical: 'edu', description: 'd' }]);
  backend.seed('org_enabled_templates', [{ org_id: 'o1', template_id: 'tpl' }]);
});

const get = (who, op) => call(handler, { method: 'GET', headers: who && who.headers, query: op ? { op } : {} });

test('405 for POST, 401 signed out, 400 unknown op', async () => {
  assert.equal((await call(handler, { method: 'POST', headers: admin.headers })).statusCode, 405);
  assert.equal((await get(null)).statusCode, 401);
  assert.equal((await get(admin, 'secrets')).statusCode, 400);
});

test('org_status (default op): admin sees role, org and enabled templates', async () => {
  const res = await get(admin);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role, 'admin');
  assert.equal(res.body.org.domain, 'acme.edu');
  assert.deepEqual(res.body.enabledTemplates.map(t => t.id), ['tpl']);
  assert.equal(res.body.is_manager, false);
});

test('org_status: a workroom manager is flagged is_manager', async () => {
  assert.equal((await get(manager, 'org_status')).body.is_manager, true);
});

test('org_status: a user with no org gets an empty status, not an error', async () => {
  const loner = signedInUser('x@nowhere.com');
  assert.deepEqual((await get(loner, 'org_status')).body, { role: null, org: null, enabledTemplates: [], is_manager: false });
});

test('org_roster: lists every member with email', async () => {
  const res = await get(student, 'org_roster');
  assert.equal(res.body.members.length, 4);
  assert.ok(res.body.members.some(m => m.email === 'admin@acme.edu'));
});

test('usage: admin sees the whole org with 24h/7d counts', async () => {
  const now = Date.now();
  backend.seed('ai_usage_events', [
    { user_id: student.user.id, created_at: new Date(now - 3600e3).toISOString() },
    { user_id: student.user.id, created_at: new Date(now - 3 * 86400e3).toISOString() },
    { user_id: student.user.id, created_at: new Date(now - 10 * 86400e3).toISOString() },
  ]);
  const res = await get(admin, 'usage');
  assert.equal(res.body.members.length, 4);
  const s = res.body.members.find(m => m.user_id === student.user.id);
  assert.equal(s.count_24h, 1);
  assert.equal(s.count_7d, 2);
});

test('usage: a manager sees only their workroom roster', async () => {
  const res = await get(manager, 'usage');
  assert.deepEqual(res.body.members.map(m => m.email), ['s@acme.edu']);
});

test('usage: a plain member gets 403', async () => {
  assert.equal((await get(other, 'usage')).statusCode, 403);
});

test('workrooms: admin sees all org workrooms with rosters; plain member sees none', async () => {
  const res = await get(admin, 'workrooms');
  assert.equal(res.body.workrooms.length, 1);
  assert.equal(res.body.workrooms[0].manager_email, 'm@acme.edu');
  assert.deepEqual(res.body.workrooms[0].roster.map(r => r.email), ['s@acme.edu']);
  assert.deepEqual((await get(other, 'workrooms')).body, { workrooms: [] });
});

test('templates: lists the dataset library', async () => {
  const res = await get(other, 'templates');
  assert.deepEqual(res.body.templates.map(t => t.name), ['University']);
});

test('a database error surfaces as 500', async () => {
  backend.failNext('organizations', 'select', 'down');
  assert.equal((await get(admin, 'org_status')).statusCode, 500);
});
