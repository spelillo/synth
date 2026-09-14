# AI Rate Limiting — Spec

`/api/chat` now requires a signed-in session (see REMEDIATION_PLAN.md, H1), which closes off anonymous abuse but not a single signed-in account looping the endpoint, by accident or on purpose. This adds a per-account limit, split by tier, plus a new Premium differentiator built on top of it: more daily AI usage, quantified as a multiplier rather than a number anywhere a user can see it.

Two numbers, agreed in chat:

- **Free (Normal Mode, signed in, not Premium): 60 messages/day**
- **Premium: 300 messages/day** — exactly 5x

Nowhere in the product does either number appear. The Premium feature list says "5x," never "300." This is a product decision, not just an engineering one: the multiplier communicates the value without inviting a user to do the math on whether 60 is "enough" and start counting down, and it means the two numbers can move together later (raise the free tier, Premium scales with it) without touching copy.

## Data model

One table, one source of truth for both a burst check and a daily check — two `COUNT` queries against the same rows rather than two counters to keep in sync.

```sql
-- supabase/migrations/20260914120000_ai_usage_events.sql

create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_events_user_time_idx
  on public.ai_usage_events (user_id, created_at desc);

alter table public.ai_usage_events enable row level security;

-- No policies: this table is only ever read/written by api/chat.js using the
-- service-role key (see api/_supabaseAuth.js), the same pattern
-- api/stripe-webhook.js already uses for profiles. RLS stays enabled with
-- zero policies so the anon/authenticated roles get nothing even if a
-- future change starts querying this table from the client by mistake.
```

One row per accepted chat message. No cleanup job in this pass — at the volume a hobby project sees, a few thousand rows a year costs nothing to store, and it's one `delete from ai_usage_events where created_at < now() - interval '30 days'` to add later if it ever matters. Don't build that now for a table that has to grow for months before it's worth the code.

## Limits

```js
// api/_aiRateLimit.js
const BURST_LIMIT = 15;            // requests
const BURST_WINDOW_MINUTES = 5;
const DAILY_LIMIT_FREE = 60;
const DAILY_LIMIT_PREMIUM = 300;
```

The burst limit is the same for every account, Premium included — it's not a usage tier, it's a "this is a script, not a person" circuit breaker. Nobody chatting normally sends 15 messages in 5 minutes.

The daily limit is a rolling 24 hours from the request, not a calendar-day reset, so a user who hits the limit at 11pm doesn't get a free reset at midnight two hours later.

Known, accepted gap: the check-then-insert isn't atomic. Two requests landing in the same few milliseconds could both read a count just under the limit and both get inserted, overshooting by one. At this traffic level that's not worth a database transaction or an advisory lock to prevent — noting it here so it's a decision, not an oversight, if it ever needs revisiting.

## Server: `api/_aiRateLimit.js` (new)

```js
import { createClient } from '@supabase/supabase-js';

let cachedClient;
function getSupabaseAdmin() {
  if (cachedClient !== undefined) return cachedClient;
  cachedClient = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedClient;
}

const BURST_LIMIT = 15;
const BURST_WINDOW_MINUTES = 5;
const DAILY_LIMIT_FREE = 60;
const DAILY_LIMIT_PREMIUM = 300;

// Checks both limits and, if the request is allowed, records it in the same
// call — callers should treat a rejected result as "don't forward to Groq."
export async function checkAndRecordAiUsage(userId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { allowed: true }; // fail open if Supabase isn't configured — chat still works, just unmetered

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_premium')
    .eq('id', userId)
    .maybeSingle();
  const dailyLimit = profile?.is_premium ? DAILY_LIMIT_PREMIUM : DAILY_LIMIT_FREE;

  const now = Date.now();
  const burstSince = new Date(now - BURST_WINDOW_MINUTES * 60_000).toISOString();
  const daySince = new Date(now - 24 * 60 * 60_000).toISOString();

  const { count: burstCount } = await supabase
    .from('ai_usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', burstSince);
  if (burstCount >= BURST_LIMIT) {
    return { allowed: false, message: "You're sending messages faster than the assistant can keep up. Wait a few minutes and try again." };
  }

  const { count: dailyCount } = await supabase
    .from('ai_usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', daySince);
  if (dailyCount >= dailyLimit) {
    return {
      allowed: false,
      message: profile?.is_premium
        ? "You've used today's AI messages. It resets on a rolling basis, so try again in a bit."
        : "You've used today's AI messages. Go Premium for a lot more room, or come back tomorrow."
    };
  }

  await supabase.from('ai_usage_events').insert({ user_id: userId });
  return { allowed: true };
}
```

