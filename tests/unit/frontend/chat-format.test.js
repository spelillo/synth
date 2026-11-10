// Unit tests for chat.js's message rendering. Model output is untrusted
// text: these check it is escaped before any formatting is layered on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('../../helpers/browser-env');

const env = loadBrowserScripts(['state.js', 'grid.js', 'chat.js']);
const fn = name => env.get(name);

test('highlightSQL: wraps keywords, strings, identifiers, numbers and comments', () => {
  const h = fn('highlightSQL')(`SELECT "Name", 'x' FROM t WHERE n > 10 -- note`);
  assert.match(h, /<span class="sql-tok-keyword">SELECT<\/span>/);
  assert.match(h, /<span class="sql-tok-ident">"Name"<\/span>/);
  assert.match(h, /<span class="sql-tok-string">'x'<\/span>/);
  assert.match(h, /<span class="sql-tok-number">10<\/span>/);
  assert.match(h, /<span class="sql-tok-comment">-- note<\/span>/);
  assert.match(h, /&gt;/);
});

test('highlightSQL: keywords inside strings are not highlighted', () => {
  const h = fn('highlightSQL')(`SELECT 'from where'`);
  assert.equal((h.match(/sql-tok-keyword/g) || []).length, 1);
});

test('highlightSQL: escapes HTML', () => {
  assert.doesNotMatch(fn('highlightSQL')('<img src=x onerror=alert(1)>'), /<img/);
});

test('renderInlineFormatting: **bold** and `code`', () => {
  assert.equal(fn('renderInlineFormatting')('a **b** `c`'), 'a <strong class="chat-em">b</strong> <code class="chat-inline-code">c</code>');
});

test('renderProse: groups bullets and numbered lines into lists', () => {
  const html = fn('renderProse')('Intro\n- one\n- two\n1. first\n2. second\nend');
  assert.match(html, /<ul class="chat-list"><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol class="chat-list"><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /^Intro<br>/);
});

test('formatMessage: a ```sql block gets a Use Query button with the raw SQL in data-sql', () => {
  const html = fn('formatMessage')("Try this:\n```sql\nSELECT * FROM t WHERE a = 'x';\n```");
  assert.match(html, /class="use-query-btn"/);
  assert.match(html, /data-sql="SELECT \* FROM t WHERE a = &#39;x&#39;;"/);
});

test('formatMessage: HTML in model prose is escaped (XSS)', () => {
  const html = fn('formatMessage')('<img src=x onerror="alert(1)"> **hi**');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<strong class="chat-em">hi<\/strong>/);
});

test('formatMessage: HTML inside a sql block cannot break out of the attribute', () => {
  const html = fn('formatMessage')('```sql\nSELECT "\\"><script>x</script>"\n```');
  assert.doesNotMatch(html, /<script>/);
});

test('formatMessage: a plain ``` code block is escaped and has no Use Query button', () => {
  const html = fn('formatMessage')('```\n<b>raw</b>\n```');
  assert.match(html, /<pre id="code-[a-z0-9]+"><code>&lt;b&gt;raw&lt;\/b&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /use-query-btn/);
});

test('truncateForQuote: trims and adds an ellipsis past the limit', () => {
  const t = fn('truncateForQuote');
  assert.equal(t('  short  '), 'short');
  assert.equal(t('x'.repeat(200), 10), 'xxxxxxxxxx…');
});

test('cleanQuoteText: strips code fences but keeps the code', () => {
  assert.equal(fn('cleanQuoteText')('Use\n```sql\nSELECT 1\n```'), 'Use\nSELECT 1');
});

test('renderAssistantMessage: carries the raw content URL-encoded for Reply', () => {
  const html = fn('renderAssistantMessage')('a "quoted" <b>');
  assert.match(html, /data-raw="a%20%22quoted%22%20%3Cb%3E"/);
});
