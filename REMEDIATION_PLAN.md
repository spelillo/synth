# Synth Remediation Plan

Companion to [TEST_SCRIPT.md](./TEST_SCRIPT.md). Twelve confirmed defects, ordered by severity. Each entry names the exact file/line, what's broken, why it matters, and what to change. "Effort" is a rough size, not a schedule.

## Do these first (this week)

1. Escape the CSV render path (Critical, XSS)
2. Verify `STRIPE_WEBHOOK_SECRET` is actually set on every Vercel environment, then make a missing secret a hard failure instead of a silent downgrade (Critical)
3. Lock down `/api/chat` (High, live cost/abuse exposure)
4. Fix the column-filter focus bug (High, a core feature is effectively unusable)

Everything else can follow at normal priority.

---

## Critical

### C1. Stored XSS via unescaped CSV values

**Where:** `synth.html`, `updateTable()` (column names ~line 3098, cell values ~line 3112). Same unescaped pattern in the table-chip bar (~1754), the AI-focus dropdown (~1772), and the manual-relationship column `<select>` (~2223).

**What's broken:** Column headers and cell values from an uploaded CSV are written straight into `element.innerHTML` with no escaping. A CSV containing a cell like `<img src=x onerror="...">` executes as real JavaScript the moment the table renders.

**Verified:** live, in this pass. Uploading a CSV with that exact payload and viewing the Query Results grid set `window.__xssFired = true`: the handler ran.

**Why it matters:** CSVs move between people constantly (email attachments, shared drives, "here's the export"). Anyone can craft one and hand it to a Synth user; the payload runs with that user's full session, including their Supabase auth token, letting it call the Supabase API as them.

**Fix:** The codebase already has the right pattern elsewhere: `escapeHtml()` is defined and used correctly for workspace names, saved-query titles, and AI chat replies (lines 845, 851, 1257-1258, 2816). Apply the same function to every value interpolated in the four sites above:

```js
// synth.html:3098 and :3112: wrap col and val
html += `<th>...${escapeHtml(col)}...</th>`;
...
html += `<td>${val !== null && val !== undefined ? escapeHtml(String(val)) : '<span class="null">NULL</span>'}</td>`;
```

Do the same for the table-chip label and the AI-focus dropdown label. Add one regression test: upload a CSV with an `<img onerror=...>` cell and assert the payload never executes and renders as literal text.

**Effort:** small (a few hours, mostly finding every interpolation site and adding the test).

---

### C2. Stripe webhook accepts unsigned events when `STRIPE_WEBHOOK_SECRET` is unset

**Where:** `api/stripe-webhook.js:47-49, 65-77`

**What's broken:**

```js
event = endpointSecret
  ? stripe.webhooks.constructEvent(rawBody, signature, endpointSecret)
  : JSON.parse(rawBody.toString());   // <-- no verification at all
```

If the env var is missing, any `POST /api/stripe-webhook` with a hand-built `checkout.session.completed` body is accepted at face value. The handler then upserts `profiles.is_premium = true` for whatever `client_reference_id` (a Supabase user id) is in that body, using the service-role key, which bypasses RLS.

**Current exposure:** the repo's local `.env.local` does have a `STRIPE_WEBHOOK_SECRET` value, so the vulnerable branch is likely inactive locally. Whether it's set on the actual Vercel deployment (production and every preview environment) is a separate question this review can't answer from the repo alone: Vercel environment variables live outside the codebase. **Confirm this in the Vercel dashboard for every environment before treating this as low-risk.**

**Fix:** make a missing secret a hard failure, not a silent fallback:

```js
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!endpointSecret) {
  console.error('STRIPE_WEBHOOK_SECRET is not configured: refusing to process webhook');
  return res.status(500).json({ error: { message: 'Webhook not configured' } });
}
let event;
try {
  event = stripe.webhooks.constructEvent(rawBody, signature, endpointSecret);
} catch (err) { ... }
```