Reads `profiles.is_premium` itself rather than taking it as a parameter, since `api/chat.js` doesn't otherwise need that lookup and the two pieces of logic (which tier, whether they're over their limit) belong together.

## Server: `api/chat.js` (add one check)

Right after the existing auth check, before the message-shape validation:

```js
import { getVerifiedUserId } from './_supabaseAuth.js';
import { checkAndRecordAiUsage } from './_aiRateLimit.js';

// ...

const userId = await getVerifiedUserId(req);
if (!userId) {
  res.status(401).json({ error: { message: 'Sign in required to use the AI assistant' } });
  return;
}

const usage = await checkAndRecordAiUsage(userId);
if (!usage.allowed) {
  res.status(429).json({ error: { message: usage.message } });
  return;
}
```

## Client: `synth.html` — showing a 429

`sendMessage()` already has a branch for `response.status === 401` (added with the sign-in requirement). Same shape, one more branch, same spot:

```js
if (response.status === 429) {
  const body = await response.json().catch(() => ({}));
  throw new Error(body?.error?.message || "You've used today's AI messages. Try again later.");
}
if (response.status === 401) {
  throw new Error('Your session expired. Sign in again to keep using the AI assistant.');
}
if (!response.ok) {
  const errorText = await response.text();
  throw new Error(`API returned ${response.status}: ${errorText}`);
}
```

The existing `catch` block already renders whatever message reaches it as the assistant's reply bubble, so no new UI plumbing, just the message text itself. No running counter anywhere in the chat panel ("42 of 60 today") — the limit shows up once, when it's actually hit, worded plainly, and disappears from the user's attention otherwise. A visible countdown would make a generous daily allowance feel like a meter to watch, which isn't the experience a normal session should have.

## Client: Premium feature list copy (two places)

Both copies of `.premium-feature-list` — the Go Premium modal (`synth.html`, `id="premium-modal"`) and the Help modal's "Premium features" section — get one new line each, in the same terse `**Name** — plain clause` shape the rest of the list already uses:

```html
<li>More AI usage — 5x the daily limit on a free account</li>
```

Placed right after "Cross-table AI queries," grouping the two AI-related lines together:

```html
<ul class="premium-feature-list">
  <li>Multi-table workspaces — up to 10 tables in one workspace</li>
  <li>Table renaming — give a table a cleaner name than its raw filename</li>
  <li>Cross-table AI queries — the assistant writes joins across your tables</li>
  <li>More AI usage — 5x the daily limit on a free account</li>
  <li>Relationship detection — auto-suggested foreign keys you confirm yourself</li>
  <li>Dashboard — a home base listing every workspace you've saved to the cloud</li>
</ul>
```

Why this wording and not something punchier: the rest of the list states what each feature actually is, not what it feels like to have it — no "unlock," "supercharge," or "unlimited" (it isn't unlimited, and saying so would be a claim the product doesn't back up the moment someone actually hits 300). "5x the daily limit on a free account" is the whole fact, phrased the same plain way as "up to 10 tables in one workspace." A reader who wants to know the actual number can't get it from this line, which is the point, but nothing here reads as evasive either — it says exactly what's true.

## What this doesn't do

- No per-minute or per-hour tier in between burst and daily — two thresholds cover the real failure modes (a runaway script, a maxed-out day) without a third number to explain if anyone asks.
- No admin UI to see who's near their limit or to comp someone extra messages. If that's ever needed, it's a `select` against `ai_usage_events` and an `update` against `profiles`, not a new system.
- No change to `GENERAL_MODE_RULES` or the SQL-mode system prompts — the limit is enforced before a request ever reaches Groq, so the model itself doesn't need to know it exists.

## Testing

- Send 15 messages inside 5 minutes on a fresh account, confirm the 16th is rejected with the burst message and the UI shows it as the assistant's reply.
- Send 60 messages across a longer window on a non-Premium account (or seed `ai_usage_events` directly in Supabase to skip the wait), confirm the 61st is rejected with the free-tier message that mentions Premium.
- Flip `profiles.is_premium` to true for a test account already at 60 for the day, confirm it can keep sending up to 300 total.
- Grep the shipped page and both modals for "60" and "300" after implementing — neither number should appear anywhere in `synth.html`.
