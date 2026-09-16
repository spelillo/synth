# Synth Enterprise — Spec & Build Plan

Status: drafted, not yet built. No code has been written against this spec.
Verified against the codebase on 2026-09-16.

## 1. Why

Synth today is single-player: one `auth.users` row -> one `profiles.is_premium`
boolean -> personal workspaces. There is no concept of an organization
anywhere in the schema. This adds a second, org-scoped product surface on
top of the existing personal one, targeted first at universities/schools: a
school admin pays a flat one-time fee, and every verified member of their
email domain gets Premium for free via a join link.

- **Who buys first:** universities/schools (not companies, not yet).
- **Why now:** no existing customer is asking for this — this is a forward
  bet to open a new segment, not a fire to put out.
- **Success signal:** none fixed yet — the founder wants to build this out
  before defining a hard done-criterion. Treat the acceptance criteria in
  this doc as the working definition of "done" for v1 instead.

## 2. Current State (verified 2026-09-16)

| Area | What exists today | File |
|---|---|---|
| Premium flag | `profiles.is_premium` boolean, settable only server-side via the service-role key. RLS blocks a user granting it to themselves. | `supabase/schema.sql:190-217` |
| Purchase flow | One Stripe Checkout Session, `mode: 'payment'`, price `price_1UEAIYRqXDpXXBnZ1F8tb0r7` ($9.99 one-time). `client_reference_id` = Supabase user id, read by the webhook to know whose `profiles` row to flip. | `api/create-checkout-session.js`, `api/stripe-webhook.js` |
| AI usage tracking | Already logged per-user, per-call: `ai_usage_events(user_id, created_at)`. Read only by the service role to enforce rolling burst/daily limits (15/5min burst, 60/day free, 300/day premium). | `supabase/migrations/20260914120000_ai_usage_events.sql`, `api/_aiRateLimit.js` |
| Auth verification | `getVerifiedUserId(req)` verifies a bearer token against Supabase Auth and returns the real user id — the pattern every new server route below must reuse. | `api/_supabaseAuth.js` |
| Storage | CSVs in bucket `csvs`, path `${user.id}/${filename}`. RLS policy keys strictly off `auth.uid()` matching the folder name — no shared/org file concept exists. | `supabase/schema.sql:130-145` |
| Multi-table workspaces | Already built and already gated behind `is_premium` per the pricing page: multi-table workspaces (up to 10 tables), relationship detection, cross-table AI joins. | `supabase/schema.sql` (`workspaces`, `datasets`, `workspace_relationships`), pricing page |
| Org / team / role concept | **Does not exist anywhere in the schema.** | — |

## 3. Scope decisions locked in conversation

These were explicitly decided — do not re-litigate without flagging the change:

1. **Buyer:** universities/schools first. Company/general-business orgs are not designed for in v1 (may work incidentally, not a design goal).
2. **Monetization — SUPERSEDED 2026-09-16:** originally a flat one-time fee. Changed to a **yearly subscription** (`mode: 'subscription'`, no per-seat metering) per an explicit decision during the Stripe integration work. This reopened the lifecycle question decision #10 below assumed away — resolved the same day, see the updated #10 and section 17.
3. **Join mechanism:** admin signs up via an Enterprise entry point; their email's domain becomes the org's domain. Admin generates a join link. Anyone visiting that link **whose own verified email also matches the org's domain** becomes a member and gets Premium for free. A leaked link outside the domain grants nothing.
4. **Public domain abuse:** email providers (gmail.com, yahoo.com, outlook.com, etc.) are blocklisted from being claimed as an org domain, checked at org-creation time.
5. **Assignments / grading:** cut entirely. Not in scope, not planned as a fast-follow inside this epic.
6. **Workrooms:** in v1 (not deferred). A workroom is created by the org admin, who assigns an existing org member as its `manager` (e.g. a professor). The manager can add/remove org members from their workroom's roster. Managers cannot touch org-level settings (AI toggle, other workrooms).
7. **Custom branding:** cut entirely from v1.
8. **Dataset library:** one vertical for v1 (university), not multiple. A "database" in the library is **3-4 related tables bundled together with pre-confirmed join relationships**, not a single flat CSV — the pitch is realistic multi-table join practice.
9. **Admins:** exactly one admin per org for v1 (whoever completed the Enterprise checkout). No multi-admin, no admin-transfer/recovery flow.
10. **Org-granted premium is permanent while the subscription is active — SUPERSEDED 2026-09-16:** revoking premium when an individual member is removed/leaves is still out of scope (unchanged). But since #2 became a subscription, what happens when the *whole org's* subscription lapses is now defined and built — see section 17.

