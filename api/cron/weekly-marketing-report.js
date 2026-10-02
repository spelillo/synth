// Vercel Cron Job (see vercel.json "crons") — runs Sundays. Emails a short
// growth report for the past 7 days, compared with the 7 before: visitors,
// people who ran a query, returning users, new accounts, and where visitors
// came from. Reads usage_events (written by api/track.js) and the Supabase
// auth user list.
//
// Recipient: MARKETING_REPORT_TO, falling back to GMAIL_USER (the address
// the mailer sends from). Protected by CRON_SECRET, like the other cron.

import { createClient } from '@supabase/supabase-js';
import { sendMail } from '../_mailer.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let cachedSupabaseAdmin;
function getSupabaseAdmin() {
  if (cachedSupabaseAdmin !== undefined) return cachedSupabaseAdmin;
  cachedSupabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedSupabaseAdmin;
}

async function fetchEventsSince(supabase, since) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('usage_events')
      .select('event, visitor_id, ref, referrer, path, created_at')
      .gte('created_at', since.toISOString())
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { rows: null, error };
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return { rows, error: null };
}

async function fetchUserSignupDates(supabase) {
  const dates = [];
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    dates.push(...data.users.map(u => new Date(u.created_at)));
    if (data.users.length < 1000) break;
  }
  return dates;
}

function summarize(events, start, end) {
  const inRange = events.filter(e => {
    const t = new Date(e.created_at);
    return t >= start && t < end;
  });
  const visitors = new Set(inRange.filter(e => e.event === 'visit').map(e => e.visitor_id));
  const queriers = new Set(inRange.filter(e => e.event === 'query_run').map(e => e.visitor_id));
  return { inRange, visitors: visitors.size, queriers };
}

// Visitors who ran a query this week and had also run one on an earlier day.
function countReturning(events, queriersThisWeek, weekStart) {
  const earlier = new Set(events
    .filter(e => e.event === 'query_run' && new Date(e.created_at) < weekStart)
    .map(e => e.visitor_id));
  let n = 0;
  for (const v of queriersThisWeek) if (earlier.has(v)) n++;
  return n;
}

function topCounts(rows, key, limit = 6) {
  const byValue = new Map();
  for (const r of rows) {
    const value = r[key] || '(none)';
    if (!byValue.has(value)) byValue.set(value, new Set());
    byValue.get(value).add(r.visitor_id);
  }
  return [...byValue.entries()]
    .map(([value, ids]) => [value, ids.size])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function delta(now, before) {
  if (before === 0) return now === 0 ? '' : ' (new)';
  const pct = Math.round(((now - before) / before) * 100);
  return ` (${pct >= 0 ? '+' : ''}${pct}% vs last week)`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildEmail(r) {
  const lines = [
    ['Visitors', `${r.visitors}${delta(r.visitors, r.prevVisitors)}`],
    ['Ran a query', `${r.queriers}${delta(r.queriers, r.prevQueriers)}`],
    ['Came back and queried again', `${r.returning}`],
    ['New accounts', r.newAccounts === null ? 'unavailable' : `${r.newAccounts}${delta(r.newAccounts, r.prevNewAccounts)}`],
    ['Total accounts', r.totalAccounts === null ? 'unavailable' : `${r.totalAccounts}`],
  ];
  const list = (title, rows) => rows.length
    ? `${title}\n${rows.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`
    : `${title}\n  nothing yet`;
  const htmlList = (title, rows) => `<h3 style="margin:20px 0 6px;font-size:15px">${title}</h3>` + (rows.length
    ? `<table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0">${escapeHtml(k)}</td><td style="text-align:right">${v}</td></tr>`).join('')}</table>`
    : '<p style="margin:0;color:#666">Nothing yet.</p>');

  const subject = `Synth weekly: ${r.queriers} ran a query, ${r.newAccounts ?? "?"} new accounts, ${r.visitors} visitors`;
  const note = r.trackingMissing
    ? 'Usage tracking isn\'t set up yet (the usage_events table is missing), so only account numbers are shown. Run supabase/migrations/20261002000000_usage_events.sql once to turn it on.'
    : '';

  const text = [
    `Synth, week of ${r.weekLabel}`,
    note,
    lines.map(([k, v]) => `${k}: ${v}`).join('\n'),
    list('Where visitors came from (sites)', r.referrers),
    list('Tracked campaign links (?ref=)', r.refs),
    list('Most visited pages', r.pages),
    '— Synth',
  ].filter(Boolean).join('\n\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#222;max-width:520px">
<h2 style="font-size:18px;margin:0 0 4px">Synth, week of ${escapeHtml(r.weekLabel)}</h2>
${note ? `<p style="color:#a15c00">${escapeHtml(note)}</p>` : ''}
<table style="border-collapse:collapse;margin-top:12px">${lines.map(([k, v]) => `<tr><td style="padding:3px 16px 3px 0">${k}</td><td style="font-weight:600">${escapeHtml(v)}</td></tr>`).join('')}</table>
${htmlList('Where visitors came from (sites)', r.referrers)}
${htmlList('Tracked campaign links (?ref=)', r.refs)}
${htmlList('Most visited pages', r.pages)}
<p style="margin-top:24px;color:#666">— Synth</p></div>`;

  return { subject, text, html };
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    res.status(500).json({ error: { message: 'Cron not configured' } });
    return;
  }
  if ((req.headers['authorization'] || '') !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: { message: 'Unauthorized' } });
    return;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).json({ error: { message: 'Server is not configured (Supabase)' } });
    return;
  }

  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);
  const prevStart = new Date(now.getTime() - 14 * DAY_MS);

  // Returning users need history before this week, so read further back.
  const { rows: events, error } = await fetchEventsSince(supabase, new Date(now.getTime() - 90 * DAY_MS));
  const trackingMissing = !!error;
  const all = events || [];

  const thisWeek = summarize(all, weekStart, now);
  const lastWeek = summarize(all, prevStart, weekStart);
  const visits = thisWeek.inRange.filter(e => e.event === 'visit');

  const signupDates = await fetchUserSignupDates(supabase);

  const report = {
    weekLabel: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    trackingMissing,
    visitors: thisWeek.visitors,
    prevVisitors: lastWeek.visitors,
    queriers: thisWeek.queriers.size,
    prevQueriers: lastWeek.queriers.size,
    returning: countReturning(all, thisWeek.queriers, weekStart),
    newAccounts: signupDates ? signupDates.filter(d => d >= weekStart).length : null,
    prevNewAccounts: signupDates ? signupDates.filter(d => d >= prevStart && d < weekStart).length : 0,
    totalAccounts: signupDates ? signupDates.length : null,
    referrers: topCounts(visits, 'referrer'),
    refs: topCounts(visits.filter(e => e.ref), 'ref'),
    pages: topCounts(visits, 'path'),
  };

  const to = process.env.MARKETING_REPORT_TO || process.env.GMAIL_USER;
  const result = to ? await sendMail({ to, ...buildEmail(report) }) : { sent: false, reason: 'no recipient' };
  if (!result.sent) console.error('weekly-marketing-report: email not sent:', result.reason);
  res.status(200).json({ sent: result.sent });
}
