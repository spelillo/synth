# Synth Improvement Guide — 2026-09-17

A full build-instructions doc for taking Synth from "working solo project" to "polished, popular, trustworthy product." Grounded in a direct read of [synth.html](synth.html) (9,543 lines) plus `api/`, `supabase/`, and the existing `*_SPEC.md`/`*_PLAN.md` docs. Ordered roughly by priority; each item has what, why, and how.

---

## 0. Fix first — small, high-risk-if-ignored

These are cheap to fix and either actively wrong or a launch blocker.

1. **Stripe publishable key is still in test mode.** `synth.html` line ~99 hardcodes `pk_test_...`. Before any real launch, swap in the live `pk_live_...` key. Cross-check `STRIPE_INTEGRATION_TODO.md` — confirm `STRIPE_ENTERPRISE_PRICE_ID` is a real recurring price, the webhook is subscribed to `customer.subscription.updated`/`.deleted`, and `STRIPE_WEBHOOK_SECRET` is set in Vercel (REMEDIATION_PLAN.md flagged unsigned-webhook-acceptance as Critical — confirm it's actually enforced, not just documented as fixed).

2. **Row-cap numbers disagree between code and docs.** `llms.txt` advertises "Free tier: up to 50,000 rows," but `synth.html`'s `CSV_ROW_CAP_STANDARD = 100000`. AI answer engines and users will quote whichever number they saw first — pick one (100,000 matches the code, so update `llms.txt` and `pricing.md` to match, unless you intend to drop the free cap back down, in which case change the code instead).

3. **`enterprise.html` is missing from `sitemap.xml`.** It has its own page and marketing surface now (per git history) but isn't discoverable via the sitemap. Add it.

4. **Re-verify the XSS/auth fixes now that the file has grown.** `REMEDIATION_PLAN.md`'s line numbers predate a lot of subsequent work. The critical fixes (`escapeHtml`/`escapeAttr` in table rendering, verified-token requirement in `api/chat.js`) are present today, but the plan also named the table-chip bar, the AI-focus dropdown, and the manual-relationship `<select>` as other `innerHTML` injection sites — grep for every remaining raw `innerHTML =` assignment (71 occurrences total per the survey) and confirm each one is either escaping user-controlled content or only ever rendering trusted/static strings. Do this as a standalone pass, not read-and-assume.

5. **Gmail SMTP is a stopgap.** `STRIPE_INTEGRATION_TODO.md` notes ~500/day limit via `nodemailer` + Gmail app password. Fine today; put a real transactional-email provider (Postmark, Resend, SES) on the roadmap before Enterprise volume grows — auth confirmation codes and renewal notices silently failing past the daily cap is a bad first-impression bug to discover in production.

---

## 1. Kill the signup wall — make Lite Mode the default path

**What:** Right now `landingMode` defaults to Normal Mode, which requires "Create your account" → email confirmation code → *then* "Upload a CSV" unlocks. That's the exact friction SQL for Files (competitor) doesn't have — they let you drop a file and query it in under 10 seconds, no account.

**Why:** First-run conversion is almost certainly being lost here. Nobody evaluating a new tool wants to create an account before they've seen it do anything.

**How:**
- Flip `initLandingMode()`'s default so a first-time visitor lands in Lite Mode (upload → query immediately, everything in-memory via sql.js, nothing sent to Supabase).
- Keep the mode toggle visible and let people explicitly switch to Normal Mode when they want saved history / cross-device sync — frame it as an *upgrade*, not a *prerequisite* ("Sign in to save this session" as a banner after they've already run a query, not a gate before they can run one).
- Update the JSON-LD/OG description and `llms.txt` if the "how it works" framing changes, since both currently describe account creation as step 1.
- This is the single highest-leverage change in this doc — do it before anything else below.

---

## 2. Expand file format support: JSON / NDJSON

**What:** Synth is CSV-only. Competitor supports CSV, JSON, and Parquet via DuckDB-WASM.

**Why:** "Query your CSV" is a narrower pitch than "query your files." Every JSON-only user currently has zero reason to pick Synth.

**How:**
- Add a JSON/NDJSON parser alongside `parseCSVText` (2801+) that flattens/normalizes into the same table shape (`tables` array, same insert path into the sql.js `db`). Reuse the existing chunked-insert pattern (`CSV_CHUNK_SIZE`, `yieldToUI()`) for large JSON arrays.
- Handle both a single JSON array-of-objects and newline-delimited JSON (one object per line) — these are the two shapes competitor explicitly supports and the two shapes real API exports/log dumps actually come in.
- Nested objects/arrays inside JSON records need an explicit decision: flatten with dot-notation keys (`address.city`), or store as a JSON string column that users can query with SQLite's `json_extract`. Either is defensible; document the choice in the guide pages (see §5) since users will ask.
- Parquet is a much bigger lift (needs a WASM Parquet reader; sql.js doesn't read it natively) — treat as a stretch goal, not part of this pass, unless you're willing to add DuckDB-WASM alongside/instead of sql.js.

---

## 3. Ship the content/SEO layer

**What:** Competitor's repo shows deliberate SEO investment (commit messages like "improved SEO," a `medium-guides/` folder, multiple guide pages, a "Learn SQL" panel). Synth has one guide page (`query-csv-with-sql.html`) and otherwise no content marketing surface.

**Why:** This is how they'll out-rank you on the exact long-tail queries you both want ("query csv with sql," "analyze json in browser," "sql without database setup"). Content pages are also what AI answer engines cite — more indexed pages with real content means more chances to be the cited source.

**How:**
- Add 5–8 more guide pages following the existing `query-csv-with-sql.html` pattern (reuse `marketing.css`). Target concrete intents:
  - "Query JSON files with SQL" (ships alongside §2's JSON support)
  - "SQL cheat sheet for CSV analysis"
  - "Ask questions about your data in plain English" — this is your actual differentiator, lean into it hard since no direct competitor has it
  - "CSV to SQLite in the browser, no install"
  - "How to join two CSV files with SQL"
  - "Privacy-first data analysis: nothing leaves your browser" (Lite Mode framing from §1)
- Cross-link every guide to the app and to each other; add each new page to `sitemap.xml`.
- Consider a lightweight "Learn SQL" panel inside the app itself (competitor has this) — even a static set of 8–10 guided lessons with sample data would close a real gap, and you already have the dataset-library seeding infra (`scripts/seed-dataset-library.js`) to source sample data from.

---

## 4. Make the GitHub repo a credible public artifact

**What:** `github.com/spelillo/synth` currently has no visible README or LICENSE, next to a competitor repo with a full README, AGPL license, CI badges, and 112 commits of visible history.

**Why:** Anyone who clicks through from a "check the source" link, a dev-community post, or a GitHub search sees an apparently undocumented/private-feeling repo. That's a trust and discoverability gap independent of actual code quality.

**How:**
- Add a real `README.md`: one-line pitch, a screenshot or GIF of the app in use, feature list, "Try it live" link, local dev setup (`vercel dev` instructions already exist in the code comments — surface them), and license.
- Pick and add a `LICENSE` file. If you want to keep the business (Premium/Enterprise pricing) while still being "open," note that plenty of paid SaaS products keep client code source-available under something like BUSL, or you can keep the repo private and skip this entirely — but if it's public, an undocumented public repo is worse than a private one.
- Add a repo description and topics (`sql`, `sqlite`, `csv`, `wasm`, `data-analysis`) so it surfaces in GitHub search.

---

## 5. Add trust-building features competitor's demo already has

**What:** Column stats and lightweight charting are visible on competitor's homepage demo; Synth has neither (only the relationship-diagram/ERD canvas, which is a different feature).

**Why:** These are cheap wins that make the product *feel* complete in the first 30 seconds, which is exactly when someone decides whether to keep evaluating.

**How:**
- **Column stats:** you already compute types during CSV parse/normalize — surface a per-column summary panel (min/max/mean for numeric, distinct-count/most-common for string, null-count for all) when a table is selected. This is mostly a rendering task on data you already have, not new data infrastructure.
- **Charts:** add a minimal bar/line/pie view over the current result set (a small dependency like Chart.js, or hand-rolled SVG since you already do SVG rendering for the ERD canvas) with SVG/PNG export, matching what competitor offers. Scope this to "chart the current query result," not a full BI tool.

---

## 6. Extend the AEO/llms.txt advantage you already have

**What:** Synth already has `llms.txt`, `pricing.md`, and full `schema.org` JSON-LD — ahead of competitor on this specific front. Don't lose that lead.

**How:**
- Every new page from §3 needs its own accurate meta description + should be reflected in `llms.txt`'s "Key pages" list.
- Fix the row-cap discrepancy from §0.2 — an AI engine citing wrong pricing/limits actively hurts conversion when a user shows up expecting something the product doesn't do.
- Once JSON support (§2) ships, update `llms.txt`'s "Key facts" to say "CSV and JSON" instead of just CSV — this is exactly the kind of fact AI answer engines will quote verbatim.
- Consider adding an `Organization`/`FAQPage` schema block to the pricing or about page — FAQ-schema pages are disproportionately surfaced in AI-generated answers.

---

## 7. Architecture cleanup (not urgent, but compounds every future change)

**What the survey found:** `synth.html` is one 351KB file — ~4,930 lines of JS, ~3,780 lines of CSS, ~775 lines of HTML, all inline, no build step, no modules. ~130 top-level functions share ~30+ global mutable variables with no namespacing. Event wiring is inconsistent (121 inline `onclick=` handlers vs. 32 `addEventListener` calls vs. some handlers manually attached to `window`). There's duplicated logic between the personal-Premium and Enterprise Stripe checkout flows.

**Why this matters for "improve Synth as a whole":** every feature in §1–§6 gets slower and riskier to add as this file grows, because there's no isolation between concerns — a change to chat rendering can silently break table rendering if they happen to share a global. This isn't a "rewrite it all" recommendation; it's a "the next 6 months of features will hurt less if you do this incrementally" one.

**How (incremental, doesn't require a rewrite):**
1. **Introduce a build step** (Vite is already a natural fit — competitor uses it, and it needs near-zero config for a project this shape). This alone lets you split the file without changing behavior.
2. **Split by concern, not all at once:** pull out, in order of how self-contained they already are:
   - `auth.js` (Supabase init, sign-in/sign-up, session handling)
   - `checkout.js` (unify the personal + Enterprise Stripe flows into one parameterized module instead of two hand-rolled copies)
   - `csv-parser.js` / `json-parser.js` (parsing logic, pure functions, easiest to unit-test)
   - `chat.js` (AI assistant prompt-building + rendering)
   - `grid.js` (results table rendering — also where you'll add virtualization, see §8)
   - Leave the CSS as one file for now (3,780 lines of CSS is annoying but not dangerous the way shared JS globals are); split later if it becomes a problem.
3. **Standardize event wiring** as you touch each module — pick `addEventListener` in JS over inline `onclick=`, since inline handlers block any future Content-Security-Policy tightening and make the split above harder (inline handlers reference global function names that have to keep existing).
4. **Replace ad-hoc `window.fnName = ...` exposure** with a single small event-delegation layer or a documented "these are the public entry points" module, so it's obvious which functions are called from HTML vs. only from other JS.

This is genuinely the biggest and lowest-glamour item in this doc. It's also the one that determines how fast everything else can ship.

---

## 8. Performance: virtualize the results grid

**What:** `updateTable()`/`renderTableBodyHtml()` build the entire filtered/sorted row set into one `<tbody>` HTML string and set it via `innerHTML` in one shot — no pagination or windowing. Premium's advertised 500,000-row cap means a full result set can mean 500,000 `<tr>` elements in the DOM at once.

**Why:** This will visibly lag or freeze the tab on large Premium-tier files — the exact tier that's supposed to feel like the premium experience. CSV *ingestion* is already well-chunked (`CSV_CHUNK_SIZE`, `yieldToUI()`); rendering is the remaining bottleneck.

**How:**
- Add row virtualization to the results grid — render only the rows currently in the scroll viewport (a few hundred `<tr>`s) plus a buffer, recycling DOM nodes on scroll. This can be hand-rolled (compute visible range from `scrollTop` / row height) or use a small virtualization library — either is fine given there's no framework here yet.
- Keep the existing filter/sort/search logic operating on the full in-memory result set; only the *rendering* needs windowing.
- Test explicitly with a 500K-row CSV before calling this done — "should be fine" isn't verification for a perf fix.

---

## 9. Accessibility: currently not a first-class concern

**What the survey found:** ARIA usage is sparse (21 `aria-hidden`, 9 `aria-expanded`, 8 `aria-label` across 9,500 lines) and concentrated only around the auth-panel tabs. **`tabindex` appears zero times in the entire file** — no explicit focus order, no visible focus-trap logic in the many custom modal overlays. A lot of interactive UI (sortable table headers, chip lists, dropdown menus, ERD drag targets) is built from `<div onclick>` rather than semantic/focusable elements. No dark mode / `prefers-color-scheme` support at all (motion preference *is* respected via `prefers-reduced-motion`, which is good).

**Why:** Keyboard-only and screen-reader users currently can't reliably operate the modals or the results grid, and this is also a straightforward SEO/quality signal (Lighthouse accessibility score, which factors into how tools and some search surfaces perceive the site).

**How:**
- **Modal focus trapping:** every custom modal overlay needs (a) focus moved to the modal on open, (b) Tab/Shift+Tab cycling contained within it, (c) focus returned to the triggering element on close, (d) `aria-modal="true"` + `role="dialog"`. This is a single reusable utility applied to every `open*Modal`/`close*Modal` pair — good candidate to build once as part of the §7 modal-management extraction.
- **Convert div-based interactive controls to real buttons or add `role`+`tabindex`+keyboard handlers** — at minimum, sortable column headers and dropdown triggers.
- **Dark mode:** add a `prefers-color-scheme: dark` media block (or explicit toggle) — increasingly a baseline expectation for developer-facing tools, and competitor doesn't have this either, so it's also a differentiation opportunity, not just a checkbox.
- Run an automated pass (axe or Lighthouse) after the above as a sanity check, not as the primary method — automated tools catch maybe a third of real issues; the modal/keyboard-nav fixes above need manual verification.

---

## Suggested order of operations

1. **§0** (fix-firsts) — same day, no design decisions needed.
2. **§1** (Lite Mode default) — biggest conversion impact, isolated change, do it before investing in anything else.
3. **§3 + §6** (content pages + llms.txt sync) — can run in parallel with engineering work, no code risk.
4. **§4** (README/LICENSE) — an afternoon, do it whenever, no dependencies.
5. **§2** (JSON support) — the real feature-parity gap; start once Lite Mode ships so new users actually see it on their first try.
6. **§5** (column stats, then charts) — column stats first (cheaper, reuses existing parse data), charts second.
7. **§7** (architecture split) — start incrementally alongside §2/§5 rather than as a separate project; every new module you add from here should go in a real file, not back into synth.html.
8. **§8** (grid virtualization) — do this before marketing the 500K-row Premium cap harder, since right now that cap is a performance liability, not a selling point.
9. **§9** (accessibility) — fold modal-focus-trapping into the §7 modal extraction; do the rest as an explicit pass once the DOM structure stabilizes post-split.
