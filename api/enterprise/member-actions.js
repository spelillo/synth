// Vercel Serverless Function — member-facing Enterprise write actions,
// dispatched by `op`. Consolidated from 3 route files (join.js,
// load-template.js, workroom-roster.js) to stay under Vercel Hobby's
// 12-function cap — see SYNTH_ENTERPRISE_BUILD_INSTRUCTIONS.md. Unlike
// admin.js, each op has a DIFFERENT authorization rule, done per-case.
//
// POST body: { op: 'join' | 'load_template' | 'workroom_roster', ...op-specific fields }
//
// Note: workroom_roster's own add/remove selector is named
// `roster_action` (not `action`) to avoid colliding with this file's `op`
// dispatch key.

import { createClient } from '@supabase/supabase-js';
import { getVerifiedUserId } from '../_supabaseAuth.js';
import { extractDomain } from '../_publicDomainBlocklist.js';

const SIGNED_URL_EXPIRY_SECONDS = 300;

let cachedSupabaseAdmin;
function getSupabaseAdmin() {
  if (cachedSupabaseAdmin !== undefined) return cachedSupabaseAdmin;
  cachedSupabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedSupabaseAdmin;
}

// Shared by workroom_roster's add/remove — returns the workroom's org_id if
// `userId` manages `workroomId`, else null. Does NOT let an org admin
// bypass this (see the original workroom-roster.js design note carried
// over here).
async function getManagedWorkroomOrgId(supabaseAdmin, userId, workroomId) {
  const { data: workroom } = await supabaseAdmin
    .from('workrooms').select('org_id, manager_id').eq('id', workroomId).maybeSingle();
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

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: { message: 'Server is not configured (Supabase)' } });
    return;
  }

  const op = req.body?.op;

  switch (op) {
    case 'join': {
      const token = req.body?.token;
      if (!token || typeof token !== 'string') {
        res.status(400).json({ error: { message: '"token" is required' } });
        return;
      }

      const { data: link, error: linkError } = await supabaseAdmin
        .from('org_join_links').select('org_id, revoked_at').eq('token', token).maybeSingle();
      if (linkError || !link || link.revoked_at) {
        res.status(404).json({ error: { message: 'This join link is invalid or has been revoked.' } });
        return;
      }

      const { data: org, error: orgError } = await supabaseAdmin
        .from('organizations').select('id, name, domain').eq('id', link.org_id).maybeSingle();
      if (orgError || !org) {
        res.status(404).json({ error: { message: 'This join link points to an organization that no longer exists.' } });
        return;
      }

      const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (userError || !userData?.user?.email) {
        res.status(400).json({ error: { message: 'Could not verify your account email' } });
        return;
      }

      const callerDomain = extractDomain(userData.user.email);
      if (!callerDomain || callerDomain !== org.domain) {
        res.status(403).json({ error: { message: `Your email domain doesn't match this organization (${org.domain}).` } });
        return;
      }

      const { data: existingMembership } = await supabaseAdmin
        .from('org_members').select('org_id').eq('user_id', userId).maybeSingle();
      if (existingMembership) {
        if (existingMembership.org_id === org.id) {
          res.status(200).json({ joined: true, org: { name: org.name, domain: org.domain }, alreadyMember: true });
          return;
        }
        res.status(409).json({ error: { message: 'Your account is already a member of a different organization.' } });
        return;
      }

      const { error: memberError } = await supabaseAdmin
        .from('org_members').insert({ org_id: org.id, user_id: userId, role: 'member' });
      if (memberError) { res.status(500).json({ error: { message: memberError.message } }); return; }

      const { error: profileError } = await supabaseAdmin
        .from('profiles')
        .upsert({ id: userId, is_premium: true, premium_via: 'org', org_id: org.id, updated_at: new Date().toISOString() });
      if (profileError) { res.status(500).json({ error: { message: profileError.message } }); return; }

      res.status(200).json({ joined: true, org: { name: org.name, domain: org.domain } });
      return;
    }

    case 'load_template': {
      const templateId = req.body?.template_id;
      if (!templateId) {
        res.status(400).json({ error: { message: '"template_id" is required' } });
        return;
      }

      const { data: membership } = await supabaseAdmin
        .from('org_members').select('org_id').eq('user_id', userId).maybeSingle();
      if (!membership) {
        res.status(403).json({ error: { message: 'You must be a member of an organization to load a library dataset' } });
        return;
      }

      const { data: enabled } = await supabaseAdmin
        .from('org_enabled_templates').select('template_id')
        .eq('org_id', membership.org_id).eq('template_id', templateId).maybeSingle();
      if (!enabled) {
        res.status(403).json({ error: { message: 'Your organization hasn\'t enabled this dataset' } });
        return;
      }

      const { data: template, error: templateError } = await supabaseAdmin
        .from('dataset_library_templates').select('id, name').eq('id', templateId).maybeSingle();
      if (templateError || !template) { res.status(404).json({ error: { message: 'Dataset not found' } }); return; }

      const { data: tables, error: tablesError } = await supabaseAdmin
        .from('dataset_library_tables').select('table_name, storage_path, row_count, columns').eq('template_id', templateId);
      if (tablesError || !tables?.length) {
        res.status(500).json({ error: { message: tablesError?.message || 'This dataset has no tables' } });
        return;
      }

      const { data: relationships, error: relError } = await supabaseAdmin
        .from('dataset_library_relationships')
        .select('from_table, from_column, to_table, to_column').eq('template_id', templateId);
      if (relError) { res.status(500).json({ error: { message: relError.message } }); return; }

      const tablesWithUrls = [];
      for (const table of tables) {
        const { data: signed, error: signError } = await supabaseAdmin.storage
          .from('dataset-library').createSignedUrl(table.storage_path, SIGNED_URL_EXPIRY_SECONDS);
        if (signError) {
          res.status(500).json({ error: { message: `Could not sign URL for ${table.table_name}: ${signError.message}` } });
          return;
        }
        tablesWithUrls.push({ table_name: table.table_name, row_count: table.row_count, columns: table.columns, url: signed.signedUrl });
      }

      res.status(200).json({ template: { id: template.id, name: template.name }, tables: tablesWithUrls, relationships: relationships || [] });
      return;
    }

    case 'workroom_roster': {
      const workroomId = req.body?.workroom_id;
      const rosterAction = req.body?.roster_action;
      const targetUserId = req.body?.user_id;
      if (!workroomId || !['add', 'remove'].includes(rosterAction) || !targetUserId) {
        res.status(400).json({ error: { message: '"workroom_id", "roster_action" ("add"|"remove"), and "user_id" are required' } });
        return;
      }

      const orgId = await getManagedWorkroomOrgId(supabaseAdmin, userId, workroomId);
      if (!orgId) {
        res.status(403).json({ error: { message: 'You must be this workroom\'s manager to edit its roster' } });
        return;
      }

      if (rosterAction === 'add') {
        const { data: targetMembership } = await supabaseAdmin
          .from('org_members').select('user_id').eq('org_id', orgId).eq('user_id', targetUserId).maybeSingle();
        if (!targetMembership) {
          res.status(400).json({ error: { message: 'That user isn\'t a member of your organization' } });
          return;
        }
        const { error } = await supabaseAdmin
          .from('workroom_members').upsert({ workroom_id: workroomId, user_id: targetUserId }, { onConflict: 'workroom_id,user_id' });
        if (error) { res.status(500).json({ error: { message: error.message } }); return; }
      } else {
        const { error } = await supabaseAdmin
          .from('workroom_members').delete().eq('workroom_id', workroomId).eq('user_id', targetUserId);
        if (error) { res.status(500).json({ error: { message: error.message } }); return; }
      }

      res.status(200).json({ workroom_id: workroomId, roster_action: rosterAction, user_id: targetUserId });
      return;
    }

    default:
      res.status(400).json({ error: { message: `Unknown op: ${op}` } });
  }
}
