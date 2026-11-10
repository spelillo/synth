# Testing

Synth's test suite, how to run it, what it covers, and what it doesn't.

## Running the suites

```bash
npm ci
npm test                # unit + integration, about 15s, no browser
npm run test:coverage   # the same, plus the coverage gate CI enforces
npm run test:e2e        # Playwright end-to-end, about 40s (needs Chromium: npx playwright install chromium)
npm run test:perf       # performance budgets, writes perf-report.json
npm run test:real       # real-service suites (skip themselves unless configured, see below)
npm run test:all        # coverage + e2e + perf: what CI runs on every change
```

Everything uses Node's built-in test runner (`node --test`), with no extra framework. Run one file with `node --test --experimental-test-module-mocks path/to/file`, or a single test with `--test-name-pattern="part of the name"`.

## CI

`.github/workflows/test.yml` runs on every push to `main`, every pull request, and every Vercel deployment:

| Job | What it runs | Fails the build when |
|---|---|---|
| `unit` | unit + integration tests under c8 | any test fails, or coverage drops below 95% lines / 95% functions / 85% branches |
| `e2e` | Playwright against the local stack | any user flow breaks, or the page throws an uncaught error |
| `perf` | performance budgets | any budget is exceeded (report uploaded as an artifact) |
| `rls` | Row Level Security on a real Supabase test project | a policy leaks data (skips with a warning until secrets are set) |
| `preview` | smoke test of each Vercel preview URL | the deployed build is broken (runs on `deployment_status`) |
| `ci-passed` | waits for `unit`, `e2e`, `perf` and `rls` | any of them didn't succeed |

### One-time setup that the workflow file can't do on its own

1. **Make the gate binding.** In GitHub, go to Settings → Rules → Rulesets (or Branches → Add branch protection rule) for `main`: require a pull request, require the status check `ci-passed`, and block force pushes. Until you do this, CI reports failures but GitHub still lets you merge.
2. **Vercel deploys `main` on push whether or not CI passed.** With branch protection on, nothing reaches `main` without a green `ci-passed`, so production is still gated. To also hold back deploys, turn on Vercel's Deployment Checks (Project → Settings → Git) and pick `ci-passed`.
3. **Optional secrets** (Settings → Secrets and variables → Actions):
   - `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY`: a **separate, disposable** Supabase project with `supabase/schema.sql` and the migrations applied. These turn on the real RLS suite. The suite refuses to run against the production project.
   - `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD`: a dedicated test account on the preview environment. These turn on the signed-in part of the preview smoke test.

## How the suites are built

```
tests/
  helpers/
    memory-supabase.js   in-memory Supabase (Postgres/PostgREST, Auth, Storage), shared by every tier
    api-harness.mjs      mocks @supabase/supabase-js, stripe, nodemailer; fake req/res; signed Stripe events
    browser-env.js       runs the browser scripts (shared globals, no modules) inside jsdom
    learn-env.js         sql.js + lesson databases for the Learn tests
  unit/api/              every serverless function and helper in api/
  unit/frontend/         parsers, charts, chat rendering, cookie storage, tier gates, analytics, helpers
  *.test.js              Learn: grader, curriculum, datasets, progress, weekly report (pre-existing)
  integration/           modules chained together: upload→parse→SQLite→query→chart, auth→rate limit→chat,
                         checkout→webhook→Premium, the full Enterprise lifecycle
  e2e/                   Playwright: critical-paths + Learn
  e2e/support/           test server (static files + real api/ handlers + /__supabase) and browser routing
  perf/                  performance budgets
  real-services/         real Supabase RLS; deployed-preview smoke test
```

**Mocks.** Groq, Stripe's API, Gmail SMTP and Supabase are replaced in unit, integration and local E2E tests. Two things are deliberately left real: Stripe webhook signatures are produced and verified with the real `stripe` library, and SQL runs on the real sql.js build the browser loads.

**One database across the E2E stack.** In the browser E2E suite, the page's Supabase client sends every query to the test server, which runs it against the same in-memory backend the API handlers use. A row the UI writes is what the webhook reads, and a Premium flag the webhook sets is what the UI shows after reload. The backend models Postgres behaviour that matters for correctness: unique constraints, upsert on conflict, `.single()` errors, cascading deletes, and owner-based RLS for browser requests.

**Known bugs as `test.todo`.** Each confirmed bug the suite found has a test that asserts the correct behaviour, marked `todo`. It runs and shows in every report but doesn't block the build. When you fix the bug, change `test.todo` to `test`.

## Checklist: what is tested

### Authentication
- [x] Sign up → emailed 6-digit code → confirmed and signed in (E2E)
- [x] Client-side validation: invalid email, password under 8 characters; nothing is sent to Supabase (E2E)
- [x] Wrong password shows "Invalid login credentials"; right password signs in; session survives reload (E2E)
- [x] Forgot password → reset email → recovery link (PASSWORD_RECOVERY) → short password rejected → new password works, old one doesn't (E2E)
- [x] Sign out clears tables, the in-browser SQLite database and the chat history (E2E)
- [x] API token verification: missing, malformed, non-Bearer, forged and expired tokens; Supabase outage; a user id in the body is ignored (unit)
- [x] A signed-out token can't reach the AI after sign-out (integration)
- [x] Session cookie storage: chunking past 3,600 characters, shrinking, removal, key collisions, unicode, non-synth hosts (unit)

