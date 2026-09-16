// Vercel Serverless Function — creates a Stripe Checkout Session for
// Synth Enterprise (yearly subscription, per org). Mirrors
// api/create-checkout-session.js's pattern (same embedded Checkout Form),
// but:
// - verifies the caller's email domain isn't a public provider (see
//   api/_publicDomainBlocklist.js) before creating anything
// - creates a pending_organizations row first, and uses ITS id as
//   client_reference_id (not the user id) so the webhook can tell an
//   Enterprise checkout apart from a personal Premium one
// - tags the session with metadata.type = 'enterprise' as the explicit
//   discriminator the webhook branches on
//
// NOTE — pricing model changed from the original spec: SYNTH_ENTERPRISE_SPEC.md
// locked this as a flat one-time fee specifically to avoid subscription
// lifecycle handling. This is now `mode: 'subscription'` (yearly) per an
// explicit decision to switch. What's NOT yet built as a result: nothing in
// api/stripe-webhook.js reacts to `invoice.payment_failed` or
// `customer.subscription.deleted` by disabling the org — a lapsed
// subscription currently leaves every member's org-granted Premium active
// forever. See STRIPE_INTEGRATION_TODO.md before charging a real school.
//
// Env vars needed (in addition to the ones api/create-checkout-session.js
// already requires): STRIPE_ENTERPRISE_PRICE_ID — the yearly recurring
// Stripe Price id, created in Checkout Studio / the Stripe Dashboard. Not
// hardcoded here on purpose: creating that Price object is a real,
// billable action on your Stripe account and has to be done by you, once,
// in the Dashboard.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getVerifiedUserId } from '../_supabaseAuth.js';
import { isPublicEmailDomain, extractDomain } from '../_publicDomainBlocklist.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  // Bumped to match the live Checkout Studio config for this checkout
  // (screen shows Stripe-Version: 2026-08-26.dahlia; ...) — deliberately
  // NOT changed in api/create-checkout-session.js or api/stripe-webhook.js,
  // which stay pinned to 2026-03-25.dahlia for the personal Premium flow.
  // Multiple API versions can coexist; Stripe versions each webhook
  // endpoint independently of the version used to create a session.
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

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_ENTERPRISE_PRICE_ID) {
    res.status(500).json({ error: { message: 'Enterprise checkout is not configured on the server' } });
    return;
  }

  const userId = await getVerifiedUserId(req);
  if (!userId) {
    res.status(401).json({ error: { message: 'Sign in required before checkout' } });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: { message: 'Server is not configured (Supabase)' } });
    return;
  }

  // org_members.user_id is unique (one org per account — see
  // supabase/migrations/20260919000000_org_members_single_org.sql). Check
  // BEFORE starting a paid checkout: without this, someone already in an
  // org could pay for a new one, and the webhook's org_members insert
  // would fail against that constraint after the charge went through —
  // money taken, no org created.
  const { data: existingMembership } = await supabaseAdmin
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (existingMembership) {
    res.status(409).json({ error: { message: 'Your account is already a member of an organization. Only one organization membership is supported per account.' } });
    return;
  }

  // getVerifiedUserId only returns an id, not the email — fetch the real,
  // server-verified email the same way api/enterprise/join.js will, rather
  // than trusting anything the client sent in the request body.
  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userError || !userData?.user?.email) {
    res.status(400).json({ error: { message: 'Could not verify your account email' } });
    return;
  }

  const domain = extractDomain(userData.user.email);
  if (!domain) {
    res.status(400).json({ error: { message: 'Your account email is not valid for Enterprise signup' } });
    return;
  }
  if (isPublicEmailDomain(domain)) {
    res.status(400).json({
      error: { message: `${domain} is a public email provider and can't be used as an Enterprise organization domain. Sign up with your school or company email.` },
    });
    return;
  }

  // One domain, one org. If it's already claimed, don't let a second
  // person start a duplicate (paid) checkout for it.
  const { data: existingOrg } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('domain', domain)
    .maybeSingle();
  if (existingOrg) {
    res.status(409).json({ error: { message: `${domain} already has a Synth Enterprise organization. Ask your admin for the join link instead of signing up again.` } });
    return;
  }

  try {
    const { data: pendingOrg, error: pendingError } = await supabaseAdmin
      .from('pending_organizations')
      .insert({ domain, admin_user_id: userId })
      .select('id')
      .single();
    if (pendingError) throw pendingError;

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const returnUrl = `${proto}://${req.headers.host}/?enterprise_checkout=success`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      ui_mode: 'form',
      return_url: returnUrl,
      // The webhook uses this to find the pending_organizations row to
      // fulfill — deliberately NOT the user id (that's what the personal
      // Premium checkout uses; metadata.type below is what tells them apart).
      client_reference_id: pendingOrg.id,
      metadata: { type: 'enterprise', domain },
      line_items: [{ price: process.env.STRIPE_ENTERPRISE_PRICE_ID, quantity: 1 }],
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: false },
      automatic_tax: { enabled: false },
      // Only valid (and only included) in subscription mode.
      payment_method_collection: 'always',
      submit_type: 'auto',
      integration_identifier: 'custom_embedded_web_0003',
    });

    // Keep the pending row's stripe_checkout_session_id in sync so a
    // support/debug lookup can go pending_organizations -> Stripe directly.
    await supabaseAdmin
      .from('pending_organizations')
      .update({ stripe_checkout_session_id: session.id })
      .eq('id', pendingOrg.id);

    res.status(200).json({ client_secret: session.client_secret });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
}
