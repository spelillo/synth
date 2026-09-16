# Synth transactional email drafts

Sender: Synth <synth.sql@gmail.com>

---

## 1. New user signs up — confirm your email

**This is Supabase's built-in "Confirm signup" template.** Configure it in:
Supabase Dashboard → Authentication → Emails → Templates → Confirm signup

Subject: `Confirm your Synth account`

```
Hi,

Thanks for signing up for Synth. Click below to confirm your email
and finish setting up your account:

{{ .ConfirmationURL }}

If you didn't create a Synth account, you can safely ignore this email.

— Synth
```

---

## 1b. Password reset code (you're missing this one — it's live-critical)

**Also a Supabase built-in template** ("Reset Password"), but the default
version only shows a clickable link. Synth's reset flow has people paste in
a code instead, so this template needs `{{ .Token }}` front and center, not
buried:
Supabase Dashboard → Authentication → Emails → Templates → Reset Password

Subject: `Your Synth password reset code`

```
Hi,

Your password reset code is:

{{ .Token }}

Enter this code on the Synth reset password screen. It expires in 1 hour.

If you didn't request this, you can safely ignore this email — your
password won't change.

— Synth
```

---

## 2. User upgrades to Premium

**Not a Supabase template — this needs custom send code**, triggered from
`api/stripe-webhook.js` in the `checkout.session.completed` handler (right
where `is_premium: true` gets set). Stripe already emails its own payment
receipt separately, so this is a distinct "welcome" email, not a duplicate
receipt.

Subject: `You're Premium — welcome to Synth`

```
Hi,

You're officially Premium. Here's what just unlocked:

- Multi-table workspaces — up to 10 tables in one workspace
- Table renaming
- Cross-table AI queries — the assistant writes joins across your tables
- 5x the daily AI usage limit
- Relationship detection
- CSVs up to 500,000 rows

This was a one-time payment, not a subscription — nothing renews and
there's nothing to cancel later.

— Synth
```

---

## 3. User deletes their account (free/Normal tier)

**No delete-account feature exists yet** — Settings currently only has
"Cancel Premium" (downgrades, keeps the account). This would need a real
delete flow built first (confirm modal -> wipe workspaces/sessions from
Supabase -> delete the auth.users row), most likely a Supabase Edge
Function or a Vercel API route using the service role key, since deleting
an auth user isn't something the client-side anon key can do.

Subject: `Your Synth account has been deleted`

```
Hi,

Confirming your Synth account and all associated data have been
permanently deleted, including:

- Saved workspaces and CSV data
- Chat sessions
- Your account and sign-in details

This can't be undone. If this wasn't you, contact us immediately at
synth.sql@gmail.com.

Thanks for trying Synth.

— Synth
```

---

## 4. User deletes their account (Premium tier)

Same missing feature as #3 — same deletion flow, but this copy
acknowledges the Premium purchase explicitly so it doesn't read like it
silently vanished.

Subject: `Your Synth account has been deleted`

```
Hi,

Confirming your Synth account and all associated data have been
permanently deleted, including:

- Saved workspaces and CSV data
- Chat sessions
- Your account and sign-in details
- Your Premium access

Since Premium was a one-time purchase, there's no subscription to cancel.

If this wasn't you, contact us immediately.

— Synth
```

---

## Other scenarios worth considering (not drafted — lower priority / different system)

- **New-device / new-location sign-in alert** — a security nice-to-have,
  not built. Would need to be triggered from `onAuthStateChange`, storing
  known devices somewhere to compare against.
- **Re-engagement email** (e.g. "come back and finish your query") — this
  is a marketing/lifecycle email, not a transactional one. It needs a real
  email-marketing tool (not Gmail SMTP) since it's not triggered by a
  single event — already flagged as a gap in the marketing audit from
  earlier this week.
- **Stripe's own payment receipt** — sent automatically by Stripe on
  checkout, separate from #2 above. You don't need to build anything for
  this one; it already happens.
