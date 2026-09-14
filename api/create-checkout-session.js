// Vercel Serverless Function — creates a Stripe Checkout Session for the
// embedded payment form (Custom Checkout / initCheckoutFormSdk on the
// client, see synth.html). Mirrors api/chat.js's pattern: no framework,
// just a handler reading process.env.
//
// Set STRIPE_SECRET_KEY in your Vercel project's Environment Variables
// (Project Settings -> Environment Variables). Never commit a real key
// into this file.

import Stripe from 'stripe';
import { getVerifiedUserId } from './_supabaseAuth.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  // Required for the embedded Checkout Form (initCheckoutFormSdk) used in
  // synth.html — do not change without also updating the client. Pulled
  // directly from the checkout configured in Stripe's Checkout Studio.
  apiVersion: '2026-03-25.dahlia; custom_checkout_payment_form_preview=v1',
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: { message: 'STRIPE_SECRET_KEY is not configured on the server' } });
    return;
  }

  // The client only shows "Go Premium" when signed in, but that's just UI.
  // client_reference_id is how the webhook knows which Supabase user to
  // grant premium to, so it has to come from a verified session, not a
  // client-supplied field a request could claim to be anyone's id.
  const userId = await getVerifiedUserId(req);
  if (!userId) {
    res.status(401).json({ error: { message: 'Sign in required before checkout' } });
    return;
  }

  try {
    // Some payment methods (3D Secure, wallets) redirect the customer away
    // and back, so a payment-mode Checkout Session requires a return_url —
    // Stripe's own sample omitted this. Computed from the request so it
    // works on prod, preview deploys, and local dev without hardcoding a
    // domain.
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const returnUrl = `${proto}://${req.headers.host}/?checkout=success`;

    // Parameters below match the checkout configured in Stripe's Checkout
    // Studio exactly (mode: "payment" — a one-time charge, not a
    // subscription). If premium should actually renew, change `mode` to
    // "subscription" here and re-add `payment_method_collection: "if_required"`
    // — it's only valid in subscription mode.
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ui_mode: 'form',
      return_url: returnUrl,
      // Ties this session back to a Supabase user — the webhook reads this
      // to know whose profiles.is_premium to flip on.
      client_reference_id: userId,
      // Synth Premium — $9.99 one-time (price_1UEAIYRqXDpXXBnZ1F8tb0r7, test mode)
      line_items: [{ price: 'price_1UEAIYRqXDpXXBnZ1F8tb0r7', quantity: 1 }],
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: false },
      automatic_tax: { enabled: false },
      submit_type: 'auto',
      integration_identifier: 'custom_embedded_web_0002',
    });

    res.status(200).json({ client_secret: session.client_secret });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
}
