// Vercel Cron Job (see vercel.json "crons") — runs daily. For every org
// that's still set to auto-renew, checks whether its subscription's
// current_period_end has crossed the 3-month, 1-month, or 1-week-out mark
// and, if so, emails the admin once per threshold per billing period (the
// notice_*_sent_at columns are the "once" guard; they're reset to null in
// api/stripe-webhook.js's customer.subscription.updated handler whenever a
// renewal moves current_period_end forward, so the same three notices fire
// again next year).
//
// Protected by CRON_SECRET: Vercel signs its own cron invocations with an
// `Authorization: Bearer <CRON_SECRET>` header when that env var is set —
// see https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
// Without this check, this URL would be a public, unauthenticated way to
// spam every org admin's inbox.

import { createClient } from '@supabase/supabase-js';
import { sendMail } from '../_mailer.js';

let cachedSupabaseAdmin;
function getSupabaseAdmin() {
  if (cachedSupabaseAdmin !== undefined) return cachedSupabaseAdmin;
  cachedSupabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedSupabaseAdmin;
}

const THRESHOLDS = [
  { column: 'notice_3mo_sent_at', days: 90, label: '3 months' },
  { column: 'notice_1mo_sent_at', days: 30, label: '1 month' },
  { column: 'notice_1wk_sent_at', days: 7, label: '1 week' },
];

function renewalNoticeEmail({ orgName, orgDomain, label, renewalDate }) {
  const dateStr = renewalDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const subject = `Synth Enterprise for ${orgDomain} renews in ${label}`;
  const text = `Your Synth Enterprise subscription for ${orgName} (${orgDomain}) renews on ${dateStr} — about ${label} from now.\n\nNo action needed if you want to keep it. If you'd rather not renew, sign in to Synth and turn off auto-renewal in Account Settings before ${dateStr} — you'll keep full access through that date either way, you just won't be charged again after it.\n\n— Synth`;
  const html = `<p>Your Synth Enterprise subscription for <strong>${orgName}</strong> (${orgDomain}) renews on <strong>${dateStr}</strong> — about ${label} from now.</p><p>No action needed if you want to keep it. If you'd rather not renew, sign in to Synth and turn off auto-renewal in Account Settings before ${dateStr} — you'll keep full access through that date either way, you just won't be charged again after it.</p><p>— Synth</p>`;
  return { subject, text, html };
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: { message: 'Unauthorized' } });
      return;
    }
  } else {
    console.error('CRON_SECRET is not configured — refusing to run unauthenticated');
    res.status(500).json({ error: { message: 'Cron not configured' } });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: { message: 'Server is not configured (Supabase)' } });
    return;
  }

  const { data: orgs, error: orgsError } = await supabaseAdmin
    .from('organizations')
    .select('id, name, domain, current_period_end, cancel_at_period_end, notice_3mo_sent_at, notice_1mo_sent_at, notice_1wk_sent_at')
    .eq('cancel_at_period_end', false)
    .not('current_period_end', 'is', null);

  if (orgsError) {
    res.status(500).json({ error: { message: orgsError.message } });
    return;
  }

  const now = Date.now();
  const results = [];

  for (const org of orgs) {
    const periodEnd = new Date(org.current_period_end);
    const daysRemaining = (periodEnd.getTime() - now) / (24 * 60 * 60 * 1000);

    for (const threshold of THRESHOLDS) {
      const alreadySent = org[threshold.column];
      if (alreadySent) continue;
      if (daysRemaining > threshold.days) continue; // not there yet
      if (daysRemaining < 0) continue; // already lapsed — customer.subscription.deleted handles that

      const { data: admin } = await supabaseAdmin
        .from('org_members')
        .select('user_id')
        .eq('org_id', org.id)
        .eq('role', 'admin')
        .maybeSingle();
      if (!admin) {
        console.error('No admin found for org', org.id, '— skipping notice');
        continue;
      }

      const { data: adminUser } = await supabaseAdmin.auth.admin.getUserById(admin.user_id);
      const adminEmail = adminUser?.user?.email;
      if (!adminEmail) {
        console.error('Could not resolve admin email for org', org.id, '— skipping notice');
        continue;
      }

      const { subject, text, html } = renewalNoticeEmail({
        orgName: org.name,
        orgDomain: org.domain,
        label: threshold.label,
        renewalDate: periodEnd,
      });
      const mailResult = await sendMail({ to: adminEmail, subject, text, html });

      if (mailResult.sent) {
        await supabaseAdmin
          .from('organizations')
          .update({ [threshold.column]: new Date().toISOString() })
          .eq('id', org.id);
      }

      results.push({ org: org.domain, threshold: threshold.label, ...mailResult });
      // Only one threshold can legitimately fire per org per run (they're
      // mutually exclusive day ranges), so stop scanning thresholds for
      // this org once one is handled.
      break;
    }
  }

  res.status(200).json({ checked: orgs.length, notified: results });
}
