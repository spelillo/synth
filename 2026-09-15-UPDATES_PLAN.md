# Synth — September 15 Update Batch: Implementation Plan

Companion to `2026-09-15-UPDATES_SPEC.md`. All line numbers reference `synth.html` as of the current `main` branch (commit `d45503b`).

**How this will run:** work proceeds phase by phase in the order below. At each ✋ **checkpoint**, implementation pauses and a multiple-choice/custom-response question is presented before continuing, per Sean's explicit request to confirm changes as they go — rather than delivering one large unreviewed diff.

---

## Phase 0 — Tier-gating foundation (blocks everything else)

**Why first:** R2–R6 in the spec all need a consistent way to ask "can this account do X," and a consistent way to tell them no. Building this once avoids 5 different ad hoc `if` checks.

**Files:** `synth.html` (new helper functions near the existing `isPremium`/`currentUser` globals, ~line 199-224)

1. Add `getUserTier()`:
   ```js
   function getUserTier() {
     if (!currentUser) return 'lite';
     return isPremium ? 'premium' : 'normal';
   }
   ```
2. Add a small feature→minimum-tier map and `canUseFeature(featureKey)`:
   - `multiCsv`, `tableRename`, `crossTableAI` → `'premium'`
   - `saveQuery`, `dashboard` → `'normal'`
3. Add one reusable gate modal (generalize `#premium-signin-modal`, `synth.html:6919-6929`) — `openTierGateModal(requiredTier, context)`:
   - `requiredTier === 'normal'` and current is `'lite'` → "Sign in to use this" copy + sign-in CTA (reuse `toggleAuthPanel()`).
   - `requiredTier === 'premium'` → "Upgrade to Premium" copy + existing `window.openPremiumPanel()` CTA.
