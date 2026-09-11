> **Superseded.** This spec's account-free-Stripe-checkout design was the first draft, based on "premium without sign-in." The actual direction landed on is simpler and doesn't involve payment at all — see [LITE_MODE_SPEC.md](LITE_MODE_SPEC.md). Kept here for the record of what was considered and ruled out (the accepted-risk discussion around unrecorded token redemption is still relevant if a paid no-account tier ever comes back).

# Safety Mode — Spec (superseded, see LITE_MODE_SPEC.md)

Premium features, no sign-in, nothing saved to Supabase. Pay once, unlock premium for this browser tab's session, close the tab and it's gone — by design, not as a limitation to work around.

## Why this doesn't fit the existing Premium model

Today, "Go Premium" is entirely account-bound:

- [api/create-checkout-session.js](api/create-checkout-session.js) 400s without a `userId` and sets it as Stripe's `client_reference_id`.
- [api/stripe-webhook.js](api/stripe-webhook.js) reads that `client_reference_id` off `checkout.session.completed` and upserts `public.profiles.is_premium = true`, keyed to `auth.uid()`.
- [synth.html](synth.html) shows "Sign in to go Premium" before it will even open the checkout form (`signInThenGoPremium`, line ~866).

Safety Mode inverts every one of those: no `userId`, no `profiles` row, no `auth.uid()`. It needs its own entitlement path that never touches Supabase.

## Entitlement without an account

**New endpoint: `api/create-safety-checkout-session.js`**

Same shape as `create-checkout-session.js`, minus the account requirement:

```js
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  ui_mode: 'form',
  return_url: `${proto}://${req.headers.host}/?safety_checkout=success`,
  // No client_reference_id — there's no user to tie this to.
  metadata: { synth_mode: 'safety' },
  line_items: [{ price: 'price_1UEAIYRqXDpXXBnZ1F8tb0r7', quantity: 1 }], // same $9.99 price
  billing_address_collection: 'auto',
  submit_type: 'auto',
  integration_identifier: 'custom_embedded_web_0002',
});
```

**New endpoint: `api/verify-safety-checkout.js`**

Client calls this after Stripe confirms payment, passing the Checkout Session id. The endpoint calls `stripe.checkout.sessions.retrieve(id)`, checks `payment_status === 'paid'` and `metadata.synth_mode === 'safety'`, and — if valid — mints a signed, short-lived token instead of writing anything anywhere:

```js
import { createHmac } from 'crypto';

const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h, one browser session's worth
const payload = `${session.id}.${expiresAt}`;
const sig = createHmac('sha256', process.env.SAFETY_MODE_SECRET).update(payload).digest('hex');
const token = Buffer.from(`${payload}.${sig}`).toString('base64url');

res.status(200).json({ token, expiresAt });
```

New env var: `SAFETY_MODE_SECRET` (Vercel + `.env.local`, same pattern as `STRIPE_WEBHOOK_SECRET`).

**`api/stripe-webhook.js`** needs one guard: when `session.metadata?.synth_mode === 'safety'`, skip the `profiles` upsert entirely (there's no user id to upsert against, and there shouldn't be — that upsert is exactly the Supabase write Safety Mode exists to avoid). Logging the event for Stripe-side bookkeeping is fine; writing to Supabase is not.

### Accepted risk (write this down, don't try to solve it)

There's no server-side record of which Checkout Session ids have already been redeemed, because keeping one would mean a database — the thing this feature exists to avoid. In practice this means a leaked `token` or a re-visited `?safety_checkout=success&session_id=...` URL could mint a second token from the same payment. This is the same trust model the existing "Cancel Premium" button already uses (a local flag flip, no server enforcement) — acceptable for a $9.99 one-time charge, not acceptable to quietly expand scope on later without revisiting.

## Client-side state (synth.html)

**Storage:** `sessionStorage`, never `localStorage`, never Supabase. `sessionStorage` already dies when the tab/browser session ends, which is exactly the "browser session" boundary the feature is named for — no custom expiry-sweeping logic needed beyond the token's own 24h `expiresAt` as a backstop.

```js
const SAFETY_TOKEN_KEY = 'synth_safety_token';
let safetyMode = false; // true once a valid, unexpired token is loaded

