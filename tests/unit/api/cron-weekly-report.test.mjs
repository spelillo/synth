// Unit tests for the handler in api/cron/weekly-marketing-report.js
// (buildEmail's content is covered in tests/learn-report.test.js).

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, backend, mailState, silenceConsole } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

const auth = { authorization: 'Bearer cron-secret-test' };
let handler;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/cron/weekly-marketing-report.js'));
});

test('500 without CRON_SECRET, 401 with a wrong one', async () => {
  assert.equal((await call(handler, { method: 'GET', headers: { authorization: 'Bearer nope' } })).statusCode, 401);
  resetAll({ CRON_SECRET: undefined });
  ({ default: handler } = await importFresh('api/cron/weekly-marketing-report.js'));
  assert.equal((await call(handler, { method: 'GET', headers: auth })).statusCode, 500);
});

test('counts this week\'s visitors and queriers and emails the report', async () => {
  const now = Date.now();
  const iso = d => new Date(now - d * 86400e3).toISOString();
  backend.seed('usage_events', [
    { event: 'visit', visitor_id: 'v1', created_at: iso(1), referrer: 'google.com', path: '/' },
    { event: 'visit', visitor_id: 'v2', created_at: iso(2), path: '/learn' },
    { event: 'query_run', visitor_id: 'v1', created_at: iso(1) },
    { event: 'query_run', visitor_id: 'v1', created_at: iso(20) },
    { event: 'visit', visitor_id: 'v3', created_at: iso(9) },
  ]);
  backend.createUser({ email: 'new@x.com' });
  const res = await call(handler, { method: 'GET', headers: auth });
  assert.deepEqual(res.body, { sent: true });
  const mail = mailState.sent[0];
  assert.equal(mail.to, 'synth-test@example.com');
  assert.match(mail.subject, /1 ran a query, 1 new accounts, 2 visitors/);
  assert.match(mail.text, /Came back and queried again: 1/);
  assert.match(mail.text, /google\.com: 1/);
});

test('MARKETING_REPORT_TO overrides the recipient', async () => {
  resetAll({ MARKETING_REPORT_TO: 'growth@example.com' });
  ({ default: handler } = await importFresh('api/cron/weekly-marketing-report.js'));
  await call(handler, { method: 'GET', headers: auth });
  assert.equal(mailState.sent[0].to, 'growth@example.com');
});

test('reports sent:false (200) when mail fails, without throwing', async (t) => {
  silenceConsole(t);
  mailState.failNextWith = 'SMTP down';
  const res = await call(handler, { method: 'GET', headers: auth });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { sent: false });
});

test('a missing usage_events table still produces a report with a setup note', async () => {
  backend.failNext('usage_events', 'select', 'relation "usage_events" does not exist');
  backend.failNext('usage_events', 'select', 'relation "usage_events" does not exist');
  await call(handler, { method: 'GET', headers: auth });
  assert.match(mailState.sent[0].text, /Usage tracking isn't set up yet/);
});
