# Synth

Query any CSV or JSON file with real SQL, or in plain English, entirely in your browser. No database to install, no server to host — upload a file and it becomes a live SQLite database running client-side in your browser tab.

![Synth](synth-og-card.png)

**Live app:** [synth-sql.com](https://www.synth-sql.com/)

## Features

- **Real SQL, not a formula language** — runs an actual SQLite database (compiled to WebAssembly via [sql.js](https://github.com/sql-js/sql.js)), so you get real `JOIN`s, `GROUP BY`, window functions, and subqueries against your file
- **CSV and JSON** — a plain CSV, a JSON array of objects, or newline-delimited JSON (NDJSON); nested JSON objects flatten into dot-notation columns, arrays store as JSON text queryable with SQLite's own `json_extract()`
- **AI assistant, two modes** — SQL Mode returns a runnable query, General Mode answers in plain English; only your table's schema (column names, types, row count) is ever sent to generate a response, never your actual data
- **No account required to start** — Lite Mode loads and queries a file with zero sign-in, entirely in-memory; an optional free account (Normal Mode) adds cross-device sync
- **Multi-table workspaces** — load several files into one workspace, with relationship detection that auto-suggests foreign keys between tables (Premium)
- **Runs entirely client-side** — your file is never uploaded anywhere unless you explicitly sign in and choose to save it to the cloud

## How it works

- **Query engine:** [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly) — runs entirely in the browser, no server round-trip for query execution
- **AI assistant:** served through a Vercel serverless function (`api/chat.js`) that proxies to Groq, so the API key is never exposed to the browser
- **Auth & storage:** [Supabase](https://supabase.com/) (Postgres + Auth + Storage) for the optional signed-in tier — workspaces, saved chat sessions, and Enterprise org data
- **Billing:** [Stripe](https://stripe.com/) Checkout (embedded form) for Premium (one-time) and Enterprise (yearly subscription)
- **No build step:** the app itself (`synth.html`) is a single static HTML file with inline CSS/JS — no bundler, no framework

## Local development

**Prerequisites:** Node.js, and the [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`) since the API routes under `api/` are Vercel serverless functions.

```bash
git clone https://github.com/spelillo/synth.git
cd synth
npm install
vercel dev
```

`vercel dev` serves `synth.html` and the `api/` functions together, matching production.

### Environment variables

The API routes read these from your environment (create a `.env.local`, which is gitignored):

| Variable | Used for |
|---|---|
| `SUPABASE_URL` | Server-side Supabase client (admin operations) |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS for the webhook/admin routes — never expose this to the client |
| `STRIPE_SECRET_KEY` | Creating Checkout Sessions and verifying webhooks |
| `STRIPE_WEBHOOK_SECRET` | Verifying that incoming webhook requests actually came from Stripe |
| `STRIPE_ENTERPRISE_PRICE_ID` | The recurring Stripe Price ID for Enterprise |
| `GROQ_API_KEY` | Powers the AI assistant (`api/chat.js`) |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Transactional email (auth confirmation codes, Enterprise renewal notices) |
| `CRON_SECRET` | Authenticates the Vercel Cron job that sends renewal notices |

The client-side Supabase URL/anon key and Stripe publishable key are hardcoded directly in `synth.html`/`enterprise.html` rather than pulled from env vars — there's no bundler here to inject them at build time, and both are meant to be public. Point them at your own Supabase project and Stripe account for local development.

## Tech stack

SQLite (via WebAssembly) &middot; Supabase &middot; Stripe &middot; Groq &middot; Vercel Serverless Functions &middot; vanilla JS/HTML/CSS (no framework, no bundler)

## License

This repository is public for transparency, but no open-source license is granted — there is no `LICENSE` file, so standard copyright applies and the code isn't licensed for reuse, modification, or redistribution. If you're interested in something not covered here, open an issue.
