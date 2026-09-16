// Shared helper: blocks common public email providers from being claimed as
// an Enterprise org domain. Without this, anyone could sign up as
// "admin@gmail.com" and mint free Premium access for the entire internet
// via a join link. Checked only at org-creation time (api/enterprise/
// create-checkout-session.js) — not itself a route.

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'protonmail.com', 'proton.me',
  'zoho.com',
  'gmx.com', 'gmx.us',
  'mail.com',
  'yandex.com',
  'fastmail.com',
  'hey.com',
  'pm.me',
]);

export function isPublicEmailDomain(domain) {
  return PUBLIC_EMAIL_DOMAINS.has(String(domain).toLowerCase());
}

// Extracts and normalizes the domain from an email address. Returns null if
// the input doesn't look like an email at all — callers should treat that
// as invalid, not as "not public."
export function extractDomain(email) {
  const match = /^[^@\s]+@([^@\s]+)$/.exec(String(email).trim());
  return match ? match[1].toLowerCase() : null;
}
