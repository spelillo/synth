# Synth Setup Instructions

Follow these steps to set up Synth on a new device after cloning from GitHub.

## Prerequisites

- Python 3.x installed
- Git installed
- Modern web browser (Chrome, Firefox, Edge, Safari)
- Your OpenAI API key ([get one here](https://platform.openai.com/api-keys))

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

Edit `proxy-server.py` and replace `YOUR_OPENAI_API_KEY_HERE` with your actual OpenAI API key:

```python
# Line 12 in proxy-server.py
API_KEY = 'sk-proj-...'  # Paste your actual API key here
```

**Important:** Never commit `proxy-server.py` back to GitHub! It's already in `.gitignore` to prevent this.

### 3. Start the Servers

You need two terminal windows/tabs:

**Terminal 1 - Proxy Server (handles AI requests):**
```bash
python3 proxy-server.py
```

You should see:
```
✓ Proxy server running on http://localhost:8001
✓ API Key loaded (length: 164)
✓ Ready to proxy requests to OpenAI
```

**Terminal 2 - Web Server (serves the HTML):**
```bash
python3 -m http.server 8000
```

You should see:
```
Serving HTTP on :: port 8000 (http://[::]:8000/) ...
```

### 4. Open Synth

Open your browser and navigate to:
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
4. Make sure you have credits in your OpenAI account

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
- The proxy server only forwards AI requests to OpenAI - your data stays local

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
