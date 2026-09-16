// Shared helper: sends transactional email via Gmail SMTP using an app
// password (not Gmail's normal login password — see
// https://support.google.com/accounts/answer/185833). Not itself a route.
//
// Env vars needed: GMAIL_USER (the Gmail address sending mail),
// GMAIL_APP_PASSWORD (the 16-character app password, not your real Gmail
// password). Chosen because it needs no third-party account/billing
// (Resend, SendGrid, etc.) — fine at Synth Enterprise's current volume
// (at most 3 emails per org per year), but Gmail SMTP has sending-volume
// caps meant for personal use, not bulk mail — worth switching to a real
// transactional provider if Enterprise ever has more than a handful of
// orgs.

import nodemailer from 'nodemailer';

let cachedTransporter;
function getTransporter() {
  if (cachedTransporter !== undefined) return cachedTransporter;
  cachedTransporter = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      })
    : null;
  return cachedTransporter;
}

// Returns { sent: false, reason } instead of throwing when mail isn't
// configured — callers (the renewal-notice cron) should log and move on to
// the next org rather than fail the whole run over one email.
export async function sendMail({ to, subject, text, html }) {
  const transporter = getTransporter();
  if (!transporter) {
    return { sent: false, reason: 'GMAIL_USER/GMAIL_APP_PASSWORD not configured' };
  }
  try {
    await transporter.sendMail({ from: process.env.GMAIL_USER, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}
