// Unit tests for api/track.js: anonymous analytics writes. Everything the
// client sends is validated or dropped before it reaches the database.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, call, backend } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let handler;
beforeEach(async () => {
  resetAll();
  ({ default: handler } = await importFresh('api/track.js'));
});

const VID = 'a1b2c3d4-0000-4000-8000-000000000000';

test('rejects non-POST with 405', async () => {
  assert.equal((await call(handler, { method: 'GET' })).statusCode, 405);
});

test('records a valid visit and returns 204', async () => {
  const res = await call(handler, { body: { event: 'visit', visitor_id: VID, ref: 'Reddit', referrer: 'news.ycombinator.com', path: '/learn' } });
  assert.equal(res.statusCode, 204);
  const [row] = backend.rows('usage_events');
  assert.equal(row.event, 'visit');
  assert.equal(row.ref, 'reddit', 'ref is lower-cased');
  assert.equal(row.referrer, 'news.ycombinator.com');
  assert.equal(row.path, '/learn');
  assert.equal('detail' in row, false, 'detail is only sent when valid');
});

test('accepts a JSON string body (sendBeacon delivers text)', async () => {
  const res = await call(handler, { body: JSON.stringify({ event: 'query_run', visitor_id: VID }) });
  assert.equal(res.statusCode, 204);
  assert.equal(backend.rows('usage_events').length, 1);
});

test('a malformed JSON string body is a 400, not a crash', async () => {
  assert.equal((await call(handler, { body: '{not json' })).statusCode, 400);
});

test('unknown events are rejected', async () => {
  assert.equal((await call(handler, { body: { event: 'delete_everything', visitor_id: VID } })).statusCode, 400);
  assert.equal(backend.rows('usage_events').length, 0);
});

test('visitor ids must be 8-64 safe characters', async () => {
  for (const bad of [undefined, 'short', 'x'.repeat(65), 'has spaces in it', "abc'; drop table--"]) {
    assert.equal((await call(handler, { body: { event: 'visit', visitor_id: bad } })).statusCode, 400, String(bad));
  }
});

test('invalid ref/referrer are stored as null, not rejected', async () => {
  await call(handler, { body: { event: 'visit', visitor_id: VID, ref: '<script>', referrer: 'Evil Host!' } });
  const [row] = backend.rows('usage_events');
  assert.equal(row.ref, null);
  assert.equal(row.referrer, null);
});

test('path is truncated to 100 characters; non-strings become null', async () => {
  await call(handler, { body: { event: 'visit', visitor_id: VID, path: '/' + 'a'.repeat(300) } });
  await call(handler, { body: { event: 'visit', visitor_id: VID, path: { evil: true } } });
  const rows = backend.rows('usage_events');
  assert.equal(rows[0].path.length, 100);
  assert.equal(rows[1].path, null);
});

test('Learn events keep a valid lesson-id detail and drop an invalid one', async () => {
  await call(handler, { body: { event: 'learn_lesson_done', visitor_id: VID, detail: 'b01' } });
  await call(handler, { body: { event: 'learn_lesson_done', visitor_id: VID, detail: 'DROP TABLE' } });
  const rows = backend.rows('usage_events');
  assert.equal(rows[0].detail, 'b01');
  assert.equal('detail' in rows[1], false);
});

test('still returns 204 when Supabase is not configured (nothing stored)', async () => {
  resetAll({ SUPABASE_URL: undefined });
  ({ default: handler } = await importFresh('api/track.js'));
  assert.equal((await call(handler, { body: { event: 'visit', visitor_id: VID } })).statusCode, 204);
  assert.equal(backend.log.length, 0);
});
