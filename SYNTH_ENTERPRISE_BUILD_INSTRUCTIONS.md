# Synth Enterprise — Build Instructions

Step-by-step implementation guide derived from [SYNTH_ENTERPRISE_SPEC.md](SYNTH_ENTERPRISE_SPEC.md).
That doc is the source of truth for *why* and *what*; this doc is *how*, in
build order, with exact files and verification steps per child. Follow it in
order — later children depend on earlier ones being done and deployed.

Status key: ✅ built and merged · ⬜ not started.

**Function count note (2026-09-16, post-deploy):** the individual route
files named throughout this doc (one file per action, `join.js`,
`toggle-ai.js`, `create-workroom.js`, etc.) were consolidated into three
dispatch-based files — `api/enterprise/admin.js`, `status.js`,
`member-actions.js` — after the first deploy failed Vercel Hobby's
12-serverless-function-per-deployment cap at 18 functions. See
[SYNTH_ENTERPRISE_SPEC.md](SYNTH_ENTERPRISE_SPEC.md)'s route-consolidation
table at the top for the exact old-name → new-file/op mapping. The steps
below still describe each action by its original filename; if you're
implementing something new, follow the same one-file-per-dispatch pattern
(add an `op` case to the right existing file) rather than creating a 15th
route file.

## Before you start

- Read [SYNTH_ENTERPRISE_SPEC.md](SYNTH_ENTERPRISE_SPEC.md) sections 3 and 8 first — every "decision" listed there is locked. Don't re-derive them; if one seems wrong mid-build, stop and flag it instead of quietly picking a different answer.
- Every new API route reuses `getVerifiedUserId(req)` from [api/_supabaseAuth.js](api/_supabaseAuth.js) — never trust a user id from the request body.
- Every new table gets RLS enabled. If a table is written only by API routes via the service-role key, it gets zero client-facing policies (same pattern as `ai_usage_events` and the Child 1 tables) — don't invent a client-writable policy "to be safe," it defeats the point.
- Naming convention already established: migrations are timestamp-prefixed (`YYYYMMDDHHMMSS_description.sql`), enterprise API routes live under `api/enterprise/`.

---

## ✅ Child 1 — Org foundation (built 2026-09-16)

Schema, Enterprise checkout, webhook fulfillment. Nothing to do here — listed for completeness so the dependency graph reads correctly.

**Built:**
- [supabase/migrations/20260917000000_organizations.sql](supabase/migrations/20260917000000_organizations.sql) — `pending_organizations`, `organizations`, `org_members`, `org_join_links`, `profiles.premium_via`/`org_id` + the column-lock trigger.
- [api/_publicDomainBlocklist.js](api/_publicDomainBlocklist.js)
- [api/enterprise/create-checkout-session.js](api/enterprise/create-checkout-session.js)
- [api/stripe-webhook.js](api/stripe-webhook.js) — enterprise branch of `checkout.session.completed`

## ✅ Subscription lifecycle (built 2026-09-16, ahead of the original sequencing)

Renewal notices, auto-renew toggle, teardown-on-lapse. See [SYNTH_ENTERPRISE_SPEC.md §17](SYNTH_ENTERPRISE_SPEC.md). Built out of order relative to Children 2-5 because it was decided during the Stripe integration pass, not because the dependency graph changed — Children 2-5 below still assume only Child 1 + this lifecycle work exist so far.

**Built:**
- [supabase/migrations/20260918000000_org_subscription_lifecycle.sql](supabase/migrations/20260918000000_org_subscription_lifecycle.sql)
- [api/_mailer.js](api/_mailer.js), [api/cron/enterprise-renewal-notices.js](api/cron/enterprise-renewal-notices.js)
- [api/enterprise/org-status.js](api/enterprise/org-status.js), [api/enterprise/toggle-auto-renew.js](api/enterprise/toggle-auto-renew.js)
- `api/stripe-webhook.js` — `customer.subscription.updated`/`.deleted` branches
- `synth.html` — dynamic Enterprise row in Account Settings

---

## ✅ Child 2 — Join links (built 2026-09-16)

**Depends on:** Child 1. **Effort:** ~5h.

**Built**, including two things not called out in the original steps below,
found while implementing:

