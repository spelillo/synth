# Lite Mode — Spec

The hero landing page offers two paths in, not one mandatory gate:

- **Lite Mode** — jump straight into the tool, the way Synth used to work before the landing gate existed. No email, no sign-in, nothing saved anywhere but this browser tab.
- **Normal Mode** — today's existing flow, unchanged: sign in with a magic link first, then upload. Signed-in users can save datasets/workspaces/chat sessions to the cloud (`Save to cloud`, `Save session`, `My Data`). Going Premium (Dashboard, etc.) is a separate, still-paid upsell available *inside* Normal Mode — this feature doesn't touch that, and Lite Mode never grants it.

No Stripe, no tokens, no new API endpoints. This is a landing-page UX change plus removing one hard gate.

## What's actually gating the tool today

[synth.html:5091-5115](synth.html:5091) — `#landing-view` is a forced two-step flow: Step 1 collects an email and sends a magic link (or, cross-device, polls a `landing_gates` row — [synth.html:299-374](synth.html:299)); Step 2's upload button starts `pointer-events: none` (`.landing-upload-btn.is-locked`, [synth.html:3037](synth.html:3037)) and only becomes clickable once `unlockLandingUpload()` runs, which currently only happens from `confirmLandingSignIn()` / `confirmLandingGateConfirmed()`.

Crucially, **the lock is UI-only** — `uploadCSV()` and `revealApp()` ([synth.html:1874](synth.html:1874)) have no auth check baked in. The only thing standing between "arrive at the page" and "using the tool" is that one CSS class and the JS that removes it. That makes Lite Mode a small, structurally-safe change: skip the gate, don't touch anything downstream.

It also confirms multi-table workspace features (`add-table-btn`, `workspace-badge`, [synth.html:1487-1498](synth.html:1487)) are **not** premium- or sign-in-gated today — they appear for anyone with more than one table loaded, Lite Mode included. The only things actually behind sign-in are cloud save (`save-csv-btn`, `save-session-btn`, `my-projects-btn` — all null-guarded on `currentUser`) and, behind sign-in *and* payment, the Dashboard (`dashboard-nav-btn`, gated on `isPremium`). So the three tiers are already cleanly layered in the existing code:

```
Lite Mode   →  no account   →  nothing persisted, everything else works
Normal Mode →  account      →  + cloud save (datasets, workspaces, chat sessions)
Premium     →  account+$    →  + Dashboard (existing "Go Premium" upsell, unchanged)
```

Lite Mode only needs to open the door to the first tier without forcing the second.

## Landing page changes

**New mode toggle**, above the existing two-panel split:

```html
<div class="landing-mode-toggle" role="tablist">
  <button type="button" class="landing-mode-btn is-active" id="landing-mode-lite-btn"
          onclick="selectLandingMode('lite')" role="tab" aria-selected="true">Lite Mode</button>
  <button type="button" class="landing-mode-btn" id="landing-mode-normal-btn"
          onclick="selectLandingMode('normal')" role="tab" aria-selected="false">Normal Mode</button>
</div>
<p class="landing-mode-sub" id="landing-mode-sub">
  No sign-in. Nothing saved. Closes with the tab.
</p>
```

`selectLandingMode()` swaps which framing is active — it doesn't create two separate DOM subtrees, it repurposes the existing `.landing-panel-upload` panel and hides/dims the auth one:

```js
let landingMode = 'lite'; // default — see "Which mode is the default" below

window.selectLandingMode = function(mode) {
  landingMode = mode;
  document.getElementById('landing-mode-lite-btn').classList.toggle('is-active', mode === 'lite');
  document.getElementById('landing-mode-normal-btn').classList.toggle('is-active', mode === 'normal');
  document.getElementById('landing-mode-lite-btn').setAttribute('aria-selected', mode === 'lite');
  document.getElementById('landing-mode-normal-btn').setAttribute('aria-selected', mode === 'normal');
  document.getElementById('landing-view').classList.toggle('mode-lite', mode === 'lite');
  document.getElementById('landing-view').classList.toggle('mode-normal', mode === 'normal');

  const sub = document.getElementById('landing-mode-sub');
  const panel = document.getElementById('landing-upload-panel');

  if (mode === 'lite') {
    stopWatchingLandingGate();          // no-op if nothing was watching
    unlockLandingUpload();              // existing helper — removes .is-locked, marks panel .unlocked
    document.getElementById('landing-upload-sub').textContent =
      'No sign-in. Nothing saved to the cloud — upload a CSV to jump right in.';
    sub.textContent = 'No sign-in. Nothing saved. Closes with the tab.';
  } else if (!panel.classList.contains('unlocked')) {
    // Only re-lock if the Normal Mode flow hasn't already been completed
    // (switching modes after a real magic link was sent shouldn't undo it).
    document.getElementById('landing-upload-label').classList.add('is-locked');
    document.getElementById('landing-upload-sub').textContent = 'Unlocks once your magic link is on its way.';
    sub.textContent = 'Sign in once — sync your data across devices and pick up where you left off.';
  }
};
```