## 4. Proposed architecture

```
pending_organizations (checkout in flight)
        |  webhook fulfills on payment
        v
organizations ──< org_members >── auth.users
        |                              |
        ├──< org_join_links            └── role: admin | member
        ├──< workrooms ──< workroom_members
        └──< org_enabled_templates >── dataset_library_templates ──< dataset_library_tables
                                                                  └──< dataset_library_relationships
```

Nothing about the existing personal (non-org) signup, checkout, or chat flow changes. This is purely additive.

## 5. Schema

New migration, e.g. `supabase/migrations/20260917000000_organizations.sql`:

```sql
create table public.pending_organizations (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  stripe_checkout_session_id text,
  status text not null default 'pending' check (status in ('pending','fulfilled')),
  created_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null unique,          -- normalized lowercase, e.g. 'cornell.edu'
  ai_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member')),
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table public.org_join_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  token text not null unique,           -- random, url-safe
  created_by uuid not null references auth.users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.workrooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  manager_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.workroom_members (
  workroom_id uuid not null references public.workrooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (workroom_id, user_id)
);

alter table public.profiles
  add column premium_via text not null default 'purchase' check (premium_via in ('purchase','org')),
  add column org_id uuid references public.organizations(id) on delete set null;

-- Dataset library (Child 4)
create table public.dataset_library_templates (
  id uuid primary key default gen_random_uuid(),
  vertical text not null,              -- 'university', 'hospital', 'sports', 'bank', 'real_estate'
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table public.dataset_library_tables (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.dataset_library_templates(id) on delete cascade,
  table_name text not null,
  storage_path text not null,          -- shared bucket, not user-scoped
  row_count integer,
  columns jsonb
);

create table public.dataset_library_relationships (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.dataset_library_templates(id) on delete cascade,
  from_table text not null,
  from_column text not null,
  to_table text not null,
  to_column text not null
);

create table public.org_enabled_templates (
  org_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.dataset_library_templates(id) on delete cascade,
  enabled_at timestamptz not null default now(),
  primary key (org_id, template_id)
);
```

All new tables get RLS enabled. Tables written exclusively by API routes via
the service-role key (`pending_organizations`, `organizations`,
`org_members` writes, `dataset_library_*`) get zero client-facing policies —
same pattern as `ai_usage_events` today. The client never writes these
directly.

## 6. New API routes

| File | Purpose | Auth |
|---|---|---|
| `api/enterprise/create-checkout-session.js` | Checks caller's email domain isn't blocklisted, creates a `pending_organizations` row, creates a Stripe Checkout Session (new one-time enterprise price) with `client_reference_id = pending_org.id` | verified user |
| `api/stripe-webhook.js` (extend existing) | New branch on `checkout.session.completed` keyed by the enterprise price id: reads `pending_organizations`, creates `organizations` + `org_members` (role=admin), marks pending fulfilled | Stripe signature (existing pattern) |
| `api/enterprise/create-join-link.js` | Generates a token, inserts `org_join_links` | admin of that org |
| `api/enterprise/join.js` | Looks up token -> org, fetches caller's real email via `supabaseAdmin.auth.admin.getUserById`, checks it ends in `org.domain`, inserts `org_members` (role=member), sets `profiles.is_premium=true, premium_via='org', org_id=org.id` | verified user |
| `api/enterprise/toggle-ai.js` | Flips `organizations.ai_enabled` | admin of that org |
| `api/enterprise/usage.js` | Returns `ai_usage_events` counts grouped by `user_id` for all `org_members` of caller's org | admin of that org |
| `api/enterprise/create-workroom.js`, `workrooms-list.js`, `workroom-roster.js` | Create workroom + assign manager; list workrooms (admin sees all, manager sees own, with roster); manager adds/removes `workroom_members` — built 2026-09-16 as three files instead of one, matching the rest of `api/enterprise/`'s one-file-per-action convention | admin (create/list-all), manager (roster/list-own) |
| `api/enterprise/org-roster.js` | Lists the caller's org members (id + email only) — built 2026-09-16, needed by the manager pickers above, not in the original plan | any org member |
| `api/enterprise/list-templates.js` | Lists all dataset library templates (metadata only) — built 2026-09-16, not in the original route list | any signed-in user |
| `api/enterprise/enable-template.js` | Turns a template on/off for the caller's org — built 2026-09-16, not in the original route list; `org_enabled_templates` had no writer without this | admin of that org |
| `api/enterprise/load-template.js` | Checks `org_enabled_templates`, returns short-lived signed URLs for the template's table files plus metadata/relationships — built 2026-09-16. **Design decision made during implementation:** does NOT copy bytes server-side. Every other Storage write in this app happens client-side via the Supabase JS SDK (see `synth.html`'s save-workspace flow); this route only does the one thing the client can't (prove org entitlement against a private bucket), then the client downloads via the signed URL and saves into its own `workspaces`/`datasets`/`workspace_relationships` using the exact same upload/insert code as a manual CSV upload | verified org member, template must be enabled for their org |

