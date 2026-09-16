// Vercel Serverless Function — lists every dataset library template that
// exists (metadata only, no data). Any signed-in user can see what
// templates exist; whether their org can actually load one is a separate
// check in api/enterprise/load-template.js.

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

  const { data: templates, error } = await supabaseAdmin
    .from('dataset_library_templates')
    .select('id, vertical, name, description')
    .order('created_at', { ascending: true });

  if (error) {
    res.status(500).json({ error: { message: error.message } });
    return;
  }

  res.status(200).json({ templates });
}
