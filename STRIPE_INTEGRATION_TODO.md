# Stripe Integration — TODO

This is the single source of truth for what's left before Premium checkout can go live. Synth had no existing Stripe code, so this was a from-scratch integration (Scenario B) using an embedded Checkout Form (Stripe-hosted iframe via `initCheckoutFormSdk`), not a redirect-based Checkout.

## Checkout reconfigured (Scenario A update)

The checkout was re-configured in Stripe's Checkout Studio and re-synced against the existing `stripe.checkout.sessions.create(...)` call in [api/create-checkout-session.js](api/create-checkout-session.js) (Scenario A — an existing call was found, so only its parameters were updated, not the surrounding code):

- **Added** `phone_number_collection: { enabled: false }` and `automatic_tax: { enabled: false }` — newly present in the Checkout Studio config, weren't set before.
- **`payment_method_collection`** (Checkout Studio value: `"if_required"`) was intentionally **not** added — it's only valid in `mode: "subscription"`, and this checkout stays `mode: "payment"` (a one-time charge).
- **API version** bumped to `2026-03-25.dahlia; custom_checkout_payment_form_preview=v1` in both [api/create-checkout-session.js](api/create-checkout-session.js) and [api/stripe-webhook.js](api/stripe-webhook.js), per the new integration instructions (was `2026-08-26.dahlia; ...`).
- **`mode: "payment"`** and **`line_items`** (the real `price_1UEAIYRqXDpXXBnZ1F8tb0r7`) were left untouched — Checkout Studio treats these as placeholders to be replaced only when missing/placeholder-like, and this app already has real, correct values here.
- **Judgment call — `return_url` and `client_reference_id` were kept**, even though neither appears in Checkout Studio's field list. Both predate this reconfiguration and are load-bearing: `return_url` is required for a `payment`-mode Checkout Session's `confirm()` to work (some payment methods redirect away and back — 3D Secure, wallets); `client_reference_id` is how the webhook knows which Supabase user to grant premium to. Removing either would silently break checkout or premium-granting, and neither is a Checkout Studio "appearance/behavior" knob — they're integration-specific wiring outside that config's scope, so they were left alone rather than deleted per a literal reading of "remove parameters absent from the field intents."

Part 2 (client-side) required no changes — [synth.html](synth.html) already loads `stripe.js` from the `dahlia` build, initializes with `betas: ['custom_checkout_payment_form_1']`, posts to an endpoint that returns `{ client_secret }` as JSON, and wires `initCheckoutFormSdk` → `createForm` → `mount` → `loadActions` → `confirm` exactly per spec.

## Status: live and working in test mode

Checkout is fully deployed and verified at `https://vercel-nine-zeta-17.vercel.app` — real Stripe keys, a real Price, a real webhook endpoint, all wired up. Nothing left in "Values to Replace."

One bug found and fixed after Stripe's own generated sample omitted it: **`return_url`** is required on a `payment`-mode Checkout Session (some payment methods redirect the customer away and back — 3D Secure, wallets). Without it, confirming a payment threw `IntegrationError: You must provide a returnUrl on confirm()...`. Fixed in [api/create-checkout-session.js](api/create-checkout-session.js) by computing it from the incoming request (`https://<host>/?checkout=success`), so it's correct on production, preview deploys, and local dev without hardcoding a domain.

## Premium access is now real, not just a checkout form

The gap flagged earlier — "checkout works but doesn't unlock anything" — is closed:

