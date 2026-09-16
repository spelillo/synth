-- Synth Enterprise — subscription lifecycle tracking.
--
-- Enterprise checkout is now a yearly subscription (see
-- api/enterprise/create-checkout-session.js and STRIPE_INTEGRATION_TODO.md
-- for why this changed from the original one-time-fee spec). This adds
-- what's needed to: (1) know when an org's subscription renews, so
-- api/cron/enterprise-renewal-notices.js can warn the admin at 3mo/1mo/1wk
-- out, (2) let the admin disable/re-enable auto-renew, and (3) let
-- api/stripe-webhook.js's new customer.subscription.deleted handler find
-- the right org to tear down when a subscription actually lapses.

alter table public.organizations
  add column stripe_customer_id text,
  add column stripe_subscription_id text unique,
  add column current_period_end timestamptz,
  add column cancel_at_period_end boolean not null default false,
  -- Each reset to null whenever current_period_end moves forward (i.e. the
  -- subscription renewed) — see the customer.subscription.updated handler —
  -- so the same three notices fire again for the next year, not just once
  -- ever.
  add column notice_3mo_sent_at timestamptz,
  add column notice_1mo_sent_at timestamptz,
  add column notice_1wk_sent_at timestamptz;
