// Test harness for the Vercel serverless functions in api/.
//
// Call `installApiMocks(mock)` at the top of a test file (before importing
// any handler). It swaps the three external SDKs for in-process fakes:
//
//   @supabase/supabase-js -> tests/helpers/memory-supabase.js (shared `backend`)
//   stripe                -> FakeStripe (records calls; real signature verification)
//   nodemailer            -> fakeMailer (records sent mail)
//
// Needs `node --test --experimental-test-module-mocks` (see package.json).
//
// `importFresh('api/chat.js')` re-imports a handler with a fresh module
// instance, so module-level caches (getSupabaseAdmin's cachedClient, the
// Stripe instance created at import time) pick up env changes made by the
// test. Only the named file is fresh: shared helpers it imports
// (api/_supabaseAuth.js, api/_mailer.js) keep their first instance for the
// rest of the test file, so test "env var missing" for those helpers in
// their own test files.

import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// Loaded before any mock is installed, so this is the real library: its
// webhook signing and verification are used as-is.
const RealStripe = require('stripe');
const { MemoryBackend, createClient } = require('./memory-supabase.js');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const backend = new MemoryBackend();

// ---------- Stripe ----------

export const stripeState = {
  instances: [],
  calls: [],
  subscriptions: {},
  failures: [],
  reset() { this.instances = []; this.calls = []; this.subscriptions = {}; this.failures = []; this.counter = 0; },
  failNext(method, message) { this.failures.push({ method, message }); },
  counter: 0,
};

function stripeCall(method, args, result) {
  stripeState.calls.push({ method, args });
  const i = stripeState.failures.findIndex(f => f.method === method);
  if (i >= 0) {
    const f = stripeState.failures.splice(i, 1)[0];
    const err = new Error(f.message || `${method} failed`);
    err.type = 'StripeAPIError';
    return Promise.reject(err);
  }
  return Promise.resolve(typeof result === 'function' ? result() : result);
}

export class FakeStripe {
  constructor(key, options) {
    this.key = key;
    this.options = options;
    stripeState.instances.push(this);
    this.webhooks = RealStripe.webhooks;
    this.checkout = {
      sessions: {
        create: (params) => stripeCall('checkout.sessions.create', params, () => {
          stripeState.counter += 1;
          const id = `cs_test_${stripeState.counter}`;
          return { id, client_secret: `${id}_secret_abc`, ...params };
        }),
      },
    };
    this.subscriptions = {
      retrieve: (id) => stripeCall('subscriptions.retrieve', id, () => {
        const sub = stripeState.subscriptions[id];
        if (!sub) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: 'StripeInvalidRequestError' });
        return sub;
      }),
      update: (id, params) => stripeCall('subscriptions.update', { id, params }, () => ({ id, ...params })),
    };
  }
}
FakeStripe.webhooks = RealStripe.webhooks;

export const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';

// A request body + header pair exactly as Stripe would deliver it.
export function signedStripeEvent(type, object, { secret = WEBHOOK_SECRET, id } = {}) {
  const payload = JSON.stringify({ id: id || `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, data: { object } });
  const header = RealStripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, header };
}

// ---------- nodemailer ----------

export const mailState = {
  sent: [],
  transports: [],
  failNextWith: null,
  reset() { this.sent = []; this.transports = []; this.failNextWith = null; },
};

export const fakeNodemailer = {
  createTransport(options) {
    mailState.transports.push(options);
    return {
      sendMail: async (msg) => {
        if (mailState.failNextWith) {
          const m = mailState.failNextWith; mailState.failNextWith = null;
          throw new Error(m);
        }
        mailState.sent.push(msg);
        return { messageId: `<${mailState.sent.length}@test>` };
      },
    };
  },
};

// ---------- install ----------

export function installApiMocks(mock) {
  mock.module('@supabase/supabase-js', {
    namedExports: { createClient: () => createClient(msg => backend.handle(msg)) },
  });
  mock.module('stripe', { defaultExport: FakeStripe });
  mock.module('nodemailer', { defaultExport: fakeNodemailer, namedExports: fakeNodemailer });
}

const BASE_ENV = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_ENTERPRISE_PRICE_ID: 'price_enterprise_test',
  GROQ_API_KEY: 'gsk_test',
  CRON_SECRET: 'cron-secret-test',
  GMAIL_USER: 'synth-test@example.com',
  GMAIL_APP_PASSWORD: 'app-password-test',
};
const ENV_KEYS = [...Object.keys(BASE_ENV), 'MARKETING_REPORT_TO'];

// Resets every fake and sets a fully configured environment; pass
// overrides (a value of undefined deletes the variable).
export function resetAll(envOverrides = {}) {
  backend.reset();
  stripeState.reset();
  mailState.reset();
  for (const k of ENV_KEYS) delete process.env[k];
  const env = { ...BASE_ENV, ...envOverrides };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let importCounter = 0;
export async function importFresh(relPath) {
  importCounter += 1;
  const url = pathToFileURL(path.join(ROOT, relPath)).href + `?fresh=${importCounter}`;
  return import(url);
}

// ---------- req / res ----------

export function mockReq({ method = 'POST', headers = {}, body, query = {}, rawBody } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = v;
  if (!lower.host) lower.host = 'synth.test';
  const stream = Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]);
  return Object.assign(stream, { method, headers: lower, body, query });
}

export function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    status(code) { res.statusCode = code; return res; },
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; return res; },
    json(obj) { res.body = obj; res.ended = true; return res; },
    send(data) { res.body = data; res.ended = true; return res; },
    end(data) { if (data !== undefined) res.body = data; res.ended = true; return res; },
  };
  return res;
}

// Runs a handler and returns the finished response.
export async function call(handler, reqOptions) {
  const res = mockRes();
  await handler(mockReq(reqOptions), res);
  return res;
}

// A signed-in user plus the Authorization header for them.
export function signedInUser(email = 'ada@example.com', extra = {}) {
  const user = backend.createUser({ email, ...extra });
  const token = backend.tokenFor(user);
  return { user, token, headers: { authorization: `Bearer ${token}` } };
}

export function silenceConsole(t) {
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const logs = [];
  console.log = (...a) => logs.push(['log', a.join(' ')]);
  console.error = (...a) => logs.push(['error', a.join(' ')]);
  console.warn = (...a) => logs.push(['warn', a.join(' ')]);
  t.after(() => Object.assign(console, orig));
  return logs;
}