**Modify `api/_aiRateLimit.js`:** before the existing free/premium limit
check, look up `profiles.org_id` -> `organizations.ai_enabled`. If false,
reject with "AI has been disabled by your organization admin" regardless of
the user's premium status.

**New file `api/_publicDomainBlocklist.js`:** hardcoded array of ~20-30
common public email providers (gmail.com, yahoo.com, outlook.com,
hotmail.com, icloud.com, aol.com, protonmail.com, ...), checked only at
org-creation time.

**New storage bucket `dataset-library`:** private, not user-scoped. Only
readable via `api/enterprise/load-template.js` using the service-role key —
never exposed to the client directly, so a template can't be scraped by
anyone without an org that has it enabled.

## 7. Dataset library v1 content (university vertical)

Reuses files already sitting in the repo root, cleaned up and moved into
the `dataset-library` bucket instead of the repo root:

| Source file | Becomes table | Joins via |
|---|---|---|
| `Nstudents.csv` | `students` | `College` -> `staff.College`, `buildings.College` |
| `Ncourses.csv` | `courses` | `Staff ID` -> `staff.Staff ID` |
| `Nstaff.csv` | `staff` | `Course ID` -> `courses.Course ID` |
| `buildings.csv` | `buildings` | `College` -> `students.College` |

Open question, resolve before building Child 4: `Nstudents.csv` /
`Ncourses.csv` / `Nstaff.csv` are currently untracked in git and sitting at
repo root next to product code, and there are also `students.numbers` /
`courses.numbers` / `staff.numbers` files. Confirm which is the
source-of-truth original before exporting the final CSVs into the library
bucket.

## 8. Decisions made during spec review (flag if wrong before building)

1. Workroom manager role is per-workroom, assigned by the org admin — not
   self-serve. A professor is a regular `org_member` until the admin sets
   them as `manager_id` on a specific workroom.
2. Workroom "shared datasets" for v1 = the org's enabled library templates
   only, not arbitrary sharing of one member's own uploaded CSV to another
   member. Real member-to-member sharing needs new storage RLS policies
   beyond the current `${user.id}/` scheme and is cut from v1.
3. "Loading a template" for a member behaves exactly like uploading CSVs
   manually — it creates normal `workspaces`/`datasets`/
   `workspace_relationships` rows for that member, just sourced from the
   shared bucket instead of their own upload. This means multi-table
   workspaces, relationship detection, and cross-table AI joins — already
   built and already gated behind `is_premium` — work on library data with
   zero new client-side query logic.

## 9. Acceptance criteria

1. A user whose email is not on the public-domain blocklist can complete
   Enterprise checkout, and an `organizations` row is created with their
   email's domain, with them as `admin`.
2. A user attempting Enterprise checkout with a blocklisted domain (e.g.
   `@gmail.com`) is rejected before Stripe checkout starts, with a clear
   error.
3. An org admin can generate a join link from the admin console.
4. A user visiting the join link who is signed in with an email matching
   the org's domain becomes an `org_member` (role=member) and
   `profiles.is_premium` becomes `true` with `premium_via='org'`.
5. A user visiting the join link with a non-matching email domain is
   rejected with a clear error and is NOT granted membership or premium.
6. Org admin can toggle `ai_enabled` off; any org member's next
   `api/chat.js` call is rejected with the org-disabled message, regardless
   of their own premium status.
7. Org admin can view a table of every org member's AI usage count (e.g.
   last 24h, last 7d).
8. Org admin can create a workroom and assign an existing org member as its
   manager.
9. A workroom manager can add/remove org members from their workroom's
   roster but cannot modify org-level settings (AI toggle, other
   workrooms).
10. An org member whose org has the university template enabled can load it
    and see 4 joinable tables (`students`, `courses`, `staff`, `buildings`)
    with relationships pre-confirmed, and can run a cross-table AI query
    against them successfully.
11. Tests written and passing for all of the above.
12. No degradation of existing personal (non-org) signup, checkout, or chat
    flows.

## 10. Testing plan