4. Add a minimal event hook (e.g. `logGateImpression(featureKey, tier)` → just a `console.log`/local array for now, or a lightweight Supabase insert if there's already an events table) so the spec's "upgrade-modal impressions" success metric is measurable from day one, not bolted on later.

✋ **Checkpoint 0:** confirm the tier map above matches intent (in particular: is `dashboard` really `'normal'` minimum, or should Lite get a *preview* of dashboards with everything gated inside? Spec assumes full sign-in wall for Lite here) before wiring it into every feature in Phases 1–5.

---

## Phase 1 — Dashboards open to Normal + Premium (R3)

**Files:** `synth.html:811-817` (`openDashboard`)

1. Change the guard from `if (!currentUser || !isPremium) return;` to:
   ```js
   if (!currentUser) { openTierGateModal('normal', 'dashboard'); return; }
   ```
2. No changes needed to `renderDashboard()` (`synth.html:833-891`) itself — it already lists whatever workspaces exist for `currentUser`, it just wasn't reachable before for non-premium.

**Test:** sign in as a non-premium test account, confirm Dashboard opens and lists workspaces; confirm Lite (signed-out) still gets the sign-in modal, not a silent return.

---

## Phase 2 — "Change workspace" bug fix (R4)

**Files:** `synth.html:1780-1788` (`updateWorkspaceSwitcher`), `synth.html:1874-1877` (`changeWorkspace`)

1. `updateWorkspaceSwitcher()`: replace the `tables.length <= 1` visibility check with a check against the account's *saved workspace count* (will need a lightweight cached count from the last dashboard/workspace fetch, or a small Supabase count query — reuse whatever `renderDashboard()` already fetches rather than adding a second round-trip).
2. `changeWorkspace()`: 
   - If saved-workspace count is exactly 1 → show a friendly inline toast/message: "This is your only workspace." (no dashboard open).
   - If ≥2 → proceed to `openDashboard()` as today (now reachable for Normal+ per Phase 1).
   - If 0 (shouldn't normally happen while a workspace is loaded, but defensively) → same friendly message pattern.

**Test:** 3 scenarios — account with 1 workspace, account with ≥2 workspaces, and Lite mode (control shouldn't attempt to open anything, should prompt sign-in if visible at all).

✋ **Checkpoint 1:** confirm the "only one workspace" message should be a toast vs. a small modal, and exact copy, before finalizing.

---

## Phase 3 — Gate multi-CSV, table rename, cross-table AI to Premium (R2)

**Files:**
- `synth.html:1638` (`MAX_TABLES_PER_WORKSPACE`), `synth.html:1660` / `1728-1732` (`uploadCSV`, `addTablesCSV`)
- `synth.html:1900-1920` / `1922-1962` (`startRenameChip`, `renameTable`)
- `synth.html:2468-2487` (`buildSystemPrompt`, cross-table branch)

1. In `addTablesCSV` (and the second-file path inside `uploadCSV`), before allowing a table beyond the first: `if (tables.length >= 1 && !canUseFeature('multiCsv')) { openTierGateModal('premium', 'multiCsv'); return; }`. Leave `MAX_TABLES_PER_WORKSPACE = 10` as the Premium ceiling, unchanged.
2. In `startRenameChip`: `if (!canUseFeature('tableRename')) { openTierGateModal('premium', 'tableRename'); return; }` before entering the contenteditable rename flow.
3. In `buildSystemPrompt`'s cross-table branch (`tables.length > 1`): add a defensive `if (!canUseFeature('crossTableAI')) { /* fall back to single-table prompt or block */ }` — this is a belt-and-suspenders check since (1) already prevents non-premium from reaching 2+ tables going forward, but existing grandfathered workspaces can still hit this path (see spec Open Questions — confirm desired behavior before finalizing this one).

✋ **Checkpoint 2:** confirm the cross-table-AI behavior for grandfathered multi-table Normal workspaces (block it despite tables existing, vs. allow it since the tables are already there) — this is the one item flagged as an open question in the spec, and changes what step 3 above actually does.

**Test:** Normal-tier account — attempt 2nd CSV upload (blocked, modal shown), attempt table rename (blocked, modal shown). Premium account — both succeed unchanged. A manually-seeded "grandfathered" workspace (2+ tables, non-premium owner) — first table operations work, adding a 3rd is blocked, cross-table AI behaves per Checkpoint 2's answer.

---

## Phase 4 — Save Query gated to Normal+, with sign-in-and-resume (R5)

**Files:** `synth.html:1203-1211` (`openSaveQueryModal`), existing save-query form fields/state, `#premium-signin-modal` pattern (`synth.html:6919-6929`) as the UI template

1. Leave `openSaveQueryModal()` itself unchanged — Lite users can still open and fill it out.
2. On the modal's Save button handler: before persisting to `localStorage`, check `canUseFeature('saveQuery')`. If false (Lite):
   - Capture current form field values into a small temp object (e.g. `window.pendingSaveQueryDraft`).
   - Open the sign-in modal (reuse `toggleAuthPanel()` / the existing auth panel), on top of or immediately replacing the save modal — don't clear the save modal's DOM state, just cover it.
3. Hook into the existing `handleAuthChange` (`synth.html:173`, called from `initAuth()`'s `onAuthStateChange`) — after a successful sign-in, if `window.pendingSaveQueryDraft` is set, reopen `openSaveQueryModal()` and repopulate its fields from the draft, then clear the draft variable.
4. Normal/Premium: unchanged, saves immediately as today.

**Test:** Lite mode — fill form, hit Save, confirm sign-in modal appears without losing form contents, complete sign-in, confirm modal reopens pre-filled, confirm save then succeeds. Normal/Premium — confirm zero behavior change (regression check, since this handler is shared).

---

## Phase 5 — SQL editor column visibility (R7)

**Files:** `synth.html:7300-7314` (`#tab-query` panel), table metadata already available via existing table-chip rendering (`renderTableChips()`, `synth.html:1791-1816`) — reuse that data source rather than re-querying schema.

1. Add a collapsible panel or persistent strip above/beside `#query-input` listing each loaded table + its column names (pull from the same in-memory schema data `renderTableChips()` already has — likely `tables` global plus a per-table columns array already tracked for rename/relationship logic).
2. Multiple tables (Premium): group columns under each table name so it's unambiguous which column belongs where, relevant for cross-table JOINs.
3. No autocomplete/typeahead in this pass (P2 per spec) — static, always-visible list is sufficient for v1.

✋ **Checkpoint 3:** confirm placement — a collapsible sidebar (persistent, takes horizontal space) vs. an expandable strip above the editor (drawer, saves space but requires a click) — a quick screenshot/mockup comparison makes sense here before writing the final CSS.

**Test:** load 1 table, confirm columns visible in query tab without switching tabs; load 2 tables (Premium), confirm both show grouped separately.

---

## Phase 6 — Tagline + copy sweep (R8)

**Files:** `synth.html:6-9` (title/meta tags), `synth.html:7483/7513/7559` (help/about modal copy)

1. Update:
   - `<title>Synth: Instantly query any CSV file with SQL</title>`
   - `og:title` content to match
   - Meta description: keep the plain-English/AI mention if still accurate, lead with the new tagline.
2. Sweep the 3 help/about locations for the old "Query any CSV with SQL or plain English" phrasing and align without duplicating verbatim (avoid it reading like the same sentence copy-pasted 4 times).

**Test:** view page source / browser tab title, view Help modal, confirm consistent phrasing. Zero functional risk — safe to ship independently of everything else, could go out first as a quick win if desired.

---

## Phase 7 — Large-CSV performance fix + tier row cap (R6)

**This is the largest and riskiest phase — sequenced last so Phases 0-6 (foundation + simpler fixes) are already stable.**

**Files:**
- `synth.html:1543-1576` (`parseCSVText`)
- `synth.html:1591-1610` (`normalizeThousandsSeparators`)
- `synth.html:1614-1636` (`loadFileAsTable`)
- `synth.html:3307-3322` (`renderTableView`)
- `synth.html:3200-3211` (`renderTableBodyHtml`)
- `synth.html:3115-3166` (`getVisibleRows` — sort/filter/search)

**Step 7a — Row-count tier gate (independent of the perf fix, do this first, cheap):**
1. After `parseCSVText` returns row count, before rendering: check `canUseFeature`-style row cap (`lite`/`normal` → 50,000; `premium` → 500,000 soft-warn threshold).
2. Over cap for lite/normal → `openTierGateModal('premium', 'csvRowCap')`, abort load, no partial state left behind.
3. Over the premium soft threshold → non-blocking warning toast, proceed with load.

**Step 7b — Chunked parsing:**
1. Break `parseCSVText`'s line-by-line loop into batches (e.g. 2,000 lines at a time) yielded via `setTimeout(...,0)` or `requestIdleCallback`, so the main thread isn't blocked for the full file. Same treatment for `normalizeThousandsSeparators`'s O(rows × cols) pass — fold it into the same chunked pass rather than a second full iteration if possible.

**Step 7c — Batched inserts:**
1. In `loadFileAsTable()`, wrap the per-row `stmt.run(row)` loop in a single `db.run('BEGIN TRANSACTION')` / `db.run('COMMIT')` (sql.js supports this) instead of implicit per-statement commits.

**Step 7d — Paginated Table View (the big one):**
1. `renderTableView()`: replace the unbounded `SELECT * FROM "table"` with a paged query (`LIMIT/OFFSET`, page size ~200 rows) plus a separate lightweight `SELECT COUNT(*)` for total-row display.
2. `renderTableBodyHtml()`: only ever builds HTML for the current page's rows, never the full dataset.
3. `getVisibleRows()` (sort/filter/search): per spec's Open Question — sort/filter operate on the full in-memory row set (correctness), but only the current page gets rendered to the DOM (performance). Add pagination controls (next/prev, or a simple page-jump) to the Table View tab.

✋ **Checkpoint 4:** after 7a-7c land and are testable, share actual measured load times for 50k/100k/250k/500k-row files before finalizing the exact tier cap numbers in the spec's tier table (currently placeholders per the spec's Open Questions) — this is the natural point to lock real numbers instead of estimates.

✋ **Checkpoint 5:** after 7d lands, confirm pagination UX (page-number style vs. infinite-scroll vs. "load more" button) before considering this phase done — this is a user-facing interaction choice, not just a perf fix.

**Test:**
- 1,000-row CSV: confirm zero visible behavior change for any tier (regression baseline).
- 50,000-row CSV: Lite/Normal — blocked with clear upgrade messaging; Premium — loads, paginated Table View is responsive.
- 100,000+ row CSV: Premium — loads and is interactive (scroll/sort/filter) without the "very very slow" symptom Sean reported.
- Sort/filter/search on a large loaded table: confirm still correct across the *full* dataset, not just the visible page.

---

## Phase 8 — Cross-tier regression pass

Once Phases 0–7 are in, do one pass testing every feature area × every tier (Lite / Normal / Premium) as a matrix, since several phases touch shared code paths (`handleAuthChange`, `renderDashboard`, table-chip rendering):

| Feature | Lite | Normal | Premium |
|---|---|---|---|
| Upload 1st CSV | works | works | works |
| Upload 2nd CSV | blocked (sign-in) | blocked (upgrade) | works |
| Table rename | blocked (sign-in) | blocked (upgrade) | works |
| Cross-table AI | N/A (no AI access) | blocked (upgrade) | works |
| Save Query | sign-in-and-resume flow | works | works |
| Dashboard / Change workspace | sign-in prompt | works, incl. "only 1 workspace" message | works |
| Large CSV (50k+) | blocked (upgrade) | blocked (upgrade) | works, paginated |
| AI daily limit | N/A | 60/day enforced (unchanged, just re-verify) | 300/day enforced (unchanged, just re-verify) |

Ship after this matrix passes clean.

---

## Suggested Sequencing Summary

`Phase 0 (foundation) → Phase 1 (dashboard) → Phase 2 (workspace switcher) → Phase 3 (multi-CSV/rename/cross-table gates) → Phase 4 (save query gate) → Phase 5 (schema panel) → Phase 6 (tagline, can ship anytime independently) → Phase 7 (perf + row cap, largest/riskiest, last) → Phase 8 (regression matrix)`

Phase 6 has zero dependencies and zero risk — it can be pulled forward and shipped same-day if a quick early win is wanted while the rest is in progress.
