// Vercel Serverless Function — the gate in front of the dataset library's
// private storage. Returns short-lived signed URLs for a template's table
// files plus its metadata/relationships; does NOT copy any bytes itself.
//
// Why signed URLs instead of a server-side copy: every other CSV/dataset
// write in this app happens client-side via the Supabase JS SDK (anon key
// + RLS) — see the "save workspace" flow in synth.html
// (sb.storage.from('csvs').upload(...) + sb.from('datasets').insert(...)).
// This route only does the one thing the client CAN'T do itself: prove the
// caller's org has this template enabled before letting them read the
// private 'dataset-library' bucket. Once it hands back signed URLs, the
// client fetches the CSVs and saves them into its own workspace using the
// exact same upload/insert code path as a manual CSV upload — so loading a
// template needs zero new client-side SQLite-loading logic (see
// SYNTH_ENTERPRISE_SPEC.md §8, decision 3).

import { createClient } from '@supabase/supabase-js';
import { getVerifiedUserId } from '../_supabaseAuth.js';

const SIGNED_URL_EXPIRY_SECONDS = 300; // plenty for the client to fetch all tables right after this call

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
  if (!templateId) {
    res.status(400).json({ error: { message: '"template_id" is required' } });
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
    res.status(403).json({ error: { message: 'You must be a member of an organization to load a library dataset' } });
    return;
  }

  const { data: enabled } = await supabaseAdmin
    .from('org_enabled_templates')
    .select('template_id')
    .eq('org_id', membership.org_id)
    .eq('template_id', templateId)
    .maybeSingle();

  if (!enabled) {
    res.status(403).json({ error: { message: 'Your organization hasn\'t enabled this dataset' } });
    return;
  }

  const { data: template, error: templateError } = await supabaseAdmin
    .from('dataset_library_templates')
    .select('id, name')
    .eq('id', templateId)
    .maybeSingle();
  if (templateError || !template) {
    res.status(404).json({ error: { message: 'Dataset not found' } });
    return;
  }

  const { data: tables, error: tablesError } = await supabaseAdmin
    .from('dataset_library_tables')
    .select('table_name, storage_path, row_count, columns')
    .eq('template_id', templateId);
  if (tablesError || !tables?.length) {
    res.status(500).json({ error: { message: tablesError?.message || 'This dataset has no tables' } });
    return;
  }

  const { data: relationships, error: relError } = await supabaseAdmin
    .from('dataset_library_relationships')
    .select('from_table, from_column, to_table, to_column')
    .eq('template_id', templateId);
  if (relError) {
    res.status(500).json({ error: { message: relError.message } });
    return;
  }

  const tablesWithUrls = [];
  for (const table of tables) {
    const { data: signed, error: signError } = await supabaseAdmin.storage
      .from('dataset-library')
      .createSignedUrl(table.storage_path, SIGNED_URL_EXPIRY_SECONDS);
    if (signError) {
      res.status(500).json({ error: { message: `Could not sign URL for ${table.table_name}: ${signError.message}` } });
      return;
    }
    tablesWithUrls.push({
      table_name: table.table_name,
      row_count: table.row_count,
      columns: table.columns,
      url: signed.signedUrl,
    });
  }

  res.status(200).json({
    template: { id: template.id, name: template.name },
    tables: tablesWithUrls,
    relationships: relationships || [],
  });
}
