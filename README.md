# Synth

A local CSV query tool with AI-powered SQL assistance. Query your CSV files with SQL and get AI help generating queries.

![Synth Interface](https://img.shields.io/badge/status-active-success.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- 🗄️ **Local SQL Queries** - Load CSV files and query them with SQL (SQLite)
- 🤖 **AI SQL Assistant** - Get AI help writing queries (powered by OpenAI GPT-4o-mini)
- 🔍 **Column Filters & Sorting** - Filter and sort results in real-time
- 📊 **Line Numbers** - SQL editor with numbered lines
- 🎨 **Zapier-Inspired Design** - Warm, professional UI with cream canvas and orange accents
- 🔒 **Privacy First** - All data processing happens locally, API key never exposed to browser

## Quick Start

### Prerequisites

- Python 3.x
- OpenAI API key ([get one here](https://platform.openai.com/api-keys))
- Modern web browser

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/spelillo/synth.git
   cd synth
   ```

2. **Configure the proxy server**
   ```bash
   cp proxy-server.example.py proxy-server.py
   ```
   
   Edit `proxy-server.py` and replace `YOUR_OPENAI_API_KEY_HERE` with your actual OpenAI API key:
   ```python
   API_KEY = 'sk-proj-...'  # Your OpenAI API key here
   ```

3. **Start the servers**
   
   Terminal 1 - Start the proxy server:
   ```bash
   python3 proxy-server.py
   ```
   
   Terminal 2 - Start the web server:
   ```bash
   python3 -m http.server 8000
   ```

4. **Open Synth**
   
   Navigate to: `http://localhost:8000/synth.html`

## Usage

### Basic Query Workflow

1. **Upload CSV** - Click "Upload CSV" and select your file
2. **Write SQL** - Type your query in the SQL editor
   ```sql
   SELECT * FROM data 
   WHERE column_name = 'value'
   LIMIT 100
   ```
3. **Run Query** - Click "Run Query" or press `Cmd/Ctrl + Enter`
4. **Filter Results** - Use the filter boxes under each column header
5. **Sort Columns** - Click column headers to sort

### AI Assistant

1. **Toggle AI On** - Enable the AI assistant in the right panel
2. **Ask Questions** - Describe what you want in plain English:
   - "Show me all rows where amount > 1000"
   - "Group by category and count"
   - "Find duplicates based on email"
3. **Use Query** - Click "Use Query" to insert the AI-generated SQL into the editor

### Tips

- The table name is always `data`
- Use single quotes for strings: `'value'`
- Column names are case-sensitive
- Both `!=` and `<>` work for not-equals
- Use `%` wildcards with `LIKE`: `WHERE name LIKE '%John%'`

## Architecture

```
┌─────────────────┐
│   Browser       │
│  synth.html     │
└────────┬────────┘
         │
         │ HTTP (localhost:8000)
         │
    ┌────▼────┐
    │ Python  │
    │ Server  │
    └─────────┘

┌─────────────────┐
│   Browser       │
│   (API calls)   │
└────────┬────────┘
         │
         │ HTTP (localhost:8001)
         │
    ┌────▼─────────┐
    │ Proxy Server │
    │ (with API    │
    │  key)        │
    └────────┬─────┘
             │
             │ HTTPS
             │
    ┌────────▼─────┐
    │   OpenAI     │
    │     API      │
    └──────────────┘
```

**Why a proxy server?**
- Browsers can't make direct CORS requests to OpenAI's API
- Keeps your API key secure (never exposed to the browser)
- Allows local file:// protocol usage

## Security Notes

- ⚠️ **Never commit `proxy-server.py` with your API key**
- ✅ API key is only stored in `proxy-server.py` (gitignored)
- ✅ Browser never sees or stores your API key
- ✅ All CSV data stays local (never sent to any server except OpenAI for AI queries)

## Design

Synth uses a **Zapier-inspired design language**:
- Warm cream canvas (#fffefb)
- Coffee-dark text (#201515)  
- Orange accent (#ff4f00) for CTAs
- Inter font family
- 12px border radius (Zapier's signature)

## Tech Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **SQL Engine**: [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly)
- **AI**: OpenAI GPT-4o-mini via Python proxy
- **Design**: Custom CSS inspired by Zapier's design system

## Troubleshooting

**AI not working?**
- Check that `proxy-server.py` is running on port 8001
- Verify your OpenAI API key is correct
- Check browser console for errors

**CSV won't load?**
- Make sure it's a valid CSV file
- Try opening in a Chromium-based browser (better file:// support)

**Port already in use?**
```bash
# Kill process on port 8001
lsof -ti:8001 | xargs kill -9

# Kill process on port 8000
lsof -ti:8000 | xargs kill -9
```

## Contributing

Contributions welcome! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests

## License

MIT License - feel free to use this project however you'd like.

## Acknowledgments

- Design inspired by [Zapier](https://zapier.com)
- Built with [sql.js](https://github.com/sql-js/sql.js)
- AI powered by [OpenAI](https://openai.com)
