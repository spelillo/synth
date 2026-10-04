// learn-curriculum.js — the three Learn courses, lesson by lesson.
//
// Each lesson is one concept and one exercise, DataCamp style: a short
// explanation, a runnable example, a task, progressive hints, a reference
// solution, and a takeaway shown once it's solved.
//
// Lesson fields:
//   id, module, title, minutes    identity and outline placement
//   tables                        dataset ids (learn-datasets.js) loaded for this lesson
//   concept                       trusted HTML (authored here, never user input)
//   example { sql, caption }      runnable demo; must differ from the solution
//   task                          trusted HTML: what to return
//   starter                       initial editor contents
//   solution                      reference query; its result is the expected answer
//   hints[]                       plain text, `backticks` become code
//   takeaway                      plain text shown after a correct answer
// Grading options (see learn-grader.js):
//   orderMatters        default: true if the solution's outer query has ORDER BY
//   orderKeys[]         output columns the order is judged on (tie-tolerant);
//                       default: whole rows
//   checkColumnNames    aliases must match
//   columnOrderMatters  columns must come back in the listed order
//   mustUse[] / mustNotUse[]   { pattern, message } for construct-focused lessons
//
// `npm test` runs every solution against the real data, checks that every
// starter query fails, and checks that every expected result is the same
// regardless of how the rows happen to be stored (no tie-dependent LIMITs).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LearnCurriculum = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Small inline Venn diagrams for the join lessons. Styled by learn.css
  // (.learn-venn-*), so they follow light/dark mode.
  function venn(kind, leftLabel, rightLabel) {
    const fills = {
      inner: { l: false, m: true, r: false },
      left: { l: true, m: true, r: false },
      right: { l: false, m: true, r: true },
      full: { l: true, m: true, r: true },
      anti: { l: true, m: false, r: false },
    }[kind];
    const id = 'venn-' + kind;
    return `<figure class="learn-venn" aria-label="${kind} join diagram">
      <svg viewBox="0 0 220 120" role="img" focusable="false">
        <defs>
          <clipPath id="${id}-l"><circle cx="85" cy="58" r="46"/></clipPath>
        </defs>
        ${fills.l ? '<circle class="learn-venn-on" cx="85" cy="58" r="46"/>' : ''}
        ${fills.r ? '<circle class="learn-venn-on" cx="135" cy="58" r="46"/>' : ''}
        ${fills.m ? `<circle class="learn-venn-on" cx="135" cy="58" r="46" clip-path="url(#${id}-l)"/>` : (fills.l || fills.r ? `<circle class="learn-venn-off" cx="135" cy="58" r="46" clip-path="url(#${id}-l)"/>` : '')}
        <circle class="learn-venn-ring" cx="85" cy="58" r="46"/>
        <circle class="learn-venn-ring" cx="135" cy="58" r="46"/>
        <text class="learn-venn-label" x="62" y="114" text-anchor="middle">${leftLabel}</text>
        <text class="learn-venn-label" x="158" y="114" text-anchor="middle">${rightLabel}</text>
      </svg>
    </figure>`;
  }

  const LEVELS = [
    {
      id: 'beginner',
      level: 'Beginner',
      title: 'SQL Foundations',
      icon: 'ph-plant',
      tagline: 'Write your first queries. Select, filter, sort, and summarize real data.',
      topics: ['SELECT & FROM', 'WHERE', 'AND / OR / IN / LIKE', 'NULL', 'ORDER BY & LIMIT', 'Aliases', 'COUNT, SUM, AVG, MIN, MAX', 'GROUP BY & HAVING'],
      lessons: [
        {
          id: 'b01', module: 'Getting started', title: 'Your first query', minutes: 3,
          tables: ['nfl_team_stats', 'grocery_store_data'],
          concept: `
            <p>SQL (Structured Query Language) is how you ask a database questions. A question is called a <strong>query</strong>, and every query is built from <strong>clauses</strong>.</p>
            <p>The two clauses you'll use in every query are <code>SELECT</code>, which says which columns you want, and <code>FROM</code>, which says which table they come from. <code>*</code> is shorthand for "every column".</p>
            <p>Keywords aren't case-sensitive (<code>select</code> works too), but writing them in capitals makes queries easier to read. The semicolon at the end is optional here.</p>`,
          example: { sql: 'SELECT * FROM nfl_team_stats;', caption: 'Every column and every row of the NFL table.' },
          task: '<p>Return <strong>every column</strong> and <strong>every row</strong> from the <code>grocery_store_data</code> table.</p>',
          starter: '-- Write your query below, then press Check Answer\n',
          solution: 'SELECT * FROM grocery_store_data;',
          hints: [
            'Every query starts with `SELECT` followed by the columns you want.',
            '`*` means every column, and `FROM` names the table.',
            'The pattern is `SELECT * FROM table_name;`',
          ],
          takeaway: '`SELECT *` is the fastest way to look at a table. In real work you usually name just the columns you need, which you\'ll do next.',
        },
        {
          id: 'b02', module: 'Getting started', title: 'Choosing columns', minutes: 3,
          tables: ['nfl_team_stats'],
          concept: `
            <p>Instead of <code>*</code>, list the columns you want after <code>SELECT</code>, separated by commas. The result shows them in exactly the order you list them.</p>
            <p>Column names have to match the table exactly. Open the <strong>Tables</strong> tab or the column list above the editor to see what's available.</p>
            <p>A common slip: a comma after the <em>last</em> column, right before <code>FROM</code>. SQL treats that as a syntax error.</p>`,
          example: { sql: 'SELECT team, wins\nFROM nfl_team_stats;', caption: 'Just two columns, in the order listed.' },
          task: '<p>Return the <code>team</code>, <code>season</code>, <code>wins</code>, and <code>losses</code> columns, in that order, for every row of <code>nfl_team_stats</code>.</p>',
          starter: 'SELECT \nFROM nfl_team_stats;',
          solution: 'SELECT team, season, wins, losses\nFROM nfl_team_stats;',
          columnOrderMatters: true,
          hints: [
            'List the four column names between `SELECT` and `FROM`.',
            'Separate the columns with commas, but don\'t put a comma after the last one.',
            '`SELECT team, season, wins, losses FROM nfl_team_stats;`',
          ],
          takeaway: 'Picking columns keeps results readable and fast. The column order in your SELECT list is the column order in the output.',
        },
        {
          id: 'b03', module: 'Getting started', title: 'Renaming columns with AS', minutes: 3,
          tables: ['bank_statement'],
          concept: `
            <p><code>AS</code> gives a column a new name in your result. This is called an <strong>alias</strong>. It only changes the output; the table itself is untouched.</p>
            <p>Aliases make results clearer for whoever reads them, and later you'll use them to name calculated columns like totals and averages.</p>
            <p>Stick to letters, numbers, and underscores (<code>transaction_date</code>). If you really need a space, wrap the alias in double quotes: <code>AS "Transaction Date"</code>.</p>`,
          example: { sql: 'SELECT description AS merchant, amount\nFROM bank_statement;', caption: 'The description column shows up as merchant.' },
          task: '<p>From <code>bank_statement</code>, return <code>date</code> renamed to <code>transaction_date</code>, <code>description</code> renamed to <code>merchant</code>, and <code>amount</code> unchanged.</p>',
          starter: 'SELECT \nFROM bank_statement;',
          solution: 'SELECT date AS transaction_date, description AS merchant, amount\nFROM bank_statement;',
          checkColumnNames: true,
          hints: [
            'Write each column, then `AS`, then its new name.',
            '`amount` doesn\'t need an alias.',
            '`SELECT date AS transaction_date, description AS merchant, amount FROM bank_statement;`',
          ],
          takeaway: 'Aliases rename columns in the result only. You\'ll use AS constantly once you start calculating new columns.',
        },
        {
          id: 'b04', module: 'Getting started', title: 'Unique values with DISTINCT', minutes: 3,
          tables: ['grocery_store_data'],
          concept: `
            <p>Many rows can share the same value: the grocery table has 140 sales but only a handful of categories. <code>SELECT DISTINCT</code> removes duplicate rows from the result.</p>
            <p>With several columns, <code>DISTINCT</code> applies to the <em>combination</em>: <code>SELECT DISTINCT category, store_location</code> returns each category and store pair once.</p>`,
          example: { sql: 'SELECT DISTINCT store_location\nFROM grocery_store_data;', caption: 'Each of the five stores, once.' },
          task: '<p>List each product <code>category</code> in <code>grocery_store_data</code> exactly once.</p>',
          starter: 'SELECT \nFROM grocery_store_data;',
          solution: 'SELECT DISTINCT category\nFROM grocery_store_data;',
          hints: [
            'You only need one column: `category`.',
            'Put `DISTINCT` right after `SELECT`.',
            '`SELECT DISTINCT category FROM grocery_store_data;`',
          ],
          takeaway: 'DISTINCT is the quickest way to see what values a column holds, like the categories, statuses, or regions in a table.',
        },
        {
          id: 'b05', module: 'Filtering rows', title: 'Filtering rows with WHERE', minutes: 4,
          tables: ['nfl_team_stats'],
          concept: `
            <p><code>WHERE</code> keeps only the rows where a condition is true. It goes right after <code>FROM</code>.</p>
            <p>The comparison operators are <code>=</code>, <code>&lt;&gt;</code> or <code>!=</code> (not equal), <code>&gt;</code>, <code>&lt;</code>, <code>&gt;=</code>, and <code>&lt;=</code>.</p>
            <p>Watch the boundary: "14 or more" is <code>&gt;= 14</code>, while <code>&gt; 14</code> means 15 and up.</p>`,
          example: { sql: 'SELECT team, season, losses\nFROM nfl_team_stats\nWHERE losses >= 12;', caption: 'Team-seasons with 12 or more losses.' },
          task: '<p>Find every team-season with <strong>14 or more wins</strong>. Return <code>team</code>, <code>season</code>, and <code>wins</code>.</p>',
          starter: 'SELECT team, season, wins\nFROM nfl_team_stats\n',
          solution: 'SELECT team, season, wins\nFROM nfl_team_stats\nWHERE wins >= 14;',
          hints: [
            'Add a `WHERE` clause after `FROM nfl_team_stats`.',
            '"14 or more" means greater than or equal to: `>=`.',
            '`... WHERE wins >= 14;`',
          ],
          takeaway: 'WHERE filters rows before anything else happens to them. Getting the boundary operator right (> vs >=) is one of the most common sources of off-by-one answers.',
        },
        {
          id: 'b06', module: 'Filtering rows', title: 'Filtering text', minutes: 4,
          tables: ['bank_statement'],
          concept: `
            <p>Text values go in <strong>single quotes</strong>: <code>WHERE type = 'credit'</code>. Without quotes, SQL thinks <code>credit</code> is a column name.</p>
            <p>Text comparisons are exact: <code>'Dining Out'</code> won't match <code>'dining out'</code> or <code>'Dining  Out'</code>. Copy values exactly as they appear in the table.</p>
            <p>Double quotes are for identifiers (column and table names). SQLite tolerates them for text, but other databases don't, so build the single-quote habit now.</p>`,
          example: { sql: "SELECT date, description, amount\nFROM bank_statement\nWHERE type = 'credit';", caption: 'Money coming in.' },
          task: "<p>Show every transaction in the <code>'Dining Out'</code> category. Return <code>date</code>, <code>description</code>, and <code>amount</code>.</p>",
          starter: 'SELECT date, description, amount\nFROM bank_statement\n',
          solution: "SELECT date, description, amount\nFROM bank_statement\nWHERE category = 'Dining Out';",
          hints: [
            'Filter on the `category` column.',
            'Put the text value in single quotes, matching its capitalization exactly.',
            "`... WHERE category = 'Dining Out';`",
          ],
          takeaway: 'Single quotes for values, exact matches for text. When a text filter returns nothing, check capitalization and spacing first.',
        },
        {
          id: 'b07', module: 'Filtering rows', title: 'Combining conditions: AND, OR, NOT', minutes: 5,
          tables: ['nfl_team_stats'],
          concept: `
            <p><code>AND</code> keeps rows where <em>both</em> conditions are true. <code>OR</code> keeps rows where <em>either</em> is. <code>NOT</code> flips a condition.</p>
            <p><code>AND</code> is evaluated before <code>OR</code>, which trips people up: <code>season = 2023 AND conference = 'AFC' OR conference = 'NFC'</code> returns every NFC season ever. Use parentheses to say what you mean: <code>season = 2023 AND (conference = 'AFC' OR conference = 'NFC')</code>.</p>`,
          example: { sql: "SELECT team, season, wins\nFROM nfl_team_stats\nWHERE division = 'North' AND conference = 'NFC';", caption: 'NFC North teams, every season.' },
          task: "<p>Find the <strong>AFC</strong> teams that <strong>made the playoffs</strong> in the <strong>2023</strong> season. Return <code>team</code>, <code>division</code>, and <code>wins</code>.</p>",
          starter: 'SELECT team, division, wins\nFROM nfl_team_stats\nWHERE ',
          solution: "SELECT team, division, wins\nFROM nfl_team_stats\nWHERE season = 2023\n  AND conference = 'AFC'\n  AND made_playoffs = 'Yes';",
          hints: [
            'You need three conditions, and all of them must be true.',
            'Join them with `AND`. `made_playoffs` holds the text `\'Yes\'` or `\'No\'`.',
            "`WHERE season = 2023 AND conference = 'AFC' AND made_playoffs = 'Yes'`",
          ],
          takeaway: 'AND narrows, OR widens. When you mix them, add parentheses even if you think you don\'t need them; future you will thank you.',
        },
        {
          id: 'b08', module: 'Filtering rows', title: 'Matching a list with IN', minutes: 4,
          tables: ['grocery_store_data'],
          concept: `
            <p><code>IN</code> checks whether a value matches anything in a list: <code>WHERE store_location IN ('Uptown', 'Westside')</code>.</p>
            <p>It's shorthand for a chain of <code>OR</code>s, and much easier to read once the list grows. <code>NOT IN</code> keeps everything that <em>isn't</em> in the list.</p>`,
          example: { sql: "SELECT product_name, store_location\nFROM grocery_store_data\nWHERE store_location IN ('Uptown', 'Westside');", caption: 'Sales at two of the five stores.' },
          task: "<p>Return <code>product_name</code>, <code>category</code>, and <code>revenue</code> for sales in the <code>'Dairy'</code>, <code>'Bakery'</code>, or <code>'Frozen'</code> categories. Use <code>IN</code>.</p>",
          starter: 'SELECT product_name, category, revenue\nFROM grocery_store_data\nWHERE ',
          solution: "SELECT product_name, category, revenue\nFROM grocery_store_data\nWHERE category IN ('Dairy', 'Bakery', 'Frozen');",
          mustUse: [{ pattern: '\\bIN\\s*\\(', message: 'This lesson is practicing `IN`. Try rewriting the filter as `category IN (...)`.' }],
          hints: [
            'The filter is on `category`.',
            'Put the three values, each in single quotes, inside `IN ( ... )`, separated by commas.',
            "`WHERE category IN ('Dairy', 'Bakery', 'Frozen')`",
          ],
          takeaway: 'IN keeps filters short and readable. Later you\'ll put a whole subquery inside IN instead of a typed list.',
        },
        {
          id: 'b09', module: 'Filtering rows', title: 'Ranges with BETWEEN', minutes: 4,
          tables: ['bank_statement'],
          concept: `
            <p><code>BETWEEN low AND high</code> keeps values in a range, <strong>including both ends</strong>. <code>amount BETWEEN 100 AND 200</code> is the same as <code>amount &gt;= 100 AND amount &lt;= 200</code>.</p>
            <p>It works on dates too. SQLite stores dates as text like <code>'2025-03-14'</code>, and because that format goes year, month, day, alphabetical order is also date order.</p>`,
          example: { sql: 'SELECT date, description, amount\nFROM bank_statement\nWHERE amount BETWEEN 100 AND 200;', caption: 'Transactions from $100 to $200, inclusive.' },
          task: "<p>Find all transactions in <strong>March 2025</strong> (<code>'2025-03-01'</code> through <code>'2025-03-31'</code>). Return <code>transaction_id</code>, <code>date</code>, <code>description</code>, and <code>amount</code>.</p>",
          starter: 'SELECT transaction_id, date, description, amount\nFROM bank_statement\nWHERE ',
          solution: "SELECT transaction_id, date, description, amount\nFROM bank_statement\nWHERE date BETWEEN '2025-03-01' AND '2025-03-31';",
          hints: [
            'Filter on the `date` column.',
            'Dates are text, so quote them: `\'2025-03-01\'`.',
            "`WHERE date BETWEEN '2025-03-01' AND '2025-03-31'`",
          ],
          takeaway: 'BETWEEN is inclusive on both ends. ISO dates (YYYY-MM-DD) compare correctly as text, which is why databases love that format.',
        },
        {
          id: 'b10', module: 'Filtering rows', title: 'Pattern matching with LIKE', minutes: 4,
          tables: ['grocery_store_data'],
          concept: `
            <p><code>LIKE</code> matches text against a pattern. <code>%</code> stands for any number of characters (including none), and <code>_</code> stands for exactly one.</p>
            <ul>
              <li><code>LIKE 'B%'</code> starts with B</li>
              <li><code>LIKE '%pack'</code> ends with "pack"</li>
              <li><code>LIKE '%Cheese%'</code> contains "Cheese" anywhere</li>
            </ul>
            <p>In SQLite, <code>LIKE</code> ignores upper and lower case for English letters. Many other databases don't, so don't rely on it.</p>`,
          example: { sql: "SELECT DISTINCT product_name\nFROM grocery_store_data\nWHERE product_name LIKE 'B%';", caption: 'Products starting with B.' },
          task: "<p>Find the products sold in multi-packs: those whose <code>product_name</code> <strong>ends with</strong> <code>pack</code>. Return <code>product_name</code> and <code>unit_price</code>, each product once.</p>",
          starter: 'SELECT DISTINCT product_name, unit_price\nFROM grocery_store_data\nWHERE ',
          solution: "SELECT DISTINCT product_name, unit_price\nFROM grocery_store_data\nWHERE product_name LIKE '%pack';",
          hints: [
            'Use `LIKE` on `product_name`.',
            '"Ends with" means the wildcard goes at the start of the pattern.',
            "`WHERE product_name LIKE '%pack'`",
          ],
          takeaway: 'Put % where any text may appear. LIKE \'%x%\' (contains) is handy, but it can\'t use an index, so it\'s slow on very large tables.',
        },
        {
          id: 'b11', module: 'Filtering rows', title: 'Missing values: NULL', minutes: 5,
          tables: ['customers'],
          concept: `
            <p><code>NULL</code> means a value is missing or unknown. It isn't zero and it isn't an empty string. In <code>customers</code>, <code>referred_by</code> is <code>NULL</code> for anyone nobody referred.</p>
            <p>Because NULL means "unknown", <code>referred_by = NULL</code> is never true, not even for missing values. To test for NULL, use <code>IS NULL</code> or <code>IS NOT NULL</code>.</p>`,
          example: { sql: 'SELECT first_name, last_name, referred_by\nFROM customers\nWHERE referred_by IS NOT NULL;', caption: 'Customers someone referred.' },
          task: '<p>Find the customers who <strong>weren\'t referred</strong> by anyone. Return <code>customer_id</code>, <code>first_name</code>, and <code>last_name</code>.</p>',
          starter: 'SELECT customer_id, first_name, last_name\nFROM customers\nWHERE ',
          solution: 'SELECT customer_id, first_name, last_name\nFROM customers\nWHERE referred_by IS NULL;',
          hints: [
            'Customers nobody referred have a missing `referred_by`.',
            '`= NULL` never matches anything. There\'s a special operator for NULL.',
            '`WHERE referred_by IS NULL`',
          ],
          takeaway: 'Always test for missing values with IS NULL / IS NOT NULL. NULL behaves differently in comparisons, math, and aggregates, which you\'ll keep running into.',
        },
        {
          id: 'b12', module: 'Sorting & calculating', title: 'Sorting with ORDER BY', minutes: 4,
          tables: ['bank_statement'],
          concept: `
            <p>Rows come back in no guaranteed order unless you ask. <code>ORDER BY</code> sorts the result, smallest first by default (<code>ASC</code>). Add <code>DESC</code> for largest first.</p>
            <p><code>ORDER BY</code> comes after <code>WHERE</code>. Text sorts alphabetically and dates in <code>YYYY-MM-DD</code> form sort chronologically.</p>`,
          example: { sql: "SELECT date, description, amount\nFROM bank_statement\nWHERE category = 'Gas'\nORDER BY amount;", caption: 'Gas purchases, cheapest first.' },
          task: '<p>List every transaction with an <code>amount</code> <strong>over $500</strong>, from largest to smallest amount. Return <code>date</code>, <code>description</code>, and <code>amount</code>.</p>',
          starter: 'SELECT date, description, amount\nFROM bank_statement\nWHERE amount > 500\n',
          solution: 'SELECT date, description, amount\nFROM bank_statement\nWHERE amount > 500\nORDER BY amount DESC;',
          orderKeys: ['amount'],
          hints: [
            'Add `ORDER BY` after the WHERE clause.',
            'Largest first means descending.',
            '`ORDER BY amount DESC`',
          ],
          takeaway: 'Without ORDER BY, row order is whatever the database finds convenient. If order matters, always say so.',
        },
        {
          id: 'b13', module: 'Sorting & calculating', title: 'Top N with ORDER BY and LIMIT', minutes: 5,
          tables: ['nfl_team_stats'],
          concept: `
            <p><code>LIMIT n</code> keeps only the first <em>n</em> rows of the result. Combined with <code>ORDER BY</code>, that's a "top N" query.</p>
            <p>You can sort by several columns: <code>ORDER BY wins DESC, point_differential DESC</code> sorts by wins, and only uses point differential to order teams with the same number of wins. Tie-breakers matter with <code>LIMIT</code>: without one, which tied row makes the cut is up to chance.</p>
            <p><code>LIMIT</code> always goes last.</p>`,
          example: { sql: 'SELECT team, season, points_against\nFROM nfl_team_stats\nORDER BY points_against\nLIMIT 3;', caption: 'The three stingiest defenses, any season.' },
          task: '<p>Return the <strong>top 5 teams of the 2022 season</strong>: most <code>wins</code> first, with ties broken by the higher <code>point_differential</code>. Return <code>team</code>, <code>wins</code>, and <code>point_differential</code>.</p>',
          starter: 'SELECT team, wins, point_differential\nFROM nfl_team_stats\nWHERE season = 2022\n',
          solution: 'SELECT team, wins, point_differential\nFROM nfl_team_stats\nWHERE season = 2022\nORDER BY wins DESC, point_differential DESC\nLIMIT 5;',
          hints: [
            'Sort by two columns, both descending, separated by a comma.',
            'Then keep only the first five rows.',
            '`ORDER BY wins DESC, point_differential DESC LIMIT 5`',
          ],
          takeaway: 'ORDER BY + LIMIT answers "top N" questions. Always add a tie-breaker so the answer doesn\'t depend on luck.',
        },
        {
          id: 'b14', module: 'Sorting & calculating', title: 'Calculated columns', minutes: 6,
          tables: ['nfl_team_stats'],
          concept: `
            <p>A SELECT list can contain calculations, not just columns: <code>points_for - points_against</code>, <code>wins + losses</code>, <code>price * 1.08</code>. Name them with <code>AS</code>.</p>
            <p>One gotcha: in SQLite, dividing two whole numbers throws away the fraction. <code>7 / 2</code> is <code>3</code>, not <code>3.5</code>. Multiply by <code>1.0</code> first to get a decimal: <code>wins * 1.0 / 16</code>.</p>`,
          example: { sql: 'SELECT team, season, points_for - points_against AS margin\nFROM nfl_team_stats\nWHERE season = 2021;', caption: 'A calculated, aliased column.' },
          task: '<p>For the <strong>2023</strong> season, return <code>team</code>, <code>wins</code>, <code>losses</code>, and <code>win_pct</code>: wins divided by games played (<code>wins + losses + ties</code>), as a decimal.</p>',
          starter: 'SELECT team, wins, losses\nFROM nfl_team_stats\nWHERE season = 2023;',
          solution: 'SELECT team, wins, losses,\n       wins * 1.0 / (wins + losses + ties) AS win_pct\nFROM nfl_team_stats\nWHERE season = 2023;',
          checkColumnNames: true,
          hints: [
            'Add a fourth column: wins divided by the total games, named with `AS win_pct`.',
            'Wrap the total in parentheses, and multiply by `1.0` so SQLite keeps the decimals.',
            '`wins * 1.0 / (wins + losses + ties) AS win_pct`',
          ],
          takeaway: 'Calculated columns turn raw data into answers. Remember the integer-division trap: if a ratio comes out as 0 or a suspiciously whole number, multiply by 1.0.',
        },
        {
          id: 'b15', module: 'Sorting & calculating', title: 'Built-in functions', minutes: 5,
          tables: ['bank_statement'],
          concept: `
            <p>Functions transform values. A few you'll use all the time:</p>
            <ul>
              <li><code>ROUND(x, 2)</code> rounds to 2 decimal places; <code>ROUND(x)</code> to a whole number</li>
              <li><code>UPPER(text)</code> and <code>LOWER(text)</code> change case</li>
              <li><code>LENGTH(text)</code> counts characters</li>
              <li><code>a || b</code> glues text together: <code>first_name || ' ' || last_name</code></li>
            </ul>`,
          example: { sql: "SELECT description, LENGTH(description) AS name_length, ROUND(amount, 1) AS amount_1dp\nFROM bank_statement\nWHERE category = 'Gas';", caption: 'Functions in the SELECT list.' },
          task: "<p>For every transaction in the <code>'Groceries'</code> category, return the <code>description</code> in <strong>upper case</strong> as <code>merchant</code>, and the <code>amount</code> rounded to the nearest whole dollar as <code>rounded_amount</code>.</p>",
          starter: "SELECT \nFROM bank_statement\nWHERE category = 'Groceries';",
          solution: "SELECT UPPER(description) AS merchant, ROUND(amount) AS rounded_amount\nFROM bank_statement\nWHERE category = 'Groceries';",
          checkColumnNames: true,
          hints: [
            'Two calculated columns, each with an alias.',
            '`UPPER()` for the description, `ROUND()` with no second argument for whole dollars.',
            '`SELECT UPPER(description) AS merchant, ROUND(amount) AS rounded_amount ...`',
          ],
          takeaway: 'Functions can wrap any column or expression, and you can nest them: ROUND(AVG(amount), 2) is coming up next.',
        },
        {
          id: 'b16', module: 'Aggregating data', title: 'Counting rows with COUNT', minutes: 4,
          tables: ['bank_statement'],
          concept: `
            <p><strong>Aggregate functions</strong> collapse many rows into one summary value. <code>COUNT(*)</code> counts rows.</p>
            <p>Variations: <code>COUNT(column)</code> counts only rows where that column isn't NULL, and <code>COUNT(DISTINCT column)</code> counts unique values.</p>
            <p>Aggregates run <em>after</em> <code>WHERE</code>, so you can count just the rows that match a filter.</p>`,
          example: { sql: 'SELECT COUNT(*) AS total_transactions, COUNT(DISTINCT category) AS categories\nFROM bank_statement;', caption: 'Two counts in one row.' },
          task: "<p>How many <strong>debit</strong> transactions are there? Return a single column named <code>debit_count</code>.</p>",
          starter: 'SELECT \nFROM bank_statement\n',
          solution: "SELECT COUNT(*) AS debit_count\nFROM bank_statement\nWHERE type = 'debit';",
          checkColumnNames: true,
          hints: [
            'Filter to debits with `WHERE`, then count what\'s left.',
            '`COUNT(*)` counts rows. Name it with `AS debit_count`.',
            "`SELECT COUNT(*) AS debit_count FROM bank_statement WHERE type = 'debit';`",
          ],
          takeaway: 'COUNT(*) counts rows; COUNT(column) skips NULLs; COUNT(DISTINCT column) counts unique values. Knowing which one you want avoids subtle wrong answers.',
        },
        {
          id: 'b17', module: 'Aggregating data', title: 'SUM and AVG', minutes: 5,
          tables: ['grocery_store_data'],
          concept: `
            <p><code>SUM(column)</code> adds values up and <code>AVG(column)</code> averages them. Both ignore NULLs.</p>
            <p>Averages rarely come out round, so wrap them in <code>ROUND()</code>: <code>ROUND(AVG(unit_price), 2)</code>. A function inside a function is called <strong>nesting</strong>.</p>`,
          example: { sql: "SELECT SUM(quantity_sold) AS units, ROUND(AVG(unit_price), 2) AS avg_price\nFROM grocery_store_data\nWHERE category = 'Bakery';", caption: 'Bakery totals.' },
          task: "<p>For the <code>'Produce'</code> category, return the total <code>revenue</code> as <code>total_revenue</code> and the average <code>quantity_sold</code> per sale as <code>avg_quantity</code>, both rounded to 2 decimal places.</p>",
          starter: "SELECT \nFROM grocery_store_data\nWHERE category = 'Produce';",
          solution: "SELECT ROUND(SUM(revenue), 2) AS total_revenue,\n       ROUND(AVG(quantity_sold), 2) AS avg_quantity\nFROM grocery_store_data\nWHERE category = 'Produce';",
          checkColumnNames: true,
          hints: [
            'Use `SUM(revenue)` and `AVG(quantity_sold)`.',
            'Wrap each in `ROUND(..., 2)` and give each an alias.',
            '`SELECT ROUND(SUM(revenue), 2) AS total_revenue, ROUND(AVG(quantity_sold), 2) AS avg_quantity ...`',
          ],
          takeaway: 'SUM and AVG skip NULLs, which is usually what you want, but it means AVG divides by the number of non-NULL values, not the number of rows.',
        },
        {
          id: 'b18', module: 'Aggregating data', title: 'MIN and MAX', minutes: 4,
          tables: ['bank_statement'],
          concept: `
            <p><code>MIN()</code> and <code>MAX()</code> return the smallest and largest value in a column. They work on numbers, text (alphabetical), and ISO dates (earliest and latest).</p>
            <p>You can put several aggregates in one SELECT list to build a one-row summary.</p>`,
          example: { sql: "SELECT MIN(balance_after) AS lowest_balance, MAX(balance_after) AS highest_balance\nFROM bank_statement;", caption: 'The range of the running balance.' },
          task: "<p>For <strong>debit</strong> transactions only, return the smallest <code>amount</code> as <code>smallest</code>, the largest as <code>largest</code>, and the earliest <code>date</code> as <code>first_date</code>.</p>",
          starter: "SELECT \nFROM bank_statement\nWHERE type = 'debit';",
          solution: "SELECT MIN(amount) AS smallest, MAX(amount) AS largest, MIN(date) AS first_date\nFROM bank_statement\nWHERE type = 'debit';",
          checkColumnNames: true,
          hints: [
            'Three aggregates, each with an alias.',
            'The earliest date is the minimum date.',
            '`SELECT MIN(amount) AS smallest, MAX(amount) AS largest, MIN(date) AS first_date ...`',
          ],
          takeaway: 'MIN and MAX work on any sortable type. Combining several aggregates in one query gives you a quick profile of a column.',
        },
        {
          id: 'b19', module: 'Aggregating data', title: 'Grouping with GROUP BY', minutes: 6,
          tables: ['grocery_store_data'],
          concept: `
            <p><code>GROUP BY</code> splits rows into groups that share a value, then runs your aggregates once per group. One output row per group.</p>
            <p>The rule: every column in the SELECT list must either be in <code>GROUP BY</code> or be inside an aggregate. (SQLite lets you break this rule and quietly picks a value at random. Other databases refuse.)</p>
            <p>You can <code>ORDER BY</code> an aggregate's alias to rank the groups.</p>`,
          example: { sql: 'SELECT store_location, COUNT(*) AS sales\nFROM grocery_store_data\nGROUP BY store_location;', caption: 'Number of sales per store.' },
          task: '<p>Find the total revenue <strong>per category</strong>, highest first. Return <code>category</code> and <code>total_revenue</code> (rounded to 2 decimal places).</p>',
          starter: 'SELECT category\nFROM grocery_store_data\n',
          solution: 'SELECT category, ROUND(SUM(revenue), 2) AS total_revenue\nFROM grocery_store_data\nGROUP BY category\nORDER BY total_revenue DESC;',
          checkColumnNames: true,
          orderKeys: ['total_revenue'],
          hints: [
            'Group by `category` and sum `revenue` within each group.',
            'Round the sum, alias it `total_revenue`, then `ORDER BY total_revenue DESC`.',
            '`SELECT category, ROUND(SUM(revenue), 2) AS total_revenue FROM grocery_store_data GROUP BY category ORDER BY total_revenue DESC;`',
          ],
          takeaway: 'GROUP BY + an aggregate is the heart of most reporting queries: totals per category, counts per month, averages per region.',
        },
        {
          id: 'b20', module: 'Aggregating data', title: 'Filtering groups with HAVING', minutes: 6,
          tables: ['bank_statement'],
          concept: `
            <p><code>WHERE</code> filters <strong>rows</strong> before they're grouped. <code>HAVING</code> filters <strong>groups</strong> after aggregating, so it can use aggregates: <code>HAVING SUM(amount) &gt; 1000</code>.</p>
            <p>You can use both in one query: <code>WHERE</code> decides which rows go into the groups, <code>HAVING</code> decides which groups come out.</p>`,
          example: { sql: 'SELECT category, COUNT(*) AS n\nFROM bank_statement\nGROUP BY category\nHAVING COUNT(*) >= 10;', caption: 'Categories with at least 10 transactions.' },
          task: "<p>Which <strong>debit</strong> categories have total spending <strong>over $1,000</strong>? Return <code>category</code> and <code>total_spent</code> (rounded to 2 decimal places), highest first.</p>",
          starter: "SELECT category\nFROM bank_statement\nWHERE type = 'debit'\n",
          solution: "SELECT category, ROUND(SUM(amount), 2) AS total_spent\nFROM bank_statement\nWHERE type = 'debit'\nGROUP BY category\nHAVING SUM(amount) > 1000\nORDER BY total_spent DESC;",
          checkColumnNames: true,
          orderKeys: ['total_spent'],
          hints: [
            'Keep `WHERE type = \'debit\'`, then group by `category`.',
            'Filter the groups with `HAVING SUM(amount) > 1000`. `WHERE` can\'t use aggregates.',
            "`... GROUP BY category HAVING SUM(amount) > 1000 ORDER BY total_spent DESC;`",
          ],
          takeaway: 'WHERE filters rows, HAVING filters groups. If your condition uses an aggregate, it belongs in HAVING.',
        },
        {
          id: 'b21', module: 'Aggregating data', title: 'Putting it together: the six clauses', minutes: 8,
          tables: ['nfl_team_stats'],
          concept: `
            <p>You now know the six main clauses. They're always <em>written</em> in this order:</p>
            <p><code>SELECT</code> → <code>FROM</code> → <code>WHERE</code> → <code>GROUP BY</code> → <code>HAVING</code> → <code>ORDER BY</code> (then <code>LIMIT</code>)</p>
            <p>But the database <em>runs</em> them in a different order: FROM, WHERE, GROUP BY, HAVING, SELECT, ORDER BY, LIMIT. That explains two rules you've met: <code>WHERE</code> can't use aggregates (nothing's been grouped yet), and <code>ORDER BY</code> can use a SELECT alias (SELECT has already run).</p>`,
          example: { sql: "SELECT division, ROUND(AVG(points_for), 1) AS avg_points\nFROM nfl_team_stats\nWHERE conference = 'AFC'\nGROUP BY division\nORDER BY avg_points DESC;", caption: 'Average points scored by AFC division.' },
          task: "<p>Using seasons from <strong>2020 onward</strong>, find the <strong>NFC</strong> teams that averaged <strong>at least 10 wins</strong> per season. Return <code>team</code> and <code>avg_wins</code> (rounded to 1 decimal place), ordered by <code>avg_wins</code> highest first, then <code>team</code> alphabetically.</p>",
          starter: '-- SELECT ... FROM ... WHERE ... GROUP BY ... HAVING ... ORDER BY ...\n',
          solution: "SELECT team, ROUND(AVG(wins), 1) AS avg_wins\nFROM nfl_team_stats\nWHERE season >= 2020 AND conference = 'NFC'\nGROUP BY team\nHAVING AVG(wins) >= 10\nORDER BY avg_wins DESC, team;",
          checkColumnNames: true,
          hints: [
            'WHERE handles the season and conference; GROUP BY team; HAVING handles the average.',
            'Use `HAVING AVG(wins) >= 10` (compare the unrounded average) and round only in the SELECT list.',
            "`... WHERE season >= 2020 AND conference = 'NFC' GROUP BY team HAVING AVG(wins) >= 10 ORDER BY avg_wins DESC, team;`",
          ],
          takeaway: 'You can now answer real questions with all six clauses. Next level: combining tables with joins.',
        },
      ],
    },

    {
      id: 'intermediate',
      level: 'Intermediate',
      title: 'Joins & Combining Data',
      icon: 'ph-intersect',
      tagline: 'Combine tables with every kind of join, then layer on subqueries and set operations.',
      topics: ['Keys & relationships', 'INNER JOIN', 'LEFT / RIGHT JOIN', 'FULL OUTER JOIN', 'Self & CROSS joins', 'Joins + GROUP BY', 'UNION', 'Subqueries & EXISTS'],
      lessons: [
        {
          id: 'i01', module: 'Relational basics', title: 'How tables relate: keys', minutes: 4,
          tables: ['authors', 'books'],
          concept: `
            <p>Real databases split information across tables so nothing is stored twice. In the Page Turner Books store, each author is stored once in <code>authors</code>, and each book in <code>books</code> points back at its author.</p>
            <div class="learn-erd">
              <div class="learn-erd-table"><div class="learn-erd-name">authors</div><div class="learn-erd-col is-pk">author_id <span>PK</span></div><div class="learn-erd-col">name</div><div class="learn-erd-col">country</div></div>
              <div class="learn-erd-arrow" aria-hidden="true">←</div>
              <div class="learn-erd-table"><div class="learn-erd-name">books</div><div class="learn-erd-col is-pk">book_id <span>PK</span></div><div class="learn-erd-col">title</div><div class="learn-erd-col is-fk">author_id <span>FK</span></div></div>
            </div>
            <p>A <strong>primary key</strong> (PK) uniquely identifies each row: <code>authors.author_id</code>. A <strong>foreign key</strong> (FK) is a column in another table that refers to it: <code>books.author_id</code>. Joins, coming up next, follow these links.</p>`,
          example: { sql: 'SELECT * FROM authors\nWHERE author_id = 5;', caption: 'Author 5 is Haruki Murakami.' },
          task: '<p>Using the foreign key, list the books written by <strong>author 5</strong>. Return <code>title</code> and <code>published_year</code>, oldest first.</p>',
          starter: 'SELECT title, published_year\nFROM books\n',
          solution: 'SELECT title, published_year\nFROM books\nWHERE author_id = 5\nORDER BY published_year;',
          hints: [
            'You only need the `books` table: filter on its `author_id` column.',
            'Then sort by `published_year` ascending.',
            '`WHERE author_id = 5 ORDER BY published_year`',
          ],
          takeaway: 'Primary keys identify rows; foreign keys point at them. Every join you write follows one of these links.',
        },
        {
          id: 'i02', module: 'Relational basics', title: 'Table aliases and qualified columns', minutes: 4,
          tables: ['books'],
          concept: `
            <p>Once a query uses more than one table, you'll need to say which table a column comes from: <code>books.title</code>. That's a <strong>qualified</strong> column name.</p>
            <p>Typing full table names gets old, so give tables short <strong>aliases</strong>: <code>FROM books AS b</code>, then write <code>b.title</code>. (<code>AS</code> is optional for tables: <code>FROM books b</code> works too.)</p>`,
          example: { sql: "SELECT b.title, b.genre\nFROM books AS b\nWHERE b.genre = 'Mystery';", caption: 'Every column qualified with the alias b.' },
          task: '<p>Using the alias <code>b</code> for <code>books</code>, return the <code>title</code> and <code>pages</code> of books with <strong>more than 400 pages</strong>, longest first.</p>',
          starter: 'SELECT \nFROM books AS b\n',
          solution: 'SELECT b.title, b.pages\nFROM books AS b\nWHERE b.pages > 400\nORDER BY b.pages DESC;',
          orderKeys: ['pages'],
          mustUse: [{ pattern: '\\bb\\.(title|pages)\\b', message: 'Now write the columns with the alias, like `b.title` and `b.pages`.' }],
          hints: [
            'Prefix each column with `b.`.',
            'Filter with `b.pages > 400` and sort descending.',
            '`SELECT b.title, b.pages FROM books AS b WHERE b.pages > 400 ORDER BY b.pages DESC;`',
          ],
          takeaway: 'Aliases keep multi-table queries short. Qualifying every column (b.title, a.name) is a good habit even when it isn\'t strictly required.',
        },
        {
          id: 'i03', module: 'Inner joins', title: 'INNER JOIN', minutes: 6,
          tables: ['authors', 'books'],
          concept: `
            <p><code>JOIN</code> combines rows from two tables wherever the <code>ON</code> condition is true. Here, each book is paired with the author whose <code>author_id</code> matches.</p>
            ${venn('inner', 'books', 'authors')}
            <p>An <strong>INNER JOIN</strong> (plain <code>JOIN</code> means the same thing) keeps only rows that found a match. Books without an author, and authors without books, are dropped.</p>
            <pre><code>FROM books AS b
JOIN authors AS a ON b.author_id = a.author_id</code></pre>`,
          example: { sql: 'SELECT b.title, a.name\nFROM books AS b\nJOIN authors AS a ON b.author_id = a.author_id\nWHERE b.genre = \'Fantasy\';', caption: 'Fantasy books with their authors.' },
          task: '<p>Return every book\'s <code>title</code> alongside its author\'s <code>name</code> and <code>country</code>.</p>',
          starter: 'SELECT b.title, a.name, a.country\nFROM books AS b\n',
          solution: 'SELECT b.title, a.name, a.country\nFROM books AS b\nJOIN authors AS a ON b.author_id = a.author_id;',
          mustUse: [{ pattern: '\\bJOIN\\b', message: 'This lesson is about `JOIN`. Combine the tables with `JOIN ... ON ...`.' }],
          hints: [
            'Add `JOIN authors AS a` after the FROM line.',
            'The tables connect through `author_id`: `ON b.author_id = a.author_id`.',
            '`FROM books AS b JOIN authors AS a ON b.author_id = a.author_id`',
          ],
          takeaway: 'INNER JOIN keeps only matching pairs. Notice the anthology (no author) is missing from your result; outer joins are how you keep it.',
        },
        {
          id: 'i04', module: 'Inner joins', title: 'Joins with filters and sorting', minutes: 5,
          tables: ['authors', 'books'],
          concept: `
            <p>After a join, the combined rows behave like one wide table. <code>WHERE</code>, <code>ORDER BY</code>, and everything else work as usual, and can use columns from either side.</p>
            <p>Order of clauses doesn't change: <code>FROM ... JOIN ... ON ...</code> comes before <code>WHERE</code>.</p>`,
          example: { sql: "SELECT b.title, a.name, b.price\nFROM books AS b\nJOIN authors AS a ON b.author_id = a.author_id\nWHERE b.price > 20\nORDER BY b.price DESC;", caption: 'Filtering on a books column after the join.' },
          task: "<p>List the books by authors from the <code>'United Kingdom'</code>, with the author's name, oldest first. Return <code>title</code>, <code>name</code>, and <code>published_year</code>.</p>",
          starter: 'SELECT b.title, a.name, b.published_year\nFROM books AS b\nJOIN authors AS a ON b.author_id = a.author_id\n',
          solution: "SELECT b.title, a.name, b.published_year\nFROM books AS b\nJOIN authors AS a ON b.author_id = a.author_id\nWHERE a.country = 'United Kingdom'\nORDER BY b.published_year;",
          orderKeys: ['published_year'],
          hints: [
            'The country lives in `authors`, so filter on `a.country`.',
            'Sort by `b.published_year` ascending.',
            "`WHERE a.country = 'United Kingdom' ORDER BY b.published_year`",
          ],
          takeaway: 'Once tables are joined, you can filter and sort on any column from any of them.',
        },
        {
          id: 'i05', module: 'Inner joins', title: 'Joining three tables', minutes: 6,
          tables: ['orders', 'order_items', 'books'],
          concept: `
            <p>Joins chain: each <code>JOIN</code> adds one more table, with its own <code>ON</code>. Follow the keys from table to table.</p>
            <p><code>order_items</code> is a <strong>junction table</strong>: one order has many books and one book appears in many orders, so each row of <code>order_items</code> links one order to one book.</p>
            <pre><code>orders ──< order_items >── books</code></pre>`,
          example: { sql: 'SELECT o.order_id, o.order_date, oi.book_id, oi.quantity\nFROM orders AS o\nJOIN order_items AS oi ON oi.order_id = o.order_id\nWHERE o.order_id = 1006;', caption: 'The lines of one order (book ids only, so far).' },
          task: "<p>For every item in orders placed in <strong>December 2024</strong>, return <code>order_id</code>, <code>order_date</code>, the book <code>title</code>, and <code>quantity</code>, sorted by <code>order_id</code>.</p>",
          starter: 'SELECT o.order_id, o.order_date, b.title, oi.quantity\nFROM orders AS o\n',
          solution: "SELECT o.order_id, o.order_date, b.title, oi.quantity\nFROM orders AS o\nJOIN order_items AS oi ON oi.order_id = o.order_id\nJOIN books AS b ON b.book_id = oi.book_id\nWHERE o.order_date BETWEEN '2024-12-01' AND '2024-12-31'\nORDER BY o.order_id;",
          orderKeys: ['order_id'],
          hints: [
            'Join `order_items` on `order_id`, then `books` on `book_id`.',
            "Filter December with `BETWEEN '2024-12-01' AND '2024-12-31'` (or `LIKE '2024-12%'`).",
            "`FROM orders AS o JOIN order_items AS oi ON oi.order_id = o.order_id JOIN books AS b ON b.book_id = oi.book_id WHERE o.order_date BETWEEN '2024-12-01' AND '2024-12-31' ORDER BY o.order_id;`",
          ],
          takeaway: 'Multi-table joins are just one join at a time. Sketch the path of keys first (orders → order_items → books) and the query writes itself.',
        },
        {
          id: 'i06', module: 'Outer joins', title: 'LEFT JOIN', minutes: 6,
          tables: ['authors', 'books'],
          concept: `
            <p>A <strong>LEFT JOIN</strong> keeps <em>every</em> row from the left table (the one in <code>FROM</code>), matched or not. Where there's no match, the right table's columns come back as <code>NULL</code>.</p>
            ${venn('left', 'authors', 'books')}
            <p>Which table is "left" matters: <code>authors LEFT JOIN books</code> keeps all authors; <code>books LEFT JOIN authors</code> keeps all books.</p>`,
          example: { sql: "SELECT a.name, b.title\nFROM authors AS a\nLEFT JOIN books AS b ON b.author_id = a.author_id\nWHERE a.country = 'United States';", caption: 'US authors, including N. K. Jemisin, who has no books yet.' },
          task: '<p>List <strong>every author</strong> and the titles of their books, including authors with no books in the catalog (their <code>title</code> will be NULL). Return <code>name</code> and <code>title</code>.</p>',
          starter: 'SELECT a.name, b.title\nFROM authors AS a\n',
          solution: 'SELECT a.name, b.title\nFROM authors AS a\nLEFT JOIN books AS b ON b.author_id = a.author_id;',
          mustUse: [{ pattern: '\\bLEFT\\s+(OUTER\\s+)?JOIN\\b', message: 'This lesson is practicing `LEFT JOIN`. Try writing it with `authors` on the left.' }],
          hints: [
            '`authors` is the table you want to keep entirely, so it goes in `FROM`.',
            'Use `LEFT JOIN books AS b ON b.author_id = a.author_id`.',
            '`SELECT a.name, b.title FROM authors AS a LEFT JOIN books AS b ON b.author_id = a.author_id;`',
          ],
          takeaway: 'LEFT JOIN keeps everything on the left and fills gaps with NULL. It\'s the join you\'ll reach for whenever "including ones with none" appears in a question.',
        },
        {
          id: 'i07', module: 'Outer joins', title: 'Finding missing matches', minutes: 6,
          tables: ['customers', 'orders'],
          concept: `
            <p>Combine a LEFT JOIN with a NULL check to find rows that have <em>no</em> match. This is called an <strong>anti-join</strong>.</p>
            ${venn('anti', 'customers', 'orders')}
            <pre><code>FROM customers AS c
LEFT JOIN orders AS o ON o.customer_id = c.customer_id
WHERE o.order_id IS NULL</code></pre>
            <p>Unmatched customers get NULLs for every order column, so testing the order's primary key for NULL finds them.</p>`,
          example: { sql: 'SELECT c.first_name, o.order_id\nFROM customers AS c\nLEFT JOIN orders AS o ON o.customer_id = c.customer_id\nWHERE c.city = \'Denver\';', caption: 'Denver customers and their orders. Two have none.' },
          task: '<p>Find the customers who have <strong>never placed an order</strong>. Return <code>customer_id</code>, <code>first_name</code>, and <code>last_name</code>.</p>',
          starter: 'SELECT c.customer_id, c.first_name, c.last_name\nFROM customers AS c\n',
          solution: 'SELECT c.customer_id, c.first_name, c.last_name\nFROM customers AS c\nLEFT JOIN orders AS o ON o.customer_id = c.customer_id\nWHERE o.order_id IS NULL;',
          hints: [
            'Start with a LEFT JOIN from `customers` to `orders`.',
            'Keep only the rows where no order matched: the order columns are NULL.',
            '`... LEFT JOIN orders AS o ON o.customer_id = c.customer_id WHERE o.order_id IS NULL;`',
          ],
          takeaway: 'LEFT JOIN + IS NULL finds "who never did X". Watch out for NOT IN with a subquery here: orders has guest checkouts with a NULL customer_id, and a single NULL makes NOT IN return nothing.',
        },
        {
          id: 'i08', module: 'Outer joins', title: 'RIGHT JOIN', minutes: 5,
          tables: ['orders', 'customers'],
          concept: `
            <p>A <strong>RIGHT JOIN</strong> is the mirror image of a LEFT JOIN: it keeps every row from the <em>right</em> table (the one after <code>JOIN</code>).</p>
            ${venn('right', 'orders', 'customers')}
            <p>Any RIGHT JOIN can be rewritten as a LEFT JOIN by swapping the tables, which is why many people never use it. But you'll see it in other people's queries, so it's worth knowing. (SQLite added it in version 3.39.)</p>`,
          example: { sql: 'SELECT o.order_id, c.first_name\nFROM orders AS o\nRIGHT JOIN customers AS c ON c.customer_id = o.customer_id\nWHERE c.state = \'CO\';', caption: 'Every Colorado customer, with or without orders.' },
          task: '<p>Using a <code>RIGHT JOIN</code> with <code>orders</code> as the left table, list <strong>every customer</strong> with their order ids. Customers with no orders should appear with a NULL <code>order_id</code>. Return <code>first_name</code>, <code>last_name</code>, and <code>order_id</code>.</p>',
          starter: 'SELECT c.first_name, c.last_name, o.order_id\nFROM orders AS o\n',
          solution: 'SELECT c.first_name, c.last_name, o.order_id\nFROM orders AS o\nRIGHT JOIN customers AS c ON c.customer_id = o.customer_id;',
          mustUse: [{ pattern: '\\bRIGHT\\s+(OUTER\\s+)?JOIN\\b', message: 'This lesson is practicing `RIGHT JOIN`. Keep `orders` in FROM and right-join `customers`.' }],
          hints: [
            'Keep `FROM orders AS o` and add `RIGHT JOIN customers AS c`.',
            'Match on the customer id: `ON c.customer_id = o.customer_id`.',
            '`FROM orders AS o RIGHT JOIN customers AS c ON c.customer_id = o.customer_id;`',
          ],
          takeaway: 'A RIGHT JOIN B is the same as B LEFT JOIN A. Notice the guest-checkout orders don\'t appear: they have no customer, and the right side is what\'s kept.',
        },
        {
          id: 'i09', module: 'Outer joins', title: 'FULL OUTER JOIN', minutes: 5,
          tables: ['authors', 'books'],
          concept: `
            <p>A <strong>FULL OUTER JOIN</strong> keeps unmatched rows from <em>both</em> sides: every match, plus left rows with no partner, plus right rows with no partner.</p>
            ${venn('full', 'authors', 'books')}
            <p>It's the join for reconciliation: comparing two lists and seeing what's missing from either one.</p>`,
          example: { sql: "SELECT a.name, b.title\nFROM authors AS a\nFULL OUTER JOIN books AS b ON b.author_id = a.author_id\nWHERE a.author_id IS NULL OR b.book_id IS NULL;", caption: 'Only the unmatched rows, from both sides.' },
          task: '<p>Return every author <code>name</code> and book <code>title</code>, keeping authors with no books <strong>and</strong> books with no author.</p>',
          starter: 'SELECT a.name, b.title\nFROM authors AS a\n',
          solution: 'SELECT a.name, b.title\nFROM authors AS a\nFULL OUTER JOIN books AS b ON b.author_id = a.author_id;',
          mustUse: [{ pattern: '\\bFULL\\s+(OUTER\\s+)?JOIN\\b', message: 'This lesson is practicing `FULL OUTER JOIN`.' }],
          hints: [
            'You want unmatched rows from both tables.',
            'Replace the join type with `FULL OUTER JOIN`.',
            '`FROM authors AS a FULL OUTER JOIN books AS b ON b.author_id = a.author_id;`',
          ],
          takeaway: 'INNER keeps matches, LEFT/RIGHT add one side\'s leftovers, FULL adds both. Pick the join by asking which unmatched rows you need to keep.',
        },
        {
          id: 'i10', module: 'Outer joins', title: 'Self joins', minutes: 6,
          tables: ['employees'],
          concept: `
            <p>A table can be joined to <em>itself</em>. In <code>employees</code>, <code>manager_id</code> holds another employee's <code>employee_id</code>, so to see manager names you join employees to employees.</p>
            <p>The trick is two different aliases for the same table, one per role:</p>
            <pre><code>FROM employees AS e
JOIN employees AS m ON e.manager_id = m.employee_id</code></pre>`,
          example: { sql: 'SELECT e.first_name, e.manager_id, m.first_name AS manager_first_name\nFROM employees AS e\nJOIN employees AS m ON e.manager_id = m.employee_id\nWHERE e.department_id = 5;', caption: 'Support staff and their managers.' },
          task: "<p>List each employee who has a manager, as <code>employee_name</code>, with their manager as <code>manager_name</code>. Each name is <code>first_name</code> and <code>last_name</code> joined with a space (e.g. <code>'Rosa Alvarez'</code>).</p>",
          starter: 'SELECT \nFROM employees AS e\n',
          solution: "SELECT e.first_name || ' ' || e.last_name AS employee_name,\n       m.first_name || ' ' || m.last_name AS manager_name\nFROM employees AS e\nJOIN employees AS m ON e.manager_id = m.employee_id;",
          checkColumnNames: true,
          hints: [
            'Join `employees AS e` to `employees AS m` where `e.manager_id = m.employee_id`.',
            "Build each name with `||`: `e.first_name || ' ' || e.last_name`.",
            "`SELECT e.first_name || ' ' || e.last_name AS employee_name, m.first_name || ' ' || m.last_name AS manager_name FROM employees AS e JOIN employees AS m ON e.manager_id = m.employee_id;`",
          ],
          takeaway: 'Self joins model hierarchies and pairs within one table: managers, referrals, flights between airports. Two aliases, one table.',
        },
        {
          id: 'i11', module: 'Outer joins', title: 'CROSS JOIN', minutes: 4,
          tables: ['books', 'formats'],
          concept: `
            <p>A <strong>CROSS JOIN</strong> pairs every row of one table with every row of the other. It has no <code>ON</code>. 5 rows × 4 rows = 20 rows.</p>
            <p>It's how you build grids of every combination: each product in each size, each store on each day. (A join where you forget the <code>ON</code> condition accidentally does the same thing, which is a classic way to get millions of rows.)</p>`,
          example: { sql: "SELECT f.format, b.title\nFROM formats AS f\nCROSS JOIN books AS b\nWHERE b.book_id = 1;", caption: 'One book in every format.' },
          task: '<p>Build a list of <strong>every genre paired with every format</strong>. Return <code>genre</code> and <code>format</code>, each pair once, sorted by <code>genre</code> then <code>format</code>.</p>',
          starter: 'SELECT \nFROM books AS b\n',
          solution: 'SELECT DISTINCT b.genre, f.format\nFROM books AS b\nCROSS JOIN formats AS f\nORDER BY b.genre, f.format;',
          hints: [
            '`CROSS JOIN formats AS f` gives every book with every format.',
            'You want genres, not books, so add `DISTINCT` to remove repeats.',
            '`SELECT DISTINCT b.genre, f.format FROM books AS b CROSS JOIN formats AS f ORDER BY b.genre, f.format;`',
          ],
          takeaway: 'CROSS JOIN multiplies row counts. Useful on purpose, alarming by accident: if a join returns way too many rows, check its ON clause.',
        },
        {
          id: 'i12', module: 'Joins & aggregation', title: 'Counting across a join', minutes: 6,
          tables: ['authors', 'books'],
          concept: `
            <p>Joins and <code>GROUP BY</code> combine naturally: join first, then group the combined rows.</p>
            <p>A subtle point with LEFT JOIN: <code>COUNT(*)</code> counts rows, and an author with no books still produces one row (with NULLs), so they'd count as 1. <code>COUNT(b.book_id)</code> skips NULLs and correctly gives 0.</p>`,
          example: { sql: "SELECT a.country, COUNT(b.book_id) AS books\nFROM authors AS a\nLEFT JOIN books AS b ON b.author_id = a.author_id\nGROUP BY a.country;", caption: 'Books per author country.' },
          task: '<p>For <strong>every author</strong>, count their books in the catalog, including authors with zero. Return <code>name</code> and <code>book_count</code>, most books first, then <code>name</code> alphabetically.</p>',
          starter: 'SELECT a.name\nFROM authors AS a\n',
          solution: 'SELECT a.name, COUNT(b.book_id) AS book_count\nFROM authors AS a\nLEFT JOIN books AS b ON b.author_id = a.author_id\nGROUP BY a.author_id, a.name\nORDER BY book_count DESC, a.name;',
          checkColumnNames: true,
          hints: [
            'LEFT JOIN books so authors with no books stay in.',
            'Use `COUNT(b.book_id)`, not `COUNT(*)`, so empty authors count as 0.',
            '`... LEFT JOIN books AS b ON b.author_id = a.author_id GROUP BY a.author_id, a.name ORDER BY book_count DESC, a.name;`',
          ],
          takeaway: 'With LEFT JOIN + GROUP BY, count a column from the right table so missing matches count as zero.',
        },
        {
          id: 'i13', module: 'Joins & aggregation', title: 'Revenue by genre', minutes: 5,
          tables: ['order_items', 'books'],
          concept: `
            <p>Aggregates can sum calculations, not just columns: <code>SUM(oi.quantity * oi.unit_price)</code> is total revenue.</p>
            <p>A common pattern: the numbers live in one table (<code>order_items</code>) and the labels you want to group by live in another (<code>books.genre</code>). Join, then group by the label.</p>`,
          example: { sql: 'SELECT b.title, SUM(oi.quantity) AS copies_sold\nFROM order_items AS oi\nJOIN books AS b ON b.book_id = oi.book_id\nGROUP BY b.book_id, b.title\nORDER BY copies_sold DESC\nLIMIT 3;', caption: 'Best-selling titles by copies.' },
          task: '<p>Find total revenue (<code>quantity × unit_price</code>) <strong>per genre</strong>, highest first. Return <code>genre</code> and <code>revenue</code> (rounded to 2 decimal places).</p>',
          starter: 'SELECT b.genre\nFROM order_items AS oi\n',
          solution: 'SELECT b.genre, ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue\nFROM order_items AS oi\nJOIN books AS b ON b.book_id = oi.book_id\nGROUP BY b.genre\nORDER BY revenue DESC;',
          checkColumnNames: true,
          orderKeys: ['revenue'],
          hints: [
            'Join `books` on `book_id` to get each line\'s genre.',
            'Sum `oi.quantity * oi.unit_price` per `b.genre`, round it, and sort descending.',
            '`SELECT b.genre, ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue FROM order_items AS oi JOIN books AS b ON b.book_id = oi.book_id GROUP BY b.genre ORDER BY revenue DESC;`',
          ],
          takeaway: 'Join to pick up labels, group by the label, aggregate the measure. That\'s most dashboards in one sentence.',
        },
        {
          id: 'i14', module: 'Joins & aggregation', title: 'Filtering joined groups', minutes: 6,
          tables: ['customers', 'orders', 'order_items'],
          concept: `
            <p><code>HAVING</code> works on joined data too. Join, group, then keep only the groups whose aggregate passes the test.</p>
            <p>Group by the customer's id as well as their name: two different customers can share a name, and grouping by name alone would merge them.</p>`,
          example: { sql: 'SELECT c.first_name, c.last_name, COUNT(*) AS orders_placed\nFROM customers AS c\nJOIN orders AS o ON o.customer_id = c.customer_id\nGROUP BY c.customer_id, c.first_name, c.last_name\nHAVING COUNT(*) >= 4;', caption: 'Customers with at least four orders.' },
          task: '<p>Find customers who have spent <strong>more than $100</strong> in total across all their orders. Return <code>first_name</code>, <code>last_name</code>, and <code>total_spent</code> (rounded to 2 decimal places), highest first.</p>',
          starter: 'SELECT c.first_name, c.last_name\nFROM customers AS c\n',
          solution: 'SELECT c.first_name, c.last_name, ROUND(SUM(oi.quantity * oi.unit_price), 2) AS total_spent\nFROM customers AS c\nJOIN orders AS o ON o.customer_id = c.customer_id\nJOIN order_items AS oi ON oi.order_id = o.order_id\nGROUP BY c.customer_id, c.first_name, c.last_name\nHAVING SUM(oi.quantity * oi.unit_price) > 100\nORDER BY total_spent DESC;',
          checkColumnNames: true,
          orderKeys: ['total_spent'],
          hints: [
            'Chain customers → orders → order_items.',
            'Group by the customer, and filter with `HAVING SUM(oi.quantity * oi.unit_price) > 100`.',
            '`... GROUP BY c.customer_id, c.first_name, c.last_name HAVING SUM(oi.quantity * oi.unit_price) > 100 ORDER BY total_spent DESC;`',
          ],
          takeaway: 'Joins + GROUP BY + HAVING answers "which customers / products / regions crossed a threshold" questions.',
        },
        {
          id: 'i15', module: 'Subqueries & set operations', title: 'Stacking results with UNION', minutes: 5,
          tables: ['customers', 'employees'],
          concept: `
            <p>Joins combine tables side by side. <code>UNION</code> stacks query results <em>on top of each other</em>.</p>
            <ul>
              <li>Both queries must return the same number of columns, in matching order.</li>
              <li><code>UNION</code> removes duplicate rows; <code>UNION ALL</code> keeps them (and is faster).</li>
              <li>One <code>ORDER BY</code> at the very end sorts the combined result.</li>
            </ul>
            <p>A literal like <code>'customer' AS role</code> is handy for labeling which query a row came from.</p>`,
          example: { sql: "SELECT first_name FROM customers WHERE city = 'Austin'\nUNION\nSELECT first_name FROM employees WHERE department_id = 3;", caption: 'First names from two tables, stacked into one column.' },
          task: "<p>Build one contact list of everyone: <code>first_name</code>, <code>last_name</code>, and a <code>role</code> column that says <code>'customer'</code> or <code>'employee'</code>. Sort by <code>last_name</code>, then <code>first_name</code>.</p>",
          starter: "SELECT first_name, last_name, 'customer' AS role\nFROM customers\n",
          solution: "SELECT first_name, last_name, 'customer' AS role\nFROM customers\nUNION ALL\nSELECT first_name, last_name, 'employee' AS role\nFROM employees\nORDER BY last_name, first_name;",
          checkColumnNames: true,
          orderKeys: ['last_name', 'first_name'],
          hints: [
            'Write a second SELECT on `employees` with `\'employee\' AS role`.',
            'Put `UNION ALL` (or `UNION`) between them, and one `ORDER BY` at the very end.',
            "`... FROM customers UNION ALL SELECT first_name, last_name, 'employee' AS role FROM employees ORDER BY last_name, first_name;`",
          ],
          takeaway: 'UNION stacks, JOIN widens. Use UNION ALL unless you specifically need duplicates removed.',
        },
        {
          id: 'i16', module: 'Subqueries & set operations', title: 'Subqueries in WHERE', minutes: 5,
          tables: ['books'],
          concept: `
            <p>A <strong>subquery</strong> is a query inside another query, in parentheses. The inner one runs first and its result is plugged into the outer one.</p>
            <pre><code>WHERE price > (SELECT AVG(price) FROM books)</code></pre>
            <p>A subquery used with <code>&gt;</code>, <code>=</code>, and friends must return exactly one value (one row, one column). That's called a <strong>scalar subquery</strong>.</p>`,
          example: { sql: 'SELECT title, pages\nFROM books\nWHERE pages = (SELECT MAX(pages) FROM books);', caption: 'The longest book, without hard-coding its page count.' },
          task: '<p>Return the <code>title</code> and <code>price</code> of books that cost <strong>more than the average book price</strong>, most expensive first.</p>',
          starter: 'SELECT title, price\nFROM books\nWHERE ',
          solution: 'SELECT title, price\nFROM books\nWHERE price > (SELECT AVG(price) FROM books)\nORDER BY price DESC;',
          orderKeys: ['price'],
          mustUse: [{ pattern: '\\(\\s*SELECT\\b', message: 'Compute the average with a subquery, `(SELECT AVG(price) FROM books)`, instead of typing a number.' }],
          hints: [
            'The average price is `(SELECT AVG(price) FROM books)`.',
            'Compare `price` to it in WHERE, then sort descending.',
            '`WHERE price > (SELECT AVG(price) FROM books) ORDER BY price DESC;`',
          ],
          takeaway: 'Subqueries let one query use another\'s answer. When the data changes, the average updates itself; a typed-in number wouldn\'t.',
        },
        {
          id: 'i17', module: 'Subqueries & set operations', title: 'IN with a subquery', minutes: 6,
          tables: ['customers', 'orders', 'order_items', 'books'],
          concept: `
            <p><code>IN</code> accepts a subquery that returns one column of values: <code>WHERE customer_id IN (SELECT customer_id FROM orders ...)</code>.</p>
            <p>This often reads more naturally than a join when you only need to <em>filter</em> by another table, and it never produces duplicate rows the way a join can.</p>`,
          example: { sql: "SELECT title\nFROM books\nWHERE book_id IN (SELECT book_id FROM order_items WHERE quantity >= 3);", caption: 'Books someone bought three or more copies of at once.' },
          task: "<p>Find the customers who have bought at least one <code>'Mystery'</code> book. Return <code>customer_id</code>, <code>first_name</code>, and <code>last_name</code>, each customer once, sorted by <code>customer_id</code>.</p>",
          starter: 'SELECT customer_id, first_name, last_name\nFROM customers\nWHERE customer_id IN (\n  \n)\n',
          solution: "SELECT customer_id, first_name, last_name\nFROM customers\nWHERE customer_id IN (\n  SELECT o.customer_id\n  FROM orders AS o\n  JOIN order_items AS oi ON oi.order_id = o.order_id\n  JOIN books AS b ON b.book_id = oi.book_id\n  WHERE b.genre = 'Mystery'\n)\nORDER BY customer_id;",
          hints: [
            'The subquery should return the `customer_id` of every order containing a Mystery book.',
            'Inside it, join orders → order_items → books and filter `b.genre = \'Mystery\'`.',
            "`WHERE customer_id IN (SELECT o.customer_id FROM orders AS o JOIN order_items AS oi ON oi.order_id = o.order_id JOIN books AS b ON b.book_id = oi.book_id WHERE b.genre = 'Mystery') ORDER BY customer_id;`",
          ],
          takeaway: 'IN (subquery) filters without duplicating rows. The equivalent join needs DISTINCT, because a customer who bought three Mystery books would appear three times.',
        },
        {
          id: 'i18', module: 'Subqueries & set operations', title: 'Subqueries in FROM', minutes: 6,
          tables: ['orders', 'order_items'],
          concept: `
            <p>A subquery can also stand in for a table in <code>FROM</code>. This is called a <strong>derived table</strong>, and it must have an alias.</p>
            <p>It's how you aggregate an aggregate: first total each order, then average those totals.</p>
            <pre><code>SELECT AVG(order_total)
FROM (SELECT order_id, SUM(...) AS order_total
      FROM order_items GROUP BY order_id) AS t</code></pre>`,
          example: { sql: 'SELECT MAX(items) AS most_lines_in_an_order\nFROM (\n  SELECT order_id, COUNT(*) AS items\n  FROM order_items\n  GROUP BY order_id\n) AS per_order;', caption: 'Count per order, then the max of those counts.' },
          task: '<p>What\'s the <strong>average order value</strong>? First total each order (sum of <code>quantity × unit_price</code>), then average those totals. Return one column, <code>avg_order_value</code>, rounded to 2 decimal places.</p>',
          starter: 'SELECT \nFROM (\n  \n) AS t;',
          solution: 'SELECT ROUND(AVG(order_total), 2) AS avg_order_value\nFROM (\n  SELECT order_id, SUM(quantity * unit_price) AS order_total\n  FROM order_items\n  GROUP BY order_id\n) AS t;',
          checkColumnNames: true,
          hints: [
            'Inner query: `SELECT order_id, SUM(quantity * unit_price) AS order_total FROM order_items GROUP BY order_id`.',
            'Outer query: average `order_total` and round it.',
            '`SELECT ROUND(AVG(order_total), 2) AS avg_order_value FROM (SELECT order_id, SUM(quantity * unit_price) AS order_total FROM order_items GROUP BY order_id) AS t;`',
          ],
          takeaway: 'AVG(price) across all items is not the same as the average order value. Derived tables let you aggregate at the right level first.',
        },
        {
          id: 'i19', module: 'Subqueries & set operations', title: 'EXISTS and NOT EXISTS', minutes: 6,
          tables: ['books', 'order_items'],
          concept: `
            <p><code>EXISTS (subquery)</code> is true if the subquery returns any row at all. It's usually <strong>correlated</strong>: the subquery refers to the outer query's current row.</p>
            <pre><code>WHERE NOT EXISTS (
  SELECT 1 FROM order_items AS oi
  WHERE oi.book_id = b.book_id
)</code></pre>
            <p>For each book, that checks "is there any order line for this book?". <code>SELECT 1</code> is a convention: the columns don't matter, only whether a row exists.</p>`,
          example: { sql: 'SELECT b.title\nFROM books AS b\nWHERE EXISTS (\n  SELECT 1 FROM order_items AS oi\n  WHERE oi.book_id = b.book_id AND oi.quantity >= 3\n);', caption: 'Books with at least one 3+ copy order line.' },
          task: '<p>Find the books that have <strong>never been ordered</strong>, using <code>NOT EXISTS</code>. Return <code>book_id</code> and <code>title</code>.</p>',
          starter: 'SELECT b.book_id, b.title\nFROM books AS b\nWHERE ',
          solution: 'SELECT b.book_id, b.title\nFROM books AS b\nWHERE NOT EXISTS (\n  SELECT 1 FROM order_items AS oi\n  WHERE oi.book_id = b.book_id\n);',
          mustUse: [{ pattern: '\\bEXISTS\\s*\\(', message: 'This lesson is practicing `NOT EXISTS`. Try writing the filter with it.' }],
          hints: [
            'Use `WHERE NOT EXISTS ( ... )`.',
            'Inside, select from `order_items` where its `book_id` equals the outer `b.book_id`.',
            '`WHERE NOT EXISTS (SELECT 1 FROM order_items AS oi WHERE oi.book_id = b.book_id);`',
          ],
          takeaway: 'NOT EXISTS is the safest way to ask "has no matching row". Unlike NOT IN, it isn\'t thrown off by NULLs.',
        },
        {
          id: 'i20', module: 'Subqueries & set operations', title: 'Capstone: best customers report', minutes: 8,
          tables: ['customers', 'orders', 'order_items'],
          concept: `
            <p>Time to combine everything: multiple joins, a filter, grouping, two different aggregates, sorting, and a limit.</p>
            <p>One new detail: when a join multiplies rows (an order with three items appears three times), <code>COUNT(*)</code> counts the items, not the orders. <code>COUNT(DISTINCT o.order_id)</code> counts each order once.</p>`,
          example: { sql: "SELECT o.status, COUNT(DISTINCT o.order_id) AS orders, COUNT(*) AS item_lines\nFROM orders AS o\nJOIN order_items AS oi ON oi.order_id = o.order_id\nGROUP BY o.status;", caption: 'COUNT(DISTINCT) vs COUNT(*) after a join.' },
          task: "<p>Report the <strong>top 3 customers</strong> by total spend on <code>'delivered'</code> orders. Return <code>first_name</code>, <code>last_name</code>, <code>orders_count</code> (number of delivered orders), and <code>total_spent</code> (rounded to 2 decimal places), highest spend first.</p>",
          starter: '-- customers → orders → order_items, delivered only, top 3 by spend\n',
          solution: "SELECT c.first_name, c.last_name,\n       COUNT(DISTINCT o.order_id) AS orders_count,\n       ROUND(SUM(oi.quantity * oi.unit_price), 2) AS total_spent\nFROM customers AS c\nJOIN orders AS o ON o.customer_id = c.customer_id\nJOIN order_items AS oi ON oi.order_id = o.order_id\nWHERE o.status = 'delivered'\nGROUP BY c.customer_id, c.first_name, c.last_name\nORDER BY total_spent DESC\nLIMIT 3;",
          checkColumnNames: true,
          orderKeys: ['total_spent'],
          hints: [
            'Join customers → orders → order_items and filter `o.status = \'delivered\'`.',
            'Group by customer; use `COUNT(DISTINCT o.order_id)` and `SUM(oi.quantity * oi.unit_price)`.',
            'Finish with `ORDER BY total_spent DESC LIMIT 3`.',
          ],
          takeaway: 'You can now join, filter, aggregate, and rank across a whole relational schema. Next level: analytics with CASE, CTEs, and window functions.',
        },
      ],
    },

    {
      id: 'advanced',
      level: 'Advanced',
      title: 'Analytics SQL',
      icon: 'ph-rocket-launch',
      tagline: 'Conditional logic, CTEs, and window functions: the SQL analysts use every day.',
      topics: ['CASE', 'COALESCE', 'CTEs (WITH)', 'Recursive CTEs', 'OVER & PARTITION BY', 'ROW_NUMBER, RANK, DENSE_RANK', 'Running totals & LAG', 'Window frames', 'Dates'],
      lessons: [
        {
          id: 'a01', module: 'Conditional logic', title: 'CASE expressions', minutes: 5,
          tables: ['books'],
          concept: `
            <p><code>CASE</code> is SQL's if/else. It checks conditions top to bottom and returns the value for the first one that's true:</p>
            <pre><code>CASE
  WHEN price &lt; 15 THEN 'budget'
  WHEN price &lt; 20 THEN 'standard'
  ELSE 'premium'
END AS price_tier</code></pre>
            <p>Because the first match wins, the second condition only needs <code>&lt; 20</code>: anything under 15 was already caught. Without an <code>ELSE</code>, unmatched rows get NULL.</p>`,
          example: { sql: "SELECT title, pages,\n       CASE WHEN pages > 400 THEN 'long' ELSE 'short' END AS length\nFROM books;", caption: 'A two-way CASE.' },
          task: "<p>Label each book's price as <code>'budget'</code> (under $15), <code>'standard'</code> ($15 up to but not including $20), or <code>'premium'</code> ($20 and up). Return <code>title</code>, <code>price</code>, and <code>price_tier</code>.</p>",
          starter: 'SELECT title, price,\n       CASE\n         \n       END AS price_tier\nFROM books;',
          solution: "SELECT title, price,\n       CASE\n         WHEN price < 15 THEN 'budget'\n         WHEN price < 20 THEN 'standard'\n         ELSE 'premium'\n       END AS price_tier\nFROM books;",
          checkColumnNames: true,
          hints: [
            'Two `WHEN ... THEN ...` lines and an `ELSE`.',
            "Order matters: test `price < 15` first, then `price < 20`, and `ELSE 'premium'`.",
            "`CASE WHEN price < 15 THEN 'budget' WHEN price < 20 THEN 'standard' ELSE 'premium' END AS price_tier`",
          ],
          takeaway: 'CASE turns numbers into categories. Order conditions from most to least specific, and add an ELSE so nothing silently becomes NULL.',
        },
        {
          id: 'a02', module: 'Conditional logic', title: 'Conditional aggregation', minutes: 6,
          tables: ['orders'],
          concept: `
            <p>Put a <code>CASE</code> inside an aggregate to count or sum only some rows, several different ways, in one pass:</p>
            <pre><code>SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered</code></pre>
            <p>This "pivots" values from rows into columns. SQLite also supports the shorter <code>COUNT(*) FILTER (WHERE status = 'delivered')</code>.</p>`,
          example: { sql: "SELECT strftime('%m', order_date) AS month,\n       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,\n       COUNT(*) AS total\nFROM orders\nGROUP BY month;", caption: 'Delivered vs total orders by month.' },
          task: "<p>Summarize all orders in <strong>one row</strong> with four columns: <code>total_orders</code>, <code>delivered</code>, <code>in_progress</code> (<code>'shipped'</code> or <code>'processing'</code>), and <code>problems</code> (<code>'cancelled'</code> or <code>'returned'</code>).</p>",
          starter: "SELECT COUNT(*) AS total_orders,\n       \nFROM orders;",
          solution: "SELECT COUNT(*) AS total_orders,\n       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,\n       SUM(CASE WHEN status IN ('shipped', 'processing') THEN 1 ELSE 0 END) AS in_progress,\n       SUM(CASE WHEN status IN ('cancelled', 'returned') THEN 1 ELSE 0 END) AS problems\nFROM orders;",
          checkColumnNames: true,
          hints: [
            "Each column is `SUM(CASE WHEN <condition> THEN 1 ELSE 0 END)`.",
            "Use `IN ('shipped', 'processing')` for the two-status columns.",
            "`SUM(CASE WHEN status IN ('cancelled', 'returned') THEN 1 ELSE 0 END) AS problems`",
          ],
          takeaway: 'Conditional aggregation builds whole summary tables in a single query. It\'s the SQL version of a pivot table.',
        },
        {
          id: 'a03', module: 'Conditional logic', title: 'Handling NULLs with COALESCE', minutes: 5,
          tables: ['employees', 'departments'],
          concept: `
            <p><code>COALESCE(a, b, ...)</code> returns the first argument that isn't NULL. It's the standard way to give missing values a default: <code>COALESCE(d.name, 'Unassigned')</code>.</p>
            <p>Its counterpart <code>NULLIF(a, b)</code> returns NULL when <code>a = b</code>. The classic use is avoiding division by zero: <code>x / NULLIF(y, 0)</code>.</p>`,
          example: { sql: "SELECT first_name, COALESCE(manager_id, 0) AS manager_or_zero\nFROM employees\nWHERE employee_id <= 3;", caption: 'The CEO\'s NULL manager becomes 0.' },
          task: "<p>List <strong>every employee</strong> with their department name, showing <code>'Unassigned'</code> when they have none. Return <code>first_name</code>, <code>last_name</code>, and <code>department</code>.</p>",
          starter: 'SELECT e.first_name, e.last_name\nFROM employees AS e\n',
          solution: "SELECT e.first_name, e.last_name, COALESCE(d.name, 'Unassigned') AS department\nFROM employees AS e\nLEFT JOIN departments AS d ON d.department_id = e.department_id;",
          checkColumnNames: true,
          hints: [
            'LEFT JOIN departments so the employee without a department stays in.',
            "Wrap the department name: `COALESCE(d.name, 'Unassigned') AS department`.",
            "`SELECT e.first_name, e.last_name, COALESCE(d.name, 'Unassigned') AS department FROM employees AS e LEFT JOIN departments AS d ON d.department_id = e.department_id;`",
          ],
          takeaway: 'LEFT JOIN + COALESCE is a reporting staple: keep every row, and replace the gaps with a readable label.',
        },
        {
          id: 'a04', module: 'Common table expressions', title: 'CTEs with WITH', minutes: 6,
          tables: ['orders', 'order_items'],
          concept: `
            <p>A <strong>common table expression</strong> (CTE) names a subquery up front, so the main query can use it like a table:</p>
            <pre><code>WITH order_totals AS (
  SELECT order_id, SUM(quantity * unit_price) AS order_total
  FROM order_items
  GROUP BY order_id
)
SELECT * FROM order_totals WHERE order_total > 50;</code></pre>
            <p>It does what a derived table does, but reads top to bottom, and you can reference it more than once.</p>`,
          example: { sql: "WITH delivered AS (\n  SELECT * FROM orders WHERE status = 'delivered'\n)\nSELECT COUNT(*) AS delivered_orders FROM delivered;", caption: 'A CTE used like a table.' },
          task: '<p>Using a CTE named <code>order_totals</code> that totals each order, return the orders whose total is <strong>above $50</strong>: <code>order_id</code> and <code>order_total</code> (rounded to 2 decimal places), largest first.</p>',
          starter: 'WITH order_totals AS (\n  \n)\nSELECT \nFROM order_totals\n',
          solution: 'WITH order_totals AS (\n  SELECT order_id, SUM(quantity * unit_price) AS order_total\n  FROM order_items\n  GROUP BY order_id\n)\nSELECT order_id, ROUND(order_total, 2) AS order_total\nFROM order_totals\nWHERE order_total > 50\nORDER BY order_total DESC;',
          checkColumnNames: true,
          orderKeys: ['order_total'],
          mustUse: [{ pattern: '^\\s*WITH\\b', message: 'This lesson is practicing CTEs. Start the query with `WITH order_totals AS (...)`.' }],
          hints: [
            'Inside the CTE: total `quantity * unit_price` per `order_id`.',
            'In the main query, filter `order_total > 50`, round it, and sort descending.',
            '`WITH order_totals AS (SELECT order_id, SUM(quantity * unit_price) AS order_total FROM order_items GROUP BY order_id) SELECT order_id, ROUND(order_total, 2) AS order_total FROM order_totals WHERE order_total > 50 ORDER BY order_total DESC;`',
          ],
          takeaway: 'CTEs make complex queries readable: name each step, then build on it. Most analysts reach for a CTE before a nested subquery.',
        },
        {
          id: 'a05', module: 'Common table expressions', title: 'Chaining CTEs', minutes: 7,
          tables: ['customers', 'orders', 'order_items'],
          concept: `
            <p>One <code>WITH</code> can define several CTEs, separated by commas, and later ones can use earlier ones:</p>
            <pre><code>WITH step_one AS (...),
     step_two AS (SELECT ... FROM step_one)
SELECT ... FROM step_two;</code></pre>
            <p>This lets you break an analysis into small, testable steps, like a recipe.</p>`,
          example: { sql: "WITH per_city AS (\n  SELECT city, COUNT(*) AS n FROM customers GROUP BY city\n),\nbiggest AS (\n  SELECT MAX(n) AS max_n FROM per_city\n)\nSELECT city, n FROM per_city, biggest WHERE n = max_n;", caption: 'Cities with the most customers.' },
          task: '<p>Find customers whose total spend is <strong>above the average customer\'s total spend</strong>. Use a CTE for each customer\'s total, then compare against the average of those totals. Return <code>first_name</code>, <code>last_name</code>, and <code>total_spent</code> (rounded to 2 decimal places), highest first.</p>',
          starter: 'WITH customer_spend AS (\n  \n)\n',
          solution: 'WITH customer_spend AS (\n  SELECT o.customer_id, SUM(oi.quantity * oi.unit_price) AS total_spent\n  FROM orders AS o\n  JOIN order_items AS oi ON oi.order_id = o.order_id\n  WHERE o.customer_id IS NOT NULL\n  GROUP BY o.customer_id\n),\naverage_spend AS (\n  SELECT AVG(total_spent) AS avg_spent FROM customer_spend\n)\nSELECT c.first_name, c.last_name, ROUND(s.total_spent, 2) AS total_spent\nFROM customer_spend AS s\nJOIN customers AS c ON c.customer_id = s.customer_id\nCROSS JOIN average_spend AS a\nWHERE s.total_spent > a.avg_spent\nORDER BY s.total_spent DESC;',
          checkColumnNames: true,
          orderKeys: ['total_spent'],
          hints: [
            'CTE 1, `customer_spend`: total spend per `customer_id` (skip guest orders with a NULL customer_id).',
            'CTE 2: `SELECT AVG(total_spent) AS avg_spent FROM customer_spend`.',
            'Main query: join `customer_spend` to `customers`, cross join the average, keep `total_spent > avg_spent`, sort descending.',
          ],
          takeaway: 'Chained CTEs turn a hard question into several easy ones. If a step looks wrong, you can SELECT from that CTE alone to check it.',
        },
        {
          id: 'a06', module: 'Common table expressions', title: 'Recursive CTEs', minutes: 8,
          tables: ['employees'],
          concept: `
            <p>A <code>WITH RECURSIVE</code> CTE refers to itself, which lets it walk a hierarchy of any depth. It has two parts joined by <code>UNION ALL</code>:</p>
            <pre><code>WITH RECURSIVE chain AS (
  SELECT employee_id, 1 AS level       -- anchor: where to start
  FROM employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.employee_id, c.level + 1    -- step: one level down
  FROM employees AS e
  JOIN chain AS c ON e.manager_id = c.employee_id
)
SELECT * FROM chain;</code></pre>
            <p>The step repeats, each time finding the reports of the rows found last time, until it finds nothing new.</p>`,
          example: { sql: 'WITH RECURSIVE counter AS (\n  SELECT 1 AS n\n  UNION ALL\n  SELECT n + 1 FROM counter WHERE n < 5\n)\nSELECT n FROM counter;', caption: 'Counting 1 to 5 recursively.' },
          task: '<p>Build the org chart: every employee with their <code>level</code>, where the CEO (no manager) is level 1, their direct reports are level 2, and so on. Return <code>employee_id</code>, <code>first_name</code>, and <code>level</code>, sorted by <code>level</code> then <code>employee_id</code>.</p>',
          starter: 'WITH RECURSIVE org AS (\n  -- anchor: the CEO\n  \n  UNION ALL\n  -- step: employees whose manager is already in org\n  \n)\nSELECT employee_id, first_name, level\nFROM org\nORDER BY level, employee_id;',
          solution: 'WITH RECURSIVE org AS (\n  SELECT employee_id, first_name, 1 AS level\n  FROM employees\n  WHERE manager_id IS NULL\n  UNION ALL\n  SELECT e.employee_id, e.first_name, o.level + 1\n  FROM employees AS e\n  JOIN org AS o ON e.manager_id = o.employee_id\n)\nSELECT employee_id, first_name, level\nFROM org\nORDER BY level, employee_id;',
          checkColumnNames: true,
          mustUse: [{ pattern: '\\bRECURSIVE\\b', message: 'This lesson is practicing recursive CTEs. Build the levels with `WITH RECURSIVE`.' }],
          hints: [
            'Anchor: `SELECT employee_id, first_name, 1 AS level FROM employees WHERE manager_id IS NULL`.',
            'Step: join `employees AS e` to `org AS o` on `e.manager_id = o.employee_id`, selecting `o.level + 1`.',
            'Connect the two with `UNION ALL` inside `WITH RECURSIVE org AS ( ... )`.',
          ],
          takeaway: 'Recursive CTEs handle trees and graphs: org charts, category hierarchies, bill of materials. Always make sure the step eventually finds nothing, or it never stops.',
        },
        {
          id: 'a07', module: 'Window functions', title: 'Window functions with OVER()', minutes: 6,
          tables: ['books'],
          concept: `
            <p>A <strong>window function</strong> calculates across a set of rows, but unlike <code>GROUP BY</code> it doesn't collapse them: every row keeps its own line and gains the calculated value.</p>
            <pre><code>SELECT title, price, AVG(price) OVER () AS avg_price
FROM books;</code></pre>
            <p><code>OVER ()</code> with empty parentheses means "the window is every row". Each book now sits next to the overall average, so you can compare them directly.</p>`,
          example: { sql: 'SELECT title, pages, SUM(pages) OVER () AS total_pages\nFROM books;', caption: 'Each book next to the catalog\'s total page count.' },
          task: '<p>Return each book\'s <code>title</code>, <code>price</code>, the average price of all books as <code>avg_price</code>, and <code>diff_from_avg</code> (price minus the average). Round both calculated columns to 2 decimal places.</p>',
          starter: 'SELECT title, price\nFROM books;',
          solution: 'SELECT title, price,\n       ROUND(AVG(price) OVER (), 2) AS avg_price,\n       ROUND(price - AVG(price) OVER (), 2) AS diff_from_avg\nFROM books;',
          checkColumnNames: true,
          mustUse: [{ pattern: '\\bOVER\\s*\\(', message: 'This lesson is practicing window functions. Use `AVG(price) OVER ()`.' }],
          hints: [
            '`AVG(price) OVER ()` gives the overall average on every row.',
            'Subtract it from `price` for the difference, and round both.',
            '`ROUND(AVG(price) OVER (), 2) AS avg_price, ROUND(price - AVG(price) OVER (), 2) AS diff_from_avg`',
          ],
          takeaway: 'Window functions add context to each row without losing detail. GROUP BY answers "what\'s the average?"; OVER answers "how does each row compare to it?".',
        },
        {
          id: 'a08', module: 'Window functions', title: 'PARTITION BY', minutes: 6,
          tables: ['books'],
          concept: `
            <p><code>PARTITION BY</code> splits the window into groups, like GROUP BY, but still without collapsing rows. Each row's calculation only sees rows from its own partition.</p>
            <pre><code>AVG(price) OVER (PARTITION BY genre)</code></pre>
            <p>Every Fantasy book gets the Fantasy average, every Mystery book the Mystery average, and so on.</p>`,
          example: { sql: 'SELECT title, genre, COUNT(*) OVER (PARTITION BY genre) AS books_in_genre\nFROM books;', caption: 'How many books share each book\'s genre.' },
          task: '<p>For each book, return <code>title</code>, <code>genre</code>, <code>price</code>, and <code>genre_avg_price</code>: the average price within its genre, rounded to 2 decimal places.</p>',
          starter: 'SELECT title, genre, price\nFROM books;',
          solution: 'SELECT title, genre, price,\n       ROUND(AVG(price) OVER (PARTITION BY genre), 2) AS genre_avg_price\nFROM books;',
          checkColumnNames: true,
          mustUse: [{ pattern: '\\bPARTITION\\s+BY\\b', message: 'This lesson is practicing `PARTITION BY`. Use `AVG(price) OVER (PARTITION BY genre)`.' }],
          hints: [
            'Same as last lesson, but put `PARTITION BY genre` inside the `OVER ( )`.',
            'Round to 2 decimal places and alias it `genre_avg_price`.',
            '`ROUND(AVG(price) OVER (PARTITION BY genre), 2) AS genre_avg_price`',
          ],
          takeaway: 'PARTITION BY is GROUP BY that keeps every row. Use it whenever you need a row-level comparison against its group.',
        },
        {
          id: 'a09', module: 'Window functions', title: 'Numbering rows with ROW_NUMBER', minutes: 6,
          tables: ['orders'],
          concept: `
            <p><code>ROW_NUMBER()</code> numbers rows 1, 2, 3... in the order given inside <code>OVER</code>. With <code>PARTITION BY</code>, numbering restarts for each group:</p>
            <pre><code>ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date)</code></pre>
            <p>That gives each customer's orders a sequence number: 1 for their first order, 2 for their second, and so on.</p>`,
          example: { sql: 'SELECT order_id, order_date,\n       ROW_NUMBER() OVER (ORDER BY order_date) AS nth_order_overall\nFROM orders\nLIMIT 5;', caption: 'Numbering every order by date.' },
          task: '<p>Number each customer\'s orders from first to most recent. Return <code>customer_id</code>, <code>order_id</code>, <code>order_date</code>, and <code>order_number</code>. Leave out guest orders (no <code>customer_id</code>).</p>',
          starter: 'SELECT customer_id, order_id, order_date\nFROM orders\nWHERE customer_id IS NOT NULL;',
          solution: 'SELECT customer_id, order_id, order_date,\n       ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date) AS order_number\nFROM orders\nWHERE customer_id IS NOT NULL;',
          checkColumnNames: true,
          hints: [
            'Use `ROW_NUMBER() OVER ( ... )` as a new column.',
            'Partition by `customer_id`, order by `order_date`.',
            '`ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_date) AS order_number`',
          ],
          takeaway: 'ROW_NUMBER is how you find "first", "latest", or "nth" per group. You\'ll combine it with a CTE to filter on it two lessons from now.',
        },
        {
          id: 'a10', module: 'Window functions', title: 'RANK vs DENSE_RANK', minutes: 6,
          tables: ['employees'],
          concept: `
            <p>When values tie, the ranking functions differ:</p>
            <ul>
              <li><code>ROW_NUMBER()</code> gives ties different numbers anyway: 1, 2, 3, 4</li>
              <li><code>RANK()</code> gives ties the same rank and skips after them: 1, 2, 2, 4</li>
              <li><code>DENSE_RANK()</code> gives ties the same rank with no gap: 1, 2, 2, 3</li>
            </ul>
            <p>Several employees share a salary, so you'll see the difference clearly.</p>`,
          example: { sql: 'SELECT first_name, hire_date,\n       ROW_NUMBER() OVER (ORDER BY hire_date) AS seniority\nFROM employees;', caption: 'Numbering employees by hire date.' },
          task: '<p>Rank employees by <code>salary</code>, highest first, both ways. Return <code>first_name</code>, <code>salary</code>, <code>salary_rank</code> (using <code>RANK</code>), and <code>salary_dense_rank</code> (using <code>DENSE_RANK</code>).</p>',
          starter: 'SELECT first_name, salary\nFROM employees;',
          solution: 'SELECT first_name, salary,\n       RANK() OVER (ORDER BY salary DESC) AS salary_rank,\n       DENSE_RANK() OVER (ORDER BY salary DESC) AS salary_dense_rank\nFROM employees;',
          checkColumnNames: true,
          hints: [
            'Two window columns, both `OVER (ORDER BY salary DESC)`.',
            'One uses `RANK()`, the other `DENSE_RANK()`.',
            '`RANK() OVER (ORDER BY salary DESC) AS salary_rank, DENSE_RANK() OVER (ORDER BY salary DESC) AS salary_dense_rank`',
          ],
          takeaway: 'Use RANK for competition-style rankings (two silver medals, no bronze), DENSE_RANK when you want "the 2nd highest salary" to mean the 2nd distinct value.',
        },
        {
          id: 'a11', module: 'Window functions', title: 'Top N per group', minutes: 7,
          tables: ['books'],
          concept: `
            <p>You can't filter on a window function in <code>WHERE</code> (window functions run after WHERE). Instead, compute it in a CTE, then filter in the outer query:</p>
            <pre><code>WITH ranked AS (
  SELECT ..., RANK() OVER (PARTITION BY genre ORDER BY price DESC) AS rnk
  FROM books
)
SELECT ... FROM ranked WHERE rnk = 1;</code></pre>
            <p><code>RANK</code> keeps ties (two books sharing the top price both get rank 1); <code>ROW_NUMBER</code> would keep exactly one.</p>`,
          example: { sql: 'WITH ranked AS (\n  SELECT title, published_year,\n         ROW_NUMBER() OVER (ORDER BY published_year) AS rn\n  FROM books\n)\nSELECT title, published_year FROM ranked WHERE rn <= 3;', caption: 'The three oldest books.' },
          task: '<p>Find the <strong>most expensive book in each genre</strong>. If books tie for the top price, include all of them. Return <code>genre</code>, <code>title</code>, and <code>price</code>.</p>',
          starter: 'WITH ranked AS (\n  SELECT genre, title, price,\n         \n  FROM books\n)\nSELECT genre, title, price\nFROM ranked\n',
          solution: 'WITH ranked AS (\n  SELECT genre, title, price,\n         RANK() OVER (PARTITION BY genre ORDER BY price DESC) AS rnk\n  FROM books\n)\nSELECT genre, title, price\nFROM ranked\nWHERE rnk = 1;',
          hints: [
            'Rank books within each genre: `RANK() OVER (PARTITION BY genre ORDER BY price DESC)`.',
            'Use `RANK`, not `ROW_NUMBER`, so ties for first are kept.',
            'Filter the CTE with `WHERE rnk = 1`.',
          ],
          takeaway: 'CTE + window function + WHERE is the standard "top N per group" pattern. Choose RANK or ROW_NUMBER based on how you want ties handled.',
        },
        {
          id: 'a12', module: 'Window functions', title: 'Running totals', minutes: 6,
          tables: ['monthly_sales'],
          concept: `
            <p>Add <code>ORDER BY</code> inside <code>OVER</code> and an aggregate becomes <strong>cumulative</strong>: each row sums everything from the start up to itself.</p>
            <pre><code>SUM(revenue) OVER (ORDER BY month) AS running_total</code></pre>
            <p>Add <code>PARTITION BY region</code> to keep a separate running total for each region.</p>`,
          example: { sql: "SELECT month, region, orders,\n       SUM(orders) OVER (PARTITION BY region ORDER BY month) AS orders_to_date\nFROM monthly_sales\nWHERE region IN ('North', 'South');", caption: 'Cumulative orders per region.' },
          task: "<p>For the <code>'East'</code> region, return <code>month</code>, <code>revenue</code>, and <code>running_total</code> (cumulative revenue through that month), in month order.</p>",
          starter: "SELECT month, revenue\nFROM monthly_sales\nWHERE region = 'East'\nORDER BY month;",
          solution: "SELECT month, revenue,\n       SUM(revenue) OVER (ORDER BY month) AS running_total\nFROM monthly_sales\nWHERE region = 'East'\nORDER BY month;",
          checkColumnNames: true,
          orderKeys: ['month'],
          hints: [
            'Add a window column: `SUM(revenue) OVER ( ... )`.',
            'Order the window by `month` so it accumulates.',
            '`SUM(revenue) OVER (ORDER BY month) AS running_total`',
          ],
          takeaway: 'ORDER BY inside OVER turns any aggregate into a running one: running totals, cumulative counts, year-to-date figures.',
        },
        {
          id: 'a13', module: 'Window functions', title: 'LAG and LEAD', minutes: 6,
          tables: ['monthly_sales'],
          concept: `
            <p><code>LAG(column)</code> reads the value from the <strong>previous</strong> row in the window; <code>LEAD(column)</code> reads the <strong>next</strong> one. The first row has no previous row, so <code>LAG</code> returns NULL there.</p>
            <pre><code>revenue - LAG(revenue) OVER (ORDER BY month) AS change</code></pre>
            <p>That's month-over-month change in one line, no self join needed.</p>`,
          example: { sql: "SELECT month, revenue,\n       LEAD(revenue) OVER (ORDER BY month) AS next_month\nFROM monthly_sales\nWHERE region = 'South';", caption: 'Each month next to the following one.' },
          task: "<p>For the <code>'West'</code> region, return <code>month</code>, <code>revenue</code>, <code>prev_revenue</code> (the previous month's revenue), and <code>change</code> (revenue minus the previous month's), in month order.</p>",
          starter: "SELECT month, revenue\nFROM monthly_sales\nWHERE region = 'West'\nORDER BY month;",
          solution: "SELECT month, revenue,\n       LAG(revenue) OVER (ORDER BY month) AS prev_revenue,\n       revenue - LAG(revenue) OVER (ORDER BY month) AS change\nFROM monthly_sales\nWHERE region = 'West'\nORDER BY month;",
          checkColumnNames: true,
          orderKeys: ['month'],
          hints: [
            '`LAG(revenue) OVER (ORDER BY month)` is the previous month\'s revenue.',
            'Subtract it from `revenue` for the change. January\'s will be NULL, which is correct.',
            '`LAG(revenue) OVER (ORDER BY month) AS prev_revenue, revenue - LAG(revenue) OVER (ORDER BY month) AS change`',
          ],
          takeaway: 'LAG and LEAD compare each row with its neighbors: growth rates, gaps between events, churn detection.',
        },
        {
          id: 'a14', module: 'Window functions', title: 'Moving averages with frames', minutes: 7,
          tables: ['monthly_sales'],
          concept: `
            <p>A <strong>frame</strong> narrows the window to rows near the current one:</p>
            <pre><code>AVG(revenue) OVER (
  ORDER BY month
  ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
)</code></pre>
            <p>That's a 3-month moving average: this month and the two before it. It smooths out noise so trends stand out. (The first two months average fewer rows, because there aren't two earlier months yet.)</p>`,
          example: { sql: "SELECT month, revenue,\n       MAX(revenue) OVER (ORDER BY month ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS local_max\nFROM monthly_sales\nWHERE region = 'East';", caption: 'Highest of last, this, and next month.' },
          task: "<p>For the <code>'North'</code> region, return <code>month</code>, <code>revenue</code>, and <code>moving_avg_3m</code>: the average of this month and the two before it, rounded to 2 decimal places. Keep month order.</p>",
          starter: "SELECT month, revenue\nFROM monthly_sales\nWHERE region = 'North'\nORDER BY month;",
          solution: "SELECT month, revenue,\n       ROUND(AVG(revenue) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 2) AS moving_avg_3m\nFROM monthly_sales\nWHERE region = 'North'\nORDER BY month;",
          checkColumnNames: true,
          orderKeys: ['month'],
          hints: [
            'Use `AVG(revenue) OVER (ORDER BY month ...)` with a frame.',
            'The frame is `ROWS BETWEEN 2 PRECEDING AND CURRENT ROW`.',
            '`ROUND(AVG(revenue) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 2) AS moving_avg_3m`',
          ],
          takeaway: 'Frames (ROWS BETWEEN ...) control exactly which neighbors a window sees. Moving averages, rolling sums, and trailing maximums all use them.',
        },
        {
          id: 'a15', module: 'Window functions', title: 'Share of total', minutes: 6,
          tables: ['monthly_sales'],
          concept: `
            <p>Divide a row's value by a window total to get its share:</p>
            <pre><code>revenue * 100.0 / SUM(revenue) OVER (PARTITION BY month)</code></pre>
            <p>Notice the <code>100.0</code>: <code>revenue</code> and the sum are both whole numbers, and whole-number division in SQLite throws away the fraction.</p>`,
          example: { sql: "SELECT region, SUM(revenue) AS year_revenue,\n       ROUND(SUM(revenue) * 100.0 / SUM(SUM(revenue)) OVER (), 1) AS pct_of_year\nFROM monthly_sales\nGROUP BY region;", caption: 'A window over a GROUP BY result.' },
          task: "<p>For <code>'2024-12'</code>, return each <code>region</code>, its <code>revenue</code>, and <code>pct_of_month</code>: its share of that month's total revenue as a percentage, rounded to 1 decimal place. Highest share first.</p>",
          starter: "SELECT region, revenue\nFROM monthly_sales\nWHERE month = '2024-12'\n",
          solution: "SELECT region, revenue,\n       ROUND(revenue * 100.0 / SUM(revenue) OVER (), 1) AS pct_of_month\nFROM monthly_sales\nWHERE month = '2024-12'\nORDER BY pct_of_month DESC;",
          checkColumnNames: true,
          orderKeys: ['pct_of_month'],
          hints: [
            'The month total is `SUM(revenue) OVER ()` once WHERE has kept only December.',
            'Multiply by `100.0` before dividing so you keep the decimals, then round to 1.',
            "`ROUND(revenue * 100.0 / SUM(revenue) OVER (), 1) AS pct_of_month ... ORDER BY pct_of_month DESC`",
          ],
          takeaway: 'Value ÷ window total = share. The window runs after WHERE, so filtering first changes what "total" means.',
        },
        {
          id: 'a16', module: 'Window functions', title: 'Bucketing with NTILE', minutes: 7,
          tables: ['orders', 'order_items'],
          concept: `
            <p><code>NTILE(n)</code> splits ordered rows into <em>n</em> roughly equal buckets and returns each row's bucket number. <code>NTILE(4)</code> gives quartiles.</p>
            <pre><code>NTILE(4) OVER (ORDER BY total_spent DESC) AS quartile</code></pre>
            <p>With <code>DESC</code>, bucket 1 holds the top spenders. If rows don't divide evenly, the first buckets get one extra row each.</p>`,
          example: { sql: 'SELECT order_id, order_date,\n       NTILE(4) OVER (ORDER BY order_date) AS date_bucket\nFROM orders;', caption: 'Orders split into four equal groups by date.' },
          task: '<p>Split customers into 4 spending quartiles. Return <code>customer_id</code>, <code>total_spent</code> (rounded to 2 decimal places), and <code>quartile</code> (1 = top spenders). Skip guest orders.</p>',
          starter: 'WITH spend AS (\n  \n)\nSELECT customer_id, total_spent,\n       \nFROM spend;',
          solution: 'WITH spend AS (\n  SELECT o.customer_id, ROUND(SUM(oi.quantity * oi.unit_price), 2) AS total_spent\n  FROM orders AS o\n  JOIN order_items AS oi ON oi.order_id = o.order_id\n  WHERE o.customer_id IS NOT NULL\n  GROUP BY o.customer_id\n)\nSELECT customer_id, total_spent,\n       NTILE(4) OVER (ORDER BY total_spent DESC) AS quartile\nFROM spend;',
          checkColumnNames: true,
          hints: [
            'In the CTE, total each customer\'s spend (skip NULL customer_id).',
            'Then add `NTILE(4) OVER (ORDER BY total_spent DESC) AS quartile`.',
            '`WITH spend AS (SELECT o.customer_id, ROUND(SUM(oi.quantity * oi.unit_price), 2) AS total_spent FROM orders AS o JOIN order_items AS oi ON oi.order_id = o.order_id WHERE o.customer_id IS NOT NULL GROUP BY o.customer_id) SELECT customer_id, total_spent, NTILE(4) OVER (ORDER BY total_spent DESC) AS quartile FROM spend;`',
          ],
          takeaway: 'NTILE turns a ranking into segments: quartiles, deciles, top 10%. Great for customer segmentation.',
        },
        {
          id: 'a17', module: 'Dates & capstone', title: 'Working with dates', minutes: 7,
          tables: ['subscriptions'],
          concept: `
            <p>SQLite stores dates as text (<code>'2024-06-29'</code>) and gives you functions to work with them:</p>
            <ul>
              <li><code>STRFTIME('%Y-%m', d)</code> formats a date (here, year-month)</li>
              <li><code>DATE(d, '+30 days')</code> shifts a date</li>
              <li><code>JULIANDAY(d)</code> turns a date into a day number, so <code>JULIANDAY(b) - JULIANDAY(a)</code> is the days between them</li>
            </ul>
            <p>Real queries often use <code>DATE('now')</code>; here we use a fixed date so everyone gets the same answer.</p>`,
          example: { sql: "SELECT subscription_id, start_date, DATE(start_date, '+1 month') AS first_renewal\nFROM subscriptions\nLIMIT 5;", caption: 'Shifting a date by a month.' },
          task: "<p>For each subscription, return <code>subscription_id</code>, <code>plan</code>, and <code>days_active</code>: the whole number of days from <code>start_date</code> to <code>end_date</code>, or to <code>'2025-01-01'</code> if it's still active (<code>end_date</code> is NULL).</p>",
          starter: 'SELECT subscription_id, plan\nFROM subscriptions;',
          solution: "SELECT subscription_id, plan,\n       CAST(JULIANDAY(COALESCE(end_date, '2025-01-01')) - JULIANDAY(start_date) AS INTEGER) AS days_active\nFROM subscriptions;",
          checkColumnNames: true,
          hints: [
            "`COALESCE(end_date, '2025-01-01')` gives the end date, or the fixed date if still active.",
            'Subtract `JULIANDAY(start_date)` from `JULIANDAY(...)` of that, then wrap in `CAST(... AS INTEGER)`.',
            "`CAST(JULIANDAY(COALESCE(end_date, '2025-01-01')) - JULIANDAY(start_date) AS INTEGER) AS days_active`",
          ],
          takeaway: 'Store dates as YYYY-MM-DD text and SQLite\'s date functions handle the rest. JULIANDAY differences are the go-to for durations.',
        },
        {
          id: 'a18', module: 'Dates & capstone', title: 'Grouping by month', minutes: 5,
          tables: ['subscriptions'],
          concept: `
            <p>To report per month, group by a formatted date: <code>STRFTIME('%Y-%m', start_date)</code> turns <code>'2024-06-29'</code> into <code>'2024-06'</code>.</p>
            <p>You can group and sort by the alias, since GROUP BY and ORDER BY both accept SELECT aliases in SQLite.</p>`,
          example: { sql: "SELECT STRFTIME('%Y', start_date) AS year, COUNT(*) AS subs\nFROM subscriptions\nGROUP BY year;", caption: 'Grouping by year.' },
          task: "<p>Count new subscriptions <strong>per month</strong> (by <code>start_date</code>). Return <code>month</code> (as <code>'YYYY-MM'</code>), <code>new_subscriptions</code>, and <code>new_mrr</code> (the total <code>monthly_price</code> of those new subscriptions), in month order.</p>",
          starter: 'SELECT \nFROM subscriptions\n',
          solution: "SELECT STRFTIME('%Y-%m', start_date) AS month,\n       COUNT(*) AS new_subscriptions,\n       SUM(monthly_price) AS new_mrr\nFROM subscriptions\nGROUP BY month\nORDER BY month;",
          checkColumnNames: true,
          hints: [
            "`STRFTIME('%Y-%m', start_date) AS month`.",
            'Count rows and sum `monthly_price` per month.',
            "`... GROUP BY month ORDER BY month;`",
          ],
          takeaway: 'STRFTIME + GROUP BY is how you build monthly, weekly, or yearly trends from raw dates.',
        },
        {
          id: 'a19', module: 'Dates & capstone', title: 'Capstone: regional performance', minutes: 10,
          tables: ['monthly_sales'],
          concept: `
            <p>One last query that combines what you've learned: two different window functions with different partitions, a percentage calculation, NULL handling, and multi-column sorting.</p>
            <ul>
              <li>Rank regions <em>within each month</em>: partition by month.</li>
              <li>Growth vs the region's <em>previous month</em>: partition by region, order by month.</li>
            </ul>
            <p>Each window can have its own <code>OVER (...)</code>, so both fit in one SELECT.</p>`,
          example: { sql: "SELECT month, region, revenue,\n       MAX(revenue) OVER (PARTITION BY month) AS best_in_month\nFROM monthly_sales\nWHERE month >= '2024-11';", caption: 'A per-month window.' },
          task: "<p>For every month and region, return <code>month</code>, <code>region</code>, <code>revenue</code>, <code>rank_in_month</code> (1 = the highest-revenue region that month, using <code>RANK</code>), and <code>mom_growth_pct</code>: percent change from that region's previous month, rounded to 1 decimal place (NULL for January). Sort by <code>month</code>, then <code>rank_in_month</code>.</p>",
          starter: 'SELECT month, region, revenue\nFROM monthly_sales\n',
          solution: "SELECT month, region, revenue,\n       RANK() OVER (PARTITION BY month ORDER BY revenue DESC) AS rank_in_month,\n       ROUND((revenue - LAG(revenue) OVER (PARTITION BY region ORDER BY month)) * 100.0\n             / LAG(revenue) OVER (PARTITION BY region ORDER BY month), 1) AS mom_growth_pct\nFROM monthly_sales\nORDER BY month, rank_in_month;",
          checkColumnNames: true,
          orderKeys: ['month', 'rank_in_month'],
          hints: [
            '`RANK() OVER (PARTITION BY month ORDER BY revenue DESC)` ranks regions within each month.',
            'Previous month for the same region: `LAG(revenue) OVER (PARTITION BY region ORDER BY month)`. Growth % = (revenue − prev) × 100.0 / prev.',
            'Round the growth to 1 decimal and finish with `ORDER BY month, rank_in_month`.',
          ],
          takeaway: 'That\'s a real analytics query: rankings and growth rates side by side. You\'ve finished the whole path, from SELECT * to multi-window analysis.',
        },
      ],
    },
  ];

  // Flat lookups.
  const LESSONS = [];
  const LESSON_INDEX = {};
  LEVELS.forEach(level => {
    level.lessons.forEach((lesson, i) => {
      lesson.levelId = level.id;
      lesson.number = i + 1;
      LESSON_INDEX[lesson.id] = LESSONS.length;
      LESSONS.push(lesson);
    });
  });

  function getLesson(id) {
    const i = LESSON_INDEX[id];
    return i === undefined ? null : LESSONS[i];
  }

  function getLevel(id) {
    return LEVELS.find(l => l.id === id) || null;
  }

  // Next/previous within a level. Crossing levels is a deliberate step
  // (the level-complete screen), not an arrow click.
  function neighbors(id) {
    const lesson = getLesson(id);
    if (!lesson) return { prev: null, next: null };
    const level = getLevel(lesson.levelId);
    const i = level.lessons.indexOf(lesson);
    return { prev: level.lessons[i - 1] || null, next: level.lessons[i + 1] || null };
  }

  function modulesOf(level) {
    const out = [];
    level.lessons.forEach(lesson => {
      let mod = out[out.length - 1];
      if (!mod || mod.title !== lesson.module) { mod = { title: lesson.module, lessons: [] }; out.push(mod); }
      mod.lessons.push(lesson);
    });
    return out;
  }

  return { LEVELS, LESSONS, getLesson, getLevel, neighbors, modulesOf, venn };
});
