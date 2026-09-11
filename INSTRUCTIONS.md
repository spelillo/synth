# Synth Setup Instructions

Follow these steps to set up Synth on a new device after cloning from GitHub.

## Prerequisites

- Python 3.x installed
- Git installed
- Modern web browser (Chrome, Firefox, Edge, Safari)
- Your Groq API key ([get one free here](https://console.groq.com/keys))
- Node.js — only needed if you want local dev to match production exactly, or if you're deploying. Skip if you're just running the legacy two-Python-server workflow below. No global install required; the steps below use `npx vercel`, which downloads and runs the CLI on demand (avoids the `npm install -g` permissions error some Macs hit).

## Setup Steps

### 1. Clone the Repository

```bash
git clone https://github.com/spelillo/synth.git
cd synth
```

### 2. Create Your Proxy Server Configuration

Copy the example file and add your API key:

```bash
cp proxy-server.example.py proxy-server.py
```

Edit `proxy-server.py` and replace `YOUR_GROQ_API_KEY_HERE` with your actual Groq API key:

```python
# Line 12 in proxy-server.py
API_KEY = 'gsk_...'  # Paste your actual API key here
```

**Important:** Never commit `proxy-server.py` back to GitHub! It's already in `.gitignore` to prevent this.

### 3. Start the Local Server

There are two ways to run Synth locally. Pick one.

**Option A — `vercel dev` (recommended, matches production exactly)**

This runs the static site and the `/api/chat` serverless function together on one port, exactly like the deployed version. Requires a Vercel account (free) — see [Deploying to Vercel](#deploying-to-vercel-production) below for account setup.

```bash
npx vercel dev
```

Set `GROQ_API_KEY` when prompted (or add it to a `.env.local` file — it's gitignored). Then open the URL it prints (usually `http://localhost:3000`).

**Option B — legacy two-Python-server workflow (no Vercel account needed, fully offline)**

You need two terminal windows/tabs:

**Terminal 1 - Proxy Server (handles AI requests):**
```bash
python3 proxy-server.py
```

You should see:
```
✓ Proxy server running on http://localhost:8001
✓ API Key loaded (length: 164)
✓ Ready to proxy requests to Groq
```

**Terminal 2 - Web Server (serves the HTML):**
```bash
python3 -m http.server 8000
```

You should see:
```
Serving HTTP on :: port 8000 (http://[::]:8000/) ...
```

With this option, open `synth.html` and change the `CHAT_ENDPOINT` constant near the top of the `<script>` tag from `'/api/chat'` to `'http://localhost:8001/chat'` — the two servers run on different ports, so a relative path won't reach the proxy.

### 4. Open Synth

**If using `vercel dev`:** open the URL it printed (usually `http://localhost:3000`).

**If using the legacy two-server workflow:** open your browser and navigate to:
```
http://localhost:8000/synth.html
```

### 5. Verify Everything Works

1. **Upload a CSV file** - Click "Upload CSV" button
2. **Run a SQL query** - Type `SELECT * FROM data LIMIT 10` and click "Run Query"
3. **Test AI Assistant** - Toggle AI to ON and ask: "show me the first 5 rows"

If the AI responds with SQL, you're all set! 🎉

## Troubleshooting

### Proxy server fails to start

**Error:** `Address already in use`

**Solution:** Kill the process using port 8001:
```bash
lsof -ti:8001 | xargs kill -9
```

### Web server fails to start

**Error:** `Address already in use`

**Solution:** Kill the process using port 8000:
```bash
lsof -ti:8000 | xargs kill -9
```

Or use a different port:
```bash
python3 -m http.server 8080
# Then open http://localhost:8080/synth.html
```

### AI not responding

1. Check that proxy-server.py is running (Terminal 1)
2. Verify your API key is correct in `proxy-server.py`
3. Check browser console for errors (F12)
4. Make sure your Groq API key is valid and not rate-limited

### CSV won't upload

- Make sure it's a valid CSV file with headers
- Try with a smaller file first (< 1MB)
- Check browser console for errors

## Making Changes

### If you edit the HTML

Just refresh the browser - no need to restart servers.

### If you edit proxy-server.py

Stop the proxy server (Ctrl+C in Terminal 1) and restart it:
```bash
python3 proxy-server.py
```

## Stopping the Servers

Press `Ctrl+C` in each terminal window to stop the servers.

## Git Workflow

### Committing changes

```bash
git add synth.html README.md
git commit -m "Your change description"
git push
```

**Never run:** `git add proxy-server.py` - it contains your API key!

### Pulling changes on another device

```bash
git pull
```

Your `proxy-server.py` (with your API key) won't be overwritten - it's local to each device.

## Notes

- Each device needs its own `proxy-server.py` with your API key
- CSV files are not stored in Git (they're in `.gitignore`)
- All data processing happens locally - nothing is sent to servers except AI queries
- The proxy server only forwards AI requests to Groq - your data stays local

## Deploying to Vercel (production)

Synth's static page (`synth.html`) and its AI proxy (`api/chat.js`) are both zero-config for Vercel's free tier.

1. **Create a Vercel account** at [vercel.com](https://vercel.com) (free). No CLI install needed — `npx vercel` downloads and runs it on demand each time (sidesteps the `npm install -g` permissions error some Macs hit).
2. From the project folder, run:
   ```bash
   npx vercel
   ```
   Follow the prompts (link to a new project, accept the defaults). This deploys a preview.
3. **Add your Groq key as an environment variable** — in the Vercel dashboard: Project → Settings → Environment Variables → add `GROQ_API_KEY` with your key, for all environments. (Or `npx vercel env add GROQ_API_KEY`.)
4. **Deploy to production:**
   ```bash
   npx vercel --prod
   ```
5. **Connect your domain** — Project → Settings → Domains → add the domain you own, then follow Vercel's instructions to point it at Vercel (usually an `A`/`CNAME` record at your registrar). SSL is automatic and free.

Nothing else needs to change — `synth.html` already calls `/api/chat`, which resolves correctly once deployed.

## Cloud Sync (optional): Supabase

By default Synth works exactly as before: fully anonymous, nothing saved, nothing leaves your browser except the AI question itself. Signing in is entirely opt-in and only unlocks saving CSVs and chat sessions so you can pick them back up later or from another device.

1. **Create a project** at [supabase.com](https://supabase.com) (free tier).
2. **Run the schema** — Project → SQL Editor → New query → paste the contents of [`supabase/schema.sql`](supabase/schema.sql) → Run. This creates the `datasets`, `chat_sessions`, and `chat_messages` tables with row-level security so users can only ever see their own data.
3. **Enable magic-link sign-in** — Authentication → Providers → Email → make sure "Magic Link" is enabled (password sign-in can stay off).
4. **Create the Storage bucket** — Storage → New bucket → name it `csvs` → keep it private (not public). The read/write policies for it are already included at the bottom of `supabase/schema.sql`.
5. **Wire up the keys** — Project → Settings → API → copy the "Project URL" and the "anon public" key. Paste them into `synth.html`, replacing `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` near the top of the `<script>` tag.

Once configured, a "Sign in" button appears in the header. Signed-in users get a "Save to cloud" button next to an uploaded CSV and a "Save session" button on the AI panel, plus a "My Data" view to reload anything they've saved.

## Quick Reference

**Start everything:**
```bash
# Terminal 1
python3 proxy-server.py

# Terminal 2  
python3 -m http.server 8000

# Browser
http://localhost:8000/synth.html
```

**Stop everything:**
Press `Ctrl+C` in both terminals.
