// Shared helper: deletes data that's past its retention period. Not itself
// a route. Runs from the weekly report cron (api/cron/weekly-marketing-report.js)
// so it doesn't need a cron of its own. The privacy policy (privacy.html,
// "How long we keep data") states these same periods: change both together.
//
// - usage_events (anonymous usage stats, see analytics.js): 13 months. The
//   weekly email only reads the last 90 days; the extra year keeps
//   year-over-year comparisons possible in the SQL editor.
// - ai_usage_events (one timestamp per AI request, for rate limiting): 30
//   days. api/_aiRateLimit.js only ever looks back 24 hours.

export const RETENTION_DAYS = {
  usage_events: 395,
  ai_usage_events: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns { [table]: 'ok' | error message }. A missing table (its migration
// never run) is reported, not thrown, so one table can't stop the others
// or the weekly email.
export async function purgeExpiredData(supabase, now = new Date()) {
  const results = {};
  for (const [table, days] of Object.entries(RETENTION_DAYS)) {
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    const { error } = await supabase.from(table).delete().lt('created_at', cutoff);
    results[table] = error ? error.message : 'ok';
  }
  return results;
}