This also protects against the same failure mode reappearing later (a secret rotation that doesn't get redeployed, a new preview environment that forgets the var, etc.): the endpoint fails loudly instead of quietly granting free premium.

**Effort:** trivial (a few lines), but do the Vercel dashboard check first since that determines whether any past-issued grants need auditing.

---

## High

### H1. `/api/chat` is an open, unauthenticated, unlimited proxy to a paid API

**Where:** `api/chat.js:8-37`

**What's broken:** the endpoint takes `req.body`, forwards it to Groq using the server's own API key, and returns the response. No check that the caller is a signed-in Synth user, no rate limit, no body-size or shape validation.

**Why it matters:** this isn't a UI feature being misused, it's a direct line to a metered third-party API paid for by the site owner. Anyone who finds the URL (a browser devtools tab is enough) can run unlimited completions at the owner's expense, indefinitely, with no signal in the UI that it's happening.

**Fix, in order of value:**
1. Require a valid Supabase session: verify the bearer JWT server-side (Supabase's `auth.getUser(token)`) before forwarding anything to Groq. This alone stops anonymous abuse.
2. Add per-user or per-IP rate limiting (Vercel KV, Upstash Redis, or even an in-memory sliding window if traffic is low) so a single compromised or careless session can't run up unbounded cost.
3. Validate `req.body` has the expected shape before forwarding it, rather than passing it through verbatim.

**Effort:** medium (auth check is small; a real rate limiter needs a small amount of shared state, i.e. a KV store).

---

### H2. Column-filter and per-column search boxes lose focus after every keystroke

**Where:** `synth.html`, `filterColumn()` (3167-3171) calling `updateTable()` (3083-3127), which does `target.innerHTML = html` on every single keystroke, for both the "Query Results" grid and the "Table View" grid.

**What's broken:** typing a filter value replaces the entire `<table>`, including the very `<input>` being typed into, and nothing restores focus afterward. Confirmed directly: focusing a filter input and calling the exact function its `onkeyup` handler calls moved `document.activeElement` to `<body>`. In practice, a user typing a normal filter string gets the first character applied and then has to click back into the box before every subsequent character. Multi-character filtering doesn't work as a normal person would use it.

**Fix:** stop rebuilding the whole table on every keystroke. Two reasonable approaches:
- **Minimal:** after `updateTable()` runs from a filter keystroke, find the input with the matching column index in the new DOM and call `.focus()` on it, plus restore cursor position (`setSelectionRange`). This keeps the existing full-rebuild architecture but patches the symptom.
- **Better:** only re-render the `<tbody>` (the rows) on a filter/sort change, and leave the `<thead>` (labels + filter inputs + sort icons) alone unless the column list itself changes. This is how the Table View's separate "search all columns" box already avoids the bug: it lives outside the rebuilt region entirely. Applying the same principle to the per-column filters (keep the input nodes stable, only replace `<tbody>`) fixes this permanently rather than working around it.

Either fix should ship with a test that types a multi-character string into a column filter (via real sequential keydown/keyup, not a single programmatic value assignment) and asserts the input never loses focus and the final filtered row count is correct.

**Effort:** small for the minimal patch, medium for the `<tbody>`-only re-render (touches `updateTable`, `sortColumn`, and `filterColumn`).

---

## Medium

### M1. No modal or popover closes on Escape or backdrop click

**Where:** systemic. `synth.html` defines 16 `.modal-overlay` dialogs (about, terms, privacy, premium, premium-signin, settings, cancel-premium, cloud, help, save-query, load-query, delete-query, delete-table, relationship-type, delete-workspace, switch-workspace) plus the header's sign-in dropdown. None of them have a shared dismiss handler. The only `document`-level `keydown` listener in the app is for Cmd/Ctrl+Enter (line 3311); Escape does nothing anywhere except two narrow, unrelated rename-cancel cases (lines 901, 1862).

**Why it matters:** Escape-to-close and click-outside-to-close are baseline expectations for any modal on the web, and their absence is the kind of thing that reads as broken even when every explicit close button works fine. It also has a real keyboard-accessibility angle: a keyboard-only user has to tab to the specific close button rather than hit the one key that works everywhere else on the web.

**Fix:** add one shared handler instead of touching each modal individually:

```js
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.modal-overlay:not([hidden])').forEach(m => m.hidden = true);
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
});
```

This is a generic close (just hides the overlay); a few modals do extra cleanup in their specific `closeXModal()` functions (e.g., `closeSaveQueryModal()` resets `editingQueryId`). Either call each modal's own close function by looking it up from a `data-close-fn` attribute, or accept the generic hide for Escape/backdrop and leave the explicit buttons to run the full cleanup: the second is simpler and lower-risk to ship.

**Effort:** small.

---

### M2. Placeholder support email in Terms of Service and Privacy Policy

**Where:** `synth.html`, `terms-modal` and `privacy-modal` bodies. Both say "Reach us at `support@example.com`."

**What's broken:** `example.com` is the reserved placeholder domain (RFC 2606); mail sent there goes nowhere. Anyone trying to exercise a data-deletion request (which the Privacy modal explicitly invites) or ask a Terms question hits a dead end.

**Fix:** replace with a real, monitored address in both places. One string, two locations: easy to miss the second one if fixed by hand; grep for `support@example.com` before shipping to confirm both are gone.

**Effort:** trivial.

---

### M3. `create-checkout-session` trusts a client-supplied `userId`

**Where:** `api/create-checkout-session.js:33-37`

**What's broken:** the endpoint takes `req.body.userId` at face value and bakes it into `client_reference_id`, with no check that the request actually came from a session belonging to that user.

**Why it matters:** exploitability is bounded (an attacker still needs to complete a real payment, and Supabase user ids are UUIDs, not guessable) but it's a trust-boundary gap: nothing stops a request from claiming a different `userId` than the one paying.

**Fix:** verify the caller's Supabase session server-side and use the id from the verified session instead of (or as a check against) the body value.

**Effort:** small (same JWT-verification building block as H1: worth doing both together).

---

### M4. Sign-out doesn't reset in-memory app state

**Where:** `signOutUser()` and `handleAuthChange()` (synth.html, around 173 and 578-590)

**What's broken:** signing out clears `currentUser` and swaps the header back to signed-out, but doesn't reset `tables`, the live sql.js `db` instance, or `chatHistory`. This was flagged by code review; I couldn't reach a signed-in state myself to reproduce it live (see TEST_SCRIPT.md, 2.8), so treat this as **needs a manual check**, not a confirmed live bug.

**Why it matters, if confirmed:** on a shared or public device, a sign-out that leaves the previous user's loaded CSV and chat history sitting in memory (and potentially reachable if `app-view` gets shown again through some other code path, like a back/forward-cache restore) is a real information-exposure risk, not just a cosmetic one.

**Fix:** in `signOutUser()`, explicitly reset `tables = []`, dispose/recreate the sql.js `db`, and clear `chatHistory` alongside the existing UI reset, the same way a few other flows already do (lines 1374, 1600, 2886 each clear pieces of this state for other reasons: consolidate into one reset function `signOutUser()` also calls).

**Effort:** small, once someone with a real account confirms the repro.

---

## Low / product suggestions

### L1. Numeric sort/cast breaks on thousands-separated values

**Where:** general SQL behavior, surfaced concretely by the AI assistant's own generated query (`ORDER BY CAST("Capacity" AS INTEGER) DESC` against a column containing `"1,200"`).

**What happens:** SQLite's `CAST` on a string reads only the leading digit run, so `"1,200"` casts to `1`, not `1200`. A "show me the biggest X" question silently returns the wrong row whenever a numeric-looking column has comma thousands separators, whether the SQL comes from a person or from the AI assistant.

**Options, cheapest to most thorough:**
- On CSV import, detect columns where every value matches `^\d{1,3}(,\d{3})*$` and strip the commas before loading into sqlite (store as a real integer/real column instead of text).
- If preserving the original formatting matters, keep the display column as-is but also create a normalized numeric column for sorting/filtering.
- At minimum, have the AI assistant's system prompt mention that numeric-looking text columns may need `REPLACE(col, ',', '')` before casting, so its generated SQL doesn't repeat this mistake.

**Effort:** small for the prompt fix, medium for detect-and-normalize-on-import.

### L2. "Load Query" button stays enabled with nothing to load

Minor. When the saved-queries list for a file is empty, "Load Query" is still clickable (it just does nothing). Disabling it when the list is empty, or when nothing is selected, would be a clearer affordance. Not a functional bug.

### L3. Mobile button-label wrapping

"Go Premium" and "Sign in" wrap to two lines inside their pill buttons at 375px width. Still usable, just visually cramped. Shortening the labels at narrow widths, or letting the pills grow slightly, would clean this up.

---

## What's explicitly not on this list

- Anything under "AMBIGUOUS" in TEST_SCRIPT.md (magic-link completion, Stripe checkout completion, cloud sync/workspace/dashboard/settings round-trips, sign-out data reset). These need a real inbox, a real payment, or a real account to verify, none of which this session had. They're not known-good and not known-bad; they need a follow-up pass by someone who can sign in.
- Supabase RLS policies. All checked tables correctly scope to `auth.uid()`; no changes recommended there.
