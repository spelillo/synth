# Output Mode (SQL / General) — Spec

Not implemented yet. This is a planning doc for the next pass at the AI assistant, written up after a pressure-testing session surfaced a real bug in how the assistant handles off-topic questions.

## The bug this is fixing

Asking the assistant something unrelated to the data — "how is your day" — didn't get a plain answer, a refusal, or an error. It got:

```sql
SELECT 'I am fine, thank you!' AS response;
```

That's not a hallucination glitch, it's the system prompt working exactly as written. [`buildSystemPrompt()`](synth.html:2229) (single-table path, [synth.html:2230](synth.html:2230); multi-table path, [synth.html:2239](synth.html:2239)) both end every prompt with the same rule set, including:

```
6. Never suggest anything other than SQL queries
7. If asked about non-SQL topics, redirect to SQL help
```

Rule 7 says "redirect" but gives the model no way to do that except through a SQL statement — rule 6 already forbids anything else, and [`formatMessage()`](synth.html:2464) only specially renders text wrapped in a ` ```sql ` fence, so a real refusal sentence would just show up as a plain, orphaned line, not a "Use Query" block. Under those constraints, the model's most rule-compliant move for an off-topic question is exactly what it did: invent a `SELECT` that echoes a conversational reply as a string literal. Right output for a badly-specified problem.

## What's actually being asked for

Two related things, one now and one later:

1. **A real guardrail**: an off-topic question should get an honest, on-brand message saying this assistant only answers questions about the loaded data — not a fabricated `SELECT` pretending to be a chat reply.
2. **Long-term, a proper two-mode assistant**: a toggle between **SQL Mode** (today's behavior — every reply is a runnable query) and **General Mode** (plain-English answers about the data — "what does this table look like", "any outliers in this column" — with no SQL forced, and no SQL guardrail either, since a general question isn't off-topic in that mode).

The guardrail alone (#1) is really just SQL Mode's half of #2 done properly. So this spec designs the full toggle; a SQL-Mode-only guardrail is what "proceed with the first one" (the syntax highlighting, already shipped) left for next.

## Design

### UI: a second toggle next to the existing ON/OFF one

The AI panel already has one binary toggle — `#ai-toggle`, enable/disable the whole assistant ([synth.html:5555-5559](synth.html:5555), state in `aiEnabled`, wired in [`updateAIState()`](synth.html:2243)). Output Mode is a second, independent toggle living in the same `.ai-header-actions` row, styled as a 2-position segmented control (reuse the `.landing-mode-toggle`/`.landing-mode-btn` pattern already in the codebase for Lite/Normal Mode — same visual language, no new component to invent):

```html
<div class="output-mode-toggle" role="tablist" aria-label="Output mode">
  <button type="button" class="output-mode-btn is-active" id="output-mode-sql-btn"
          onclick="selectOutputMode('sql')" role="tab" aria-selected="true">SQL</button>
  <button type="button" class="output-mode-btn" id="output-mode-general-btn"
          onclick="selectOutputMode('general')" role="tab" aria-selected="false">General</button>
</div>
```