### Payments
- [x] Checkout session is bound to the **verified** user, never a client-supplied id (unit, integration, E2E over HTTP)
- [x] Webhook: missing secret → 500, forged signature → 400, tampered body → 400, missing header → 400; none of them grant anything (unit, E2E over HTTP)
- [x] Personal Premium granted by the webhook, upsert without duplicates, safe on redelivery (unit)
- [x] Abandoned checkout grants nothing (integration)
- [x] Premium raises the AI daily cap from 60 to 300 (integration) and shows in the UI after reload (E2E)
- [x] Enterprise checkout guards, each checked before any charge: already in an org, public email domain, domain already claimed, unreadable account email (unit)
- [x] Enterprise fulfilment: org, admin membership and admin Premium are created; idempotent on redelivery; partial failures leave no half-created state (unit)
- [x] Full Enterprise lifecycle: purchase → join link → same-domain join, outsider refused → renewal email sent once → auto-renew off (Stripe and DB) → subscription ends → teardown → old join links die → domain can be bought again (integration)
- [x] Renewal notices: the 90/30/7-day thresholds, one notice per run, no re-sends, skips cancelled or lapsed orgs, a failed email isn't marked as sent, cron secret enforced (unit)

### Data submission
- [x] CSV parsing: quoted commas, CRLF, blank lines, ragged rows, BOM, header sanitizing, thousands separators, 12k rows across parse chunks (unit)
- [x] Non-CSV detection (xlsx/docx/xls/binary) with a friendly error (unit)
- [x] JSON / NDJSON: nested flattening, arrays as JSON text, key union, bad-line reporting (unit)
- [x] Row caps: 100k free, 500k Premium, boundaries, upgrade prompt (unit, integration)
- [x] Table loading: padding and truncation, name collisions (`sales_2`), SQL-injection-shaped column names and values are bound, not interpolated (unit)
- [x] Upload → query → aggregate / join across CSV and NDJSON; every bundled sample dataset loads (integration)
- [x] In the browser: CSV and JSON upload, querying, SQL error display, Ctrl+Enter, wrong file type message (E2E)
- [x] Analytics endpoint validates and sanitizes every field (unit); the client dedupes events daily and never sends query text (unit)

### Data deletion
- [x] Delete a workspace from the dashboard → confirmation modal → the row, its datasets (cascade) **and its Storage files** are gone (E2E)
- [x] Sign out wipes in-memory data (E2E)
- [x] Subscription end deletes the org and cascades members and join links; members' org Premium is revoked; other orgs and personal buyers are untouched; a failed revoke stops the delete (unit)
- [x] Workroom roster removal; template disable (unit)

### Cloud save and isolation
- [x] Save to cloud → stored CSV keeps its quoting → reload → reopen → query works (E2E)
- [x] A second user sees none of the first user's workspaces (E2E; RLS modelled in the fake)
- [x] Real RLS policies: workspaces, storage folders, profile self-upgrade, org self-attach, service-role writes (real-services suite, **runs only once the secrets are set**)

### AI assistant
- [x] Signed-in question → `/api/chat` → Groq → **Use Query** → results (E2E)
- [x] Only the schema is sent to the AI, never row data (E2E asserts that a cell value is absent from the request)
- [x] Metering: one usage row per message; 15-per-5-minute burst limit; 60/300 daily caps with boundaries; per-user isolation (unit, integration)
- [x] Org admin AI kill switch: members can't flip it; it blocks members and admins immediately; turning it back on restores access (integration)
- [x] Groq errors relayed; network failures → 500; the server key is used and the user's token is never forwarded (unit)
- [x] Chat rendering escapes model output (XSS), keeps SQL intact for Use Query, formats lists and code (unit)

### Enterprise administration
- [x] Every admin op is admin-only (403 for members and outsiders); input validation; DB and Stripe errors (unit)
- [x] Join links: unguessable tokens, revoked or unknown → 404, domain must match exactly (no look-alike subdomains), idempotent (unit)
- [x] Status reads: per-op access for admin, manager and member; usage counts over 24h and 7d (unit)

### Charts, grid and UI helpers
- [x] Number parsing, column typing, spec heuristics and repair, AI-spec mapping, data capping, scales, formatting (unit)
- [x] Every chart type renders well-formed SVG; labels from the data are escaped (unit)
- [x] Mobile home page has no sideways scroll (E2E); Learn's phone layout (E2E, pre-existing)

