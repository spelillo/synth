// Vercel Serverless Function — lets an org's admin turn a dataset library
// template on/off for their org. The org_enabled_templates row this writes
// is what api/enterprise/load-template.js checks before letting any member
// actually load the template's data.

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

  const templateId = req.body?.template_id;
  const enabled = req.body?.enabled;
  if (!templateId || typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: '"template_id" and "enabled" (boolean) are required' } });
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

  if (enabled) {
    const { error } = await supabaseAdmin
      .from('org_enabled_templates')
      .upsert({ org_id: membership.org_id, template_id: templateId }, { onConflict: 'org_id,template_id' });
    if (error) {
      res.status(500).json({ error: { message: error.message } });
      return;
    }
  } else {
    const { error } = await supabaseAdmin
      .from('org_enabled_templates')
      .delete()
      .eq('org_id', membership.org_id)
      .eq('template_id', templateId);
    if (error) {
      res.status(500).json({ error: { message: error.message } });
      return;
    }
  }

  res.status(200).json({ template_id: templateId, enabled });
}
