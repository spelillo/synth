// Vercel Serverless Function — lets an org's admin create a workroom
// (class/team) and assign an existing org member as its manager. Managers
// are assigned by the admin, not self-serve — a professor stays a regular
// org_members row (role='member') until this happens; see
// SYNTH_ENTERPRISE_SPEC.md §8 decision 1.

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

  const name = req.body?.name;
  const managerUserId = req.body?.manager_user_id;
  if (!name || typeof name !== 'string' || !managerUserId) {
    res.status(400).json({ error: { message: '"name" and "manager_user_id" are required' } });
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
    res.status(403).json({ error: { message: 'Only your organization\'s admin can create a workroom' } });
    return;
  }

  // The manager must already be a member of this same org — an admin
  // can't hand manager rights to an outsider.
  const { data: managerMembership } = await supabaseAdmin
    .from('org_members')
    .select('user_id')
    .eq('org_id', membership.org_id)
    .eq('user_id', managerUserId)
    .maybeSingle();

  if (!managerMembership) {
    res.status(400).json({ error: { message: 'manager_user_id must be an existing member of your organization' } });
    return;
  }

  const { data: workroom, error: insertError } = await supabaseAdmin
    .from('workrooms')
    .insert({ org_id: membership.org_id, name, manager_id: managerUserId })
    .select('id, name, manager_id')
    .single();

  if (insertError) {
    res.status(500).json({ error: { message: insertError.message } });
    return;
  }

  res.status(200).json({ workroom });
}
