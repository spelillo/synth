// Vercel Serverless Function — lists the caller's org's members (id +
// email only, no usage/role-sensitive data). Any org member can call this
// — it's just enough to populate a "pick a member" dropdown, needed by
// both the admin's "create workroom" manager picker and a workroom
// manager's "add to roster" picker. api/enterprise/usage.js stays
// admin-only and focused on usage stats; this is the low-sensitivity
// counterpart for membership lookups.

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

  const { data: membership } = await supabaseAdmin
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) {
    res.status(200).json({ members: [] });
    return;
  }

  const { data: members, error } = await supabaseAdmin
    .from('org_members')
    .select('user_id')
    .eq('org_id', membership.org_id);
  if (error) {
    res.status(500).json({ error: { message: error.message } });
    return;
  }

  const result = [];
  for (const m of members) {
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(m.user_id);
    result.push({ user_id: m.user_id, email: userData?.user?.email || '(unknown)' });
  }

  res.status(200).json({ members: result });
}
