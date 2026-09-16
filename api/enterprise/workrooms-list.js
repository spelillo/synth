// Vercel Serverless Function — lists workrooms visible to the caller: an
// org admin sees every workroom in their org (with roster); a manager sees
// only the workroom(s) where they're the manager (with roster). A regular
// member sees nothing here — workroom membership isn't a self-service view
// in v1.

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
    .select('org_id, role')
    .eq('user_id', userId)
    .maybeSingle();

  if (!membership) {
    res.status(200).json({ workrooms: [] });
    return;
  }

  let query = supabaseAdmin.from('workrooms').select('id, name, manager_id, org_id');
  query = membership.role === 'admin'
    ? query.eq('org_id', membership.org_id)
    : query.eq('manager_id', userId);

  const { data: workrooms, error: workroomsError } = await query;
  if (workroomsError) {
    res.status(500).json({ error: { message: workroomsError.message } });
    return;
  }
  if (!workrooms.length) {
    res.status(200).json({ workrooms: [] });
    return;
  }

  const workroomIds = workrooms.map((w) => w.id);
  const { data: rosterRows, error: rosterError } = await supabaseAdmin
    .from('workroom_members')
    .select('workroom_id, user_id')
    .in('workroom_id', workroomIds);
  if (rosterError) {
    res.status(500).json({ error: { message: rosterError.message } });
    return;
  }

  // Batch-resolve every member id (workroom rosters + managers) to an
  // email in one pass rather than looping auth.admin.getUserById per
  // workroom — same "fine at org scale, revisit if it ever grows" call as
  // api/enterprise/usage.js.
  const allUserIds = new Set(workrooms.map((w) => w.manager_id));
  for (const row of rosterRows) allUserIds.add(row.user_id);
  const emailById = {};
  for (const id of allUserIds) {
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(id);
    emailById[id] = userData?.user?.email || '(unknown)';
  }

  const result = workrooms.map((w) => ({
    id: w.id,
    name: w.name,
    manager_id: w.manager_id,
    manager_email: emailById[w.manager_id],
    roster: rosterRows
      .filter((r) => r.workroom_id === w.id)
      .map((r) => ({ user_id: r.user_id, email: emailById[r.user_id] })),
  }));

  res.status(200).json({ workrooms: result });
}