| Layer | What | Count |
|---|---|---|
| Unit | domain blocklist matcher, join-token domain-match logic, `ai_enabled` gate in `_aiRateLimit.js` | +6 |
| Integration | enterprise checkout -> webhook -> org created; join link -> membership + premium granted; join link rejected on domain mismatch; AI toggle blocks `chat.js` end-to-end; template load creates correct workspace/dataset/relationship rows | +8 |
| E2E | admin signs up -> creates org -> generates link -> second browser session joins via link -> sees Premium unlocked -> loads university template -> runs a cross-table AI query | +1 |

## 11. Rollback plan

All new tables are additive. The only change to an existing table is adding
two nullable/defaulted columns to `profiles` (`premium_via`, `org_id`).
Rollback = drop the new tables and the two `profiles` columns; zero impact
on personal-tier data. Feature-flag the Enterprise entry point behind an env
var so it can be hidden from the landing page without a deploy if something
breaks post-launch.

## 12. Effort estimate

| Component | Estimate |
|---|---|
| Schema + migrations | 3h |
| Enterprise checkout + webhook branch | 4h |
| Join link create/redeem + domain blocklist | 5h |
| Admin console UI (AI toggle + usage table) in `synth.html` | 6h |
| Dataset library: bucket, 4 tables, template loader route | 4h |
| Dataset library: cleaning/curating existing CSVs into final form | 2h |
| Workrooms (create, assign manager, roster mgmt) UI + API | 8h |
| Tests | 8h |
| **Total** | **~40h** |

## 13. Out of scope (this epic)

- Custom branding (logo/theming/subdomains) — deferred entirely.
- Assignments and any form of grading — cut entirely, not a fast-follow
  inside this epic.
- Per-seat/subscription billing — flat one-time org fee only.
- Multiple admins per org, admin transfer/recovery flow.
- Revoking org-granted premium when a member is removed or leaves.
- Custom subdomains.
- Cross-org or member-to-member dataset sharing.
- Additional dataset library verticals (hospital, sports, bank, real
  estate) — university ships first, others are separate future issues.

## 14. Child issues & sequencing

| # | Title | Depends on | Effort |
|---|---|---|---|
| 1 | Org foundation: schema, enterprise checkout, webhook fulfillment | none | ~7h |
| 2 | Join links: create/redeem + domain blocklist + premium grant | #1 | ~5h |
| 3 | Admin console: AI toggle + usage tracking dashboard | #1, #2 | ~6h |
| 4 | Dataset library MVP: university vertical (4 joinable tables) | #1 | ~6h |
| 5 | Workrooms: manager role, roster management | #1, #2, #3 | ~10h |

```
#1 Org foundation ─┬─> #2 Join links ─┬─> #3 Admin console ──> #5 Workrooms
                    │                  └──────────────────────> #5
                    └─> #4 Dataset library (independent after #1)
```

**Sequencing rationale:** #1 must exist before anything else touches
`organizations`. #2 (join links) is the actual mechanism that makes an org
useful, so it comes right after. #3 and #5 both need real members to exist
in the org before there's anything to toggle/manage, so they come after #2.
#4 only needs the org to exist (to gate template access), so it can be built
in parallel with #2/#3 by a second contributor if there ever is one.

## 15. Files reference

| File | Change |
|---|---|
| `supabase/migrations/20260917000000_organizations.sql` | New — all tables in section 5 |
| `supabase/schema.sql` | Update to reflect new tables (repo convention: schema.sql documents the authoritative state, migrations are the source of truth) |
| `api/_aiRateLimit.js` | Add org `ai_enabled` gate before existing limit check — built 2026-09-16 |
| `api/_publicDomainBlocklist.js` | New |
| `api/enterprise/create-checkout-session.js` | New — built 2026-09-16 |
| `api/enterprise/create-join-link.js` | New — built 2026-09-16 |
| `api/enterprise/join.js` | New — built 2026-09-16 |
| `api/enterprise/toggle-ai.js` | New — built 2026-09-16 |
| `api/enterprise/usage.js` | New — built 2026-09-16 |
| `api/enterprise/create-workroom.js` | New — built 2026-09-16 (originally spec'd as one `workrooms.js` route; split into `create-workroom.js`/`workrooms-list.js`/`workroom-roster.js` for consistency with the rest of `api/enterprise/`'s one-file-per-action convention) |
| `api/enterprise/workrooms-list.js` | New — built 2026-09-16 |
| `api/enterprise/workroom-roster.js` | New — built 2026-09-16 |
| `api/enterprise/org-roster.js` | New — built 2026-09-16, not in the original route list. Low-sensitivity member-lookup endpoint (id + email only) needed by both the admin's manager-picker and a workroom manager's add-to-roster picker; `usage.js` stayed admin-only and usage-focused rather than being reused for this |
| `supabase/migrations/20260921000000_workrooms.sql` | New — built 2026-09-16 |
| `api/enterprise/list-templates.js` | New — built 2026-09-16 |
| `api/enterprise/enable-template.js` | New — built 2026-09-16 |
| `api/enterprise/load-template.js` | New — built 2026-09-16 |
| `supabase/migrations/20260920000000_dataset_library.sql` | New — built 2026-09-16 |
| `scripts/seed-dataset-library.js` | New — built 2026-09-16, one-off seed script |
| `api/stripe-webhook.js` | Add new branch for the enterprise price id |
| `synth.html` | New UI: Enterprise landing/signup, admin console, workroom management, template picker |