`.landing-panel-auth` gets dimmed/hidden under `.landing-view.mode-lite`:

```css
.landing-view.mode-lite .landing-panel-auth {
  opacity: 0.35;
  pointer-events: none;
}
```

(Dimmed rather than removed — a Lite Mode visitor can still see Normal Mode is one click away, and switching back re-enables the form instantly. Nothing in it has been touched, so there's no state to restore.)

The `Step 1` / `Step 2` kickers ([synth.html:5095](synth.html:5095), [synth.html:5109](synth.html:5109)) stop making sense once there's no sequence in Lite Mode — either drop them from the upload panel's markup entirely and add them back only under `.mode-normal` via CSS content, or simplify to non-numbered copy ("Upload a CSV") that reads fine in both modes. Simplest: change the static markup to just "Upload a CSV" with no kicker, and add the "Step 1 / Step 2" kickers back in only for `.mode-normal` via a small CSS `::before` or a second hidden span toggled by the mode class.

## Zero Supabase calls in Lite Mode — verify structurally, not by convention

This falls out of the existing code shape rather than needing new guards: the only two places that touch Supabase from the landing page are `landingSendMagicLink()` (inserts into `landing_gates`, calls `sb.auth.signInWithOtp`) and `watchLandingGate()`'s polling/`sb.channel(...)` subscription. Neither is ever called unless the user is in Normal Mode and clicks "Send magic link." Lite Mode's `selectLandingMode('lite')` calls `stopWatchingLandingGate()` (tears down any in-flight Normal Mode watch if the user switches away mid-flow) but never calls anything that reaches Supabase. No new guard function is needed — just confirm this with a network-tab check per the testing section below, since "falls out of the existing shape" is a claim worth verifying once, not trusting forever.

## Respecting an in-progress Normal Mode flow

If the page loads with a `?gate=<id>` query param (cross-device magic-link confirmation, [synth.html:290-297](synth.html:290)) or an active Supabase session is found on load, force Normal Mode before running that logic, regardless of the default:

```js
// early in init, before wiring the default mode
const params = new URLSearchParams(location.search);
if (params.has('gate') || (await sb?.auth.getSession())?.data?.session) {
  selectLandingMode('normal');
}
```

A returning signed-in user, or someone who just clicked their magic link on another device, should never land on a dimmed-out auth panel.

## Which mode is the default

Set Lite Mode active by default, matching the "jump right into the tool, like it used to" framing — the whole point is removing friction for people who just want to try it. This does trade away Normal Mode's current role as a mandatory email-capture step, which may have been intentional for growth reasons; flagging that explicitly rather than deciding it silently. If email capture matters more than first-touch friction, flip the default to `'normal'` — everything else in this spec is unaffected either way, it's one initial value.

## What doesn't change

- `Sign in` / `Go Premium` in the app header ([synth.html:4897-4901](synth.html:4897)) stay exactly as they are. A Lite Mode user can sign in from inside the app later; the moment `currentUser` is set, `Save to cloud` / `Save session` / `My Data` appear, same as today — that's how Normal Mode's "can save to cloud, no premium features" tier already works, with Premium remaining its own separate paid step on top.
- No Supabase schema changes.
- No changes to `uploadCSV`, `addTablesCSV`, workspace/relationship detection, or the AI panel — none of it was ever gated, so none of it needs touching.
- Existing Normal Mode flow (email → magic link → cross-device gate confirmation) is untouched, just reachable via a tab instead of being the only option.

## Files touched

```
synth.html   # landing mode toggle (HTML + CSS), selectLandingMode(), small tweaks to
             # unlockLandingUpload()'s copy, init-time force-to-normal check
```

Nothing else.

## Testing

- Lite Mode, fresh private window: land on the page, upload a CSV, run a SQL query, ask the AI something — all work with zero clicks on anything auth-related.
- Network tab during that same session: zero requests to the Supabase project's REST/Auth/Realtime endpoints.
- Switch to Normal Mode mid-visit (before uploading): auth panel re-enables, upload re-locks, existing magic-link flow works exactly as before.
- Switch to Lite Mode *after* completing Normal Mode's magic-link step: upload panel stays unlocked (doesn't regress a real, completed sign-in back to locked).
- Load the page with `?gate=<a real pending gate id>`: lands in Normal Mode regardless of the default, and the existing cross-device confirmation still fires.
- Sign in from inside the app after entering via Lite Mode: `Save to cloud` appears, `Dashboard` does not (no Premium purchase happened) — confirms the three tiers stay layered correctly.
