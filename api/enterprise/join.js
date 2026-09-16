// Vercel Serverless Function — redeems a Synth Enterprise join link. This
// is the only route in the app where a user grants themselves Premium
// without paying, so the domain check MUST run against a server-verified
// email (supabaseAdmin.auth.admin.getUserById), never anything the client
// claims about itself.

import { createClient } from '@supabase/supabase-js';
import { getVerifiedUserId } from '../_supabaseAuth.js';
import { extractDomain } from '../_publicDomainBlocklist.js';

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

  const token = req.body?.token;
  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: { message: '"token" is required' } });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: { message: 'Server is not configured (Supabase)' } });
    return;
  }

  const { data: link, error: linkError } = await supabaseAdmin
    .from('org_join_links')
    .select('org_id, revoked_at')
    .eq('token', token)
    .maybeSingle();

  if (linkError || !link || link.revoked_at) {
    res.status(404).json({ error: { message: 'This join link is invalid or has been revoked.' } });
    return;
  }

  const { data: org, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id, name, domain')
    .eq('id', link.org_id)
    .maybeSingle();

  if (orgError || !org) {
    res.status(404).json({ error: { message: 'This join link points to an organization that no longer exists.' } });
    return;
  }

  // Server-verified email — never trust anything the client sends about
  // its own identity beyond the bearer token itself.
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

  // Re-clicking an already-used link shouldn't be an error state.
  const { data: existingMembership } = await supabaseAdmin
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existingMembership) {
    if (existingMembership.org_id === org.id) {
      res.status(200).json({ joined: true, org: { name: org.name, domain: org.domain }, alreadyMember: true });
      return;
    }
    // Already a member of a DIFFERENT org — v1 has no multi-org membership
    // or org-switching flow, so refuse rather than silently reassigning them.
    res.status(409).json({ error: { message: 'Your account is already a member of a different organization.' } });
    return;
  }

  const { error: memberError } = await supabaseAdmin
    .from('org_members')
    .insert({ org_id: org.id, user_id: userId, role: 'member' });
  if (memberError) {
    res.status(500).json({ error: { message: memberError.message } });
    return;
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .upsert({
      id: userId,
      is_premium: true,
      premium_via: 'org',
      org_id: org.id,
      updated_at: new Date().toISOString(),
    });
  if (profileError) {
    res.status(500).json({ error: { message: profileError.message } });
    return;
  }

  res.status(200).json({ joined: true, org: { name: org.name, domain: org.domain } });
}
