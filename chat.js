    // Note: the Groq API key is handled server-side (proxy-server.py locally,
    // /api/chat.js when deployed). No API key is ever stored in the browser.
    //
    // Where chat requests go. '/api/chat' (same origin) works both with
    // `vercel dev` locally and once deployed on Vercel. If you're using
    // the older local-only workflow instead (`python3 proxy-server.py`
    // + `python3 -m http.server 8000`), change this to
    // 'http://localhost:8001/chat'.
    const CHAT_ENDPOINT = '/api/chat';

    // ---- Output mode: SQL (every reply is a runnable query, today's
    // behavior) vs General (plain-English answers about the data, no SQL
    // forced). Persisted per-browser like saved queries, so it doesn't
    // reset to SQL every reload.
    const OUTPUT_MODE_KEY = 'synth_output_mode_v1';
    let outputMode = 'sql';

    function crossTableAIBlocked() {
      return tables.length > 1 && !canUseFeature('crossTableAI');
    }

    let tableSchema = '';

    function schemaTextFor(tableName) {
      const result = db.exec(`PRAGMA table_info("${tableName}")`);
      const columns = result[0].values.map(col => ({ name: col[1], type: col[2] }));
      const rowCount = getCurrentRowCount(tableName);
      return { columns, text: `Table: ${tableName}\nColumns:\n${columns.map(c => `- ${c.name} (${c.type})`).join('\n')}\nTotal rows: ${rowCount}` };
    }

    // Multi-table system prompt: the AI always sees every table's schema,
    // never just the focused one, so cross-table joins keep working
    // regardless of which table is selected in the chip bar / focus dropdown.
    // Real instruction for off-topic input in SQL Mode, replacing the old
    // toothless "redirect to SQL help" rule that gave the model no actual
    // way to redirect — its most rule-compliant move was inventing a
    // SELECT that echoed a conversational reply as a string literal.
    const SQL_OFFTOPIC_RULE = 'If the question is not about the loaded data, do not write SQL for it. Reply with exactly one line, in plain text, no code fence: "I can only help with questions about your data — try asking about specific rows, columns, or aggregates."';

    // General Mode still only ever gets schema text, never actual row
    // values (db never leaves the browser) — rule 3 keeps it honest about
    // that boundary instead of confabulating numbers.
    const GENERAL_MODE_RULES = `You are a data analyst assistant. The user has loaded the schema above and wants plain-English answers, not SQL.\n1. Never write SQL or use \`\`\`sql code fences — describe things in words.\n2. Ground every answer in the actual schema/columns above; don't invent columns or guess at data you can't see.\n3. If the question needs an actual computed answer from the data itself (not just schema — "what's the average of X"), say plainly that you can't compute it without running a query, and suggest switching to SQL Mode to get the query for it.\n4. Keep answers concise — a few sentences, not an essay.`;

    function buildSystemPrompt() {
      // Cross-table AI is Premium. Most non-premium accounts never reach
      // tables.length > 1 in the first place (gated at upload), but an
      // account that already had 2+ tables saved before that gate existed
      // can still load one — so this checks the tier directly rather than
      // just table count, and falls back to a single-table prompt scoped
      // to whichever table is active instead of exposing every schema.
      const crossTableAllowed = tables.length > 1 && canUseFeature('crossTableAI');

      if (!crossTableAllowed) {
        const schemaText = tables.length <= 1 ? tableSchema : schemaTextFor(activeTableName).text;
        if (outputMode === 'general') {
          return `You are a data analyst assistant. The user has loaded a CSV file into a SQLite database. Here is the schema:\n\n${schemaText}\n\n${GENERAL_MODE_RULES}`;
        }
        return `You are a SQL query assistant. The user has loaded a CSV file into a SQLite database. Here is the schema:\n\n${schemaText}\n\nYour job is to:\n1. ONLY respond with SQL queries that work on this exact table\n2. Use the table name ${activeTableName} exactly as written, with no surrounding quotes — table names in this database never need quoting. Column names only need double quotes if they contain a space or special character (e.g. "First Name")\n3. Format SQL queries in markdown code blocks with \`\`\`sql\n4. Keep explanations brief\n5. Never suggest anything other than SQL queries\n6. ${SQL_OFFTOPIC_RULE}\n7. CRITICAL: Use proper SQL syntax - ensure spaces between all keywords\n8. Use single quotes for string literals (e.g., 'value' not "value")\n9. For not-equals use <> or != (both work in SQLite)\n10. Column names are case-sensitive - match them exactly from the schema\n11. All SQL must be valid SQLite syntax\n12. Every column is stored as TEXT regardless of what it looks like. Before CAST()ing a column to a number (for ORDER BY, comparisons, math), wrap it in REPLACE(column, ',', '') in case it has thousands-separator commas (e.g. "1,200"), since CAST alone reads only the leading digit run and silently returns the wrong value\n\nBe concise, practical, and syntactically perfect.`;
      }

      const focusList = [...focusedTableNames].filter(name => tables.some(t => t.name === name));
      const focusNote = focusList.length
        ? `\nThe user has ${focusList.length === 1 ? 'this table' : 'these tables'} focused in the UI: ${focusList.map(n => `"${n}"`).join(', ')}. If a question is ambiguous about which table it refers to (e.g. "show me the first 10 rows"), default to ${focusList.length === 1 ? 'that table' : 'those tables'}. If the question clearly needs other tables (joins, cross-table aggregation), use whichever tables are actually needed regardless of focus.\n`
        : '';
      const relationshipNote = relationshipHintsText();

      if (outputMode === 'general') {
        return `You are a data analyst assistant. The user has loaded multiple related tables into one SQLite database. Here is the schema for every table in the workspace:\n\n${tableSchema}\n${focusNote}${relationshipNote}\n${GENERAL_MODE_RULES}`;
      }

      return `You are a SQL query assistant. The user has loaded multiple related tables into one SQLite database. Here is the schema for every table in the workspace:\n\n${tableSchema}\n${focusNote}${relationshipNote}\nYour job is to:\n1. ONLY respond with SQL queries that work on these exact tables\n2. Use the correct table name(s) from the schema above exactly as written, with no surrounding quotes — table names in this database never need quoting, and you should never invent a table\n3. Several tables may share column names (id, name, status, etc.) — always qualify column names with a table alias once more than one table is involved, and pick the specific table's column the question actually refers to\n4. If a question requires data from more than one table, write a proper JOIN using the relationships implied by matching id columns (e.g. orders.customer_id -> customers.id)\n5. Format SQL queries in markdown code blocks with \`\`\`sql\n6. Keep explanations brief\n7. Never suggest anything other than SQL queries\n8. ${SQL_OFFTOPIC_RULE}\n9. CRITICAL: Use proper SQL syntax - ensure spaces between all keywords\n10. Use single quotes for string literals (e.g., 'value' not "value")\n11. Column names are case-sensitive - match them exactly from the schema\n12. All SQL must be valid SQLite syntax\n13. Every column is stored as TEXT regardless of what it looks like. Before CAST()ing a column to a number (for ORDER BY, comparisons, math), wrap it in REPLACE(column, ',', '') in case it has thousands-separator commas (e.g. "1,200"), since CAST alone reads only the leading digit run and silently returns the wrong value\n\nBe concise, practical, and syntactically perfect.`;
    }

    // Updates state + toggle button UI + persists the preference. No other
    // side effects — switching mid-conversation doesn't touch chatHistory
    // or re-render the transcript, it only changes what system prompt the
    // *next* message sends.
    window.selectOutputMode = function(mode) {
      outputMode = mode;
      document.getElementById('output-mode-sql-btn').classList.toggle('is-active', mode === 'sql');
      document.getElementById('output-mode-general-btn').classList.toggle('is-active', mode === 'general');
      document.getElementById('output-mode-sql-btn').setAttribute('aria-selected', mode === 'sql');
      document.getElementById('output-mode-general-btn').setAttribute('aria-selected', mode === 'general');
      try {
        localStorage.setItem(OUTPUT_MODE_KEY, mode);
      } catch (err) {
        console.error('Failed to persist output mode:', err);
      }
    };

    function initOutputModePreference() {
      let saved = 'sql';
      try {
        saved = localStorage.getItem(OUTPUT_MODE_KEY) === 'general' ? 'general' : 'sql';
      } catch (err) {
        console.error('Failed to read saved output mode:', err);
      }
      selectOutputMode(saved);
    }

    function updateAIState() {
      const toggle = document.getElementById('ai-toggle');
      const toggleLabel = document.querySelector('.toggle-label');
      const chatInput = document.getElementById('chat-input');
      const chatSend = document.getElementById('chat-send');
      const chatMessages = document.getElementById('chat-messages');

      // Same "no tables loaded" gate #ai-toggle already runs on: the mode
      // toggle is meaningless until there's a schema to query.
      const outputModeSqlBtn = document.getElementById('output-mode-sql-btn');
      const outputModeGeneralBtn = document.getElementById('output-mode-general-btn');
      if (outputModeSqlBtn && outputModeGeneralBtn) {
        outputModeSqlBtn.disabled = !csvLoaded;
        outputModeGeneralBtn.disabled = !csvLoaded;
      }

      // /api/chat now requires a signed-in session (it spends the site's
      // own Groq budget, so it can no longer be left open to anyone).
      // Keep the toggle itself off and disabled until sign-in, rather than
      // letting someone flip it on and hit a confusing error on message 1.
      toggle.disabled = !currentUser;
      if (!currentUser && aiEnabled) {
        aiEnabled = false;
        toggle.checked = false;
      }

      if (aiEnabled && csvLoaded) {
        toggleLabel.textContent = 'ON';

        try {
          const perTable = tables.map(t => schemaTextFor(t.name));
          tableSchema = perTable.map(t => t.text).join('\n\n');

          // One mode-agnostic greeting — the old version was SQL-Mode-only
          // copy ("I can help you write SQL...") that made no sense once
          // General Mode existed too.
          const greeting = 'Use SQL mode to get query responses to use. Use General mode to ask questions about your data.';

          chatMessages.innerHTML = `<div class="chat-message assistant">${greeting}</div>`;

          chatInput.disabled = false;
          chatSend.disabled = false;
          chatInput.focus();

          chatHistory = [];
          updateCloudButtons();

        } catch (err) {
          console.error('Schema error:', err);
        }
      } else {
        toggleLabel.textContent = 'OFF';
        chatInput.disabled = true;
        chatSend.disabled = true;

        if (!currentUser) {
          chatMessages.innerHTML = '<div class="empty ai-disabled-msg">Sign in to use the AI assistant</div>';
        } else if (!csvLoaded) {
          chatMessages.innerHTML = '<div class="empty ai-disabled-msg">Upload a CSV first, then toggle AI ON to ask questions.</div>';
        } else {
          chatMessages.innerHTML = '<div class="empty ai-disabled-msg">AI assistant is disabled. Toggle it ON to ask SQL questions.</div>';
        }
      }
    }

    function updateLineNumbers() {
      const textarea = document.getElementById('query-input');
      const lineNumbers = document.getElementById('line-numbers');
      const lines = textarea.value.split('\n').length;
      lineNumbers.innerHTML = Array.from({length: lines}, (_, i) => i + 1).join('<br>');
    }

    // The textarea's own text is transparent (see #query-input CSS) — this
    // paints the same text, tokenized by highlightSQL(), on a <pre> layered
    // exactly behind it, so the editor shows live keyword/string/number
    // coloring without giving up native textarea editing/selection/undo.
    function updateQueryHighlight() {
      const textarea = document.getElementById('query-input');
      const code = document.getElementById('query-highlight-code');
      let html = highlightSQL(textarea.value);
      if (textarea.value.endsWith('\n')) html += '\n';
      code.innerHTML = html;
    }

    // The query box grows to fit what you type/load (up to a max height,
    // beyond which it scrolls normally) instead of staying a fixed size and
    // silently clipping content a manual resize handle doesn't fix, because
    // dragging that handle bigger doesn't reset the box's existing scroll
    // position back to the top.
    function autoGrowQueryInput(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(Math.max(el.scrollHeight, 120), 400) + 'px';
    }

    // Used after we set the query's value ourselves (loading a saved query,
    // inserting an AI suggestion, the initial default query) so the box
    // resizes to fit AND always shows the top of that query, rather than
    // keeping whatever scroll position was left over from before.
    function resetQueryInputView() {
      const textarea = document.getElementById('query-input');
      updateLineNumbers();
      updateQueryHighlight();
      autoGrowQueryInput(textarea);
      textarea.scrollTop = 0;
      document.getElementById('line-numbers').scrollTop = 0;
      document.getElementById('query-highlight').scrollTop = 0;
    }

    window.addEventListener('DOMContentLoaded', () => {
      const textarea = document.getElementById('query-input');

      textarea.addEventListener('input', () => {
        updateLineNumbers();
        updateQueryHighlight();
        autoGrowQueryInput(textarea);
      });
      textarea.addEventListener('scroll', () => {
        document.getElementById('line-numbers').scrollTop = textarea.scrollTop;
        const highlight = document.getElementById('query-highlight');
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
      });

      document.getElementById('ai-toggle').addEventListener('change', (e) => {
        aiEnabled = e.target.checked;
        updateAIState();
      });

      initOutputModePreference();

      const chatInputEl = document.getElementById('chat-input');
      chatInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      chatInputEl.addEventListener('input', () => autoGrowChatInput(chatInputEl));

      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
          if (btn.dataset.tab === 'relationships') {
            requestAnimationFrame(renderERD);
          }
        });
      });

      document.getElementById('table-search').addEventListener('input', (e) => tableSearch(e.target.value));

      document.getElementById('save-query-desc-input').addEventListener('input', (e) => {
        document.getElementById('save-query-desc-count').textContent = e.target.value.length;
      });

      document.getElementById('load-query-list').addEventListener('scroll', closeAllQueryMenus);

      document.getElementById('editor-results-resizer').addEventListener('mousedown', (e) => startPaneDrag(e, 'h'));
      document.getElementById('workspace-resizer').addEventListener('mousedown', (e) => startPaneDrag(e, 'v'));
      window.addEventListener('resize', clearPaneOverridesForMobile);

      ['landing-email', 'landing-password'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            landingAuthSubmit();
          }
        });
      });

      document.getElementById('auth-password').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          authPanelSubmit();
        }
      });

      updateLineNumbers();
    });

    function autoGrowChatInput(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }

    async function sendMessage() {
      if (!aiEnabled) {
        alert('Please enable the AI assistant toggle first');
        return;
      }

      const input = document.getElementById('chat-input');
      const message = input.value.trim();
      if (!message) return;

      const messagesDiv = document.getElementById('chat-messages');
      const replyContext = activeReplyContext;

      messagesDiv.innerHTML += `<div class="chat-message user">${renderUserMessage(message, replyContext ? replyContext.snippet : null)}</div>`;
      input.value = '';
      autoGrowChatInput(input);
      chatHistory.push({ role: 'user', content: message });
      updateCloudButtons();
      cancelReplyContext();

      // Cross-table AI is Premium-gated (see buildSystemPrompt). Without this,
      // a free account with 2+ tables silently got a narrower, single-table
      // answer with no indication why — surfacing it here instead so it reads
      // as "this needs Premium," not "the AI got it wrong."
      if (crossTableAIBlocked() && crossTableNoticeTableCount !== tables.length) {
        crossTableNoticeTableCount = tables.length;
        messagesDiv.innerHTML += `<div class="chat-turn assistant-turn"><div class="chat-message assistant chat-message-notice">This needs data from more than one table — that's a Premium feature. This answer will only use <strong>${escapeHtml(activeTableName)}</strong>. <a href="#" onclick="openPremiumPanel(); return false;">Unlock cross-table AI queries</a></div></div>`;
      }

      messagesDiv.innerHTML += `<div class="chat-turn assistant-turn"><div class="chat-message assistant">Thinking...</div></div>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

      try {
        const apiMessages = [
          {
            role: 'system',
            content: buildSystemPrompt()
          }
        ];

        if (replyContext) {
          apiMessages.push({ role: 'assistant', content: replyContext.fullText });
        }
        apiMessages.push({ role: 'user', content: message });

        // /api/chat requires a signed-in session — it spends the site's own
        // Groq budget, so it checks this bearer token server-side rather
        // than trusting anything the client claims.
        const { data: { session } } = sb ? await sb.auth.getSession() : { data: { session: null } };
        if (!session) {
          throw new Error('Please sign in to use the AI assistant.');
        }

        const response = await fetch(CHAT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: apiMessages,
            temperature: 0.3
          })
        });

        if (response.status === 429) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body?.error?.message || "You've used today's AI messages. Try again later.");
        }
        if (response.status === 401) {
          throw new Error('Your session expired. Sign in again to keep using the AI assistant.');
        }
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API returned ${response.status}: ${errorText}`);
        }

        const data = await response.json();

        if (data.error) {
          throw new Error(data.error.message);
        }

        const assistantMessage = data.choices[0].message.content;

        const lastTurn = messagesDiv.lastElementChild;
        lastTurn.innerHTML = renderAssistantMessage(assistantMessage);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        chatHistory.push({ role: 'assistant', content: assistantMessage });
        updateCloudButtons();

      } catch (err) {
        const lastTurn = messagesDiv.lastElementChild;
        const bubble = lastTurn.querySelector('.chat-message') || lastTurn;
        if (err.message.includes('Failed to fetch')) {
          bubble.innerHTML = `Error: Cannot reach ${CHAT_ENDPOINT}. If you're running locally, make sure \`vercel dev\` (or proxy-server.py) is running.`;
        } else {
          bubble.innerHTML = `Error: ${err.message}`;
        }
        bubble.style.background = '#dc2626';
      }
    }

    // Lightweight SQL syntax highlighter for chat code blocks — no library,
    // one regex pass tokenizing strings/identifiers/comments/keywords/
    // numbers in priority order (strings and quoted identifiers are matched
    // before the keyword alternative, so a keyword-looking word inside a
    // string is never re-highlighted). Escapes HTML first, then tokenizes
    // the already-escaped text, since none of the token patterns depend on
    // the characters `&`/`<`/`>` that escaping changes.
    const SQL_KEYWORDS = [
      'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON',
      'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS',
      'IN', 'LIKE', 'GLOB', 'BETWEEN', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
      'CREATE', 'TABLE', 'DROP', 'ALTER', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
      'UNION', 'ALL', 'EXISTS', 'DESC', 'ASC', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
      'DEFAULT', 'CAST', 'WITH', 'OVER', 'PARTITION', 'IF', 'USING', 'INDEX', 'VIEW', 'TRIGGER'
    ];

    const SQL_TOKEN_RE = new RegExp(
      `('(?:[^']|'')*')` +                        // 1: string literal
      `|("(?:[^"]|"")*")` +                        // 2: quoted identifier
      `|(--[^\\n]*)` +                              // 3: line comment
      `|\\b(${SQL_KEYWORDS.join('|')})\\b` +       // 4: keyword
      `|\\b(\\d+\\.?\\d*)\\b`,                     // 5: number
      'gi'
    );

    function highlightSQL(code) {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return escaped.replace(SQL_TOKEN_RE, (match, str, ident, comment, kw, num) => {
        if (str !== undefined) return `<span class="sql-tok-string">${match}</span>`;
        if (ident !== undefined) return `<span class="sql-tok-ident">${match}</span>`;
        if (comment !== undefined) return `<span class="sql-tok-comment">${match}</span>`;
        if (kw !== undefined) return `<span class="sql-tok-keyword">${match}</span>`;
        if (num !== undefined) return `<span class="sql-tok-number">${match}</span>`;
        return match;
      });
    }

    // Inline markdown-lite for a single (already HTML-escaped) line: bold
    // and inline code get their own accent colors — see .chat-em /
    // .chat-inline-code — instead of showing up as literal ** or ` marks.
    function renderInlineFormatting(line) {
      line = line.replace(/\*\*([^*]+)\*\*/g, '<strong class="chat-em">$1</strong>');
      line = line.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
      return line;
    }

    // Groups consecutive "- "/"* "/"1. " lines into real, indented <ul>/<ol>
    // lists (with colored markers) instead of leaving the raw bullet
    // characters as plain text — everything else keeps the old
    // newline-to-<br> behavior. Expects text already HTML-escaped.
    function renderProse(escapedText) {
      const lines = escapedText.split('\n');
      const htmlParts = [];
      let listBuffer = null; // { type: 'ul' | 'ol', items: [] }

      const flushList = () => {
        if (!listBuffer) return;
        const tag = listBuffer.type;
        htmlParts.push(`<${tag} class="chat-list">${listBuffer.items.map(item => `<li>${item}</li>`).join('')}</${tag}>`);
        listBuffer = null;
      };

      lines.forEach(line => {
        const bulletMatch = line.match(/^\s*[-*•]\s+(.*)$/);
        const numberedMatch = !bulletMatch && line.match(/^\s*\d+[.)]\s+(.*)$/);

        if (bulletMatch) {
          if (!listBuffer || listBuffer.type !== 'ul') { flushList(); listBuffer = { type: 'ul', items: [] }; }
          listBuffer.items.push(renderInlineFormatting(bulletMatch[1]));
        } else if (numberedMatch) {
          if (!listBuffer || listBuffer.type !== 'ol') { flushList(); listBuffer = { type: 'ol', items: [] }; }
          listBuffer.items.push(renderInlineFormatting(numberedMatch[1]));
        } else {
          flushList();
          htmlParts.push(line.trim() === '' ? '<br>' : renderInlineFormatting(line) + '<br>');
        }
      });
      flushList();

      return htmlParts.join('');
    }

    function formatMessage(text) {
      const msgId = 'msg-' + Math.random().toString(36).substr(2, 9);

      // Extract SQL blocks first and store them separately
      const sqlBlocks = [];
      text = text.replace(/```sql\n([\s\S]*?)```/g, (match, code) => {
        const id = 'code-' + Math.random().toString(36).substr(2, 9);
        const cleanCode = code.trim();
        sqlBlocks.push({ id, code: cleanCode });
        return `__SQL_BLOCK_${id}__`;
      });

      // Extract regular code blocks the same way — rendered further down,
      // after the prose in between has been escaped and formatted.
      const codeBlocks = [];
      text = text.replace(/```\n([\s\S]*?)```/g, (match, code) => {
        const id = 'code-' + Math.random().toString(36).substr(2, 9);
        codeBlocks.push({ id, code: code.trim() });
        return `__CODE_BLOCK_${id}__`;
      });

      // Everything left is prose. Escape it first — this is model output,
      // not markup we wrote — then layer bold/inline-code/list formatting
      // on top of the now-safe text.
      text = renderProse(escapeHtml(text));

      codeBlocks.forEach(({ id, code }) => {
        const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        text = text.replace(`__CODE_BLOCK_${id}__`, `<pre id="${id}"><code>${escaped}</code></pre>`);
      });

      // Now replace SQL block placeholders with formatted HTML
      sqlBlocks.forEach(({ id, code }) => {
        const escapedCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '\\n');
        const displayCode = highlightSQL(code);
        text = text.replace(
          `__SQL_BLOCK_${id}__`,
          `<pre id="${id}"><code data-sql="${escapedCode}">${displayCode}</code><button class="use-query-btn" onclick="insertQuery('${id}')">Use Query</button></pre>`
        );
      });

      return `<div id="${msgId}" class="message-content">${text}</div><button class="copy-message-btn" onclick="copyMessage('${msgId}')" title="Copy message">📋</button>`;
    }

    // ---- Reply-to-a-response: quote a prior AI answer as context for a follow-up ----

    let activeReplyContext = null; // { fullText, snippet }

    function truncateForQuote(text, max = 180) {
      const clean = text.trim();
      return clean.length > max ? clean.slice(0, max).trim() + '…' : clean;
    }

    // Strips markdown code fences for the human-readable quote preview only
    // (the composer bar + the sent bubble). The unmodified original text is
    // what actually gets sent back to the AI as context, via fullText.
    function cleanQuoteText(text) {
      return text
        .replace(/```sql\n?([\s\S]*?)```/g, (m, code) => code.trim())
        .replace(/```\n?([\s\S]*?)```/g, (m, code) => code.trim())
        .trim();
    }

    function renderAssistantMessage(content) {
      return `<div class="chat-message assistant">${formatMessage(content)}</div>
        <div class="message-below-actions">
          <button type="button" class="reply-btn" data-raw="${encodeURIComponent(content)}" onclick="startReplyToMessage(this)" title="Reply to this answer">↩ Reply</button>
        </div>`;
    }

    function renderUserMessage(content, quoteSnippet) {
      const quoteHtml = quoteSnippet
        ? `<div class="reply-quote">${escapeHtml(quoteSnippet)}</div>`
        : '';
      return `${quoteHtml}${escapeHtml(content).replace(/\n/g, '<br>')}`;
    }

    window.startReplyToMessage = function(btn) {
      const raw = decodeURIComponent(btn.dataset.raw || '');
      if (!raw) return;
      activeReplyContext = { fullText: raw, snippet: truncateForQuote(cleanQuoteText(raw)) };
      document.getElementById('reply-context-text').textContent = activeReplyContext.snippet;
      document.getElementById('reply-context-bar').hidden = false;
      const input = document.getElementById('chat-input');
      if (!input.disabled) input.focus();
    };

    window.cancelReplyContext = function() {
      activeReplyContext = null;
      document.getElementById('reply-context-bar').hidden = true;
    };

    window.clearChatSession = function() {
      cancelReplyContext();
      chatHistory = [];
      updateAIState();
    };

    window.copyMessage = function(msgId) {
      const msgDiv = document.getElementById(msgId);
      let text = msgDiv.innerText || msgDiv.textContent;

      text = text.replace(/Use Query/g, '').trim();
      navigator.clipboard.writeText(text);

      const btn = event.target;
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = '📋';
        btn.classList.remove('copied');
      }, 2000);
    };

    window.insertQuery = function(id) {
      const pre = document.getElementById(id);
      const codeEl = pre.querySelector('code[data-sql]');

      if (codeEl) {
        const escapedCode = codeEl.getAttribute('data-sql');
        const code = escapedCode
          .replace(/\\n/g, '\n')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        document.getElementById('query-input').value = code;
      } else {
        const code = pre.querySelector('code').textContent.trim();
        document.getElementById('query-input').value = code;
      }

      resetQueryInputView();
      document.getElementById('query-input').focus();
    };

