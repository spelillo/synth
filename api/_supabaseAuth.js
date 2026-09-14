// Shared helper for API routes that must not trust a client-supplied user
// id. Verifies the `Authorization: Bearer <access_token>` header against
// Supabase Auth and returns the real user id it belongs to, or null.
//
// Not itself a route: it has no default export, so Vercel doesn't turn it
// into an endpoint, only bundles it for the files that import it.

import { createClient } from '@supabase/supabase-js';

let cachedClient;

function getSupabaseAdmin() {
  if (cachedClient !== undefined) return cachedClient;
  cachedClient = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedClient;
}

export async function getVerifiedUserId(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}