Defaults to `sql` (today's behavior, zero surprise for existing users). State lives in a new top-level `let outputMode = 'sql';` next to `aiEnabled` ([synth.html:33](synth.html:33)) — session-only, same lifetime as `aiEnabled` itself (not persisted to `chat_sessions` on save/load; reopening a saved session should not need to guess which mode produced which message, since mode is a per-turn input, not a property of the transcript — see Edge cases).

### System prompt: branch on `outputMode`, not just table count

`buildSystemPrompt()` currently branches once, on `tables.length <= 1` vs multi-table. Output Mode adds an orthogonal second axis. Cleanest shape: keep the existing single/multi-table schema-building logic exactly as is (`tableSchema`, `focusNote`, `relationshipNote` all stay useful in both modes — a general question about "which tables relate to which" still needs the schema and relationship hints), and swap only the trailing rules block based on `outputMode`:

**SQL Mode** (today's rules, unchanged) — plus a real instruction for off-topic input, replacing the toothless rule 7:

```
7. If the question is not about the loaded data, do not write SQL for it. Reply with exactly one line, in plain text, no code fence: "I can only help with questions about your data — try asking about specific rows, columns, or aggregates."
```

**General Mode** — a different rule block entirely:

```
You are a data analyst assistant. The user has loaded the schema above and wants plain-English answers, not SQL.
1. Never write SQL or use ```sql code fences — describe things in words.
2. Ground every answer in the actual schema/columns above; don't invent columns or guess at data you can't see.
3. If the question needs an actual computed answer from the data itself (not just schema — "what's the average of X"), say plainly that you can't compute it without running a query, and suggest switching to SQL Mode to get the query for it.
4. Keep answers concise — a few sentences, not an essay.
```

Rule 3 matters: General Mode still can't see actual row values (the model only ever gets schema text, same as today — `db` never leaves the browser), so it has to be honest about that boundary instead of confabulating numbers. This is the same "don't hallucinate data" discipline SQL Mode gets for free by only ever emitting queries.

### Chat rendering: General Mode replies need a path with no SQL block

`formatMessage()` ([synth.html:2497](synth.html:2497)) already handles plain non-code text fine (paragraph text, `<br>`-joined) — General Mode replies need no new rendering, they just won't contain a ` ```sql ` fence, so no "Use Query" button appears, which is correct (there's no query to use). No code change needed here beyond what SQL Mode's guardrail message already exercises (a plain-text assistant reply with no code block is an existing, working path).

### Switching modes mid-conversation

Switching the toggle doesn't touch `chatHistory` or clear the transcript — it only changes what system prompt the *next* message sends. A transcript can legitimately mix a SQL Mode query with a General Mode explanation of it a message later; that's a feature (ask for a query, switch to General, ask "what does this actually do"), not a bug to guard against.

## Requirements

- [ ] `outputMode` state (`'sql' | 'general'`), default `'sql'`, alongside `aiEnabled`.
- [ ] `.output-mode-toggle` UI in `.ai-header-actions`, mirroring the `.landing-mode-toggle` visual pattern.
- [ ] `selectOutputMode(mode)` — updates state + toggle button `.is-active`/`aria-selected`, no other side effects (no chat clear, no re-render of history).
- [ ] `buildSystemPrompt()` branches its trailing rules block on `outputMode`; schema/focus/relationship sections stay shared.
- [ ] SQL Mode off-topic guardrail: a fixed, predictable refusal sentence — not a fabricated query — verified with the exact "how is your day" case from this session as a regression check.
- [ ] General Mode: verified it never emits a ` ```sql ` fence even when asked a very leading question ("write me a query for..." while in General Mode should redirect to switching modes, not silently comply).
- [ ] Toggle is disabled/hidden under the same conditions `#ai-toggle` already is (no tables loaded) — reuse the existing `csvLoaded` gate in `updateAIState()`.

## Open questions (need a decision before building)

- Should switching to General Mode grey out / hide the "Use Query" affordance messaging anywhere, or is "it just won't appear" sufficient?
- Does General Mode's chat greeting (`updateAIState()`'s `greeting` text, [synth.html:2257](synth.html:2257)) need its own copy, since today's greeting ("I can help you write SQL...") is SQL-Mode-flavored?
- Worth a small persisted preference (localStorage) for `outputMode`, the way saved queries persist per-browser, so it doesn't reset to SQL every reload? Leaning yes, but out of scope to decide unilaterally.

## Out of scope for this spec

- Actually building any of the above — this is the plan, not the PR.
- Changing the Groq model, temperature, or endpoint ([`api/chat.js`](api/chat.js)) — General Mode is a prompt change, not an infra change.
- Retroactively re-labeling old saved chat messages with which mode produced them.
