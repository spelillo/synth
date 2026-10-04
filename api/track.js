// Vercel Serverless Function — records one anonymous launch-analytics event
// (see analytics.js). Write-only: nothing here can be read back by a client.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, already set for the
// other API routes.

import { createClient } from '@supabase/supabase-js';

const ALLOWED_EVENTS = new Set([
  'visit', 'query_run', 'signup',
  // Learn page; need the 20261005000000_learn_usage_events migration.
  'learn_open', 'learn_attempt', 'learn_lesson_done', 'learn_course_done', 'learn_tutor'
]);
const VISITOR_ID = /^[A-Za-z0-9-]{8,64}$/;
const REF = /^[A-Za-z0-9_.-]{1,40}$/;
const HOST = /^[a-z0-9.-]{1,100}$/;
const DETAIL = /^[a-z0-9_-]{1,40}$/;

let cachedClient;
function getSupabaseAdmin() {
  if (cachedClient !== undefined) return cachedClient;
  cachedClient = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedClient;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const { event, visitor_id, ref, referrer, path, detail } = body || {};

  if (!ALLOWED_EVENTS.has(event) || !VISITOR_ID.test(visitor_id || '')) {
    res.status(400).end();
    return;
  }

  const supabase = getSupabaseAdmin();
  if (supabase) {
    const row = {
      event,
      visitor_id,
      ref: REF.test(ref || '') ? ref.toLowerCase() : null,
      referrer: HOST.test(referrer || '') ? referrer : null,
      path: typeof path === 'string' ? path.slice(0, 100) : null
    };
    // Only sent with a detail, so the original events keep working before
    // the column exists.
    if (DETAIL.test(detail || '')) row.detail = detail;
    await supabase.from('usage_events').insert(row);
  }
  res.status(204).end();
}
