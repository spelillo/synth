# Synth — September 15 Update Batch: Spec

**Status:** Draft for review
**Author:** Claude Code (from Sean's 9/15 update list)
**Codebase context:** Synth is a single-file vanilla-JS app (`synth.html`, ~7,600 lines) with global mutable state (no framework, no store). SQL execution runs client-side via `sql.js` (SQLite/WASM). Auth + Postgres storage is Supabase. Payments are Stripe **one-time** ($9.99, not a subscription) — `profiles.is_premium` is a single boolean flipped by the Stripe webhook. Small serverless functions live in `/api` (Vercel).

---

## Problem Statement

Synth currently has three real gaps, all discovered while triaging this update list against the actual code:

1. **Marketing promises tiers that the code doesn't enforce.** The Settings/Help copy already claims table renaming, cross-table AI, and multi-CSV workspaces are Premium-exclusive — but zero gating code exists for any of them today. Any signed-in (even free) account already has full access. This is a trust/revenue gap, not just a missing feature.
2. **Two workflows silently fail instead of erring.** "Change workspace" no-ops for non-premium accounts and is invisible when it shouldn't be; Save Query has no tier boundary at all in Lite Mode. Both produce confusing "nothing happened" moments reported directly by Sean.
3. **Large CSVs make the app unusable.** A 100k-row upload in Lite Mode is "very very slow"; a 1,000-row one is fine. Root cause is a fixable rendering/parsing bug (unbounded `SELECT *` render into the DOM, unbatched SQLite inserts, no chunked parsing) — not a hard browser ceiling — so it affects every tier today, silently.

Left unfixed, (1) undercuts the premium upgrade path, (2) erodes trust in basic navigation, and (3) will surface as churn/support complaints as soon as users try realistically-sized datasets.

## Goals

1. Every feature the app already markets as Premium-only (multi-CSV, table rename, cross-table AI) is actually gated, with a single consistent "upgrade" prompt pattern — not silent access or silent failure.
2. "Change workspace" and "Save Query" behave correctly for every tier: no silent no-ops, no invisible controls, and Lite users get a frictionless sign-in path instead of a dead end.
3. A 100k-row CSV loads and renders responsively for at least Normal-tier accounts (target: <3s from file-select to interactive table view, from an untested current baseline the user describes as multi-second/hung).
4. Tier boundaries (row-count caps, table caps, AI daily limits) are documented in one place and match what the UI actually enforces — no more drift between marketing copy and code.
5. Ship the tagline update and SQL-editor column visibility as quick, low-risk wins alongside the above.

## Non-Goals

- **No migration to a subscription billing model.** Premium stays a one-time Stripe purchase; this batch does not touch checkout, refunds, or renewal logic.
- **No framework rewrite.** `synth.html` stays a single-file vanilla-JS app; gating is added as a small shared helper, not a state-management migration.
- **No cloud sync for saved queries.** They stay in `localStorage`, per-workspace, per-browser, as today. Sign-in becomes a *gate* for Normal+, not a sync mechanism — that's a separate future feature.
- **No retroactive migration of existing over-cap workspaces.** Per Sean's call: workspaces that already have multiple tables under a non-premium account keep working exactly as-is (view/query/add — no lockout). Only *new* workspace creation enforces the new caps. (See Open Questions for the one edge case this doesn't cover.)
- **No change to the AI rate-limit numbers.** 60/day (free) and 300/day (Premium), rolling 24h window, were audited against `AI_RATE_LIMIT_SPEC.md` and confirmed to already match the code exactly. Nothing to change here.

## Tier Model (net-new — this is the reference table the code doesn't currently have)

