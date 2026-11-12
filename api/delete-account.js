// Vercel Serverless Function: lets a signed-in person delete their own
// account from Account Settings, instead of having to email us.
//
// Deletes the person's uploaded files from Storage (bucket "csvs", stored
// under <user id>/<workspace id>/...), then the auth user itself. Every
// table that points at auth.users with ON DELETE CASCADE (profiles,
// workspaces, datasets, chat sessions and messages, learn_progress,
// ai_usage_events, org_members, workroom_members) goes with it.
//
// Two references don't cascade on purpose: an Enterprise org's join links
// (org_join_links.created_by) and workrooms (workrooms.manager_id). Someone
// who runs an organization or a workroom would leave it broken, so they
// get a message to email us instead and nothing is deleted.
//
// The same account signs in to Synth BI (bi.synth-sql.com), whose
// dashboards live in a separate Supabase project with no foreign key back
// to this one. So before anything here is deleted, this asks Synth BI's
// own /api/delete-account to delete that account's dashboards, forwarding
// the caller's token. If that fails, nothing here is deleted.
// SYNTH_BI_URL overrides where that call goes (default
// https://bi.synth-sql.com).
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, already set for the
// other API routes.

import { createClient } from '@supabase/supabase-js';
import { getVerifiedUserId } from './_supabaseAuth.js';

const BUCKET = 'csvs';

let cachedClient;
function getSupabaseAdmin() {
  if (cachedClient !== undefined) return cachedClient;
  cachedClient = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedClient;
}

// Storage's list() isn't recursive, so walk <user id>/ one folder at a
// time. A folder entry comes back with id === null.
export async function listAllPaths(supabase, prefix) {
  const paths = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: pageSize, offset });
    if (error) throw new Error(error.message);
    for (const entry of data) {
      const path = `${prefix}/${entry.name}`;
      if (entry.id === null) paths.push(...await listAllPaths(supabase, path));
      else paths.push(path);
    }
    if (data.length < pageSize) break;
  }
  return paths;
}

export async function blocksDeletion(supabase, userId) {
  // Plain selects (not head/count requests) so a missing table comes back
  // with its error code instead of a bodiless HEAD failure.
  const checks = [
    supabase.from('org_members').select('org_id').eq('user_id', userId).eq('role', 'admin').limit(1),
    supabase.from('workrooms').select('id').eq('manager_id', userId).limit(1),
    supabase.from('org_join_links').select('id').eq('created_by', userId).limit(1),
  ];
  for (const { data, error } of await Promise.all(checks)) {
    // A missing table (Enterprise migrations never run) can't block anything.
    if (error) {
      if (['42P01', 'PGRST205'].includes(error.code)) continue;
      throw new Error(error.message);
    }
    if (data && data.length) return true;
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const userId = await getVerifiedUserId(req);
  if (!userId) {
    res.status(401).json({ error: { message: 'Sign in again, then try deleting your account.' } });
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).json({ error: { message: 'Server is not configured (Supabase)' } });
    return;
  }

  try {
    if (await blocksDeletion(supabase, userId)) {
      res.status(409).json({ error: { message: 'You run a Synth Enterprise organization or workroom, so your account can\'t be deleted from here without breaking it for your members. Email synth.sql@gmail.com and we\'ll sort it out with you.' } });
      return;
    }

    const biBase = (process.env.SYNTH_BI_URL || 'https://bi.synth-sql.com').replace(/\/$/, '');
    const bi = await fetch(`${biBase}/api/delete-account`, {
      method: 'POST',
      headers: { Authorization: req.headers['authorization'] },
    });
    if (!bi.ok) {
      const body = await bi.json().catch(() => null);
      throw new Error(`Synth BI data: ${body?.error || `request failed (${bi.status})`}`);
    }

    const paths = await listAllPaths(supabase, userId);
    for (let i = 0; i < paths.length; i += 1000) {
      const { error } = await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 1000));
      if (error) throw new Error(error.message);
    }

    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
  } catch (err) {
    res.status(500).json({ error: { message: `Couldn't finish deleting your account (${err.message}). Email synth.sql@gmail.com and we'll finish it by hand.` } });
    return;
  }

  res.status(200).json({ deleted: true });
}