- **`org_members.user_id` is now unique** (`supabase/migrations/20260919000000_org_members_single_org.sql`). The original schema's `primary key (org_id, user_id)` allowed one user to join multiple orgs, which `api/enterprise/org-status.js`'s `.maybeSingle()` and `profiles.org_id` (a single column) both silently assumed couldn't happen. `api/enterprise/join.js` refuses a second org at the application layer; this constraint is what actually guarantees it against a race between two simultaneous join requests.
- **`api/enterprise/create-checkout-session.js` now checks for an existing `org_members` row before starting checkout** — without it, someone already in an org could pay for a new one, and the webhook's `org_members` insert would fail against the new constraint *after* the charge succeeded.

**Files:**
- [api/enterprise/create-join-link.js](api/enterprise/create-join-link.js)
- [api/enterprise/join.js](api/enterprise/join.js)
- `synth.html` — `?join=<token>` URL handling (`checkEnterpriseJoinReturn`, `resumePendingJoinLink`, `redeemJoinToken`), an error-capable result banner (`#enterprise-join-banner`, distinct from the payment-only success banner), and a "Get join link" control in the admin's Enterprise settings section (`createEnterpriseJoinLink`).

Below is the original build plan, kept for reference.

This is what actually makes an org usable — until this exists, an admin can pay but nobody can join.

### Step 2.1 — `api/enterprise/create-join-link.js`

New file. POST, admin-only.

1. `getVerifiedUserId(req)` → 401 if missing.
2. Query `org_members` for `{user_id, role}` → if no row or `role !== 'admin'`, 403.
3. Generate a token: `crypto.randomBytes(24).toString('base64url')` (Node's built-in `crypto`, no new dependency).
4. Insert into `org_join_links`: `{ org_id, token, created_by: userId }`.
5. Return `{ token, url: `${proto}://${host}/join/${token}` }` — the `url` is a convenience for the client to display/copy, the route below is what actually resolves it.

**Verify:** call it twice as the same admin — confirm two distinct tokens exist in `org_join_links` (v1 doesn't cap active links per org; that's a deliberate non-decision, not tested for).

### Step 2.2 — `api/enterprise/join.js`

New file. POST `{ token }`, any verified user.

1. `getVerifiedUserId(req)` → 401 if missing.
2. Look up `org_join_links` by `token` where `revoked_at is null` → 404 if not found ("This join link is invalid or has been revoked.").
3. Fetch the org via `org_id`.
4. Fetch the caller's real email via `supabaseAdmin.auth.admin.getUserById(userId)` — **never** trust an email in the request body.
5. Extract the domain from that email (reuse `extractDomain` from [api/_publicDomainBlocklist.js](api/_publicDomainBlocklist.js)) and compare against `org.domain`. Mismatch → 403 ("Your email domain doesn't match this organization.").
6. Check the caller isn't already a member (`org_members` lookup) → if already a member, return success idempotently rather than erroring (a re-click of the same link shouldn't be an error state).
7. Insert `org_members` `{ org_id, user_id, role: 'member' }`.
8. Upsert `profiles`: `{ id: userId, is_premium: true, premium_via: 'org', org_id: org.id, updated_at: now }`.
9. Return `{ joined: true, org: { name, domain } }`.

**This is the single most security-sensitive route in the epic** — it's the only place a user grants themselves Premium without paying. Steps 4-5 (server-verified email, not client-supplied) are load-bearing; do not simplify them.