| Capability | Lite (no account) | Normal (signed in) | Premium |
|---|---|---|---|
| CSVs per workspace | 1 | 1 | up to 10 (existing `MAX_TABLES_PER_WORKSPACE`) |
| Rows per CSV | 50,000 soft cap → upgrade prompt above this | 50,000 soft cap → upgrade prompt above this | 500,000, with a non-blocking performance warning above that |
| Table rename | ❌ (sign-in prompt) | ❌ (upgrade prompt) | ✅ |
| Cross-table AI queries | ❌ (no AI at all, unchanged) | ❌ (upgrade prompt; also implies 2nd table, which they can't add) | ✅ |
| Save Query | ❌ (sign-in prompt, draft preserved) | ✅ | ✅ |
| Dashboards (workspace list/switch) | ❌ (sign-in prompt) | ✅ | ✅ |
| AI daily queries | 0 (no AI access, unchanged) | 60/day | 300/day |

Row-count numbers above are the recommended defaults, not final — see Open Questions.

## User Stories

**As a Lite-mode user (no account),**
- I want to know before I try to save a query that I need an account, and to be able to sign in right there without losing what I typed, so I don't lose work or get confused about why nothing happened.
- I want a clear message if I try to upload a very large CSV, so I understand why it's slow or blocked instead of assuming the app is broken.

**As a Normal (signed-in, free) user,**
- I want Save Query and Dashboards to just work, since those aren't premium features, so I'm not blocked on things I'm already entitled to.
- I want a clear upgrade prompt — not silent failure — when I try to add a second CSV, rename a table, or ask a cross-table AI question, so I understand *why* and *what to do next*.
- I want "Change workspace" to actually show me my saved workspaces and let me switch, so I can navigate between my own saved work.
- I want a friendly message (not a dead click) if "Change workspace" is the only option I have because I only have one workspace.

**As a Premium user,**
- I want all of the above to keep working exactly as it does today, uninterrupted.
- I want to load a 500k-row CSV without the app becoming unusable, and to get a warning (not a hard block) if I approach a size that will genuinely degrade performance.

**As any user writing SQL,**
- I want to see the column names of my table(s) while I'm writing a query, without switching tabs, so I don't have to guess or memorize schema.

**As a prospective user reading marketing copy,**
- I want the tagline to say what the product actually does in one line ("Instantly query any CSV file with SQL"), so I understand the value prop immediately.

## Requirements

### P0 — Must Ship

**R1. Centralized tier-gating helper (foundation for R2–R6)**
- Add a single `getUserTier()` → `'lite' | 'normal' | 'premium'` and `canUseFeature(featureKey)` helper in `synth.html`, replacing the scattered `if (!currentUser)` / `if (!isPremium)` checks that features currently lack entirely.
- Add one reusable gate modal component (generalizing the existing `#premium-signin-modal` pattern) with two variants: **"Sign in to use this"** (Lite → Normal boundary) and **"Upgrade to Premium"** (Normal → Premium boundary).
- Acceptance criteria:
  - [ ] A single source of truth exists for tier checks; no feature re-implements its own ad hoc check.
  - [ ] Gate modal correctly branches copy/CTA based on which boundary was hit.

**R2. Multi-CSV, table rename, and cross-table AI are actually gated to Premium**
- `addTablesCSV` / second-table upload path: Normal and Lite capped at 1 table per workspace (matching the existing `MAX_TABLES_PER_WORKSPACE=10` premium cap, now made tier-aware instead of universal).
- `startRenameChip` / `renameTable`: blocked for non-Premium, opens upgrade modal instead of executing.
- Cross-table AI (`buildSystemPrompt` cross-table branch): blocked for non-Premium — in practice this is naturally enforced once multi-CSV is gated, but add an explicit check too so it fails safely if reached another way.
- Given/When/Then:
  - Given a Normal-tier user with one CSV loaded, when they try to upload a second CSV into the same workspace, then they see the upgrade modal and the second file is not loaded.
  - Given a Normal-tier user, when they try to rename a table chip, then they see the upgrade modal and no rename occurs.
  - Given an existing (grandfathered) workspace that already has 3 tables under a Normal account, when they open it, then all 3 tables load and query normally, but attempting to add a 4th table triggers the upgrade modal.

**R3. Dashboards open to Normal + Premium (not just Premium)**
- `openDashboard()`'s current `if (!currentUser || !isPremium) return;` becomes `if (!currentUser) { open sign-in modal; return; }` — i.e., any signed-in user reaches the dashboard/workspace list; only the *number of tables per workspace* stays Premium-gated (R2), not dashboard access itself.
- Acceptance criteria:
  - [ ] Normal-tier signed-in user can open the dashboard and see/open/rename/delete their saved workspaces.
  - [ ] Lite (unauthenticated) user clicking anything dashboard-adjacent gets the sign-in modal, not a silent no-op.

**R4. "Change workspace" bug fix**
- Root cause (confirmed in code): (a) `updateWorkspaceSwitcher()` hides the pill based on the *currently loaded* table count instead of the *number of saved workspaces*; (b) `changeWorkspace()` calls `openDashboard()`, which no-ops for non-premium.
- Fix: pill visibility driven by "does this account have ≥1 saved workspace" (now reachable for Normal+ per R3); clicking it with exactly one saved workspace shows a friendly inline message ("This is your only workspace") instead of opening an empty/no-op dashboard.
- Given/When/Then:
  - Given a Normal-tier account with 3 saved workspaces and a single-table CSV currently open, when they look at the toolbar, then the "Change workspace" control is visible.
  - Given an account with exactly 1 saved workspace, when they click "Change workspace," then they see a friendly message stating this is their only workspace, not a blank/no-op dashboard.

**R5. Save Query gated to Normal+, with inline sign-in and draft preservation**
- Lite-mode users can still open the Save Query modal and fill it out normally (per Sean's explicit ask — don't remove the UI).
- On clicking Save while in Lite mode: show a sign-in modal *on top of* (or immediately after) the save modal, without discarding what was typed.
- After successful sign-in, the Save Query modal reopens pre-populated with whatever the user had entered before the interruption.
- Given/When/Then:
  - Given a Lite-mode user has filled out the Save Query modal (name + description), when they click Save, then a sign-in prompt appears without closing/clearing the save form's contents.
  - Given that user completes sign-in, when the flow returns, then the Save Query modal reopens with their name/description still filled in.
  - Given a Normal or Premium user, when they click Save, then it saves immediately as it does today — no behavior change.

**R6. Large-CSV performance fix + tier-based row cap**
- Fix the actual bottleneck (not just add a warning):
  - Batch `sql.js` inserts inside a single `BEGIN/COMMIT` transaction instead of one `stmt.run()` per row.
  - Chunk CSV parsing (e.g. `requestAnimationFrame`/`setTimeout`-yielded batches) so the main thread isn't blocked for the full parse.
  - Paginate `renderTableView()` / `renderTableBodyHtml()` — render a page (e.g. 200 rows) with next/prev or virtualized scroll, instead of dumping the entire result set into `innerHTML` on every render, sort, filter, and keystroke.
- Add the tier row-cap on top of the fix: Lite/Normal capped at 50,000 rows (upgrade modal shown, file not loaded, if exceeded); Premium capped at 500,000 rows with a non-blocking warning toast above that (file still loads).
- Acceptance criteria:
  - [ ] A 100,000-row CSV under a Premium account loads and the Table View is interactive (scroll/sort/filter) within a few seconds, not "very very slow."
  - [ ] A 100,000-row CSV under a Normal/Lite account is blocked at upload with a clear "upgrade to load files this large" message stating the current cap.
  - [ ] A 1,000-row CSV continues to behave exactly as it does today for every tier.

### P1 — Should Ship (same batch, lower risk if slipped)

**R7. SQL editor column visibility**
- Add a lightweight schema panel/sidebar (or an expandable strip above the editor) listing each loaded table's columns, visible while writing SQL in the `#tab-query` panel — no full autocomplete engine required for v1.
- Acceptance criteria:
  - [ ] With ≥1 table loaded, the query tab shows that table's column names without switching to Table View.
  - [ ] With multiple tables (Premium), each table's columns are visible/labeled separately.

**R8. Tagline update**
- Update `<title>`, `og:title`, and meta description in `synth.html` (lines ~6–9) to reflect: **"Synth: Instantly query any CSV file with SQL"**.
- Sweep help/about modal copy (`synth.html:7483`, `7513`, `7559` and similar) for the old phrasing ("Query any CSV with SQL or plain English") and align wording, without dropping the plain-English/AI mention where it's still accurate.

### P2 — Future Considerations (explicitly out of scope for this batch)

- Cloud sync for saved queries (currently `localStorage`-only by design).
- True autocomplete (type-ahead column/table suggestions) in the SQL editor, beyond the static column list in R7.
- Subscription-based Premium billing (vs. today's one-time purchase).
- A formal admin/audit view of tier boundaries (this spec's tier table is the source of truth for now; R1's helper is the code equivalent).

## Success Metrics

**Leading (days–weeks post-launch):**
- Zero reports of "Change workspace does nothing" (currently a live complaint) within 2 weeks of shipping R4.
- Upgrade-modal impressions on R2's new gates (multi-CSV, rename, cross-table AI) — establishes a baseline for premium-conversion funnel that didn't exist before, since these were previously silently free.
- Support/feedback mentions of "slow" or "frozen" tied to CSV upload drop to near zero for files under the new tier caps, within 2 weeks of shipping R6.

**Lagging (weeks–months):**
- Premium conversion rate among accounts that hit an upgrade-modal gate (new instrumentation from R2/R6) — target: establish a baseline in the first month, since this funnel didn't exist before this batch.
- No regression in Normal-tier retention after Dashboards/Save Query become properly available to them (expect this to be net-positive or neutral, not negative).

## Open Questions

- **[Product/Sean]** Are the row-count defaults (50k lite/normal, 500k premium) right, or should they be tuned after the perf fix is live and actually measured? Recommend shipping the perf fix first, measuring real render/parse time at 50k/100k/250k/500k, then locking numbers — the caps above are placeholders for that measurement.
- **[Product/Sean]** For R2's cross-table AI gate: if a Normal-tier user somehow has 2+ tables in a workspace (grandfathered per the "no special handling" decision), should cross-table AI work for them on that *existing* workspace, or should it also be blocked despite the tables already being there? Spec above blocks it outright for consistency with "cross-table AI is Premium" — flagging in case that's stricter than intended for the grandfathered edge case.
- **[Engineering]** R6's pagination change touches the same render path used by sort/filter/search (`getVisibleRows()`). Confirm sort/filter should also operate page-by-page (fast, but "sort" only sorts the visible page) vs. sorting the full dataset before paginating (correct, but reintroduces an O(n log n) full-array touch on every sort click). Recommend: sort the full in-memory array (cheap relative to DOM render) but only render the current page — this preserves correctness without reintroducing the DOM bottleneck.
- **[Product/Sean, non-blocking]** Noticed in passing during research: `profiles.is_premium` can be set back to `false` by the user themselves (self-service cancel), which is fine, but worth a quick manual confirmation that the RLS policy only allows the *downgrade* direction and not a self-service upgrade — outside this batch's scope, just flagging since it came up during the tier audit.

## Timeline Considerations

- No hard external deadline stated. Suggested phasing below (see companion plan doc) front-loads the tier-gating foundation (R1) since R2–R6 all depend on it, and sequences the CSV performance fix (R6) before locking exact row-count numbers, per the open question above.
- Per Sean's instruction: implementation will proceed in confirmable checkpoints (multiple-choice/custom-response check-ins) rather than as one large unreviewed change — see the companion plan doc for exactly where those checkpoints fall.