- A new `public.profiles` table (`id`, `is_premium`, `stripe_checkout_session_id`, `updated_at`) was added via [supabase/migrations/20260910153000_profiles_premium.sql](supabase/migrations/20260910153000_profiles_premium.sql) and pushed live with `supabase db push`. RLS lets a user read their own row and revoke their own `is_premium`, but never grant it themselves — only the webhook (service-role key, bypasses RLS) can set it `true`.
- [api/create-checkout-session.js](api/create-checkout-session.js) now requires `userId` in the request body and passes it as `client_reference_id`; the client sends `currentUser.id`, and the endpoint 400s without it — a server-side backstop, not just a UI gate.
- [api/stripe-webhook.js](api/stripe-webhook.js) reads `client_reference_id` off `checkout.session.completed` and upserts `profiles.is_premium = true` using a Supabase admin client (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, both set in Vercel and `.env.local`).
- [synth.html](synth.html): `refreshPremiumStatus()` loads the flag after sign-in; the header button becomes **Premium ✓** once granted; clicking your email opens a new **Account Settings** modal showing plan status and, if premium, a **Cancel Premium** button (with a confirmation step) that flips the flag back to `false` — self-service, no refund, no Stripe API call (this was a one-time charge, not a subscription, so there's nothing on Stripe's side to cancel).
- **Sign-in is now required before checkout** — clicking "Go Premium" while signed out shows a "Sign in to go Premium" modal instead of opening the payment form.
- Verified end-to-end against the live database (create a test user → grant → read → cancel → read → delete test user) before deploying — all steps behaved exactly as the app now uses them.

**Still worth knowing:** this is a one-time $9.99 charge, not a subscription — "Cancel Premium" only revokes the locally-tracked flag, it does not refund the payment. If premium should ever expire/renew automatically, that requires switching `mode` to `"subscription"` (a bigger change, revisits pricing/mode decisions from earlier) and using real Stripe subscription cancellation instead of a local flag flip.

**`STRIPE_WEBHOOK_SECRET` is set** — both in Vercel and `.env.local`, from a real webhook endpoint (`we_1UEAfWRqXDpXXBnZUcizYomI`) created via the Stripe API, pointed at the live `/api/stripe-webhook` route, subscribed to the three recommended events.

**`line_items[].price` is set** — `price_1UEAIYRqXDpXXBnZ1F8tb0r7` in [api/create-checkout-session.js](api/create-checkout-session.js): a one-time, $9.99 USD test-mode price for "Synth Premium" (`type: "one_time"`, `recurring: null` — matches `mode: "payment"` correctly, no mismatch). **This is a test-mode price** (`livemode: false`) — when you're ready to actually charge real cards, create the equivalent live Product/Price in Stripe's live mode and swap this ID, along with switching to live publishable/secret keys.

**`STRIPE_PUBLISHABLE_KEY` is set** — the real test-mode key (`pk_test_...51UE9ru...tZ4ezyyk`) is hardcoded in `synth.html`, same as `SUPABASE_ANON_KEY`. Publishable keys are meant to be public, so no rotation concern there even though it was pasted in chat.

**`STRIPE_SECRET_KEY` is already set** — in `.env.local` (gitignored) for local dev. **Still needed: add the same value to Vercel's Environment Variables (Project Settings → Environment Variables) before deploying** — `.env.local` never leaves your machine. One flag: this key was pasted in plaintext during this chat session. It's test-mode (`sk_test_`) so the real-world risk is low, but the general rule is any key that's been pasted somewhere outside a secrets manager is worth rotating from the Dashboard eventually, and never do this with a live (`sk_live_`) key.

## Configured Parameters

These parameters were configured in Checkout Studio and are already set correctly in [api/create-checkout-session.js](api/create-checkout-session.js) — pulled directly from the checkout configured in your Stripe account, not the generic template this integration started from.

| Parameter | Value |
|-----------|-------|
| `mode` | `"payment"` — a one-time charge. If premium should actually renew, change this to `"subscription"` and re-add `payment_method_collection: "if_required"` (only valid in subscription mode). |
| `ui_mode` | `"form"` (Stripe SDK `^22.6.2` is ≥ 21.0.0, so `"form"` is correct — see `package.json`) |
| `billing_address_collection` | `"auto"` |
| `phone_number_collection` | `{ enabled: false }` |
| `automatic_tax` | `{ enabled: false }` |
| `submit_type` | `"auto"` |
| `integration_identifier` | `"custom_embedded_web_0002"` |

The Stripe SDK is pinned to API version `2026-03-25.dahlia; custom_checkout_payment_form_preview=v1` (required for the embedded Checkout Form beta) in both [api/create-checkout-session.js](api/create-checkout-session.js) and [api/stripe-webhook.js](api/stripe-webhook.js).

