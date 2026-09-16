// Vercel Serverless Function — lets an org's admin enable/disable
// auto-renewal on their Enterprise subscription. Disabling does NOT cancel
// immediately: Stripe's `cancel_at_period_end` keeps the subscription (and
// everyone's org-granted Premium) active through the end of the current
// paid year, then lets it lapse instead of charging again. Re-enabling
// before that date just flips the flag back — no new charge happens until
// the existing renewal date either way.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
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

  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: '"enabled" (boolean) is required' } });
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
    res.status(403).json({ error: { message: 'Only your organization\'s admin can change auto-renewal' } });
    return;
  }

  const { data: org, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id, stripe_subscription_id')
    .eq('id', membership.org_id)
    .maybeSingle();

  if (orgError || !org?.stripe_subscription_id) {
    res.status(500).json({ error: { message: 'Could not find an active subscription for your organization' } });
    return;
  }

  try {
    await stripe.subscriptions.update(org.stripe_subscription_id, { cancel_at_period_end: !enabled });

    const { error: updateError } = await supabaseAdmin
      .from('organizations')
      .update({ cancel_at_period_end: !enabled })
      .eq('id', org.id);
    if (updateError) throw updateError;

    res.status(200).json({ cancel_at_period_end: !enabled });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
}
