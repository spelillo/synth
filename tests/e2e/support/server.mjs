// The E2E stack, in one Node process:
//
//   browser (Playwright, real Chromium)
//     -> static files exactly as Vercel serves them (vercel.json rewrites)
//     -> /api/*            the real serverless handlers from api/
//     -> /__supabase       the page's Supabase client (memory-supabase.js)
//   one shared in-memory database (`backend`) behind both.
//
// Must be started from a test file that has called installApiMocks(mock)
// (run with --experimental-test-module-mocks), so the handlers' Supabase /
// Stripe / nodemailer imports resolve to the in-process fakes.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ROOT, backend, importFresh } from '../../helpers/api-harness.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.csv': 'text/csv', '.json': 'application/json', '.wasm': 'application/wasm', '.whl': 'application/zip', '.txt': 'text/plain', '.xml': 'application/xml' };

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const REWRITES = Object.fromEntries(vercel.rewrites.map(r => [r.source, r.destination]));

// File-based routing like Vercel: /api/enterprise/admin -> api/enterprise/admin.js.
// Files starting with "_" are helpers, not routes.
function apiFileFor(pathname) {
  const rel = pathname.replace(/^\/+/, '');
  if (rel.split('/').some(seg => seg.startsWith('_') || seg.includes('..'))) return null;
  const file = path.join(ROOT, `${rel}.js`);
  return fs.existsSync(file) ? `${rel}.js` : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function vercelResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  res.send = (data) => { res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)); return res; };
  return res;
}

export async function startServer({ timings } = {}) {
  const modules = {};
  async function loadHandler(rel) {
    if (!modules[rel]) modules[rel] = await importFresh(rel);
    return modules[rel];
  }

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/__supabase' && req.method === 'POST') {
        const msg = JSON.parse((await readBody(req)).toString('utf8'));
        const reply = backend.handle(msg, { rls: true });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply === undefined ? null : reply));
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const rel = apiFileFor(url.pathname);
        if (!rel) { res.statusCode = 404; res.end(); return; }
        const mod = await loadHandler(rel);
        const raw = await readBody(req);
        const wantsRaw = mod.config && mod.config.api && mod.config.api.bodyParser === false;
        const vreq = Object.assign(Readable.from(wantsRaw ? [raw] : []), {
          method: req.method,
          headers: req.headers,
          url: req.url,
          query: Object.fromEntries(url.searchParams),
        });
        if (!wantsRaw && raw.length) {
          const text = raw.toString('utf8');
          const ct = req.headers['content-type'] || '';
          // Vercel parses JSON bodies; sendBeacon text/plain stays a string.
          vreq.body = ct.includes('application/json') ? (() => { try { return JSON.parse(text); } catch { return text; } })() : text;
        }
        await mod.default(vreq, vercelResponse(res));
        if (!res.writableEnded) res.end();
        return;
      }

      let file = REWRITES[url.pathname] || decodeURIComponent(url.pathname);
      if (file === '/') file = '/synth.html';
      const full = path.join(ROOT, path.normalize(file));
      if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.statusCode = 404; res.end('Not found'); return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    } catch (err) {
      console.error('[e2e server]', req.method, req.url, err);
      if (!res.headersSent) res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: err.message } }));
    } finally {
      if (timings) {
        res.on('finish', () => timings.push({ method: req.method, path: url.pathname, status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
      }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise(r => server.close(r)) };
}

// Replaces global fetch for the AI provider only (the API route's outbound
// call); everything else passes through.
export function stubGroq(reply) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.groq.com/')) {
      calls.push(JSON.parse(init.body));
      const content = typeof reply === 'function' ? reply(JSON.parse(init.body)) : reply;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}
