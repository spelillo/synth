import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { purgeExpiredData, RETENTION_DAYS } from '../api/_retention.js';

function fakeSupabase(failing = new Set()) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        delete() {
          return {
            lt(column, value) {
              calls.push({ table, column, value });
              return Promise.resolve({ error: failing.has(table) ? { message: 'relation does not exist' } : null });
            },
          };
        },
      };
    },
  };
}

test('purges each table older than its retention period', async () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const sb = fakeSupabase();
  const result = await purgeExpiredData(sb, now);
  assert.deepEqual(result, { usage_events: 'ok', ai_usage_events: 'ok' });
  const byTable = Object.fromEntries(sb.calls.map(c => [c.table, c]));
  assert.equal(byTable.usage_events.column, 'created_at');
  assert.equal(byTable.usage_events.value, new Date(now - 395 * 86400000).toISOString());
  assert.equal(byTable.ai_usage_events.value, '2026-10-02T00:00:00.000Z');
});

test('one failing table does not stop the others', async () => {
  const sb = fakeSupabase(new Set(['usage_events']));
  const result = await purgeExpiredData(sb);
  assert.equal(result.usage_events, 'relation does not exist');
  assert.equal(result.ai_usage_events, 'ok');
});

test('retention keeps more history than the weekly email and rate limiter read', () => {
  const report = readFileSync(new URL('../api/cron/weekly-marketing-report.js', import.meta.url), 'utf8');
  const lookback = Number(report.match(/now\.getTime\(\) - (\d+) \* DAY_MS\), \{ withDetail/)[1]);
  assert.ok(RETENTION_DAYS.usage_events > lookback);
  assert.ok(RETENTION_DAYS.ai_usage_events >= 1);
});
