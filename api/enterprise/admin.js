// Vercel Serverless Function — every admin-only Enterprise write action,
// dispatched by `op`. Consolidated from 5 separate route files
// (toggle-ai.js, toggle-auto-renew.js, enable-template.js,
// create-workroom.js, create-join-link.js) to stay under Vercel Hobby's
// 12-serverless-function-per-deployment cap — see
// SYNTH_ENTERPRISE_BUILD_INSTRUCTIONS.md's "Function count" note. All five
// require the SAME check (caller is their org's admin), so it's done once
// here instead of once per file.
//
// POST body: { op: 'toggle_ai' | 'toggle_auto_renew' | 'enable_template' |
//              'create_workroom' | 'create_join_link', ...op-specific fields }

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { getVerifiedUserId } from '../_supabaseAuth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-08-26.dahlia; custom_checkout_payment_form_preview=v1',
});

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
    res.status(403).json({ error: { message: 'Only your organization\'s admin can do this' } });
    return;
  }
  const orgId = membership.org_id;

  const op = req.body?.op;
  switch (op) {
    case 'toggle_ai': {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: { message: '"enabled" (boolean) is required' } });
        return;
      }
      const { error } = await supabaseAdmin.from('organizations').update({ ai_enabled: enabled }).eq('id', orgId);
      if (error) { res.status(500).json({ error: { message: error.message } }); return; }
      res.status(200).json({ ai_enabled: enabled });
      return;
    }

    case 'toggle_auto_renew': {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: { message: '"enabled" (boolean) is required' } });
        return;
      }
      const { data: org, error: orgError } = await supabaseAdmin
        .from('organizations').select('stripe_subscription_id').eq('id', orgId).maybeSingle();
      if (orgError || !org?.stripe_subscription_id) {
        res.status(500).json({ error: { message: 'Could not find an active subscription for your organization' } });
        return;
      }
      try {
        await stripe.subscriptions.update(org.stripe_subscription_id, { cancel_at_period_end: !enabled });
        const { error } = await supabaseAdmin.from('organizations').update({ cancel_at_period_end: !enabled }).eq('id', orgId);
        if (error) throw error;
        res.status(200).json({ cancel_at_period_end: !enabled });
      } catch (err) {
        res.status(500).json({ error: { message: err.message } });
      }
      return;
    }

    case 'enable_template': {
      const templateId = req.body?.template_id;
      const enabled = req.body?.enabled;
      if (!templateId || typeof enabled !== 'boolean') {
        res.status(400).json({ error: { message: '"template_id" and "enabled" (boolean) are required' } });
        return;
      }
      if (enabled) {
        const { error } = await supabaseAdmin
          .from('org_enabled_templates')
          .upsert({ org_id: orgId, template_id: templateId }, { onConflict: 'org_id,template_id' });
        if (error) { res.status(500).json({ error: { message: error.message } }); return; }
      } else {
        const { error } = await supabaseAdmin
          .from('org_enabled_templates').delete().eq('org_id', orgId).eq('template_id', templateId);
        if (error) { res.status(500).json({ error: { message: error.message } }); return; }
      }
      res.status(200).json({ template_id: templateId, enabled });
      return;
    }

    case 'create_workroom': {
      const name = req.body?.name;
      const managerUserId = req.body?.manager_user_id;
      if (!name || typeof name !== 'string' || !managerUserId) {
        res.status(400).json({ error: { message: '"name" and "manager_user_id" are required' } });
        return;
      }
      const { data: managerMembership } = await supabaseAdmin
        .from('org_members').select('user_id').eq('org_id', orgId).eq('user_id', managerUserId).maybeSingle();
      if (!managerMembership) {
        res.status(400).json({ error: { message: 'manager_user_id must be an existing member of your organization' } });
        return;
      }
      const { data: workroom, error } = await supabaseAdmin
        .from('workrooms').insert({ org_id: orgId, name, manager_id: managerUserId }).select('id, name, manager_id').single();
      if (error) { res.status(500).json({ error: { message: error.message } }); return; }
      res.status(200).json({ workroom });
      return;
    }

    case 'create_join_link': {
      const token = randomBytes(24).toString('base64url');
      const { error } = await supabaseAdmin.from('org_join_links').insert({ org_id: orgId, token, created_by: userId });
      if (error) { res.status(500).json({ error: { message: error.message } }); return; }
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const url = `${proto}://${req.headers.host}/?join=${token}`;
      res.status(200).json({ token, url });
      return;
    }

    default:
      res.status(400).json({ error: { message: `Unknown op: ${op}` } });
  }
}
