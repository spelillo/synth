# Synth QA Test Script

Target: https://vercel-nine-zeta-17.vercel.app/ (production deployment of this repo)
Tested: 2026-09-14
Method: live browser automation against the deployed site, cross-checked against the source in this repo (`synth.html`, `api/*.js`, `supabase/migrations/*.sql`) wherever the browser evidence needed an explanation. Test data used the repo's own sample CSVs (`buildings.csv`, and small inline variants) plus a few adversarial CSVs built for the security checks.

Status legend:
- **PASS**: behaved as expected, verified directly.
- **FAIL**: confirmed defect, with reproduction steps and evidence below.
- **AMBIGUOUS**: could not be fully verified in this pass; the reason is stated (needs a real inbox, a real card, an account role I don't have, or a tooling limit) rather than guessed at.

Total cases: 74 (52 pass, 12 fail, 10 ambiguous).

---

## 1. Landing page

| # | Test | Expected | Result |
|---|------|----------|--------|
| 1.1 | Load `/` | Landing page renders: logo, Go Premium, Sign in, mode toggle, email/CSV panels, "How it works", footer | PASS |
| 1.2 | Click "Lite Mode" / "Normal Mode" toggle | Switches the two-column panel; Normal Mode gates the CSV upload button behind email sign-in ("Unlocks once your magic link is on its way") | PASS |
| 1.3 | Click "More info" | Expands a Lite vs. Normal comparison table (use case, account, session storage, data security); chevron flips; collapses on second click | PASS |
| 1.4 | Click logo / "Back to home" | Returns to `/` | PASS |
| 1.5 | Footer "About" link | Opens About modal with product description; closes on × | PASS |
| 1.6 | Footer "Terms of Service" link | Opens Terms modal | PASS (content issue: see 1.8) |
| 1.7 | Footer "Privacy Policy" link | Opens Privacy modal | PASS (content issue: see 1.8) |
| 1.8 | Terms/Privacy contact line | "Reach us at [a real support address]" | **FAIL**: both modals literally say "Reach us at `support@example.com`", the RFC 2606 reserved placeholder domain. Nobody receives mail sent there. Confirmed via `terms-modal`/`privacy-modal` innerHTML. |
| 1.9 | Mobile viewport (375×812), landing page | Single-column stack, no horizontal scroll, controls usable | PASS, with a cosmetic note: "Go Premium" and "Sign in" pill buttons wrap their label to two lines at this width. Not broken, just cramped. |

## 2. Authentication (magic link)

| # | Test | Expected | Result |
|---|------|----------|--------|
| 2.1 | Enter email, click "Send magic link" (Normal Mode) | Shows "Check your email for a sign-in link…" with a "check again" link | PASS |
| 2.2 | Click "check again" before the link is clicked | Re-checks session; if still signed out, shows a waiting message | PASS (message appears) |
| 2.3 | Click "check again" a second time | Same waiting message, still with a way to retry | **FAIL**: the first "check again" click replaces the message with plain text ("Still waiting. Click the link in your email on any device, then check again.") that has no actual link or button behind the words "check again". After one retry, the only way to re-check is reloading the page or resending the email. Confirmed in source: `landingRecheckSession` (synth.html:428-445) sets `msgEl.textContent` (plain text) instead of the `msgEl.innerHTML` with a real `<a onclick="landingRecheckSession()">` that the *first* message uses (synth.html:389). |
| 2.4 | Complete the magic-link flow (click the emailed link, land back on the app signed in) | User becomes signed in, header shows "My Projects" / "Settings" instead of "Sign in" | **AMBIGUOUS**: this requires receiving and clicking a real email; I have no inbox access in this session. Not tested end-to-end. |
| 2.5 | Header "Sign in" button (in the main app, CSV already loaded) | Opens a small dropdown with email field + "Send magic link" | PASS |
| 2.6 | Press Escape while the header sign-in dropdown is open | Closes it | **FAIL**: no effect. There is no global `Escape` keydown handler anywhere in the app (confirmed: the only `document`-level `keydown` listener in synth.html is for Cmd/Ctrl+Enter to run a query, synth.html:3311-3316). This affects every popover and modal in the app, not just this one: see section 9. |
| 2.7 | Click outside the header sign-in dropdown | Closes it | **FAIL**: same root cause as 2.6; no backdrop/outside-click handler exists. Toggling the "Sign in" button again is the only way to close it. |
| 2.8 | Sign out (after being signed in) | Returns to signed-out header state, without leaking previously loaded data | **AMBIGUOUS**: I couldn't reach a signed-in state to trigger this myself (see 2.4). The code-level review (below) found a related gap worth a manual check once someone with an account can test it: `signOutUser()` clears `currentUser`/hides the signed-in header, but does not reset `tables`, the live sql.js `db`, or `chatHistory`: see Remediation, "Sign-out leaves data in memory". |

## 3. CSV upload and data import

| # | Test | Expected | Result |
|---|------|----------|--------|
| 3.1 | Upload a CSV in Lite Mode | "Loading your data…" overlay, then main app view with the table loaded, correct row/column counts | PASS |
| 3.2 | CSV with a quoted field containing a comma (`"1,200"`) | Parsed as one field, not split | PASS |
| 3.3 | CSV with an `&` in a value (`Arts & Sciences`) | Displayed correctly, not mangled | PASS |
| 3.4 | Upload a second CSV via "+ Add table" | Added as a new table chip alongside the first, without disturbing it; a "Relationships" tab appears once 2+ tables exist | PASS |
| 3.5 | CSV cell/column containing an HTML/script payload (`<img src=x onerror=...>`) | Displayed as literal text, not executed | **FAIL: Critical.** Confirmed live: the `onerror` handler actually ran (`window.__xssFired` flipped to `true` after just loading the file and viewing the results grid). See Security section and Remediation for the root cause and fix. |
| 3.6 | Workspace table cap | Adding beyond `MAX_TABLES_PER_WORKSPACE` shows an error instead of silently failing | PASS (code-reviewed: synth.html:1672-1676 shows a clear error message; not independently forced by uploading dozens of files, but the guard is unconditional and simple enough that I'm confident in it) |

## 4. SQL query editor and results

| # | Test | Expected | Result |
|---|------|----------|--------|
| 4.1 | Default query pre-filled on upload (`SELECT * FROM <table> LIMIT 100`) | Present and correct | PASS |
| 4.2 | Click "Run Query" | Executes, renders results grid with per-column sort arrows and filter boxes | PASS |
| 4.3 | Cmd/Ctrl+Enter in the editor | Runs the query (shortcut shown in the UI) | PASS |
| 4.4 | Invalid table name (e.g., after a rename, the box still says the old name) | Clear error, not a blank crash | PASS: shows `no such table: buildings` plus a helpful tip listing the real table names. Good error UX; see 6.3 for why this happens. |
| 4.5 | Click a column header to sort | Toggles ▲/▼, re-orders rows correctly (verified against a text and a numeric column) | PASS |
| 4.6 | Type into a column filter box, single character | Filters immediately | PASS in isolation |
| 4.7 | Type into a column filter box, multiple characters in a row (normal typing speed) | Filter narrows progressively as each character is typed, box stays focused | **FAIL: High.** Confirmed at the code level, not just an automation artifact: `filterColumn()` (synth.html:3167-3171) writes the keystroke into `state.filter[colIndex]` and immediately calls `updateTable()`, which replaces the *entire* results `<table>` via `target.innerHTML = html` (synth.html:3120). That destroys the very `<input>` the user is typing into and does not refocus a replacement. Verified directly: focusing a filter input, then calling the exact function the `onkeyup` handler calls, moved `document.activeElement` to `<body>`. In practice this means every keystroke after the first requires clicking back into the box: multi-character filtering is unusable as built. Same bug affects the Table View tab's per-column filters (`viewStates.tableview.filter`, same `updateTable` code path). |
| 4.8 | Table View's single "Search all columns" box, multi-character typing | Filters progressively, stays focused | PASS: this box lives outside the rebuilt table region, so it doesn't hit the bug in 4.7. Verified: typing "Engineering" correctly narrowed 3 rows to 1 with the input value and app state both intact throughout. |
| 4.9 | "Download CSV" | Triggers a browser download of the currently visible (filtered/sorted) rows as a `.csv` file | PASS: confirmed a `Blob` of type `text/csv` and the expected byte size was created when clicked. |
| 4.10 | "Table View" tab | Shows all rows/columns for the active table with search, sort, per-column filter, its own Download CSV | PASS |
| 4.11 | Rename a table via the ✎ icon | Inline edit, Enter commits, Escape cancels and restores the old name | PASS (commit path); Escape-cancels-with-restore reads correctly in source (synth.html:1862) and wasn't seen to break, though I verified the commit path more thoroughly than the cancel path |
| 4.12 | Rename the *active* table | SQL editor's query text updates to reference the new name | PASS |
| 4.13 | Rename a *non-active* table that happens to be the ONLY name currently in the query box | Query box is left alone; running the old query now fails | Expected/acceptable: see 4.4. Documented here so it's not mistaken for an untested gap. |
| 4.14 | Delete a table (× on chip) | Confirmation dialog ("Delete 'X'? This can't be undone."), then removes the chip, hides Relationships tab if <2 tables remain, and: if it was the active table: resets the query box to the remaining table | PASS |
| 4.15 | Numeric-looking column containing thousands separators (`"1,200"`) sorted/cast as a number | Sorts/casts by true numeric value | **FAIL: Medium (data correctness).** `ORDER BY CAST("Capacity" AS INTEGER) DESC` (this is literally the query Synth's own AI assistant generated for "show me the tallest building by capacity") returns Halligan Hall (capacity 450) ahead of Tisch Library (capacity "1,200"), because SQLite's `CAST` on a comma-containing string reads only the leading digit run ("1,200" → 1). Reproduced end-to-end: asked the AI assistant the question, ran the SQL it wrote, got the wrong building. This isn't unique to the AI path: anyone writing `ORDER BY CAST(...)` by hand over an unmodified thousands-separated column hits the same wrong answer, silently. |

## 5. Multi-table relationships / ERD

| # | Test | Expected | Result |
|---|------|----------|--------|
| 5.1 | Open "Relationships" tab with 2 tables loaded | Renders both tables as boxes with their columns, connecting-line area below | PASS |
| 5.2 | Auto-detected relationships | Only suggested when column names actually look like `id`/`foreign_id` matches; none suggested for these test tables (correct, since none of the columns matched that pattern) | PASS |
| 5.3 | "Add a relationship manually": table/column dropdowns | Second table dropdown's column options update to match the newly selected table | PASS |
| 5.4 | Click "+ Add" | Opens a "Set relationship type" modal (1:1, 1:M, M:M, 1:0, 0:M) | PASS |
| 5.5 | Choose a relationship type | Modal closes, ERD draws a labeled connecting line, a "Relationships" list entry appears marked CONFIRMED with Edit/Remove buttons | PASS |
| 5.6 | "Remove" a confirmed relationship | Removes the line and the list entry | PASS (verified via the Edit/Remove buttons being present and wired; full removal round-trip inferred from the same code path as add, not separately screenshotted) |
| 5.7 | Rename a table that has a confirmed relationship, then switch away from and back to the Relationships tab | ERD and relationship list reflect the new table name | PASS on re-render. (Note: immediately after the rename, before switching tabs, the already-rendered ERD is not live-updated: old name is still on screen until the tab re-renders. Cosmetic only; the underlying relationship data is correct throughout, confirmed via `relationships` array tracking the rename. Not worth a remediation item on its own.) |

## 6. Save / Load query

| # | Test | Expected | Result |
|---|------|----------|--------|
| 6.1 | "Save Query" with a query already run | Opens a modal pre-filled with the current SQL, empty title/description, character counter on description | PASS |
| 6.2 | Save with a title | Modal closes, query is now listed under "Load Query" | PASS |
| 6.3 | "Load Query" | Lists saved queries for the current file with a radio button and a "…" menu | PASS |
| 6.4 | "…" menu → "Edit query" / "Delete query" | Both options present | PASS (menu opens); edit path not independently exercised beyond confirming the menu item exists and is wired to a handler, since delete was the higher-value path to verify end-to-end |
| 6.5 | Delete a saved query | Confirmation dialog ("Delete this query? This can't be undone."), then removes it from the list | PASS |
| 6.6 | "Load Query" with the list empty | Shows "No saved queries yet for this file." and clicking the (still-enabled) "Load Query" button does nothing harmful | PASS, minor nit: the button stays visually enabled with nothing to load; disabling it would be clearer, not a functional bug. |
| 6.7 | Saved queries are per-CSV, not global | A query saved under one file doesn't appear under a different file | PASS (per `currentCSVKey()` keying in source, synth.html:1168-1178; consistent with what I observed: the list was empty for a freshly uploaded second file) |

## 7. AI SQL / chat assistant

| # | Test | Expected | Result |
|---|------|----------|--------|
| 7.1 | AI toggle OFF (default) | Chat panel shows "AI assistant is disabled. Toggle it ON to ask SQL questions." Input effectively inert. | PASS |
| 7.2 | Toggle AI ON | Chat panel becomes active, mode selector (SQL/General) and "AI focus" table selector appear | PASS |
| 7.3 | Ask a question in SQL mode ("Show me the tallest building by capacity") | Assistant returns a runnable SQL query with a "Use Query" button, copy icon, reply option | PASS: the backend Groq proxy is live and responding; see 4.15 for the correctness problem with the query it produced (not a chat-plumbing failure, a data-type gotcha the assistant doesn't guard against). |
| 7.4 | "Use Query" | Populates the SQL editor with the AI's query | PASS |
| 7.5 | "Clear Session" | Clears chat history | PASS (button present and calls `clearChatSession()`; confirmed the click doesn't error, didn't independently verify persisted-history removal since that requires a signed-in cloud session) |
| 7.6 | Copy message icon | Copies assistant's reply to clipboard | PASS (button present, wired to `copyMessage()`; clipboard write not independently confirmed since headless clipboard read-back isn't available in this environment) |
| 7.7 | Reply-to-message | Sets a reply context bar above the input, referencing the message being replied to | PASS (bar appears; not exhaustively tested with a full multi-turn thread) |
| 7.8 | AI focus dropdown (which table(s) the AI defaults to) | Opens a checkbox list of loaded tables | PASS |
| 7.9 | General mode vs. SQL mode toggle | Switches assistant behavior between "answer in plain English" and "always return SQL" | PASS (toggle switches and the placeholder/help text updates accordingly; a full side-by-side answer comparison wasn't run) |
| 7.10 | Unauthenticated, unlimited access to `/api/chat` | Should require a valid session and/or be rate-limited, since it spends the site owner's Groq API key | **FAIL: High (security).** Confirmed by code review: `api/chat.js` forwards `req.body` to Groq verbatim with no auth check and no rate limiting. Anyone who finds the endpoint, not just people using the UI, can run unlimited completions on the owner's account. |

## 8. Premium / Stripe checkout

| # | Test | Expected | Result |
|---|------|----------|--------|
| 8.1 | Click "Go Premium" while signed out | Shows "Sign in to go Premium" gate instead of jumping to checkout | PASS: sensible, and matches the server-side check in `create-checkout-session.js` that also requires a `userId`. |
| 8.2 | Complete checkout while signed in | Stripe embedded checkout form loads, test-mode card completes, `profiles.is_premium` flips to true, premium UI unlocks | **AMBIGUOUS**: requires a signed-in session (blocked on email access, see 2.4) and a real Stripe test-mode payment. Not attempted. |
| 8.3 | Stripe webhook (`/api/stripe-webhook`) signature verification | Rejects any request without a valid Stripe signature | **FAIL: Critical (conditional).** Code-confirmed: when `STRIPE_WEBHOOK_SECRET` is unset, the handler falls back to `JSON.parse(rawBody)` with **no signature check at all**, then grants premium via the Supabase service-role client to whatever `client_reference_id` is in the body (api/stripe-webhook.js:47-49, 65-77). Anyone who could reach that endpoint with the secret unset could grant free premium to any user ID with a single unauthenticated POST. The repo's local `.env.local` has a `STRIPE_WEBHOOK_SECRET` value set, so the vulnerable branch is probably not live in production today: but that's a matter of which environment variables happen to be configured on Vercel right now, not something the code itself guarantees, and I can't inspect Vercel's actual project environment variables from here. Treat this as: "verify `STRIPE_WEBHOOK_SECRET` is set on every Vercel environment (production, preview, dev) today, and fix the code so a missing secret hard-fails instead of silently degrading." |
| 8.4 | "Cancel Premium" flow | Confirmation modal, cancels subscription/one-time flag | **AMBIGUOUS**: requires an actual premium account to reach. Not tested. |

## 9. Modals and dialogs, general behavior

This app has at least 16 distinct modal overlays (`about`, `terms`, `privacy`, `premium`, `premium-signin`, `settings`, `cancel-premium`, `cloud`, `help`, `save-query`, `load-query`, `delete-query`, `delete-table`, `relationship-type`, `delete-workspace`, `switch-workspace`). I tested the dismissal pattern directly on 6 of them and confirmed the same underlying code path (a shared `.modal-overlay` class with no shared close wiring) governs all 16.

| # | Test | Expected | Result |
|---|------|----------|--------|
| 9.1 | Every modal has a visible close control (×, Cancel, or both) | Yes | PASS: checked across About, Save Query, Load Query, Delete Table, Delete Query, Relationship Type. |
| 9.2 | Escape key closes the open modal | Yes, standard web convention | **FAIL: Medium, systemic.** No modal closes on Escape. Confirmed there is no Escape-handling code anywhere except two narrow, unrelated cases (canceling an in-progress table/chip rename, synth.html:901 and :1862). Every one of the 16 `.modal-overlay` dialogs, plus the header's Sign-in dropdown, ignores Escape entirely. |
| 9.3 | Clicking the dark backdrop outside a modal closes it | Yes, standard web convention | **FAIL: Medium, systemic.** Confirmed no `.modal-overlay` element has a click handler at all (grepped the source; zero matches). Clicking anywhere outside a modal's card does nothing. Same root cause as 9.2: there's simply no shared "dismiss" behavior wired to the overlay class, only to each modal's own explicit close button(s). |

## 10. Cloud sync, workspaces, dashboard, settings

Everything in this section requires a verified sign-in, which requires clicking a magic link in a real inbox: unavailable in this session.

| # | Test | Expected | Result |
|---|------|----------|--------|
| 10.1 | Workspace switcher visibility while signed out | Hidden entirely, not just disabled | PASS: confirmed in the DOM (`#workspace-switcher-btn` exists but `offsetParent === null`, i.e., genuinely not rendered/visible) rather than present-but-broken. |
| 10.2 | "My Projects" / cloud panel (list/open/rename/delete saved datasets and chat sessions) | Functions correctly for a signed-in user | **AMBIGUOUS**: needs a signed-in account. |
| 10.3 | Dashboard view (`openDashboard()`) | Loads account/workspace summary | **AMBIGUOUS**: needs a signed-in account. |
| 10.4 | Settings panel (email, member-since, premium row) | Displays correct account info | **AMBIGUOUS**: needs a signed-in account. |
| 10.5 | Workspace create/switch/rename/delete | Each round-trips correctly and matches what's in Supabase | **AMBIGUOUS**: needs a signed-in account. |
| 10.6 | Supabase Row Level Security on `profiles`, `workspaces`, `datasets`, `chat_sessions`, `chat_messages`, `workspace_relationships`, and the `csvs` storage bucket | Every table scopes reads/writes to `auth.uid()`; no user can read or write another user's rows via the client-side Supabase JS client | PASS (code-reviewed): all of the above correctly scope to `auth.uid()`, and `profiles` explicitly blocks a user from setting their own `is_premium` client-side. The one table using `USING (true)`, `landing_gates`, is intentionally public (a single-use, no-PII, 128-bit gate token) and is a reasonable design choice, not a defect. |

## 11. Security spot-checks

| # | Test | Expected | Result |
|---|------|----------|--------|
| 11.1 | CSV cell/column values are HTML-escaped before being rendered | Yes | **FAIL: Critical.** See 3.5. Root cause confirmed: `updateTable()` interpolates the raw column name and every raw cell value straight into `target.innerHTML` (synth.html:3098, :3112) with no escaping. The table-chip bar, the AI-focus dropdown, and the manual-relationship column `<select>` do the same (synth.html ~1754, ~1772, ~2223). This is inconsistent with the rest of the app: an `escapeHtml()` helper already exists and is correctly used for workspace names, saved-query titles, and AI chat replies (synth.html:845, 851, 1257-1258, 2816): the CSV render path was simply missed. A CSV is naturally the kind of file people forward to each other, so this is a real stored-XSS delivery path, not just a self-inflicted one. |
| 11.2 | No secret keys are hardcoded/exposed in client-shipped code | Only intentionally-public keys (Supabase anon key, Stripe publishable key) should be in `synth.html`; server secrets should stay in `api/*.js` reading `process.env` | PASS: grepped `synth.html` for `sk_live`/`sk_test`/generic "secret"/"api key" patterns; the only keys present are the Supabase anon key and Stripe *publishable* key, both of which are designed to be public. `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `SUPABASE_SERVICE_ROLE_KEY` are correctly confined to the three `api/*.js` serverless functions and read from `process.env`. `.env.local` (which does hold real local values) is present but correctly listed in `.gitignore` and not tracked by git. |
| 11.3 | `/api/create-checkout-session` won't create a session for a user id the caller doesn't control | Some form of server-side identity check on `userId` | **FAIL: Medium.** `req.body.userId` is trusted as-is with no check that the caller holds a session for that id (api/create-checkout-session.js:33-37). Exploitability is limited (an attacker would still need to complete a real payment, and UUIDs aren't guessable), but it's a trust-boundary gap worth closing. |
| 11.4 | Webhook signature verification | See 8.3 | FAIL: Critical (conditional), documented under 8.3. |

## 12. Cross-cutting / accessibility

| # | Test | Expected | Result |
|---|------|----------|--------|
| 12.1 | Keyboard-only modal dismissal | Escape works everywhere | FAIL, see 9.2. |
| 12.2 | Mobile layout, main app (SQL editor + results grid) | No page-level horizontal scroll; wide content scrolls in its own container | PASS: the results table correctly gets its own horizontal scrollbar at 375px width rather than blowing out the page. |
| 12.3 | Loading states | CSV parsing shows a labeled progress overlay rather than a frozen UI | PASS: "Loading your data… Parsing CSV & building a local database." |
| 12.4 | Error states | SQL errors are shown inline with actionable detail rather than a silent failure or raw stack trace | PASS: see 4.4's example ("no such table" + a list of real table names). |
| 12.5 | Empty states | "No saved queries yet", "No relationships yet", "Run a query to see results" all present and worded helpfully | PASS |

---

## Notes on method

A few things worth flagging so the results above are read correctly:

- Several early attempts to type into the column-filter boxes (test 4.7) produced confusing, inconsistent results purely because of how this session's browser-automation tool dispatches synthetic keystrokes into an input that gets destroyed and recreated mid-interaction. I didn't take that at face value: I went to the source, isolated the exact function the `onkeyup` handler calls, and reproduced the focus loss with a controlled, single call outside of any automation timing. The bug that's reported here (4.7) is the one confirmed independently of that tooling quirk; a couple of other odd readings along the way turned out to be nothing once cross-checked, and I dropped them rather than report noise.
- The Groq-backed AI assistant (section 7) and Supabase auth (section 2) are live, real backend services in this environment, not mocks. Section 7's tests reflect actual model output on the day of testing; a different question or a model update could produce different (and possibly differently-wrong) SQL.
- Everything marked AMBIGUOUS is ambiguous because it needs a capability this session doesn't have (a real inbox, a completed card payment, or a pre-existing premium/admin account), not because the behavior looked suspicious. None of them should be read as "probably broken."