function loadSafetyMode() {
  try {
    const raw = sessionStorage.getItem(SAFETY_TOKEN_KEY);
    if (!raw) return false;
    const { expiresAt } = JSON.parse(raw);
    return Date.now() < expiresAt;
  } catch { return false; }
}
```

**Entitlement flag becomes:**

```js
const isPremiumEffective = () => isPremium || safetyMode;
```

Replace every current `isPremium` check that gates premium UI (line 204's `dashboard-nav-btn`, line 642's dashboard-open guard, line 847's checkout-panel branch) with `isPremiumEffective()` — **except** the Dashboard itself (see "What Safety Mode cannot offer" below, which stays gated on `isPremium` alone).

### Guarding every Supabase call

This is the actual emphasis of the feature, so it needs to be structural, not a checklist someone forgets. Wrap the existing `sb` client access:

```js
function sbGuarded() {
  if (safetyMode) return null; // every call site already null-checks `sb` for the unconfigured case
  return sb;
}
```

Swap the handful of direct `sb.auth.*` / `sb.from(...)` call sites (`refreshPremiumStatus`, `sendMagicLink`, `signOutUser`, dashboard/cloud-panel loaders, saved-session loaders) to go through `sbGuarded()` instead of `sb` directly. When `safetyMode` is true this makes every one of them a no-op, in one place, rather than trusting each call site to remember.

### Saved Queries (existing localStorage feature)

[synth.html:946-963](synth.html:946) already persists "Saved Queries" to `localStorage` (`SAVED_QUERIES_KEY`) — unrelated to Supabase, but it *does* survive a browser restart on a shared machine, which is exactly the kind of residue Safety Mode is promising not to leave. While `safetyMode` is true, redirect that store to an in-memory object (or `sessionStorage` under a separate key) instead of `localStorage`, and drop it on exit. Don't let a genuinely "nothing persists" feature quietly leak through an existing, unrelated persistence path.

### Entry point (UI)

Next to the existing "Go Premium" button: a second, visually distinct action — **"Try Premium — Safety Mode"** or similar, with a one-line explainer in its modal: *"Unlock premium for this browser tab. No account, no email, nothing saved — closing this tab ends it for good."* This is a deliberate trade-off being sold, not a lesser version of the real thing, so the copy should say that plainly rather than apologize for the limitation.

On successful payment (`?safety_checkout=success` return), call `verify-safety-checkout`, store the token, set `safetyMode = true`, and re-render the header exactly as `updatePremiumUI()` does today — but additionally:

- Hide the "Sign in" button entirely (signing in mid-Safety-Mode-session creates a confusing half-state — see "Mutual exclusion" below).
- Show a persistent "Safety Mode" badge in the header (parallel to the existing `Premium ✓` badge), with an "Exit Safety Mode" action.

### Exit Safety Mode

A visible, explicit action (not just "close the tab"), because someone on a shared computer needs to be able to end the session without also closing their browser:

```js
window.exitSafetyMode = function() {
  sessionStorage.removeItem(SAFETY_TOKEN_KEY);
  safetyMode = false;
  // Also clear in-memory workspace/CSV/chat state — this is the point.
  resetWorkspaceState(); // whatever the existing "load a new CSV" reset path is
  updatePremiumUI();
};
```

### Mutual exclusion with sign-in

Don't support "signed in AND Safety Mode" as a state — it muddies exactly the guarantee this feature makes. If a user has an active Safety Mode session and clicks what would be "Sign in," show a short confirmation ("Signing in will end Safety Mode and its unsaved data — continue?") rather than silently running both entitlement paths at once.

### What Safety Mode cannot offer

The Dashboard (`dashboard-nav-btn`, [synth.html:622](synth.html:622) "premium home base: every saved workspace, at a glance") is fundamentally a view over Supabase-persisted workspaces. It cannot exist for a mode whose entire premise is that nothing is persisted. Keep it gated on `isPremium` (the real, signed-in flag) only — never `isPremiumEffective()` — and if `safetyMode` is active, the Dashboard nav item should stay hidden with no explanation needed beyond the badge already visible.

## Files touched

```
api/
  create-safety-checkout-session.js   # new — no userId required
  verify-safety-checkout.js           # new — mints signed session token, writes nothing
  stripe-webhook.js                   # +guard: skip profiles upsert when metadata.synth_mode === 'safety'
synth.html                            # new UI (button/modal/badge), safetyMode state,
                                       # sbGuarded() wrapper, sessionStorage token + saved-queries
                                       # rerouting, exitSafetyMode()
SAFETY_MODE_SPEC.md                   # this file
```

No `supabase/` schema changes — that absence is the feature.

## Env vars to add

```
SAFETY_MODE_SECRET=<random 32+ byte value>
```

(Vercel Project Settings → Environment Variables, and `.env.local` for local dev — same handling as `STRIPE_WEBHOOK_SECRET`.)

## Testing

- Full flow with no Supabase session at all: open in a private window with `SUPABASE_URL` temporarily pointed at an unreachable host — Safety Mode checkout, token mint, and premium features should all still work, proving nothing on the critical path depends on Supabase being reachable.
- Network tab during a Safety Mode session: zero requests to the Supabase project's REST/Auth/Storage endpoints, start to finish.
- `sessionStorage` cleared / tab closed and reopened → back to the free, anonymous state, no token, no leftover workspace.
- Saved Queries created during Safety Mode do not appear in `localStorage` after `exitSafetyMode()`.
- Attempt to sign in mid-Safety-Mode-session → confirmation prompt, not a silent dual state.
- Stripe test card `4242 4242 4242 4242` end to end; verify webhook log shows `synth_mode: safety` and confirm (by reading the DB directly) that no `profiles` row was created for it.