## 16. Open items — resolved 2026-09-16

1. **Template content source of truth:** confirmed — `Nstudents.csv`,
   `Ncourses.csv`, `Nstaff.csv`, and `buildings.csv` are the source-of-truth
   content for the university template (not the `.numbers` files).
2. **Enterprise price — confirmed 2026-09-16:** **$499/year**, per org.
   Originally set as one-time, then the pricing model changed to a yearly
   subscription (section 17) — the $499 figure carries over as the annual
   price, now backed by a recurring yearly Stripe Price, referenced by id
   (`STRIPE_ENTERPRISE_PRICE_ID`) in `api/enterprise/create-checkout-session.js`.
3. **Issue tracking:** not needed. This spec is the tracking artifact —
   work directly off section 14 (child issues & sequencing) without filing
   anything on GitHub.

## 17. Subscription lifecycle — added 2026-09-16 (built)

Once Enterprise became a yearly subscription (see decision #2), a lapsed
subscription needed defined, built behavior instead of silently leaving
every member permanently premium. Locked and implemented:

- **Renewal notices:** the admin gets an email at **3 months**, **1 month**,
  and **1 week** before renewal, sent via a daily Vercel Cron
  (`api/cron/enterprise-renewal-notices.js`) using Gmail SMTP + an app
  password (`api/_mailer.js`) — no third-party email provider. Each
  threshold fires once per billing period (`organizations.notice_3mo_sent_at`
  etc.), reset to null on an actual renewal so the same three notices fire
  again next year.
- **Auto-renew toggle:** the admin can turn auto-renew off/on at any time
  (`api/enterprise/toggle-auto-renew.js`, wraps Stripe's
  `cancel_at_period_end`). Turning it off does **not** end access
  immediately — the org keeps full access through the already-paid period,
  then simply isn't charged again.
- **Teardown on actual lapse:** when Stripe fires `customer.subscription.deleted`
  (the subscription's grace period actually ran out, or every retry
  failed), `api/stripe-webhook.js` revokes org-granted Premium for every
  member (`is_premium=false, premium_via='purchase', org_id=null`) and
  **deletes the `organizations` row**, which cascades to `org_members` and
  `org_join_links` today (`workrooms`/`workroom_members` don't exist yet —
  Child 5 isn't built — but will cascade automatically once they do, no
  code change needed). The domain becomes claimable again by a new admin.
- **Explicitly NOT touched by teardown:** anyone's actual Synth login
  (`auth.users`). A student who joined via the org's link keeps their
  account — they just drop back to the free tier. This was a direct,
  explicit decision (not a default) given how destructive the alternative
  reading would have been.

New schema (`supabase/migrations/20260918000000_org_subscription_lifecycle.sql`):
`organizations.stripe_customer_id`, `stripe_subscription_id` (unique),
`current_period_end`, `cancel_at_period_end`, `notice_3mo_sent_at`,
`notice_1mo_sent_at`, `notice_1wk_sent_at`.

New API routes: `api/enterprise/org-status.js` (GET — role + org info for
the signed-in user), `api/enterprise/toggle-auto-renew.js` (POST,
admin-only). `api/stripe-webhook.js` gained `customer.subscription.updated`
(tracks renewal date, resets notice flags) and `customer.subscription.deleted`
(the teardown) handlers.

Client-side: Account Settings' Enterprise section is now dynamic
(`renderSettingsEnterpriseRow()` in `synth.html`) — shows the "Set up Synth
Enterprise" CTA for non-members, a plain note for regular members, and for
the admin: renewal date + the auto-renew toggle.

**Price confirmed 2026-09-16:** $499/year, set up as a recurring Stripe Price (see item 2 in section 16). No open items remain.
