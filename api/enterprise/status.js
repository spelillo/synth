// Vercel Serverless Function — every Enterprise read action, dispatched by
// `?op=`. Consolidated from 5 route files (org-status.js, org-roster.js,
// usage.js, workrooms-list.js, list-templates.js) to stay under Vercel
// Hobby's 12-function cap — see SYNTH_ENTERPRISE_BUILD_INSTRUCTIONS.md.
// Unlike admin.js, these have DIFFERENT access levels per op (not a single
// shared check), so each case does its own authorization.
//
// GET ?op=org_status | org_roster | usage | workrooms | templates (default: org_status)

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

async function getMembership(supabaseAdmin, userId) {
  const { data } = await supabaseAdmin.from('org_members').select('org_id, role').eq('user_id', userId).maybeSingle();
  return data || null;
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

  const op = req.query?.op || 'org_status';

  switch (op) {
    case 'org_status': {
      const membership = await getMembership(supabaseAdmin, userId);
      if (!membership) { res.status(200).json({ role: null, org: null, enabledTemplates: [], is_manager: false }); return; }

      const { data: org, error: orgError } = await supabaseAdmin
        .from('organizations')
        .select('id, name, domain, ai_enabled, current_period_end, cancel_at_period_end')
        .eq('id', membership.org_id).maybeSingle();
      if (orgError) { res.status(500).json({ error: { message: orgError.message } }); return; }

      const { data: enabledTemplateRows } = await supabaseAdmin
        .from('org_enabled_templates')
        .select('template_id, dataset_library_templates(id, name, vertical)')
        .eq('org_id', membership.org_id);
      const enabledTemplates = (enabledTemplateRows || []).map((r) => r.dataset_library_templates).filter(Boolean);

      // A workroom manager is still org_members.role === 'member' (see
      // workrooms.sql) — the only way to tell them apart from a rank-and-file
      // member is whether any workroom names them as its manager_id. Needed
      // so the client can route a manager to the Enterprise-page dashboard
      // instead of treating them like a plain member.
      const { data: managedWorkroom } = await supabaseAdmin
        .from('workrooms').select('id').eq('manager_id', userId).limit(1).maybeSingle();

      res.status(200).json({ role: membership.role, org, enabledTemplates, is_manager: !!managedWorkroom });
      return;
    }

    case 'org_roster': {
      const membership = await getMembership(supabaseAdmin, userId);
      if (!membership) { res.status(200).json({ members: [] }); return; }

      const { data: members, error } = await supabaseAdmin
        .from('org_members').select('user_id').eq('org_id', membership.org_id);
      if (error) { res.status(500).json({ error: { message: error.message } }); return; }

      const result = [];
      for (const m of members) {
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(m.user_id);
        result.push({ user_id: m.user_id, email: userData?.user?.email || '(unknown)' });
      }
      res.status(200).json({ members: result });
      return;
    }

    case 'usage': {
      const membership = await getMembership(supabaseAdmin, userId);
      if (!membership) {
        res.status(403).json({ error: { message: 'Only your organization\'s admin or a workroom manager can view usage' } });
        return;
      }

      // Admin: every member of the org. Manager (still role === 'member' —
      // see org_status above): only the roster of workroom(s) they manage,
      // not the whole org. Anyone else (a plain member) gets the same 403
      // an admin-only check would have given them.
      let members;
      if (membership.role === 'admin') {
        const { data: orgMembers, error: membersError } = await supabaseAdmin
          .from('org_members').select('user_id, role, joined_at').eq('org_id', membership.org_id);
        if (membersError) { res.status(500).json({ error: { message: membersError.message } }); return; }
        members = orgMembers;
      } else {
        const { data: managedWorkrooms, error: workroomsError } = await supabaseAdmin
          .from('workrooms').select('id').eq('manager_id', userId);
        if (workroomsError) { res.status(500).json({ error: { message: workroomsError.message } }); return; }
        if (!managedWorkrooms?.length) {
          res.status(403).json({ error: { message: 'Only your organization\'s admin or a workroom manager can view usage' } });
          return;
        }
        const { data: rosterRows, error: rosterError } = await supabaseAdmin
          .from('workroom_members').select('user_id').in('workroom_id', managedWorkrooms.map((w) => w.id));
        if (rosterError) { res.status(500).json({ error: { message: rosterError.message } }); return; }
        const uniqueIds = [...new Set((rosterRows || []).map((r) => r.user_id))];
        members = uniqueIds.map((id) => ({ user_id: id, role: 'member', joined_at: null }));
      }
      if (!members.length) { res.status(200).json({ members: [] }); return; }

      const memberIds = members.map((m) => m.user_id);
      const daySince = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const weekSince = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

      const { data: events, error: eventsError } = await supabaseAdmin
        .from('ai_usage_events').select('user_id, created_at').in('user_id', memberIds).gte('created_at', weekSince);
      if (eventsError) { res.status(500).json({ error: { message: eventsError.message } }); return; }

      const counts = {};
      for (const id of memberIds) counts[id] = { count_24h: 0, count_7d: 0 };
      for (const event of events) {
        const bucket = counts[event.user_id];
        if (!bucket) continue;
        bucket.count_7d += 1;
        if (event.created_at >= daySince) bucket.count_24h += 1;
      }

      const result = [];
      for (const member of members) {
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(member.user_id);
        result.push({
          user_id: member.user_id,
          email: userData?.user?.email || '(unknown)',
          role: member.role,
          joined_at: member.joined_at,
          count_24h: counts[member.user_id]?.count_24h || 0,
          count_7d: counts[member.user_id]?.count_7d || 0,
        });
      }
      res.status(200).json({ members: result });
      return;
    }

    case 'workrooms': {
      const membership = await getMembership(supabaseAdmin, userId);
      if (!membership) { res.status(200).json({ workrooms: [] }); return; }

      let query = supabaseAdmin.from('workrooms').select('id, name, manager_id, org_id');
      query = membership.role === 'admin' ? query.eq('org_id', membership.org_id) : query.eq('manager_id', userId);
      const { data: workrooms, error: workroomsError } = await query;
      if (workroomsError) { res.status(500).json({ error: { message: workroomsError.message } }); return; }
      if (!workrooms.length) { res.status(200).json({ workrooms: [] }); return; }

      const workroomIds = workrooms.map((w) => w.id);
      const { data: rosterRows, error: rosterError } = await supabaseAdmin
        .from('workroom_members').select('workroom_id, user_id').in('workroom_id', workroomIds);
      if (rosterError) { res.status(500).json({ error: { message: rosterError.message } }); return; }

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
        roster: rosterRows.filter((r) => r.workroom_id === w.id).map((r) => ({ user_id: r.user_id, email: emailById[r.user_id] })),
      }));
      res.status(200).json({ workrooms: result });
      return;
    }

    case 'templates': {
      const { data: templates, error } = await supabaseAdmin
        .from('dataset_library_templates').select('id, vertical, name, description').order('created_at', { ascending: true });
      if (error) { res.status(500).json({ error: { message: error.message } }); return; }
      res.status(200).json({ templates });
      return;
    }

    default:
      res.status(400).json({ error: { message: `Unknown op: ${op}` } });
  }
}
