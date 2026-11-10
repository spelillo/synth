// Unit tests for api/_aiRateLimit.js (AI_RATE_LIMIT_SPEC.md): org kill
// switch, 15-per-5-minutes burst, 60/day free, 300/day premium.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, backend } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

const MIN = 60_000;
let checkAndRecordAiUsage;
beforeEach(async () => {
  resetAll();
  ({ checkAndRecordAiUsage } = await importFresh('api/_aiRateLimit.js'));
});

function usage(userId, n, minutesAgo) {
  const at = new Date(Date.now() - minutesAgo * MIN).toISOString();
  backend.seed('ai_usage_events', Array.from({ length: n }, () => ({ user_id: userId, created_at: at })));
}

test('allows the first message and records one usage event', async () => {
  const r = await checkAndRecordAiUsage('u1');
  assert.deepEqual(r, { allowed: true });
  assert.equal(backend.rows('ai_usage_events').filter(e => e.user_id === 'u1').length, 1);
});

test('fails open (allowed, nothing recorded) when Supabase is not configured', async () => {
  resetAll({ SUPABASE_SERVICE_ROLE_KEY: undefined });
  ({ checkAndRecordAiUsage } = await importFresh('api/_aiRateLimit.js'));
  assert.deepEqual(await checkAndRecordAiUsage('u1'), { allowed: true });
  assert.equal(backend.log.length, 0);
});

test('blocks the 16th message inside 5 minutes (burst limit)', async () => {
  usage('u1', 15, 1);
  const r = await checkAndRecordAiUsage('u1');
  assert.equal(r.allowed, false);
  assert.match(r.message, /faster than the assistant/);
  assert.equal(backend.rows('ai_usage_events').length, 15, 'a rejected request is not recorded');
});

test('allows the 15th message inside 5 minutes (boundary)', async () => {
  usage('u1', 14, 1);
  assert.equal((await checkAndRecordAiUsage('u1')).allowed, true);
});

test('burst window ignores messages older than 5 minutes', async () => {
  usage('u1', 15, 6);
  assert.equal((await checkAndRecordAiUsage('u1')).allowed, true);
});

test('free tier: blocks after 60 messages in 24h with an upgrade hint', async () => {
  usage('u1', 60, 60);
  const r = await checkAndRecordAiUsage('u1');
  assert.equal(r.allowed, false);
  assert.match(r.message, /Go Premium/);
});

test('free tier: 59 messages in 24h still allowed (boundary)', async () => {
  usage('u1', 59, 60);
  assert.equal((await checkAndRecordAiUsage('u1')).allowed, true);
});

test('premium tier: 60 messages is fine, 300 is the cap, and the message has no upsell', async () => {
  backend.seed('profiles', [{ id: 'u1', is_premium: true }]);
  usage('u1', 60, 60);
  assert.equal((await checkAndRecordAiUsage('u1')).allowed, true);
  usage('u1', 240, 60);
  const r = await checkAndRecordAiUsage('u1');
  assert.equal(r.allowed, false);
  assert.doesNotMatch(r.message, /Go Premium/);
});

test('daily window ignores messages older than 24h', async () => {
  usage('u1', 100, 25 * 60);
  assert.equal((await checkAndRecordAiUsage('u1')).allowed, true);
});

test('limits are per user: another user\'s traffic does not count', async () => {
  usage('someone-else', 300, 1);
  assert.equal((await checkAndRecordAiUsage('u1')).allowed, true);
});

test('org admin AI kill switch overrides premium', async () => {
  backend.seed('organizations', [{ id: 'org1', domain: 'acme.edu', ai_enabled: false }]);
  backend.seed('profiles', [{ id: 'u1', is_premium: true, org_id: 'org1' }]);
  const r = await checkAndRecordAiUsage('u1');
  assert.equal(r.allowed, false);
  assert.match(r.message, /disabled by your organization admin/);
});

test('org with AI enabled falls through to the normal limits', async () => {
  backend.seed('organizations', [{ id: 'org1', domain: 'acme.edu', ai_enabled: true }]);
  backend.seed('profiles', [{ id: 'u1', is_premium: true, org_id: 'org1' }]);
  assert.equal((await checkAndRecordAiUsage('u1')).allowed, true);
});

test('a profile pointing at a deleted org is not blocked', async () => {
  backend.seed('profiles', [{ id: 'u1', org_id: 'gone' }]);
  assert.equal((await checkAndRecordAiUsage('u1')).allowed, true);
});
