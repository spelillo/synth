// Vercel Serverless Function — lets an org's admin see every member's AI
// usage. Reads the same ai_usage_events table api/_aiRateLimit.js already
// writes to (one row per AI call) — no new tracking, just a new view onto
// existing data.

import { createClient } from '@supabase/supabase-js';
import { getVerifiedUserId } from '../_supabaseAuth.js';

let cachedSupabaseAdmin;
function getSupabaseAdmin() {
  if (cachedSupabaseAdmin !== undefined) return cachedSupabaseAdmin;
  cachedSupabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedSupabaseAdmin;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const userId = await getVerifiedUserId(req);
  if (!userId) {
    res.status(401).json({ error: { message: 'Sign in required' } });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: { message: 'Server is not configured (Supabase)' } });
    return;
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', userId)
    .maybeSingle();

  if (membershipError || !membership || membership.role !== 'admin') {
    res.status(403).json({ error: { message: 'Only your organization\'s admin can view usage' } });
    return;
  }

  const { data: members, error: membersError } = await supabaseAdmin
    .from('org_members')
    .select('user_id, role, joined_at')
    .eq('org_id', membership.org_id);

  if (membersError) {
    res.status(500).json({ error: { message: membersError.message } });
    return;
  }
  if (!members.length) {
    res.status(200).json({ members: [] });
    return;
  }

  const memberIds = members.map((m) => m.user_id);
  const daySince = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const weekSince = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

  // One query for the whole 7-day window, then split into 24h/7d buckets in
  // code — cheaper than two separate count queries per member, and this
  // table only ever grows by a handful of rows per user per day.
  const { data: events, error: eventsError } = await supabaseAdmin
    .from('ai_usage_events')
    .select('user_id, created_at')
    .in('user_id', memberIds)
    .gte('created_at', weekSince);

  if (eventsError) {
    res.status(500).json({ error: { message: eventsError.message } });
    return;
  }

  const counts = {};
  for (const id of memberIds) counts[id] = { count_24h: 0, count_7d: 0 };
  for (const event of events) {
    const bucket = counts[event.user_id];
    if (!bucket) continue; // shouldn't happen given the .in() filter, but don't crash if it does
    bucket.count_7d += 1;
    if (event.created_at >= daySince) bucket.count_24h += 1;
  }

  // auth.admin.getUserById is looped rather than batched — fine at the org
  // sizes this ships for (a school's admin console, not a consumer app);
  // revisit if orgs ever have hundreds of members.
  const results = [];
  for (const member of members) {
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(member.user_id);
    results.push({
      user_id: member.user_id,
      email: userData?.user?.email || '(unknown)',
      role: member.role,
      joined_at: member.joined_at,
      count_24h: counts[member.user_id]?.count_24h || 0,
      count_7d: counts[member.user_id]?.count_7d || 0,
    });
  }

  res.status(200).json({ members: results });
}
