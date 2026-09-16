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

// api/enterprise/create-checkout-session.js creates Enterprise sessions on
// a newer pinned API version — used here only when retrieving the
// subscription that session produced, so the shape matches what created it.
const stripeEnterprise = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2026-08-26.dahlia; custom_checkout_payment_form_preview=v1',
});

const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// Stripe has moved current_period_end around between API versions (older:
// top-level on the Subscription; newer: per subscription item). Read
// whichever shape is actually present rather than assuming one.
function getSubscriptionPeriodEnd(subscription) {
  const unixSeconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

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

  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) {
    // Never fall back to parsing the body unverified — that would let
    // anyone POST a fake checkout.session.completed and grant themselves
    // premium. A misconfigured secret should fail loudly, not silently.
    console.error('STRIPE_WEBHOOK_SECRET is not configured — refusing to process webhook');
    res.status(500).json({ error: { message: 'Webhook not configured' } });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, endpointSecret);
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

      if (!supabaseAdmin) {
        console.error('SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured — cannot fulfill', session.id);
        break;
      }

      // Synth Enterprise checkout (api/enterprise/create-checkout-session.js)
      // tags its session with metadata.type = 'enterprise' and uses
      // client_reference_id for a pending_organizations row, not a user id —
      // that's the discriminator from the personal Premium checkout below.
      if (session.metadata?.type === 'enterprise') {
        const pendingOrgId = session.client_reference_id;
        if (!pendingOrgId) {
          console.error('enterprise checkout.session.completed with no client_reference_id — cannot fulfill', session.id);
          break;
        }

        const { data: pendingOrg, error: pendingFetchError } = await supabaseAdmin
          .from('pending_organizations')
          .select('id, domain, admin_user_id, status')
          .eq('id', pendingOrgId)
          .maybeSingle();

        if (pendingFetchError || !pendingOrg) {
          console.error('Could not find pending_organizations row', pendingOrgId, pendingFetchError?.message);
          break;
        }
        if (pendingOrg.status === 'fulfilled') {
          // Stripe can redeliver the same event — this is the idempotency
          // guard so a retry doesn't create a second organizations row.
          console.log('pending_organizations', pendingOrgId, 'already fulfilled, skipping');
          break;
        }

        // Enterprise is now a subscription (see STRIPE_INTEGRATION_TODO.md) —
        // capture the subscription/customer id and current period end so
        // the auto-renew toggle and renewal-notice cron have something to
        // work from.
        let subscriptionId = null;
        let customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
        let currentPeriodEnd = null;
        if (session.subscription) {
          try {
            const subscription = await stripeEnterprise.subscriptions.retrieve(session.subscription);
            subscriptionId = subscription.id;
            currentPeriodEnd = getSubscriptionPeriodEnd(subscription);
          } catch (subErr) {
            console.error('Could not retrieve subscription', session.subscription, subErr.message);
          }
        } else {
          console.error('enterprise checkout.session.completed with no session.subscription — expected mode: "subscription"', session.id);
        }

        const { data: org, error: orgError } = await supabaseAdmin
          .from('organizations')
          .insert({
            name: pendingOrg.domain,
            domain: pendingOrg.domain,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            current_period_end: currentPeriodEnd,
          })
          .select('id')
          .single();

        if (orgError) {
          console.error('Failed to create organization for', pendingOrgId, orgError.message);
          break;
        }

        const { error: memberError } = await supabaseAdmin
          .from('org_members')
          .insert({ org_id: org.id, user_id: pendingOrg.admin_user_id, role: 'admin' });

        if (memberError) {
          console.error('Failed to add admin org_member for org', org.id, memberError.message);
          break;
        }

        const { error: profileError } = await supabaseAdmin
          .from('profiles')
          .upsert({
            id: pendingOrg.admin_user_id,
            is_premium: true,
            premium_via: 'org',
            org_id: org.id,
            stripe_checkout_session_id: session.id,
            updated_at: new Date().toISOString(),
          });
        if (profileError) {
          console.error('Failed to grant premium to admin', pendingOrg.admin_user_id, profileError.message);
        }

        await supabaseAdmin
          .from('pending_organizations')
          .update({ status: 'fulfilled', stripe_checkout_session_id: session.id })
          .eq('id', pendingOrgId);

        console.log('Created organization', org.id, 'for domain', pendingOrg.domain);
        break;
      }

      // Personal Premium checkout (api/create-checkout-session.js) —
      // client_reference_id is a Supabase user id.
      const userId = session.client_reference_id;
      if (!userId) {
        console.error('checkout.session.completed with no client_reference_id — cannot grant premium for', session.id);
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
      // A failed renewal charge doesn't by itself end the subscription —
      // Stripe retries per its own retry schedule, then fires
      // customer.subscription.deleted if every retry fails. Nothing to do
      // here yet for the personal one-time charge (it isn't a subscription,
      // so this event never fires for it); the Enterprise teardown lives in
      // customer.subscription.deleted below.
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      if (!supabaseAdmin) break;

      const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('id, current_period_end')
        .eq('stripe_subscription_id', subscription.id)
        .maybeSingle();
      if (!org) break; // not an Enterprise subscription (or already torn down)

      const newPeriodEnd = getSubscriptionPeriodEnd(subscription);
      const renewed = newPeriodEnd && (!org.current_period_end || newPeriodEnd.getTime() > new Date(org.current_period_end).getTime());

      const update = {
        current_period_end: newPeriodEnd,
        cancel_at_period_end: !!subscription.cancel_at_period_end,
      };
      if (renewed) {
        // A new billing period started — let the three renewal notices
        // fire again for it instead of staying permanently "already sent."
        update.notice_3mo_sent_at = null;
        update.notice_1mo_sent_at = null;
        update.notice_1wk_sent_at = null;
      }

      const { error } = await supabaseAdmin.from('organizations').update(update).eq('id', org.id);
      if (error) console.error('Failed to update organization for subscription', subscription.id, error.message);
      else console.log('Updated organization', org.id, 'for subscription', subscription.id, renewed ? '(renewed)' : '');
      break;
    }
    case 'customer.subscription.deleted': {
      // Fires when a subscription actually ends — either it ran out its
      // cancel_at_period_end grace period, or every payment retry failed.
      // Per the locked decision: wipe the org's data (org_members and
      // org_join_links today — ON DELETE CASCADE from organizations; will
      // also cascade to workrooms/workroom_members once those tables exist,
      // no code change needed here when that ships), revoke every member's
      // org-granted Premium, and free up the domain to be claimed again.
      // Does NOT touch anyone's actual Synth login/account — only org
      // membership and Premium status.
      const subscription = event.data.object;
      if (!supabaseAdmin) break;

      const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('id, domain')
        .eq('stripe_subscription_id', subscription.id)
        .maybeSingle();
      if (!org) {
        console.log('customer.subscription.deleted for', subscription.id, '— no matching organization (already torn down?)');
        break;
      }

      const { error: revokeError } = await supabaseAdmin
        .from('profiles')
        .update({ is_premium: false, premium_via: 'purchase', org_id: null, updated_at: new Date().toISOString() })
        .eq('org_id', org.id);
      if (revokeError) {
        console.error('Failed to revoke org-granted premium for org', org.id, revokeError.message);
        break; // don't delete the org if members might still show as org-premium
      }

      const { error: deleteError } = await supabaseAdmin.from('organizations').delete().eq('id', org.id);
      if (deleteError) {
        console.error('Failed to delete organization', org.id, deleteError.message);
      } else {
        console.log('Subscription ended — wiped organization', org.id, 'for domain', org.domain);
      }
      break;
    }
    default:
      console.log('Unhandled Stripe event type:', event.type);
  }

  res.status(200).json({ received: true });
}