## Setup and Next Steps

### Environment variables

Add to your Vercel project (Project Settings → Environment Variables) — **not** to `synth.html`, which is public:

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

For local testing with `vercel dev`, add the same to `.env.local` (already gitignored in this repo).

### Install the dependency

`stripe` was added to `package.json` (`^22.6.2`) but needs an actual install:

```bash
npm install
```

### Project structure — what's new

```
api/
  create-checkout-session.js   # creates the Checkout Session, returns { client_secret }
  stripe-webhook.js            # verifies + logs Stripe webhook events
synth.html                     # + Stripe.js script tag, publishable key, "Go Premium"
                                #   button, checkout modal, initCheckoutFormSdk wiring
STRIPE_INTEGRATION_TODO.md     # this file
```

### How it works

1. User clicks **Go Premium** in the header → opens a modal and calls `startPremiumCheckout()`.
2. That does `POST /api/create-checkout-session`, which creates a Stripe Checkout Session in `payment` mode and returns `{ client_secret }` (JSON, not a redirect — required for the embedded form).
3. The client calls `stripe.initCheckoutFormSdk({ clientSecret, appearance })`, mounts the form into `#checkout-form` (a Stripe-hosted iframe), and wires the `confirm` event to `loadActionsResult.actions.confirm(...)`.
4. On success, Stripe fires a `checkout.session.completed` webhook to `/api/stripe-webhook`, which is verified and logged.

### What's deliberately NOT done yet

**Granting premium access.** The webhook currently only logs `checkout.session.completed` — it does not flip anything to unlock the multi-table features from the [Multi-Table Workspaces spec](https://claude.ai/code/artifact/a9234f0f-178e-4811-8ddd-4e8d6b9ecd42). This app has no existing "is this user premium?" model (no subscriptions table, no flag on the Supabase user), and inventing one wasn't part of a minimal Stripe integration. Before this can actually gate anything:

- Decide where premium status lives — most natural fit is a new column or table in the existing Supabase schema (`supabase/schema.sql`), keyed by the Supabase user id.
- Pass that user id into Checkout as `client_reference_id` when creating the session, so the webhook can tie `checkout.session.completed` back to a specific Synth account.
- Have the client check that flag (after sign-in) to decide whether to show the multi-table UI or the "Go Premium" upsell.

**Fulfillment beyond logging** — cancellations, failed payments, subscription renewals (`customer.subscription.updated`/`.deleted`) aren't handled. Add cases to the `switch` in `api/stripe-webhook.js` as needed.

### Webhook events to subscribe to

When creating the endpoint at [Dashboard → Webhooks](https://dashboard.stripe.com/workbench/webhooks) (pointed at `https://<your-domain>/api/stripe-webhook`), select:

- **`checkout.session.completed`** — handled (logs; see "Granting premium access" above for what's still needed)
- **`invoice.paid`** — handled (logs). Only actually fires if `mode` is switched to `"subscription"` — harmless to subscribe to now either way.
- **`invoice.payment_failed`** — handled (logs)

Optional, not yet handled in code — add a `case` to the `switch` in `api/stripe-webhook.js` if you subscribe to these: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `payment_intent.succeeded`, `setup_intent.succeeded`. All of these are subscription/mode-specific and mostly irrelevant while `mode: "payment"` stays a one-time charge.

### Testing

Use [Stripe's test card numbers](https://docs.stripe.com/testing) in test mode (keys starting `pk_test_`/`sk_test_`):

- `4242 4242 4242 4242` — succeeds
- `4000 0000 0000 9995` — declines (insufficient funds)
- Any future expiry date, any 3-digit CVC, any postal code

Use the [Stripe CLI](https://docs.stripe.com/stripe-cli) to forward webhooks to your local server while testing:

```bash
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

### Stripe plugin / MCP server

The Stripe plugin's skills (test cards, error lookup, docs search, etc.) are available now. Its MCP server (`plugin:stripe:stripe`) still needs authorization — this session can't complete that OAuth flow. Run `claude mcp` or `/mcp` in an interactive terminal session to connect it.

### Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
- https://docs.stripe.com/testing
