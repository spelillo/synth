// learn-grader.js — runs a learner's query and decides whether it answers
// the lesson, with feedback specific enough to act on.
//
// Grading is result-based, the way DataCamp and most interactive SQL
// courses do it: the learner's query and the lesson's reference solution
// run against the same freshly loaded tables, and the two result sets are
// compared. Any query that produces the right rows passes, however it's
// written, unless a lesson is specifically practicing a construct
// (mustUse), in which case the right answer by another route gets a
// "right result, now try it with X" nudge instead of a pass.
//
// When results differ, the grader works out *how* they differ (wrong
// column count, missing alias, too many rows, duplicates, wrong order,
// values off only by rounding, integer division...) and turns that into a
// message. SQL errors are translated too: "no such column: categroy"
// becomes "There's no column named categroy. Did you mean category?".
//
// Pure functions over a sql.js Database: no DOM, so the Node test suite
// exercises exactly the code the browser runs.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LearnGrader = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- SQL text helpers ----

  // Blanks out comments and string literals (keeping length/positions) so
  // keyword checks never match inside 'a string' or a -- comment.
  function maskSql(sql) {
    let out = '';
    let i = 0;
    while (i < sql.length) {
      const ch = sql[i];
      const next = sql[i + 1];
      if (ch === '-' && next === '-') {
        while (i < sql.length && sql[i] !== '\n') { out += ' '; i++; }
      } else if (ch === '/' && next === '*') {
        out += '  '; i += 2;
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i] === '\n' ? '\n' : ' '; i++; }
        if (i < sql.length) { out += '  '; i += 2; }
      } else if (ch === "'") {
        out += "'"; i++;
        while (i < sql.length) {
          if (sql[i] === "'" && sql[i + 1] === "'") { out += '  '; i += 2; continue; }
          if (sql[i] === "'") break;
          out += ' '; i++;
        }
        if (i < sql.length) { out += "'"; i++; }
      } else {
        out += ch; i++;
      }
    }
    return out;
  }

  // Splits on top-level semicolons (masked text, so a ';' in a string
  // doesn't count) and drops empty statements.
  function splitStatements(sql) {
    const masked = maskSql(sql);
    const parts = [];
    let start = 0;
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] === ';') { parts.push(sql.slice(start, i)); start = i + 1; }
    }
    parts.push(sql.slice(start));
    return parts.filter(p => maskSql(p).trim() !== '');
  }

  // Removes every OVER (...) clause so an ORDER BY inside a window
  // function doesn't make a lesson's row order count.
  function stripWindowClauses(maskedSql) {
    let out = maskedSql;
    const re = /\bOVER\s*\(/i;
    let m;
    while ((m = re.exec(out))) {
      let depth = 0;
      let j = m.index + m[0].length - 1;
      for (; j < out.length; j++) {
        if (out[j] === '(') depth++;
        else if (out[j] === ')') { depth--; if (depth === 0) break; }
      }
      out = out.slice(0, m.index) + out.slice(j + 1);
    }
    return out;
  }

  // Row order only matters if the reference solution's outermost query
  // sorts. ORDER BY inside OVER() or inside a parenthesized subquery
  // doesn't count.
  function defaultOrderMatters(solutionSql) {
    let masked = stripWindowClauses(maskSql(solutionSql));
    // Collapse parenthesized groups so only top-level clauses remain.
    let prev;
    do { prev = masked; masked = masked.replace(/\([^()]*\)/g, ' '); } while (masked !== prev);
    return /\bORDER\s+BY\b/i.test(masked);
  }

  // Statements that change data or the connection. Checked on the first
  // word of each statement; REPLACE and END only there, because they're
  // also a string function and the end of a CASE expression.
  const WRITE_STARTS = /^(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|PRAGMA|BEGIN|END|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)$/i;
  const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM|REINDEX|PRAGMA|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

  // Lessons are read-only so the data stays identical for every attempt
  // (and so the comparison against the reference solution stays fair).
  // Anything else, typos included, goes to SQLite so its error can be
  // explained.
  function readOnlyProblem(sql) {
    for (const stmt of splitStatements(sql)) {
      const masked = maskSql(stmt);
      const first = (masked.trim().match(/^[A-Za-z]+/) || [''])[0];
      if (WRITE_STARTS.test(first)) {
        return `Lessons only run read queries, and \`${first.toUpperCase()}\` would change the data. Start your query with \`SELECT\` (or \`WITH\` for a CTE).`;
      }
      const write = masked.match(WRITE_KEYWORDS);
      if (write) {
        return `Lessons only run read queries, so \`${write[1].toUpperCase()}\` isn't allowed here. The lesson data stays the same for every attempt.`;
      }
    }
    return null;
  }

  // ---- Running a query ----

  // Runs every statement and returns the last one that produced columns.
  // Uses prepared statements rather than db.exec() because exec() drops a
  // zero-row result entirely, column names and all, and "your query
  // returned no rows (but here are your columns)" is useful feedback.
  // Wrapped in a savepoint that's always rolled back: defense in depth
  // behind readOnlyProblem().
  function runQuery(db, sql) {
    const problem = readOnlyProblem(sql);
    if (problem) {
      const err = new Error(problem);
      err.learnReadOnly = true;
      throw err;
    }
    let result = null;
    let statementCount = 0;
    db.run('SAVEPOINT learn_attempt');
    try {
      for (const stmt of db.iterateStatements(sql)) {
        statementCount++;
        try {
          const columns = stmt.getColumnNames();
          const rows = [];
          while (stmt.step()) rows.push(stmt.get());
          if (columns.length) result = { columns, rows };
        } finally {
          stmt.free();
        }
      }
    } finally {
      db.run('ROLLBACK TO learn_attempt');
      db.run('RELEASE learn_attempt');
    }
    if (!result) result = { columns: [], rows: [] };
    result.statementCount = statementCount;
    return result;
  }

  // ---- Value comparison ----

  const NUMERIC_TEXT = /^\s*-?\d+(\.\d+)?\s*$/;

  function normValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string') return NUMERIC_TEXT.test(v) ? Number(v) : v;
    if (typeof Uint8Array !== 'undefined' && v instanceof Uint8Array) return `[blob ${v.length}]`;
    return String(v);
  }

  const REL_TOLERANCE = 1e-6;

  function valuesEqual(a, b) {
    a = normValue(a); b = normValue(b);
    if (a === null || b === null) return a === b;
    if (typeof a === 'number' && typeof b === 'number') {
      return Math.abs(a - b) <= REL_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
    }
    return String(a) === String(b);
  }

  function valueKey(v) {
    v = normValue(v);
    if (v === null) return 'null';
    if (typeof v === 'number') return 'n:' + (Math.round(v * 1e4) / 1e4);
    return 's:' + v;
  }

  function rowKey(row) {
    return row.map(valueKey).join('␟');
  }

  function countKeys(rows) {
    const m = new Map();
    rows.forEach(r => { const k = rowKey(r); m.set(k, (m.get(k) || 0) + 1); });
    return m;
  }

  // a ⊆ b as multisets.
  function isSubMultiset(a, b) {
    for (const [k, n] of a) if ((b.get(k) || 0) < n) return false;
    return true;
  }

  function sameMultiset(a, b) {
    if (a.size !== b.size) return false;
    return isSubMultiset(a, b) && isSubMultiset(b, a);
  }

  function decimalsOf(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
    const s = String(n);
    if (s.includes('e')) return 0;
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
  }

  function roundTo(n, d) {
    const f = Math.pow(10, d);
    return Math.round(n * f) / f;
  }

  function formatValue(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(roundTo(v, 6));
    return `'${v}'`;
  }

  function listNames(names) {
    const q = names.map(n => `\`${n}\``);
    if (q.length <= 1) return q.join('');
    return q.slice(0, -1).join(', ') + ' and ' + q[q.length - 1];
  }

  function plural(n, word, pluralWord) {
    return `${n} ${n === 1 ? word : (pluralWord || word + 's')}`;
  }

  // ---- Common-mistake detectors ("smells") ----
  // Checked on a wrong answer to add a targeted tip. Run on masked SQL.

  const SMELLS = [
    { re: /(=|!=|<>)\s*NULL\b/i, tip: '`= NULL` is never true in SQL, because NULL means "unknown". Use `IS NULL` or `IS NOT NULL` instead.' },
    { re: /\bLIKE\s+'[^'%_]*'/i, tip: '`LIKE` without a `%` or `_` wildcard only matches the exact text. Add `%` where any characters can appear, e.g. `LIKE \'%Cheese%\'`.' },
    { re: /\bNOT\s+IN\s*\(\s*SELECT\b/i, tip: '`NOT IN (SELECT ...)` returns no rows at all if the subquery produces even one NULL. `NOT EXISTS` or a `LEFT JOIN ... IS NULL` doesn\'t have that problem.' },
    { re: /\bCOUNT\s*\(\s*DISTINCT\s*\*\s*\)/i, tip: '`COUNT(DISTINCT *)` isn\'t valid. Name the column to count distinct values of, e.g. `COUNT(DISTINCT category)`.' },
  ];

  function smellTips(sql) {
    const masked = maskSql(sql);
    return SMELLS.filter(s => s.re.test(masked)).map(s => s.tip);
  }

  // ---- Error translation ----

  // Edit distance where swapping two neighbouring letters counts as one
  // edit (optimal string alignment), so "nmae" is one typo from "name".
  function levenshtein(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  function closest(word, candidates) {
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = c.toLowerCase() === word.toLowerCase() ? 0 : levenshtein(word, c);
      if (d < bestDist) { best = c; bestDist = d; }
    }
    const limit = word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3;
    return bestDist <= limit ? best : null;
  }

  const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'BY', 'HAVING', 'LIMIT', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'EXISTS', 'DESC', 'ASC', 'WITH', 'OVER', 'PARTITION', 'OFFSET', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'ROUND', 'COALESCE'];

  // SQL Server / MySQL / Postgres habits that SQLite spells differently.
  const FUNCTION_ALTERNATIVES = {
    len: '`LENGTH(text)`',
    datalength: '`LENGTH(text)`',
    isnull: '`IFNULL(value, fallback)` or `COALESCE(value, fallback)`',
    nvl: '`COALESCE(value, fallback)`',
    concat: 'the `||` operator, e.g. `first_name || \' \' || last_name`',
    concat_ws: 'the `||` operator, e.g. `first_name || \' \' || last_name`',
    string_agg: '`GROUP_CONCAT(column, \', \')`',
    listagg: '`GROUP_CONCAT(column, \', \')`',
    getdate: '`DATE(\'now\')` or `DATETIME(\'now\')`',
    now: '`DATETIME(\'now\')`',
    curdate: '`DATE(\'now\')`',
    year: '`STRFTIME(\'%Y\', date_column)`',
    month: '`STRFTIME(\'%m\', date_column)`',
    day: '`STRFTIME(\'%d\', date_column)`',
    datepart: '`STRFTIME()`, e.g. `STRFTIME(\'%Y\', date_column)` for the year',
    date_part: '`STRFTIME()`, e.g. `STRFTIME(\'%Y\', date_column)` for the year',
    extract: '`STRFTIME()`, e.g. `STRFTIME(\'%m\', date_column)` for the month',
    date_trunc: '`STRFTIME(\'%Y-%m\', date_column)` to group by month',
    datediff: '`JULIANDAY(end_date) - JULIANDAY(start_date)` for a difference in days',
    to_char: '`STRFTIME()` for dates or `PRINTF()` for numbers',
    if: '`IIF(condition, then, else)` or a `CASE WHEN` expression',
    ceiling: '`CAST(x + 0.999999 AS INTEGER)` (SQLite has no CEILING here)',
    ceil: '`CAST(x + 0.999999 AS INTEGER)` (SQLite has no CEIL here)',
    floor: '`CAST(x AS INTEGER)` for positive numbers',
    trunc: '`CAST(x AS INTEGER)`',
    top: '`LIMIT n` at the end of the query',
  };

  const CLAUSE_ORDER = 'Clauses always go in this order: `SELECT` … `FROM` … `JOIN` … `WHERE` … `GROUP BY` … `HAVING` … `ORDER BY` … `LIMIT`.';

  // Finds the first top-level clause that appears after one that should
  // follow it (e.g. WHERE after GROUP BY).
  function clauseOrderProblem(masked) {
    const order = [
      ['WHERE', /\bWHERE\b/i],
      ['GROUP BY', /\bGROUP\s+BY\b/i],
      ['HAVING', /\bHAVING\b/i],
      ['ORDER BY', /\bORDER\s+BY\b/i],
      ['LIMIT', /\bLIMIT\b/i],
    ];
    let flat = stripWindowClauses(masked);
    let prev;
    do { prev = flat; flat = flat.replace(/\([^()]*\)/g, ' '); } while (flat !== prev);
    const found = order.map(([name, re]) => { const m = re.exec(flat); return m ? { name, index: m.index } : null; }).filter(Boolean);
    for (let i = 1; i < found.length; i++) {
      if (found[i].index < found[i - 1].index) return { early: found[i - 1].name, late: found[i].name };
    }
    return null;
  }

  // Table names and aliases a query defines in FROM / JOIN, lowercased:
  // "FROM books AS b JOIN authors a" gives books, b, authors, a.
  function queryTableNames(masked) {
    const names = new Set();
    const re = /\b(?:FROM|JOIN)\s+([A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
    let m;
    while ((m = re.exec(masked))) {
      names.add(m[1].toLowerCase());
      if (m[2] && !KEYWORDS.includes(m[2].toUpperCase())) names.add(m[2].toLowerCase());
    }
    // CTE names: WITH name AS (...), name2 AS (...)
    const cte = /(?:\bWITH|,)\s*([A-Za-z_]\w*)\s+AS\s*\(/gi;
    while ((m = cte.exec(masked))) names.add(m[1].toLowerCase());
    return names;
  }

  // Turns a SQLite error into { title, message, tip }. `ctx.tables` is
  // [{ name, columns: [...] }] for the tables loaded in this lesson.
  function explainError(rawMessage, sql, ctx) {
    const message = String(rawMessage || '').replace(/^Error:\s*/, '');
    const tables = (ctx && ctx.tables) || [];
    const allColumns = [...new Set(tables.flatMap(t => t.columns))];
    const tableNames = tables.map(t => t.name);
    const masked = maskSql(sql || '');
    let m;

    if ((m = message.match(/^no such column: (.+)$/))) {
      const name = m[1].trim();
      const bare = name.includes('.') ? name.split('.').pop() : name;
      const prefix = name.includes('.') ? name.split('.')[0] : null;
      const guess = closest(bare, allColumns);
      let tip;
      if (prefix && !queryTableNames(masked).has(prefix.toLowerCase())) {
        tip = `\`${prefix}\` isn't a table or alias in this query. Define the alias in FROM or JOIN, e.g. \`FROM books AS ${prefix}\`.`;
      } else if (guess && guess !== bare) {
        tip = `Did you mean \`${prefix ? prefix + '.' : ''}${guess}\`? Column names have to match exactly.`;
      } else if (guess === bare && prefix) {
        const owner = tables.find(t => t.columns.includes(bare));
        tip = owner ? `\`${bare}\` exists, but not on \`${prefix}\`. It's a column of \`${owner.name}\`.` : null;
      } else if (/^[A-Z][a-z]+$/.test(bare) || /\s/.test(bare)) {
        tip = `If \`${bare}\` is a value rather than a column, put it in single quotes: \`'${bare}'\`.`;
      }
      return {
        title: 'Unknown column',
        message: `There's no column named \`${name}\` in this lesson's tables.`,
        tip: tip || (allColumns.length ? `Available columns: ${allColumns.map(c => `\`${c}\``).join(', ')}.` : null),
      };
    }

    if ((m = message.match(/^no such table: (.+)$/))) {
      const name = m[1].trim();
      const guess = closest(name.replace(/^main\./, ''), tableNames);
      return {
        title: 'Unknown table',
        message: `There's no table named \`${name}\` in this lesson.`,
        tip: guess ? `Did you mean \`${guess}\`?` : `Tables you can use here: ${tableNames.map(t => `\`${t}\``).join(', ')}.`,
      };
    }

    if ((m = message.match(/^ambiguous column name: (.+)$/))) {
      const name = m[1].trim();
      const owners = tables.filter(t => t.columns.includes(name)).map(t => t.name);
      return {
        title: 'Ambiguous column',
        message: `\`${name}\` exists in more than one table${owners.length ? ` (${owners.join(', ')})` : ''}, so SQLite can't tell which one you mean.`,
        tip: `Prefix it with the table name or alias, e.g. \`${owners[0] || 'table'}.${name}\`.`,
      };
    }

    if ((m = message.match(/^no such function: (.+)$/))) {
      const fn = m[1].trim();
      const alt = FUNCTION_ALTERNATIVES[fn.toLowerCase()];
      return {
        title: 'Unknown function',
        message: `SQLite doesn't have a \`${fn.toUpperCase()}()\` function.`,
        tip: alt ? `In SQLite, use ${alt}.` : 'Check the spelling, or see the lesson for the function this task needs.',
      };
    }

    if ((m = message.match(/^misuse of aggregate:? (.+?)\(?\)?$/)) || /^misuse of aggregate/.test(message)) {
      return {
        title: 'Aggregate in the wrong place',
        message: 'Aggregate functions like `SUM()` or `COUNT()` can\'t be used in `WHERE`, because `WHERE` filters rows before any grouping happens.',
        tip: 'To filter on an aggregate, move the condition to `HAVING`, after `GROUP BY`.',
      };
    }

    if (/^misuse of window function/.test(message)) {
      return {
        title: 'Window function in the wrong place',
        message: 'Window functions are calculated after `WHERE`, `GROUP BY` and `HAVING`, so they can\'t be used inside those clauses.',
        tip: 'Compute the window function in a CTE or subquery first, then filter on it in the outer query.',
      };
    }

    if (/HAVING clause on a non-aggregate query|a GROUP BY clause is required before HAVING/.test(message)) {
      return {
        title: 'HAVING without GROUP BY',
        message: '`HAVING` filters groups, so it needs a `GROUP BY` before it.',
        tip: 'If you meant to filter individual rows, use `WHERE` instead.',
      };
    }

    if ((m = message.match(/^wrong number of arguments to function (.+?)\(\)$/))) {
      return {
        title: 'Wrong number of arguments',
        message: `\`${m[1].toUpperCase()}()\` was called with the wrong number of arguments.`,
        tip: m[1].toLowerCase() === 'round' ? '`ROUND(value, decimals)`: for example `ROUND(AVG(price), 2)`.' : 'Check the lesson example for how this function is called.',
      };
    }

    if (/^incomplete input$/.test(message)) {
      const opens = (masked.match(/\(/g) || []).length;
      const closes = (masked.match(/\)/g) || []).length;
      return {
        title: 'Query ends too early',
        message: 'SQLite reached the end of your query while it was still expecting more.',
        tip: opens > closes ? `You have ${opens - closes} unclosed \`(\`. Add the matching \`)\`.`
          : /\b(FROM|WHERE|BY|AND|OR|ON|JOIN|SELECT|HAVING)\s*$/i.test(masked.trim()) ? 'Your query ends with a keyword. Finish that clause.'
          : 'Look for an unfinished clause or a missing closing parenthesis.',
      };
    }

    if ((m = message.match(/^unrecognized token: "(.*)"$/))) {
      return {
        title: 'Unclosed quote',
        message: 'SQLite found the start of a string that never ends.',
        tip: 'Close every text value with a matching single quote, e.g. `\'Produce\'`. To put an apostrophe inside a string, double it: `\'O\'\'Brien\'`.',
      };
    }

    if (/^sub-select returns \d+ columns - expected 1$/.test(message) || /row value misused/.test(message)) {
      return {
        title: 'Subquery returns too many columns',
        message: 'A subquery used with `IN` or a comparison has to return exactly one column.',
        tip: 'Select just the one column you\'re comparing against inside the subquery.',
      };
    }

    if (/SELECTs to the left and right of UNION do not have the same number of result columns/.test(message)) {
      return {
        title: 'UNION column mismatch',
        message: 'Both sides of `UNION` must return the same number of columns.',
        tip: 'Make the two SELECT lists line up column for column.',
      };
    }

    if ((m = message.match(/^near "(.*)": syntax error$/))) {
      const near = m[1];
      let tip = null;
      const order = clauseOrderProblem(masked);
      const words = (masked.match(/[A-Za-z_]+/g) || []);
      const identifiers = new Set([...allColumns, ...tableNames].map(s => s.toLowerCase()));
      const typo = words.find(w => {
        if (identifiers.has(w.toLowerCase()) || KEYWORDS.includes(w.toUpperCase())) return false;
        const k = closest(w, KEYWORDS);
        return k && w.length >= 3 && k.length >= 3;
      });
      if (/,\s*FROM\b/i.test(masked)) tip = 'Remove the comma right before `FROM`. The last column in a SELECT list has no comma after it.';
      else if (/,\s*$/.test(masked.trim())) tip = 'Your query ends with a comma. Remove it, or add the column that should follow.';
      else if (typo) tip = `\`${typo}\` looks like a typo. Did you mean \`${closest(typo, KEYWORDS)}\`?`;
      else if (order) tip = `\`${order.early}\` has to come before \`${order.late}\`. ${CLAUSE_ORDER}`;
      else if (/^(GROUP|ORDER)$/i.test(near) && !/\b(GROUP|ORDER)\s+BY\b/i.test(masked)) tip = `It's \`${near.toUpperCase()} BY\`, two words.`;
      else if (/^(GROUPBY|ORDERBY)$/i.test(near)) tip = `Put a space in it: \`${near.toUpperCase().replace('BY', ' BY')}\`.`;
      else if (/^(FROM|WHERE)$/i.test(near) && /\bSELECT\s+(FROM|WHERE)\b/i.test(masked)) tip = 'List at least one column (or `*`) between `SELECT` and `FROM`.';
      else if (/^(FROM|WHERE|GROUP|ORDER|HAVING|LIMIT)$/i.test(near)) tip = `Check the text just before \`${near.toUpperCase()}\`: a stray comma, an unfinished expression, or a clause out of order. ${CLAUSE_ORDER}`;
      else if (near === '') tip = 'Your query looks unfinished. Check the end of it.';
      else tip = 'Look for a missing comma between columns, a misspelled keyword, or a missing space between keywords.';
      return {
        title: 'Syntax error',
        message: near ? `SQLite got confused near \`${near}\`.` : 'SQLite couldn\'t parse your query.',
        tip,
      };
    }

    return { title: 'SQL error', message, tip: null };
  }

  // ---- Comparing results ----

  function lowerNames(cols) { return cols.map(c => String(c).toLowerCase()); }

  // Lines up the learner's columns with the expected ones. Columns whose
  // names match are paired by name (so a different column order still
  // passes unless the lesson says it matters); the rest are paired in the
  // order they appear, so an unaliased expression still lines up.
  function mapColumns(userCols, expectedCols, { columnOrderMatters }) {
    const u = lowerNames(userCols);
    const e = lowerNames(expectedCols);
    if (columnOrderMatters || u.length !== e.length) return { byName: false, idx: e.map((_, i) => i) };
    const idx = e.map(() => -1);
    const used = new Set();
    e.forEach((name, i) => {
      const j = u.findIndex((n, k) => n === name && !used.has(k));
      if (j !== -1) { idx[i] = j; used.add(j); }
    });
    const byName = idx.every(i => i !== -1);
    const rest = u.map((_, k) => k).filter(k => !used.has(k));
    for (let i = 0; i < idx.length; i++) if (idx[i] === -1) idx[i] = rest.shift();
    return { byName, idx };
  }

  function reorder(rows, idx) {
    return rows.map(r => idx.map(i => r[i]));
  }

  function isNumericColumn(rows, ci) {
    let seen = 0;
    for (const r of rows) {
      const v = normValue(r[ci]);
      if (v === null) continue;
      if (typeof v !== 'number') return false;
      seen++;
    }
    return seen > 0;
  }

  function sortedColumn(rows, ci) {
    return rows.map(r => valueKey(r[ci])).sort();
  }

  // Columns whose values (as a multiset, ignoring row pairing) differ.
  function mismatchedColumns(userRows, expRows, colNames) {
    const bad = [];
    for (let ci = 0; ci < colNames.length; ci++) {
      const a = sortedColumn(userRows, ci);
      const b = sortedColumn(expRows, ci);
      if (a.length !== b.length || a.some((k, i) => k !== b[i])) bad.push(ci);
    }
    return bad;
  }

  function maxDecimals(rows, ci) {
    let d = 0;
    rows.forEach(r => { const v = normValue(r[ci]); if (typeof v === 'number') d = Math.max(d, decimalsOf(v)); });
    return d;
  }

  // Do the learner's values match once rounded to the expected precision?
  function roundingExplains(userRows, expRows, ci) {
    const d = maxDecimals(expRows, ci);
    if (d > 4) return null;
    const a = userRows.map(r => { const v = normValue(r[ci]); return typeof v === 'number' ? valueKey(roundTo(v, d)) : valueKey(v); }).sort();
    const b = sortedColumn(expRows, ci);
    return a.length === b.length && a.every((k, i) => k === b[i]) ? d : null;
  }

  // Learner got whole numbers where the answer has fractions, within 1 of
  // each: the classic SQLite integer-division trap (7 / 2 = 3).
  function integerDivisionExplains(userRows, expRows, ci) {
    if (userRows.length !== expRows.length || !userRows.length) return false;
    const u = userRows.map(r => normValue(r[ci]));
    const e = expRows.map(r => normValue(r[ci]));
    if (!u.every(v => v === null || (typeof v === 'number' && Number.isInteger(v)))) return false;
    if (e.every(v => v === null || (typeof v === 'number' && Number.isInteger(v)))) return false;
    const us = [...u].sort((a, b) => a - b);
    const es = [...e].sort((a, b) => a - b);
    return us.every((v, i) => v === null || es[i] === null || Math.abs(v - es[i]) < 1);
  }

  function hasDuplicateRows(counts) {
    for (const n of counts.values()) if (n > 1) return true;
    return false;
  }

  function fail(code, title, message, tip, extra) {
    return Object.assign({ ok: false, code, title, message, tip: tip || null }, extra || {});
  }

  // Compares two { columns, rows } results. Options:
  //   orderMatters        rows must come back in the same order
  //   checkColumnNames    column names (aliases) must match, case-insensitively
  //   columnOrderMatters  columns must be in the same order
  //   orderKeys           with orderMatters: judge order only on these
  //                       expected column names (ties may come in any order)
  function compareResults(user, expected, opts = {}) {
    const { orderMatters = false, checkColumnNames = false, columnOrderMatters = false } = opts;
    const eCols = expected.columns;
    const uCols = user.columns;

    if (!uCols.length) {
      return fail('no_result', 'No result', 'Your query didn\'t return a result table.', 'Make sure it\'s a `SELECT` query.');
    }

    // ---- Shape: column count ----
    if (uCols.length !== eCols.length) {
      const uLower = lowerNames(uCols);
      const eLower = lowerNames(eCols);
      const missing = eCols.filter(c => !uLower.includes(c.toLowerCase()));
      const extra = uCols.filter(c => !eLower.includes(c.toLowerCase()));
      if (uCols.length > eCols.length) {
        const starTip = uCols.length > eCols.length + 2 ? ' If you used `SELECT *`, list just the columns the task asks for.' : '';
        return fail('extra_columns', 'Too many columns',
          `Your result has ${plural(uCols.length, 'column')}, but the task needs ${plural(eCols.length, 'column')}${eCols.length <= 6 ? `: ${listNames(eCols)}` : ''}.`,
          (extra.length && extra.length <= 4 ? `Remove ${listNames(extra)}.` : 'Select only the columns the task asks for.') + starTip);
      }
      return fail('missing_columns', 'Missing columns',
        `Your result has ${plural(uCols.length, 'column')}, but the task needs ${plural(eCols.length, 'column')}${eCols.length <= 6 ? `: ${listNames(eCols)}` : ''}.`,
        missing.length && missing.length <= 4 ? `Add ${listNames(missing)} to your SELECT list.` : 'Check the task for every column it asks for.');
    }

    const map = mapColumns(uCols, eCols, { columnOrderMatters });
    const uRows = reorder(user.rows, map.idx);
    const uNames = map.idx.map(i => uCols[i]);
    const eRows = expected.rows;

    // ---- Column names (aliases) ----
    if (checkColumnNames) {
      const wrong = eCols.map((c, i) => ({ want: c, got: uNames[i] })).filter(p => p.want.toLowerCase() !== String(p.got).toLowerCase());
      if (wrong.length) {
        const first = wrong[0];
        return fail('column_names', 'Check your column names',
          wrong.length === 1
            ? `Your column \`${first.got}\` should be named \`${first.want}\`.`
            : `These columns need different names: ${wrong.map(p => `\`${p.got}\` → \`${p.want}\``).join(', ')}.`,
          `Rename a column with \`AS\`, e.g. \`... AS ${first.want}\`.`);
      }
    }

    const uCounts = countKeys(uRows);
    const eCounts = countKeys(eRows);

    // ---- Rows ----
    if (sameMultiset(uCounts, eCounts)) {
      if (orderMatters) {
        // With orderKeys, only the sequence of those columns is judged, so
        // rows that tie on every sort key may come back in any order.
        const keyIdx = (opts.orderKeys || []).map(k => lowerNames(eCols).indexOf(String(k).toLowerCase())).filter(i => i !== -1);
        const seqKey = keyIdx.length ? (r => keyIdx.map(i => valueKey(r[i])).join('\u241f')) : rowKey;
        const firstDiff = eRows.findIndex((r, i) => seqKey(r) !== seqKey(uRows[i]));
        if (firstDiff !== -1) {
          return fail('wrong_order', 'Right rows, wrong order',
            'Your query returns exactly the right rows, but not in the order the task asks for.',
            'Check your `ORDER BY`: the column(s) you sort by, their order, and `ASC` vs `DESC` for each.',
            { firstDiffRow: firstDiff });
        }
      }
      return { ok: true, code: 'correct', columnsMatchedByName: map.byName };
    }

    if (uRows.length === 0) {
      return fail('no_rows', 'No rows returned',
        `Your query returned no rows, but the expected result has ${plural(eRows.length, 'row')}.`,
        'Check your `WHERE` conditions. Text comparisons are case-sensitive and exact: `\'Dairy\'` doesn\'t match `\'dairy\'` or `\'Dairy \'`.');
    }

    if (uRows.length !== eRows.length) {
      if (isSubMultiset(uCounts, eCounts)) {
        return fail('too_few_rows', 'Missing rows',
          `Your query returned ${plural(uRows.length, 'row')}, and they're all correct, but ${plural(eRows.length - uRows.length, 'row is', 'rows are')} missing.`,
          'Your filter may be too strict (check `>` vs `>=`, `AND` vs `OR`), or a `LIMIT` cuts the result short. With joins, an `INNER JOIN` drops rows that a `LEFT JOIN` would keep.');
      }
      if (isSubMultiset(eCounts, uCounts)) {
        const dup = hasDuplicateRows(uCounts) && !hasDuplicateRows(eCounts);
        return fail('too_many_rows', 'Extra rows',
          `Your query returned ${plural(uRows.length, 'row')}, which includes every expected row plus ${plural(uRows.length - eRows.length, 'extra')}.`,
          dup ? 'Your result has duplicate rows the answer doesn\'t. `SELECT DISTINCT` removes duplicates, or check whether a join is matching rows more than once.'
            : 'A filter may be missing or too loose, or a `LIMIT` is missing. With joins, a `LEFT JOIN` keeps rows an `INNER JOIN` would drop.');
      }
      const groupHint = uRows.length > eRows.length
        ? 'Too many rows usually means a missing filter, a missing `GROUP BY` column, or a join condition that matches too much.'
        : 'Too few rows usually means a filter that\'s too strict, an extra `GROUP BY` column merging groups, or an `INNER JOIN` dropping rows.';
      return fail('row_count', 'Different number of rows',
        `Your query returned ${plural(uRows.length, 'row')}, but the expected result has ${plural(eRows.length, 'row')}.`,
        groupHint);
    }

    // Same row count, different values.
    const bad = mismatchedColumns(uRows, eRows, eCols);
    if (bad.length) {
      for (const ci of bad) {
        if (isNumericColumn(eRows, ci) && isNumericColumn(uRows, ci)) {
          const d = roundingExplains(uRows, eRows, ci);
          if (d !== null) {
            return fail('rounding', 'Almost: check the rounding',
              `The values in \`${eCols[ci]}\` are right, but not rounded the way the task asks.`,
              d === 0 ? `Round to a whole number with \`ROUND(value)\`.` : `Round to ${plural(d, 'decimal place')} with \`ROUND(value, ${d})\`.`);
          }
          if (integerDivisionExplains(uRows, eRows, ci)) {
            return fail('integer_division', 'Integer division',
              `The values in \`${eCols[ci]}\` came out as whole numbers, but the answer has decimals.`,
              'In SQLite, dividing two integers drops the fraction (`7 / 2` is `3`). Multiply by `1.0` first, e.g. `wins * 1.0 / games`.');
          }
        }
      }
      const names = bad.map(ci => eCols[ci]);
      const ci = bad[0];
      const sample = eRows.find((r, i) => !valuesEqual(r[ci], uRows[i][ci]));
      const sampleIdx = sample ? eRows.indexOf(sample) : -1;
      return fail('wrong_values', 'Some values don\'t match',
        `Right number of rows, but the values in ${listNames(names)} aren't what the task expects.`,
        sampleIdx !== -1 && orderMatters
          ? `For example, row ${sampleIdx + 1} should have ${formatValue(normValue(eRows[sampleIdx][ci]))} in \`${eCols[ci]}\`, not ${formatValue(normValue(uRows[sampleIdx][ci]))}.`
          : 'Re-read the task: check the filter, the calculation, and which column you aggregate.',
        { badColumns: names });
    }

    // Every column has the right values, but they're paired up into rows
    // differently (e.g. ORDER BY on one column only, or a join that
    // matches the wrong keys).
    return fail('wrong_rows', 'Rows don\'t line up',
      'Each column has the right values overall, but they\'re combined into rows differently than expected.',
      'Check your join condition (`ON`) or your `GROUP BY`: values from different rows are being paired up.');
  }

  function testPattern(pattern, masked) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
    return re.test(masked);
  }

  // Grades a learner's SQL for an exercise. `expected` is the reference
  // result ({ columns, rows }), computed once per lesson load. Returns
  // { ok, code, title, message, tip, userResult, tips[] }.
  function grade(db, sql, exercise, expected, ctx) {
    const trimmed = String(sql || '').trim();
    if (!maskSql(trimmed).trim()) {
      return fail('empty', 'Nothing to check yet', 'Write a query in the editor first.', null, { userResult: null });
    }

    let userResult;
    try {
      userResult = runQuery(db, trimmed);
    } catch (err) {
      if (err.learnReadOnly) return fail('read_only', 'Read queries only', err.message, null, { userResult: null });
      const explained = explainError(err.message, trimmed, ctx);
      return fail('sql_error', explained.title, explained.message, explained.tip, { userResult: null, rawError: String(err.message) });
    }

    const masked = maskSql(trimmed);
    const opts = {
      orderMatters: exercise.orderMatters !== undefined ? exercise.orderMatters : defaultOrderMatters(exercise.solution),
      checkColumnNames: !!exercise.checkColumnNames,
      columnOrderMatters: !!exercise.columnOrderMatters,
      orderKeys: exercise.orderKeys || null,
    };

    let result = compareResults(userResult, expected, opts);

    if (result.ok) {
      if (exercise.requireFrom !== false && !/\bFROM\b/i.test(masked)) {
        result = fail('no_from', 'Query the table', 'Your result matches, but it doesn\'t read from any table. Typed-in values won\'t work on real data.', 'Use `FROM` to pull the values out of the table.');
      } else {
        for (const rule of exercise.mustUse || []) {
          if (!testPattern(rule.pattern, masked)) {
            result = fail('missing_construct', 'Right result, different route', `Your result is correct! ${rule.message}`, null);
            break;
          }
        }
        if (result.ok) {
          for (const rule of exercise.mustNotUse || []) {
            if (testPattern(rule.pattern, masked)) {
              result = fail('forbidden_construct', 'Right result, different route', `Your result is correct! ${rule.message}`, null);
              break;
            }
          }
        }
      }
    }

    const tips = result.ok ? [] : smellTips(trimmed);
    // One row where many were expected, from an aggregate with no GROUP BY:
    // the whole table collapsed into a single summary row.
    if (!result.ok && userResult.rows.length === 1 && expected.rows.length > 1
        && /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(masked) && !/\bGROUP\s+BY\b/i.test(masked)) {
      tips.push(/\bOVER\s*\(/i.test(exercise.solution)
        ? 'An aggregate like `AVG()` with no `GROUP BY` collapses the whole table into one row. To show it next to every row instead, make it a window function: `AVG(price) OVER ()`.'
        : 'An aggregate like `SUM()` with no `GROUP BY` collapses the whole table into one row. Add `GROUP BY` to get one row per group.');
    }
    if (!result.ok && userResult.statementCount > 1) {
      tips.push('Your editor has more than one statement. Only the last one\'s result is checked.');
    }
    return Object.assign(result, { userResult, tips });
  }

  return {
    maskSql,
    splitStatements,
    stripWindowClauses,
    defaultOrderMatters,
    readOnlyProblem,
    runQuery,
    valuesEqual,
    compareResults,
    explainError,
    grade,
    levenshtein,
    closest,
  };
});
