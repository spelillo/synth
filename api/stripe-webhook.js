// Vercel Serverless Function — receives Stripe webhook events.
//
// Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, and
// SUPABASE_SERVICE_ROLE_KEY in your Vercel project's Environment
// Variables. Never commit real keys into this file. The service-role key
// bypasses RLS — that's required here (this function grants premium to an
// arbitrary user by id), but never expose it to the client.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-03-25.dahlia; custom_checkout_payment_form_preview=v1',
});

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// Stripe needs the raw request body to verify the webhook signature —
// Vercel's default JSON body parsing would break that.
export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = endpointSecret
      ? stripe.webhooks.constructEvent(rawBody, signature, endpointSecret)
      : JSON.parse(rawBody.toString());
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    res.status(400).json({ error: { message: `Webhook Error: ${err.message}` } });
    return;
  }

  // Recommended events per Stripe's webhook setup for this checkout —
  // subscribe to these three when creating the endpoint in the Dashboard.
  // invoice.* only actually fires once/if mode switches to "subscription";
  // handled here now so switching later doesn't require touching this file.
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log('Checkout completed:', session.id, session.customer);

      const userId = session.client_reference_id;
      if (!userId) {
        console.error('checkout.session.completed with no client_reference_id — cannot grant premium for', session.id);
        break;
      }
      if (!supabaseAdmin) {
        console.error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured — cannot grant premium for', userId);
        break;
      }

      const { error } = await supabaseAdmin
        .from('profiles')
        .upsert({ id: userId, is_premium: true, stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() });

      if (error) {
        console.error('Failed to grant premium for', userId, error.message);
      } else {
        console.log('Granted premium to', userId);
      }
      break;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      console.log('Invoice paid:', invoice.id, invoice.customer);
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      console.log('Invoice payment failed:', invoice.id, invoice.customer);
      // TODO(stripe): once premium access exists, revoke/flag it here.
      break;
    }
    default:
      console.log('Unhandled Stripe event type:', event.type);
  }

  res.status(200).json({ received: true });
}