### Performance (budget: no user action over 2s)
- [x] App usable after navigation (median of 3): about 0.2s locally
- [x] Upload and make queryable: 10k rows about 0.5s, 50k rows about 1.1s
- [x] GROUP BY, SELECT * (rendered) and filter+sort on 100k rows: about 0.1–0.3s each
- [x] Scrolling the virtualized grid to the bottom of 100k rows: under 200ms
- [x] JS heap after a 100k-row file: under 400 MB (about 120 MB)
- [x] Chart render: under 2s (about 5ms)
- [x] API p95 under 100ms and max under 500ms over 100 calls (track, checkout, webhook, chat); 200 concurrent `/api/track` calls all succeed
- [x] First-party JS under 1.2 MB (about 570 KB); parser handles 100k rows in Node in under 2s
- [!] **Flagged:** a 100k-row upload takes about 2.1s, just over the 2s rule. It shows a progress overlay, so the suite flags it and fails only past 5s.

## Bugs found by this suite (recorded as `test.todo`)

1. **CSV: escaped quotes are dropped.** `"He said ""hi"""` loads as `He said hi`. (`tests/unit/frontend/csv-parser.test.js`)
2. **CSV: a newline inside a quoted field splits the record.** Multi-line cells (addresses, notes) break into two rows. (same file)
3. **Relationship detection misses `-ses` plurals.** `singularize('courses')` returns `'cours'`, so `students.course_id → courses.id` is never suggested. The same goes for houses, purchases, cases, responses. (`tests/unit/frontend/helpers-grid-app.test.js`)
4. **A personal Premium buyer loses Premium when their org ends.** Joining an org overwrites `premium_via` with `'org'`, and teardown revokes everyone whose `org_id` matches. (`tests/integration/payments-flow.test.mjs`)
5. **Mobile header overflows in the workspace.** At 390px wide, the header row is 91px too wide and the **Sign in** button is pushed off-screen. (`tests/e2e/critical-paths.e2e.test.mjs`)

## Not tested automatically

These need a person or a real external account. Each one is called out so it doesn't look covered.

| Area | Why it isn't automated | What would close the gap |
|---|---|---|
| **The real Stripe charge** (card entry, 3D Secure, wallets, the embedded form) | The embedded checkout is switched off in production (`checkout.js`: `ALL_TIERS_UNLOCKED = true`), so there's no UI to drive. The server also hardcodes a **live-mode** price id, which doesn't exist in Stripe test mode. | Move the price id to an env var (`STRIPE_PREMIUM_PRICE_ID`), then add a Playwright test on the preview deploy using Stripe test cards and the Stripe CLI (`stripe listen`) for webhooks. Until then: one manual test-mode purchase per release. |
| **Real Stripe webhook delivery and API version drift** | The tests sign events with the real library, but they don't talk to Stripe. | Run `stripe trigger checkout.session.completed` against a preview once per release. |
| **Real email delivery** (signup codes, reset links, renewal and weekly emails through Gmail SMTP) | Needs a real inbox. | A test inbox service (for example Mailosaur), or a manual check per release. |
| **The emailed password-reset link** | The E2E suite simulates what supabase-js does when the link is clicked (the PASSWORD_RECOVERY event); the real redirect URL configuration in Supabase isn't exercised. | Part of the inbox check above. |
| **Real Groq responses** | LLM output isn't deterministic. The tests check the request shape, metering and rendering with canned replies. The preview smoke test sends one real question when the test account is configured. | Keep it as a smoke test; don't assert on content. |
| **Real RLS policies** | Needs a disposable Supabase project. The suite exists (`tests/real-services/supabase-rls.test.mjs`) but skips until the three secrets are set. | Set the `SUPABASE_TEST_*` secrets. |
| **Excel export** (Pyodide + XlsxWriter, about 10 MB from a CDN) | Too heavy and too network-dependent for every run. | A weekly scheduled Playwright job that exports and opens the `.xlsx` with a parser. |
| **The Enterprise page UI** (`enterprise.html`) and the in-app Enterprise admin panels | The Enterprise API is covered end to end; the page itself isn't driven by Playwright yet. | Add an E2E file using the same harness; the backend already supports it. |
| **The synth-bi cross-subdomain session cookie** | Needs two real `*.synth-sql.com` hosts. | Manual check after cookie changes. |
| **Visual and design regressions, accessibility** | Not asserted beyond "no sideways scroll". | Playwright screenshot comparisons and `@axe-core/playwright`. |
| **Production-scale load** (many concurrent users against real Supabase and Vercel) | The perf suite measures Synth's own code locally; it doesn't load-test hosted services. | A k6 or Artillery run against a preview, outside CI. |
| **Browsers other than Chromium** | The suites only run Chromium. | Add `firefox` and `webkit` to the Playwright launch loop (about 2x CI time). |
| **DOM-heavy front-end files under the coverage gate** (`app.js`, `grid.js`, `charts.js` UI, `chat.js` UI, `auth.js`, `learn.js`) | These are mostly event wiring. Their pure helpers are unit-tested, and their behaviour is covered by the E2E flows instead. | Optional: collect Chromium coverage from Playwright and merge it into the c8 report. |
