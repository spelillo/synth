// Vercel Serverless Function — returns the caller's Synth Enterprise
// membership, if any. Used by synth.html's Account Settings panel to
// decide whether to show "Set up Synth Enterprise" (no org), a plain
// membership note (member of someone else's org), or the auto-renew
// toggle + renewal date (admin of an org). Also returns the org's enabled
// dataset library templates (any role) — the Cloud panel uses this to
// decide whether to show a "Dataset Library" section at all.

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
    .select('role, org_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (membershipError) {
    res.status(500).json({ error: { message: membershipError.message } });
    return;
  }
  if (!membership) {
    res.status(200).json({ role: null, org: null });
    return;
  }

  const { data: org, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id, name, domain, ai_enabled, current_period_end, cancel_at_period_end')
    .eq('id', membership.org_id)
    .maybeSingle();

  if (orgError) {
    res.status(500).json({ error: { message: orgError.message } });
    return;
  }

  const { data: enabledTemplateRows } = await supabaseAdmin
    .from('org_enabled_templates')
    .select('template_id, dataset_library_templates(id, name, vertical)')
    .eq('org_id', membership.org_id);

  const enabledTemplates = (enabledTemplateRows || [])
    .map((row) => row.dataset_library_templates)
    .filter(Boolean);

  res.status(200).json({ role: membership.role, org, enabledTemplates });
}
