// Vercel Serverless Function — lets a workroom's manager add/remove org
// members from that workroom's roster. This is the most authorization-
// sensitive route in Child 5: a manager must be blocked from touching any
// workroom but their own, and from adding anyone who isn't already an
// org_member (a manager can't pull in an outsider). Both actions share one
// isWorkroomManager check rather than inlining it twice, per
// SYNTH_ENTERPRISE_BUILD_INSTRUCTIONS.md Step 5.2.

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

// Returns the workroom's org_id if `userId` manages `workroomId`, else null.
// Deliberately does NOT let an org admin bypass this — the spec draws a
// hard line between "org admin" and "workroom manager" (acceptance
// criterion 9: a manager can't touch org-level settings; the converse also
// holds here, an admin who isn't the assigned manager can't edit a
// specific workroom's roster through this route).
async function getManagedWorkroomOrgId(supabaseAdmin, userId, workroomId) {
  const { data: workroom } = await supabaseAdmin
    .from('workrooms')
    .select('org_id, manager_id')
    .eq('id', workroomId)
    .maybeSingle();
  if (!workroom || workroom.manager_id !== userId) return null;
  return workroom.org_id;
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

  const { workroom_id: workroomId, action, user_id: targetUserId } = req.body || {};
  if (!workroomId || !['add', 'remove'].includes(action) || !targetUserId) {
    res.status(400).json({ error: { message: '"workroom_id", "action" ("add"|"remove"), and "user_id" are required' } });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: { message: 'Server is not configured (Supabase)' } });
    return;
  }

  const orgId = await getManagedWorkroomOrgId(supabaseAdmin, userId, workroomId);
  if (!orgId) {
    res.status(403).json({ error: { message: 'You must be this workroom\'s manager to edit its roster' } });
    return;
  }

  if (action === 'add') {
    const { data: targetMembership } = await supabaseAdmin
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', targetUserId)
      .maybeSingle();
    if (!targetMembership) {
      res.status(400).json({ error: { message: 'That user isn\'t a member of your organization' } });
      return;
    }

    const { error } = await supabaseAdmin
      .from('workroom_members')
      .upsert({ workroom_id: workroomId, user_id: targetUserId }, { onConflict: 'workroom_id,user_id' });
    if (error) {
      res.status(500).json({ error: { message: error.message } });
      return;
    }
  } else {
    const { error } = await supabaseAdmin
      .from('workroom_members')
      .delete()
      .eq('workroom_id', workroomId)
      .eq('user_id', targetUserId);
    if (error) {
      res.status(500).json({ error: { message: error.message } });
      return;
    }
  }

  res.status(200).json({ workroom_id: workroomId, action, user_id: targetUserId });
}
