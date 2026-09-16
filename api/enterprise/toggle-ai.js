// Vercel Serverless Function — lets an org's admin turn AI on/off for
// every member. Enforced in api/_aiRateLimit.js, which every api/chat.js
// call already goes through — this route only flips the flag.

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
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const userId = await getVerifiedUserId(req);
  if (!userId) {
    res.status(401).json({ error: { message: 'Sign in required' } });
    return;
  }

  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: '"enabled" (boolean) is required' } });
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
    res.status(403).json({ error: { message: 'Only your organization\'s admin can change this setting' } });
    return;
  }

  const { error: updateError } = await supabaseAdmin
    .from('organizations')
    .update({ ai_enabled: enabled })
    .eq('id', membership.org_id);

  if (updateError) {
    res.status(500).json({ error: { message: updateError.message } });
    return;
  }

  res.status(200).json({ ai_enabled: enabled });
}
