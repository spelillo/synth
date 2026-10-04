// Unit tests for learn-grader.js: running learner SQL safely, comparing
// result sets, and turning mismatches and SQLite errors into feedback.

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearnGrader: G, getSQL } = require('./helpers/learn-env');

async function fixtureDb() {
  const SQL = await getSQL();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, category TEXT, price REAL, qty INTEGER, supplier_id INTEGER);
    INSERT INTO items VALUES
      (1, 'Apple', 'Produce', 1.25, 10, 1),
      (2, 'Banana', 'Produce', 0.5, 30, 1),
      (3, 'Milk', 'Dairy', 3.49, 5, 2),
      (4, 'Cheese', 'Dairy', 6.75, 2, 2),
      (5, 'Bread', 'Bakery', 2.99, 8, NULL),
      (6, 'Bagel', 'Bakery', 2.99, 12, 3);
    CREATE TABLE suppliers (supplier_id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO suppliers VALUES (1, 'Green Farms'), (2, 'Valley Dairy'), (3, 'Oven Co'), (4, 'Unused Ltd');
  `);
  return db;
}

const CTX = {
  tables: [
    { name: 'items', columns: ['id', 'name', 'category', 'price', 'qty', 'supplier_id'] },
    { name: 'suppliers', columns: ['supplier_id', 'name'] },
  ],
};

function exercise(solution, extra = {}) {
  return Object.assign({ solution }, extra);
}

async function gradeAgainst(sql, solution, extra) {
  const db = await fixtureDb();
  const ex = exercise(solution, extra);
  const expected = G.runQuery(db, solution);
  return G.grade(db, sql, ex, expected, CTX);
}

test('maskSql blanks strings and comments but keeps positions', () => {
  const sql = "SELECT 'a -- not a comment' AS x -- real comment\nFROM t /* block */";
  const masked = G.maskSql(sql);
  assert.equal(masked.length, sql.length);
  assert.ok(!masked.includes('not a comment'));
  assert.ok(!masked.includes('real comment'));
  assert.ok(!masked.includes('block'));
  assert.match(masked, /FROM t/);
});

test('splitStatements ignores semicolons inside strings', () => {
  assert.deepEqual(G.splitStatements("SELECT ';'; SELECT 2;").map(s => s.trim()), ["SELECT ';'", 'SELECT 2']);
});

test('defaultOrderMatters looks only at the outer ORDER BY', () => {
  assert.equal(G.defaultOrderMatters('SELECT * FROM t ORDER BY a'), true);
  assert.equal(G.defaultOrderMatters('SELECT a, ROW_NUMBER() OVER (ORDER BY b) FROM t'), false);
  assert.equal(G.defaultOrderMatters('SELECT * FROM (SELECT * FROM t ORDER BY a LIMIT 3)'), false);
  assert.equal(G.defaultOrderMatters("SELECT 'ORDER BY' FROM t"), false);
});

test('readOnlyProblem blocks writes, allows SELECT and WITH', () => {
  assert.equal(G.readOnlyProblem('SELECT 1'), null);
  assert.equal(G.readOnlyProblem('WITH x AS (SELECT 1) SELECT * FROM x'), null);
  assert.equal(G.readOnlyProblem("SELECT 'drop table' AS note"), null);
  assert.match(G.readOnlyProblem('DELETE FROM items'), /DELETE/);
  assert.match(G.readOnlyProblem('SELECT 1; DROP TABLE items'), /DROP/);
  assert.match(G.readOnlyProblem('WITH x AS (SELECT 1) DELETE FROM items'), /DELETE/);
});

test('runQuery keeps column names for empty results and never changes data', async () => {
  const db = await fixtureDb();
  const r = G.runQuery(db, "SELECT name, price FROM items WHERE category = 'Nope'");
  assert.deepEqual(r.columns, ['name', 'price']);
  assert.equal(r.rows.length, 0);
  assert.throws(() => G.runQuery(db, 'UPDATE items SET price = 0'), err => err.learnReadOnly === true);
  assert.equal(db.exec('SELECT SUM(price) FROM items')[0].values[0][0] > 0, true);
});

test('runQuery returns the last result-producing statement', async () => {
  const db = await fixtureDb();
  const r = G.runQuery(db, 'SELECT 1 AS a; SELECT 2 AS b');
  assert.deepEqual(r.columns, ['b']);
  assert.equal(r.statementCount, 2);
});

test('valuesEqual tolerates float noise and numeric text', () => {
  assert.ok(G.valuesEqual(0.1 + 0.2, 0.3));
  assert.ok(G.valuesEqual(3, 3.0));
  assert.ok(G.valuesEqual('42', 42));
  assert.ok(G.valuesEqual(null, null));
  assert.ok(!G.valuesEqual(null, 0));
  assert.ok(!G.valuesEqual(1.5, 1.6));
  assert.ok(!G.valuesEqual('a', 'A'));
});

test('a correct answer passes, whatever the column aliases or row order', async () => {
  const sol = "SELECT name, price FROM items WHERE category = 'Dairy'";
  assert.equal((await gradeAgainst("select price AS p, name from items where category='Dairy' order by price desc", sol)).code, 'correct');
});

test('empty editor and comment-only editor are "empty"', async () => {
  assert.equal((await gradeAgainst('   ', 'SELECT 1 FROM items')).code, 'empty');
  assert.equal((await gradeAgainst('-- just a comment', 'SELECT 1 FROM items')).code, 'empty');
});

test('writes are refused before they run', async () => {
  const r = await gradeAgainst('DELETE FROM items', 'SELECT * FROM items');
  assert.equal(r.code, 'read_only');
});

test('column count problems are named', async () => {
  const sol = 'SELECT name, price FROM items';
  const extra = await gradeAgainst('SELECT name, price, qty FROM items', sol);
  assert.equal(extra.code, 'extra_columns');
  assert.match(extra.tip, /qty/);
  const missing = await gradeAgainst('SELECT name FROM items', sol);
  assert.equal(missing.code, 'missing_columns');
  assert.match(missing.tip, /price/);
});

test('checkColumnNames asks for the alias', async () => {
  const r = await gradeAgainst('SELECT COUNT(*) FROM items', 'SELECT COUNT(*) AS item_count FROM items', { checkColumnNames: true });
  assert.equal(r.code, 'column_names');
  assert.match(r.tip, /AS item_count/);
});

test('row problems: none, too few, too many, different', async () => {
  const sol = 'SELECT name FROM items WHERE price > 2';
  assert.equal((await gradeAgainst('SELECT name FROM items WHERE price > 100', sol)).code, 'no_rows');
  assert.equal((await gradeAgainst('SELECT name FROM items WHERE price > 3', sol)).code, 'too_few_rows');
  assert.equal((await gradeAgainst('SELECT name FROM items WHERE price > 1', sol)).code, 'too_many_rows');
  assert.equal((await gradeAgainst('SELECT name FROM items WHERE price < 2', sol)).code, 'row_count');
});

test('duplicate rows suggest DISTINCT', async () => {
  const r = await gradeAgainst('SELECT category FROM items', 'SELECT DISTINCT category FROM items');
  assert.equal(r.code, 'too_many_rows');
  assert.match(r.tip, /DISTINCT/);
});

test('ORDER BY in the solution makes order matter', async () => {
  const sol = 'SELECT name FROM items ORDER BY price DESC, name';
  const r = await gradeAgainst('SELECT name FROM items ORDER BY price, name', sol);
  assert.equal(r.code, 'wrong_order');
  assert.equal((await gradeAgainst('SELECT name FROM items ORDER BY price DESC, name', sol)).code, 'correct');
});

test('orderKeys accepts any order among tied rows', async () => {
  // Bread and Bagel tie on price 2.99.
  const sol = 'SELECT name, price FROM items ORDER BY price DESC';
  const reversedTie = 'SELECT name, price FROM items ORDER BY price DESC, name DESC';
  const forwardTie = 'SELECT name, price FROM items ORDER BY price DESC, name ASC';
  const ex = { orderKeys: ['price'] };
  assert.equal((await gradeAgainst(reversedTie, sol, ex)).code, 'correct');
  assert.equal((await gradeAgainst(forwardTie, sol, ex)).code, 'correct');
  assert.equal((await gradeAgainst('SELECT name, price FROM items ORDER BY price', sol, ex)).code, 'wrong_order');
});

test('rounding mistakes are recognised', async () => {
  const r = await gradeAgainst('SELECT category, AVG(price) AS avg_price FROM items GROUP BY category',
    'SELECT category, ROUND(AVG(price), 2) AS avg_price FROM items GROUP BY category');
  assert.equal(r.code, 'rounding');
  assert.match(r.tip, /ROUND\(value, 2\)/);
});

test('integer division is recognised', async () => {
  const r = await gradeAgainst('SELECT name, qty / 4 AS packs FROM items', 'SELECT name, qty * 1.0 / 4 AS packs FROM items');
  assert.equal(r.code, 'integer_division');
});

test('wrong values in a column are named, with an example when order matters', async () => {
  const r = await gradeAgainst('SELECT name, qty FROM items ORDER BY id', 'SELECT name, price FROM items ORDER BY id');
  assert.equal(r.code, 'wrong_values');
  assert.match(r.message, /price/);
  assert.match(r.tip, /row 1/);
});

test('values paired into the wrong rows are "wrong_rows"', async () => {
  const sol = 'SELECT i.name, s.name AS supplier FROM items i JOIN suppliers s ON s.supplier_id = i.supplier_id';
  const wrongJoin = `SELECT i.name, s.name AS supplier FROM items i JOIN suppliers s
    ON s.supplier_id = CASE i.supplier_id WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE i.supplier_id END`;
  assert.equal((await gradeAgainst(wrongJoin, sol)).code, 'wrong_rows');
});

test('requireFrom rejects typed-in answers', async () => {
  const r = await gradeAgainst('SELECT 6 AS n', 'SELECT COUNT(*) AS n FROM items');
  assert.equal(r.code, 'no_from');
});

test('mustUse and mustNotUse check the route, after the result is right', async () => {
  const sol = "SELECT name FROM items WHERE category IN ('Dairy', 'Bakery')";
  const viaOr = "SELECT name FROM items WHERE category = 'Dairy' OR category = 'Bakery'";
  const must = { mustUse: [{ pattern: '\\bIN\\s*\\(', message: 'This lesson is about IN.' }] };
  const r = await gradeAgainst(viaOr, sol, must);
  assert.equal(r.code, 'missing_construct');
  assert.match(r.message, /IN/);
  const mustNot = { mustNotUse: [{ pattern: '\\bOR\\b', message: 'Try it without OR.' }] };
  assert.equal((await gradeAgainst(viaOr, sol, mustNot)).code, 'forbidden_construct');
  // A wrong result is reported as wrong, not as a route problem.
  assert.equal((await gradeAgainst("SELECT name FROM items WHERE category = 'Dairy'", sol, must)).code, 'too_few_rows');
});

test('common mistakes add tips', async () => {
  const r = await gradeAgainst('SELECT name FROM items WHERE supplier_id = NULL', 'SELECT name FROM items WHERE supplier_id IS NULL');
  assert.ok(r.tips.some(t => /IS NULL/.test(t)));
  const like = await gradeAgainst("SELECT name FROM items WHERE name LIKE 'B'", "SELECT name FROM items WHERE name LIKE 'B%'");
  assert.ok(like.tips.some(t => /wildcard/.test(t)));
  const notIn = await gradeAgainst('SELECT name FROM suppliers WHERE supplier_id NOT IN (SELECT supplier_id FROM items)',
    'SELECT s.name FROM suppliers s WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.supplier_id = s.supplier_id)');
  assert.equal(notIn.code, 'no_rows');
  assert.ok(notIn.tips.some(t => /NOT EXISTS/.test(t)));
});

test('SQL errors become friendly messages', async () => {
  const sol = 'SELECT name FROM items';
  const col = await gradeAgainst('SELECT nme FROM items', sol);
  assert.equal(col.code, 'sql_error');
  assert.equal(col.title, 'Unknown column');
  assert.match(col.tip, /Did you mean `name`/);
  assert.match(col.rawError, /no such column/);

  const table = await gradeAgainst('SELECT name FROM item', sol);
  assert.equal(table.title, 'Unknown table');
  assert.match(table.tip, /`items`/);

  const ambiguous = await gradeAgainst('SELECT name FROM items JOIN suppliers USING (supplier_id)', sol);
  assert.equal(ambiguous.title, 'Ambiguous column');

  const comma = await gradeAgainst('SELECT name, FROM items', sol);
  assert.equal(comma.title, 'Syntax error');
  assert.match(comma.tip, /comma/);

  const typo = await gradeAgainst('SELEC name FROM items', sol);
  assert.match(typo.tip, /SELECT/);

  const order = await gradeAgainst("SELECT name FROM items ORDER BY name WHERE category = 'Dairy'", sol);
  assert.match(order.tip, /WHERE.*before.*ORDER BY/);

  const agg = await gradeAgainst('SELECT category FROM items WHERE COUNT(*) > 1 GROUP BY category', sol);
  assert.equal(agg.title, 'Aggregate in the wrong place');
  assert.match(agg.tip, /HAVING/);

  const quote = await gradeAgainst("SELECT name FROM items WHERE category = 'Dairy", sol);
  assert.equal(quote.title, 'Unclosed quote');

  const fn = await gradeAgainst('SELECT YEAR(name) FROM items', sol);
  assert.equal(fn.title, 'Unknown function');
  assert.match(fn.tip, /STRFTIME/);

  const unfinished = await gradeAgainst('SELECT name FROM items WHERE', sol);
  assert.equal(unfinished.title, 'Query ends too early');
});

test('unknown alias prefixes are explained', () => {
  const ctx = CTX;
  const undefinedAlias = G.explainError('no such column: x.name', 'SELECT x.name FROM items AS i', ctx);
  assert.match(undefinedAlias.tip, /`x` isn't a table or alias/);
  const wrongTable = G.explainError('no such column: s.price', 'SELECT s.price FROM items i JOIN suppliers s ON s.supplier_id = i.supplier_id', ctx);
  assert.match(wrongTable.tip, /column of `items`/);
  const cte = G.explainError('no such column: t.nme', 'WITH t AS (SELECT name FROM items) SELECT t.nme FROM t', ctx);
  assert.match(cte.tip, /Did you mean `t.name`/);
});

test('levenshtein and closest', () => {
  assert.equal(G.levenshtein('kitten', 'sitting'), 3);
  assert.equal(G.closest('nmae', ['name', 'price']), 'name');
  assert.equal(G.closest('zzzzzz', ['name', 'price']), null);
});
