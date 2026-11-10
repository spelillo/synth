// Unit tests for api/enterprise/member-actions.js: join via link,
// load a library dataset, and workroom roster edits.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, signedInUser, backend } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let handler;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/enterprise/member-actions.js'));
  backend.seed('organizations', [{ id: 'o1', name: 'Acme U', domain: 'acme.edu' }]);
  backend.seed('org_join_links', [{ org_id: 'o1', token: 'good-token' }, { org_id: 'o1', token: 'revoked-token', revoked_at: '2026-01-01' }]);
});

const post = (who, body) => call(handler, { headers: who.headers, body });

test('405 for GET, 401 when signed out, 400 for unknown op', async () => {
  const u = signedInUser('a@acme.edu');
  assert.equal((await call(handler, { method: 'GET', headers: u.headers })).statusCode, 405);
  assert.equal((await call(handler, { body: { op: 'join', token: 'good-token' } })).statusCode, 401);
  assert.equal((await post(u, { op: 'nope' })).statusCode, 400);
});

test('join: a matching-domain user joins and gets org Premium', async () => {
  const u = signedInUser('student@acme.edu');
  const res = await post(u, { op: 'join', token: 'good-token' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { joined: true, org: { name: 'Acme U', domain: 'acme.edu' } });
  assert.equal(backend.rows('org_members')[0].role, 'member');
  const [p] = backend.rows('profiles');
  assert.equal(p.is_premium, true);
  assert.equal(p.premium_via, 'org');
});

test('join: requires a string token', async () => {
  const u = signedInUser('student@acme.edu');
  assert.equal((await post(u, { op: 'join' })).statusCode, 400);
  assert.equal((await post(u, { op: 'join', token: { $ne: null } })).statusCode, 400);
});

test('join: unknown or revoked link is a 404', async () => {
  const u = signedInUser('student@acme.edu');
  assert.equal((await post(u, { op: 'join', token: 'made-up' })).statusCode, 404);
  assert.equal((await post(u, { op: 'join', token: 'revoked-token' })).statusCode, 404);
});

test('join: a link whose org was deleted is a 404', async () => {
  backend.seed('org_join_links', [{ org_id: 'deleted-org', token: 'orphan' }]);
  const u = signedInUser('student@acme.edu');
  assert.equal((await post(u, { op: 'join', token: 'orphan' })).statusCode, 404);
});

test('join: a different email domain is refused (a leaked link can\'t mint Premium for anyone)', async () => {
  const u = signedInUser('random@gmail.com');
  const res = await post(u, { op: 'join', token: 'good-token' });
  assert.equal(res.statusCode, 403);
  assert.equal(backend.rows('org_members').length, 0);
});

test('join: a look-alike subdomain does not match', async () => {
  const u = signedInUser('x@evil.acme.edu');
  assert.equal((await post(u, { op: 'join', token: 'good-token' })).statusCode, 403);
});

test('join: joining twice is idempotent (alreadyMember)', async () => {
  const u = signedInUser('student@acme.edu');
  await post(u, { op: 'join', token: 'good-token' });
  const res = await post(u, { op: 'join', token: 'good-token' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alreadyMember, true);
  assert.equal(backend.rows('org_members').length, 1);
});

test('join: a member of a different org gets 409', async () => {
  const u = signedInUser('student@acme.edu');
  backend.seed('org_members', [{ org_id: 'other', user_id: u.user.id, role: 'member' }]);
  assert.equal((await post(u, { op: 'join', token: 'good-token' })).statusCode, 409);
});

test('join: a profile write failure is a 500', async () => {
  const u = signedInUser('student@acme.edu');
  backend.failNext('profiles', 'upsert', 'down');
  assert.equal((await post(u, { op: 'join', token: 'good-token' })).statusCode, 500);
});

function seedTemplate(enabled = true) {
  backend.seed('dataset_library_templates', [{ id: 'tpl', name: 'University', vertical: 'edu' }]);
  backend.seed('dataset_library_tables', [{ template_id: 'tpl', table_name: 'students', storage_path: 'university/students.csv', row_count: 3, columns: ['id'] }]);
  backend.seed('dataset_library_relationships', [{ template_id: 'tpl', from_table: 'a', from_column: 'b', to_table: 'c', to_column: 'd' }]);
  backend.storage['dataset-library'] = { 'university/students.csv': { body: 'id\n1\n2\n3' } };
  if (enabled) backend.seed('org_enabled_templates', [{ org_id: 'o1', template_id: 'tpl' }]);
}

test('load_template: an org member gets short-lived signed URLs for an enabled dataset', async () => {
  seedTemplate();
  const u = signedInUser('s@acme.edu');
  backend.seed('org_members', [{ org_id: 'o1', user_id: u.user.id, role: 'member' }]);
  const res = await post(u, { op: 'load_template', template_id: 'tpl' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.template.name, 'University');
  assert.match(res.body.tables[0].url, /expires=300$/);
  assert.equal(res.body.relationships.length, 1);
});

test('load_template: non-members and disabled datasets are refused', async () => {
  seedTemplate(false);
  const u = signedInUser('s@acme.edu');
  assert.equal((await post(u, { op: 'load_template', template_id: 'tpl' })).statusCode, 403, 'not a member');
  backend.seed('org_members', [{ org_id: 'o1', user_id: u.user.id, role: 'member' }]);
  assert.equal((await post(u, { op: 'load_template', template_id: 'tpl' })).statusCode, 403, 'not enabled');
  assert.equal((await post(u, { op: 'load_template' })).statusCode, 400, 'missing id');
});

test('load_template: a storage signing failure is a 500 naming the table', async () => {
  seedTemplate();
  const u = signedInUser('s@acme.edu');
  backend.seed('org_members', [{ org_id: 'o1', user_id: u.user.id, role: 'member' }]);
  backend.failNext('storage:dataset-library', 'createSignedUrl', 'bucket gone');
  const res = await post(u, { op: 'load_template', template_id: 'tpl' });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error.message, /students/);
});

function seedWorkroom() {
  const manager = signedInUser('m@acme.edu');
  const student = signedInUser('s@acme.edu');
  backend.seed('org_members', [{ org_id: 'o1', user_id: manager.user.id, role: 'member' }, { org_id: 'o1', user_id: student.user.id, role: 'member' }]);
  backend.seed('workrooms', [{ id: 'w1', org_id: 'o1', name: 'Stats', manager_id: manager.user.id }]);
  return { manager, student };
}

test('workroom_roster: the manager can add and remove an org member', async () => {
  const { manager, student } = seedWorkroom();
  const add = await post(manager, { op: 'workroom_roster', workroom_id: 'w1', roster_action: 'add', user_id: student.user.id });
  assert.equal(add.statusCode, 200);
  await post(manager, { op: 'workroom_roster', workroom_id: 'w1', roster_action: 'add', user_id: student.user.id });
  assert.equal(backend.rows('workroom_members').length, 1, 'add is idempotent');
  await post(manager, { op: 'workroom_roster', workroom_id: 'w1', roster_action: 'remove', user_id: student.user.id });
  assert.equal(backend.rows('workroom_members').length, 0);
});

test('workroom_roster: only the manager may edit (not another member)', async () => {
  const { student } = seedWorkroom();
  const res = await post(student, { op: 'workroom_roster', workroom_id: 'w1', roster_action: 'add', user_id: student.user.id });
  assert.equal(res.statusCode, 403);
});

test('workroom_roster: cannot add someone outside the org', async () => {
  const { manager } = seedWorkroom();
  const outsider = signedInUser('o@other.edu');
  assert.equal((await post(manager, { op: 'workroom_roster', workroom_id: 'w1', roster_action: 'add', user_id: outsider.user.id })).statusCode, 400);
});

test('workroom_roster: validates roster_action', async () => {
  const { manager, student } = seedWorkroom();
  assert.equal((await post(manager, { op: 'workroom_roster', workroom_id: 'w1', roster_action: 'promote', user_id: student.user.id })).statusCode, 400);
});