**Verify (acceptance criteria #4, #5 from the spec):**
- A user with a matching-domain email joining via a valid token ends up with `profiles.is_premium = true`, `premium_via = 'org'`, and an `org_members` row.
- A user with a non-matching-domain email gets a 403 and **no** `org_members` row and **no** premium change — check the database directly, not just the HTTP response.

### Step 2.3 — Client-side: join flow entry point

`synth.html` has no route handling today beyond the static rewrites in `vercel.json`. Add a query-param-based entry point rather than a new page (no build step, no router):

1. On page load, check `new URLSearchParams(location.search).get('join')` — if present, treat it as the join token.
2. If not signed in, show the sign-in modal first, then resume the join flow after auth (mirrors the existing `signInThenGoPremium` deferred-callback pattern already used for the Premium checkout gate).
3. If signed in, POST to `/api/enterprise/join` with the token, show a success/error banner (reuse the `premium-success-banner` pattern), and clear the `join` query param from the URL (`history.replaceState`) so a refresh doesn't re-trigger it.
4. Update `create-join-link.js`'s returned `url` to match this scheme: `${proto}://${host}/?join=${token}`.

**Verify:** paste a generated join link into a second browser profile/incognito window signed in as a different (matching-domain) test user, confirm Premium unlocks without a payment screen.

---

## ✅ Child 3 — Admin console (built 2026-09-16)

**Depends on:** Child 1, Child 2 (needs real members to have anything to show). **Effort:** ~6h.

**Built** exactly per the plan below, one addition: the AI-disabled gate in
`api/_aiRateLimit.js` checks `organizations.ai_enabled` **before either rate
limit** and overrides `is_premium` entirely — an org member with
organization-granted Premium still gets blocked if the admin turns AI off,
matching acceptance criterion #6 in the spec ("regardless of their own
premium status") precisely.

**Files:**
- [api/enterprise/toggle-ai.js](api/enterprise/toggle-ai.js), [api/enterprise/usage.js](api/enterprise/usage.js)
- `api/_aiRateLimit.js` — org gate added
- `synth.html` — AI on/off toggle and a "View member AI usage" table (`#enterprise-usage-modal`) in the admin's Enterprise settings section

Below is the original build plan, kept for reference.

### Step 3.1 — `api/enterprise/toggle-ai.js`

New file. POST `{ enabled }`, admin-only (same admin check pattern as Step 2.1).

1. Verify admin.
2. Update `organizations.ai_enabled = enabled`.
3. Return the new value.

### Step 3.2 — Modify `api/_aiRateLimit.js`

Before the existing free/premium daily-limit check in `checkAndRecordAiUsage(userId)`:

1. Fetch `profiles.org_id` for `userId`.
2. If `org_id` is set, fetch `organizations.ai_enabled` for that org.
3. If `ai_enabled === false`, return `{ allowed: false, message: "AI has been disabled by your organization admin." }` immediately — **before** the existing burst/daily checks, and regardless of `is_premium`.

**Verify (acceptance criteria #6):** as an org member with an otherwise-fresh daily AI quota, have the admin toggle `ai_enabled` off, then confirm the member's next `api/chat.js` call is rejected with the org-disabled message.

### Step 3.3 — `api/enterprise/usage.js`

New file. GET, admin-only.

1. Verify admin, get `org_id`.
2. Fetch all `org_members` for that org.
3. For each member (or via a single grouped query — Supabase's `.select('user_id, count()')`-style aggregation if available, otherwise fetch `ai_usage_events` rows for all member ids in one `.in('user_id', memberIds)` query and aggregate in code), compute counts for last 24h and last 7d.
4. Resolve each member's email via `supabaseAdmin.auth.admin.getUserById` (batched if the SDK supports it, otherwise looped — at org-scale in v1 this is fine unbatched).
5. Return `[{ user_id, email, role, count_24h, count_7d }]`.

**Verify (acceptance criteria #7):** generate some AI usage as two different org members, confirm the admin's usage table shows correct distinct counts per member.

### Step 3.4 — Client-side: admin console UI

Add a new modal or a new tab inside the existing Enterprise section of Account Settings (extend `renderSettingsEnterpriseRow()` rather than building a whole new panel — the admin already lands there for the auto-renew toggle):

1. When `role === 'admin'`, add: an AI on/off toggle button wired to `toggle-ai.js`, and a "View usage" button that opens a small table (member email, 24h count, 7d count) fed by `usage.js`.
2. No new modal infrastructure needed if this fits inside the existing `#settings-modal` — only add a separate modal if the usage table needs more room than a settings-panel section reasonably allows.

**Verify:** full click-through as an admin — toggle AI off/on, open usage table, confirm numbers match what steps 3.2/3.3 verification produced.

---

## ✅ Child 4 — Dataset library MVP (built 2026-09-16)

**Depends on:** Child 1 only — can be built in parallel with Children 2/3 if there's ever a second contributor. **Effort:** ~6h (per [SYNTH_ENTERPRISE_SPEC.md §12](SYNTH_ENTERPRISE_SPEC.md): ~4h wiring + ~2h content cleanup).

**Built**, resolving the one open design question from the original plan
(Step 4.4 below) and adding two routes the original plan didn't name:

- **Resolved: `load-template.js` issues signed URLs, doesn't copy bytes server-side.** Every other Storage write in this app happens client-side via the Supabase JS SDK (anon key + RLS) — confirmed by reading `synth.html`'s existing save-workspace flow before deciding, per the instruction in the original Step 4.4. The route's only job is proving org entitlement against the private `dataset-library` bucket; the client does the actual download + save using its existing manual-upload code path, so **zero new client-side SQLite-loading logic** was needed (matches [SYNTH_ENTERPRISE_SPEC.md §8](SYNTH_ENTERPRISE_SPEC.md) decision 3 exactly).
- **Added: `api/enterprise/list-templates.js` and `api/enterprise/enable-template.js`.** The original schema had `org_enabled_templates` but no route to ever write to it — an admin had no way to turn a template on. These fill that gap; not called out in the original spec's route table.
- **`org-status.js` extended** to also return the caller's org's enabled templates, so the Cloud panel knows whether to show a "Dataset Library" section at all (hidden entirely for the ~everyone who isn't in an org with a template enabled).

**Files:**
- [supabase/migrations/20260920000000_dataset_library.sql](supabase/migrations/20260920000000_dataset_library.sql)
- [api/enterprise/list-templates.js](api/enterprise/list-templates.js), [api/enterprise/enable-template.js](api/enterprise/enable-template.js), [api/enterprise/load-template.js](api/enterprise/load-template.js)
- [scripts/seed-dataset-library.js](scripts/seed-dataset-library.js) — one-off seeding script (see below)
- `supabase/seed/dataset-library/university/*.csv` — cleaned copies (BOM stripped) of the four root-level CSVs
- `synth.html` — admin's "Dataset library" enable/disable list (in the Enterprise settings section), member-facing "Dataset Library" section in the Cloud panel, `loadEnterpriseTemplate()`

**Still needed — these are deploy-time actions, not code:**
1. Create the `dataset-library` bucket in the Supabase Dashboard (Storage → New bucket → name it exactly `dataset-library` → **Public: OFF**). No storage policies needed — it's only ever read via the service role inside `load-template.js`.
2. Run the new migration.
3. Run the seed script once: `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-dataset-library.js` — uploads the 4 CSVs and inserts the template/table/relationship rows. Re-runnable safely (it clears and recreates its own rows first).
4. The original root-level `Nstudents.csv`/`Ncourses.csv`/`Nstaff.csv`/`buildings.csv` are now superseded by the cleaned copies under `supabase/seed/` — safe to delete from the repo root once the seed script has been confirmed working, not deleted automatically here since they're your files.

Below is the original build plan, kept for reference.

### Step 4.1 — Migration: dataset library schema

New file `supabase/migrations/<timestamp>_dataset_library.sql`. Copy the four tables from [SYNTH_ENTERPRISE_SPEC.md §5](SYNTH_ENTERPRISE_SPEC.md) verbatim: `dataset_library_templates`, `dataset_library_tables`, `dataset_library_relationships`, `org_enabled_templates`. All get RLS enabled with zero client-facing policies (service-role-only, same as Child 1's tables).

### Step 4.2 — Storage bucket

In the Supabase Dashboard: Storage → New bucket → name `dataset-library` → **Public: OFF**. No client-facing storage policies at all — this bucket is only ever read by the service role inside `load-template.js` (Step 4.4), never directly by a browser. This is different from the existing `csvs` bucket, which does have client-facing owner policies.

### Step 4.3 — Prepare and upload the university vertical content

Per [SYNTH_ENTERPRISE_SPEC.md §7](SYNTH_ENTERPRISE_SPEC.md), confirmed source files: [Nstudents.csv](Nstudents.csv) → `students`, [Ncourses.csv](Ncourses.csv) → `courses`, [Nstaff.csv](Nstaff.csv) → `staff`, [buildings.csv](buildings.csv) → `buildings`.

1. Clean up each CSV (consistent column naming, no stray BOM/encoding issues — these files currently have a leading `﻿` BOM per the raw header row seen during spec review; strip it).
2. Upload the four cleaned CSVs to the `dataset-library` bucket, e.g. path `university/students.csv`, `university/courses.csv`, etc.
3. Insert one `dataset_library_templates` row: `{ vertical: 'university', name: 'State University', description: '...' }`.
4. Insert four `dataset_library_tables` rows pointing at the uploaded paths, with `row_count`/`columns` populated (can be computed by a one-off local script reading the CSVs — reuse whatever CSV-parsing the client already does, or a quick Node script with a CSV library).
5. Insert `dataset_library_relationships` rows matching the join table in §7: `courses.Staff ID → staff.Staff ID`, `students.College → staff.College`, `students.College → buildings.College`.

### Step 4.4 — `api/enterprise/load-template.js`

New file. POST `{ template_id }`, verified org member.

1. Verify the caller's org has `template_id` in `org_enabled_templates` → 403 if not enabled for their org.
2. Fetch the template's `dataset_library_tables` and `dataset_library_relationships`.
3. Create a new `workspaces` row for the caller (name = template name).
4. For each table: download the CSV from the `dataset-library` bucket (service role), re-upload a copy into the caller's own `csvs/${user.id}/` path (or, simpler — skip re-uploading entirely and load rows directly via whatever CSV-parsing path the client's manual upload already uses, avoiding a second storage copy if the architecture makes that easy — check how `api/create-checkout-session.js`-adjacent upload code currently handles a manual CSV upload before deciding), then insert a `datasets` row referencing it.
5. Insert `workspace_relationships` rows matching the template's `dataset_library_relationships`, translated to the new dataset ids.
6. Return the new `workspace_id` so the client can immediately switch to it.

**This route needs a design decision the spec didn't fully pin down:** whether loading a template *copies* the CSV bytes into the member's own storage folder, or the member's `datasets` row points at the shared bucket path directly (cheaper, but means `dataset-library` objects must stay stable forever, and RLS on `csvs` wouldn't apply to it — the client's existing CSV-loading code path may assume everything lives under `csvs/${user.id}/`). Read how the client currently loads a `datasets` row's `storage_path` into the in-browser SQLite instance before choosing — don't guess this one, it's a real behavior difference the current codebase's assumptions will make obvious once you look.

**Verify (acceptance criteria #10):** as an org member whose org has the university template enabled, load it, confirm a new workspace appears with 4 tables and pre-confirmed relationships, and that a cross-table AI query (e.g. "which building has the most students by college") returns a sensible joined result.

### Step 4.5 — Client-side: template picker

Add a "Browse dataset library" entry point, gated to org members whose org has at least one enabled template (check via a small addition to `org-status.js`'s response, or a new lightweight endpoint). Simplest: a button in the workspace-creation flow that, when the signed-in user is an org member, lists enabled templates and calls `load-template.js` on selection.

---

## ✅ Child 5 — Workrooms (built 2026-09-16)

**Depends on:** Child 1, Child 2, Child 3. **Effort:** ~10h.

**Built**, split into three files instead of the one `workrooms.js` originally
sketched (matches the rest of `api/enterprise/`'s one-file-per-action
convention), plus one route the original plan didn't name:

- [api/enterprise/create-workroom.js](api/enterprise/create-workroom.js) — admin-only, also verifies the proposed manager is already an org member (an admin can't hand manager rights to an outsider).
- [api/enterprise/workrooms-list.js](api/enterprise/workrooms-list.js) — role-scoped: an admin sees every workroom in their org with its full roster; a manager sees only their own workroom(s).
- [api/enterprise/workroom-roster.js](api/enterprise/workroom-roster.js) — add/remove, manager-of-that-workroom-only via a single shared `getManagedWorkroomOrgId` check (not inlined twice), per the authorization note in Step 5.2 below. Deliberately does **not** let an org admin bypass this — the spec's admin/manager line cuts both ways.
- **Added: [api/enterprise/org-roster.js](api/enterprise/org-roster.js).** Both the admin's "create workroom" manager-picker and a manager's "add to roster" picker need to list org members, but `usage.js` (the existing member-listing route) is admin-only and usage-focused. Rather than loosen that route's authorization, added this low-sensitivity (id + email only) endpoint any org member can call.
- `synth.html` — `renderWorkroomsSection()` is shared between the admin's Enterprise-settings view (sees all workrooms, can create) and a manager's own settings view (sees just their workroom, can edit its roster) — same rendering and API calls either way, since `workrooms-list.js` already scopes the response by role.

Confirmed per the original plan: **no `stripe-webhook.js` change was needed** — the `customer.subscription.deleted` handler's cascade delete on `organizations` now reaches `workrooms`/`workroom_members` automatically, exactly as the comment already in that file anticipated.

Below is the original build plan, kept for reference.

### Step 5.1 — Migration: workrooms schema

New file `supabase/migrations/<timestamp>_workrooms.sql`. Copy `workrooms` and `workroom_members` from [SYNTH_ENTERPRISE_SPEC.md §5](SYNTH_ENTERPRISE_SPEC.md) verbatim. RLS enabled, zero client-facing policies.

Once this migration lands, [api/stripe-webhook.js](api/stripe-webhook.js)'s `customer.subscription.deleted` handler automatically starts cascading org deletion to these tables too — per the comment already in that file, **no code change needed there**.

### Step 5.2 — `api/enterprise/workrooms.js`

New file, multiple actions by `req.body.action` (or split into separate files if you prefer one-route-one-purpose — the spec doesn't mandate either, pick whichever matches how other multi-action routes in this codebase are structured, if any; otherwise default to separate files for consistency with the rest of `api/enterprise/`):

- **Create** (admin-only): `{ name, manager_user_id }` → verify `manager_user_id` is an existing `org_members` row in the admin's org → insert `workrooms`.
- **Add/remove roster member** (manager-of-that-workroom-only, verified via `workrooms.manager_id === callerUserId`): insert/delete `workroom_members`, but only for users who are already `org_members` of the same org — a manager cannot add someone from outside the org.

**Authorization is the sensitive part here** — a manager must be blocked from touching any workroom other than the one(s) where `manager_id` is them, and blocked from every org-level action (AI toggle, other workrooms, billing). Write the authorization check as its own small helper (`isWorkroomManager(userId, workroomId)`) and reuse it, rather than inlining the check differently in each action.

**Verify (acceptance criteria #8, #9):** admin creates a workroom, assigns a manager; that manager can add/remove org members from their own workroom; that same manager gets a 403 attempting to toggle the org's AI setting or modify a different workroom.

### Step 5.3 — Client-side: workroom management UI

Extend the admin console area from Child 3: a "Workrooms" section listing existing workrooms (admin view: all; manager view: just theirs), a "Create workroom" flow (admin only, org-member picker for the manager), and a roster editor (manager view).

---

## Cross-cutting: tests (per [SYNTH_ENTERPRISE_SPEC.md §10](SYNTH_ENTERPRISE_SPEC.md))

Write these alongside each child, not as a separate pass at the end — the spec's testing plan maps directly onto the steps above:

| Layer | What | Maps to |
|---|---|---|
| Unit | domain blocklist matcher, join-token domain-match logic, `ai_enabled` gate | Step 2.2, Step 3.2 |
| Integration | checkout → webhook → org created; join → membership + premium; join rejected on mismatch; AI toggle blocks chat; template load creates correct rows | Child 1 (done), Step 2.2, Step 3.2, Step 4.4 |
| E2E | full admin-signup → join → template-load → cross-table-query flow | All of the above, run last |

## All five children are built (as of 2026-09-16) — what's left is deployment, not code

Every acceptance criterion in [SYNTH_ENTERPRISE_SPEC.md §9](SYNTH_ENTERPRISE_SPEC.md) is now implemented in code. Nothing here has been run against a live Supabase/Stripe environment — that's the actual remaining work:

1. **Run every migration** from `20260917000000_organizations.sql` through `20260921000000_workrooms.sql`, in order (`supabase db push`, or paste each into the SQL Editor).
2. **Create the `dataset-library` storage bucket** (Public: OFF) and run `scripts/seed-dataset-library.js` once (see Child 4).
3. **Set the new env vars**: `STRIPE_ENTERPRISE_PRICE_ID`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `CRON_SECRET` (see [STRIPE_INTEGRATION_TODO.md](STRIPE_INTEGRATION_TODO.md) for the full checklist).
4. **Subscribe the Stripe webhook** to `customer.subscription.updated` and `customer.subscription.deleted` in addition to the three already recommended events.
5. **`npm install`** — `nodemailer` was added to `package.json` mid-epic.
6. **Run the testing plan** in the table above end-to-end against that live environment — nothing in this epic has been tested against real Supabase RLS, real Stripe test-mode charges, or a real second user account yet. Every verification so far has been: syntax checks, and a static-file browser preview confirming the client-side JS parses and the right DOM elements/functions exist — neither can exercise real auth, real database writes, or real Stripe checkout.
7. **Fold every migration since `20260917000000_organizations.sql` into `supabase/schema.sql`** (per [§15](SYNTH_ENTERPRISE_SPEC.md), the repo convention documents authoritative state there) so a fresh read of `schema.sql` reflects reality without replaying migrations mentally.
8. Delete the now-superseded root-level `Nstudents.csv`/`Ncourses.csv`/`Nstaff.csv`/`buildings.csv` once step 2 is confirmed working (the cleaned copies live under `supabase/seed/dataset-library/university/` now).
