// Playwright setup shared by the E2E suites.
//
// Third-party scripts are served locally so the suite is hermetic:
//   sql.js (CDN)        -> node_modules/sql.js/dist (the same 1.8.0 build)
//   supabase-js (CDN)   -> tests/helpers/memory-supabase.js, talking to /__supabase
//   Stripe.js, fonts, icons, Vercel analytics -> empty responses
// Everything on the test server itself (HTML, app JS, /api/*) is real.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from '../../helpers/api-harness.mjs';

const require = createRequire(import.meta.url);
const SQLJS_DIST = path.join(ROOT, 'node_modules', 'sql.js', 'dist');
const MEMORY_SUPABASE = fs.readFileSync(path.join(ROOT, 'tests', 'helpers', 'memory-supabase.js'), 'utf8');
const SUPABASE_SHIM = `${MEMORY_SUPABASE}
window.supabase = { createClient: function () {
  return window.MemorySupabase.createClient(function (msg) {
    return fetch('/__supabase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) }).then(function (r) { return r.json(); });
  }, { sessionStorage: window.localStorage, sessionKey: 'sb-e2e-session' });
} };`;

export function loadPlaywright() {
  for (const name of ['playwright', '@playwright/test']) {
    try { return require(name); } catch { /* next */ }
  }
  try {
    const globalRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  } catch { return null; }
}

// Opens a page with the routing above. `page.__errors` collects uncaught
// page errors so every test can assert the UI never threw.
export async function openPage(browser, base, { viewport = { width: 1440, height: 900 }, signedOut = false } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.__errors = [];
  page.on('pageerror', e => page.__errors.push(e.message));
  page.on('dialog', d => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    const sqljs = url.match(/sql\.js@1\.8\.0\/dist\/(.+)$/);
    if (sqljs) return route.fulfill({ body: fs.readFileSync(path.join(SQLJS_DIST, sqljs[1])), contentType: sqljs[1].endsWith('.wasm') ? 'application/wasm' : 'application/javascript' });
    if (url.includes('supabase-js')) return route.fulfill({ body: signedOut ? '' : SUPABASE_SHIM, contentType: 'application/javascript' });
    return route.fulfill({ body: '', contentType: url.endsWith('.css') ? 'text/css' : 'application/javascript' });
  });
  return page;
}

export const squash = s => (s || '').replace(/\s+/g, ' ').trim();
