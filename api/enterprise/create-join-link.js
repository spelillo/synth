// Vercel Serverless Function — lets an org's admin generate a join link.
// Anyone visiting it whose verified email matches the org's domain becomes
// a member with free Premium (see api/enterprise/join.js). No cap on
// active links per org in v1 — a deliberate non-decision, not a bug.

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
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
    res.status(403).json({ error: { message: 'Only your organization\'s admin can create a join link' } });
    return;
  }

  const token = randomBytes(24).toString('base64url');

  const { error: insertError } = await supabaseAdmin
    .from('org_join_links')
    .insert({ org_id: membership.org_id, token, created_by: userId });

  if (insertError) {
    res.status(500).json({ error: { message: insertError.message } });
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${req.headers.host}/?join=${token}`;

  res.status(200).json({ token, url });
}
