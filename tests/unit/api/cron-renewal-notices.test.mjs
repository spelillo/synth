// Unit tests for api/cron/enterprise-renewal-notices.js.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, backend, mailState, silenceConsole } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

const DAY = 86400e3;
const auth = { authorization: 'Bearer cron-secret-test' };
let handler;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/cron/enterprise-renewal-notices.js'));
});

function seedOrg(daysOut, extra = {}) {
  const id = `o${backend.rows('organizations').length + 1}`;
  backend.seed('organizations', [{ id, name: `Org ${id}`, domain: `${id}.edu`, current_period_end: new Date(Date.now() + daysOut * DAY).toISOString(), ...extra }]);
  const admin = backend.createUser({ email: `admin@${id}.edu` });
  backend.seed('org_members', [{ org_id: id, user_id: admin.id, role: 'admin' }]);
  return id;
}

test('refuses to run without CRON_SECRET configured (500)', async (t) => {
  silenceConsole(t);
  resetAll({ CRON_SECRET: undefined });
  ({ default: handler } = await importFresh('api/cron/enterprise-renewal-notices.js'));
  assert.equal((await call(handler, { method: 'GET' })).statusCode, 500);
});

test('rejects a missing or wrong bearer token (401)', async () => {
  assert.equal((await call(handler, { method: 'GET' })).statusCode, 401);
  assert.equal((await call(handler, { method: 'GET', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
});

test('sends the 3-month notice at 89 days and records it', async () => {
  const id = seedOrg(89);
  const res = await call(handler, { method: 'GET', headers: auth });
  assert.equal(res.statusCode, 200);
  assert.equal(mailState.sent.length, 1);
  assert.equal(mailState.sent[0].to, `admin@${id}.edu`);
  assert.match(mailState.sent[0].subject, /renews in 3 months/);
  assert.ok(backend.rows('organizations')[0].notice_3mo_sent_at);
});

test('does nothing at 91 days out', async () => {
  seedOrg(91);
  await call(handler, { method: 'GET', headers: auth });
  assert.equal(mailState.sent.length, 0);
});

test('sends only one notice per run (1-month mark with the 3-month one already sent)', async () => {
  seedOrg(20, { notice_3mo_sent_at: '2026-01-01' });
  const res = await call(handler, { method: 'GET', headers: auth });
  assert.equal(mailState.sent.length, 1);
  assert.match(mailState.sent[0].subject, /1 month/);
  assert.equal(res.body.notified.length, 1);
});

test('the 1-week notice fires at 6 days once the earlier two are sent', async () => {
  seedOrg(6, { notice_3mo_sent_at: 'x', notice_1mo_sent_at: 'y' });
  await call(handler, { method: 'GET', headers: auth });
  assert.match(mailState.sent[0].subject, /1 week/);
});

test('never re-sends a notice already sent', async () => {
  seedOrg(6, { notice_3mo_sent_at: 'x', notice_1mo_sent_at: 'y', notice_1wk_sent_at: 'z' });
  await call(handler, { method: 'GET', headers: auth });
  assert.equal(mailState.sent.length, 0);
});

test('skips orgs that cancelled auto-renew or already lapsed', async () => {
  seedOrg(5, { cancel_at_period_end: true });
  seedOrg(-1);
  await call(handler, { method: 'GET', headers: auth });
  assert.equal(mailState.sent.length, 0);
});

test('if the email fails, the notice is NOT marked sent (it retries tomorrow)', async (t) => {
  silenceConsole(t);
  seedOrg(80);
  mailState.failNextWith = 'SMTP 421';
  const res = await call(handler, { method: 'GET', headers: auth });
  assert.equal(backend.rows('organizations')[0].notice_3mo_sent_at, null);
  assert.equal(res.body.notified[0].sent, false);
});

test('an org with no admin is skipped without failing the run', async (t) => {
  silenceConsole(t);
  backend.seed('organizations', [{ id: 'lonely', name: 'L', domain: 'l.edu', current_period_end: new Date(Date.now() + 10 * DAY).toISOString() }]);
  const id = seedOrg(10);
  const res = await call(handler, { method: 'GET', headers: auth });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(mailState.sent.map(m => m.to), [`admin@${id}.edu`]);
});

test('a database error reading orgs is a 500', async () => {
  backend.failNext('organizations', 'select', 'down');
  assert.equal((await call(handler, { method: 'GET', headers: auth })).statusCode, 500);
});
