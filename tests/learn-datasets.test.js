// learn-datasets.js: every table loads, keys hold, and the edge cases the
// join and window-function lessons are built around are really there.

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearnDatasets: D, lessonDb } = require('./helpers/learn-env');

const ALL = Object.keys(D.DATASETS);

function rows(db, sql) {
  const r = db.exec(sql);
  return r.length ? r[0].values : [];
}

function scalar(db, sql) {
  return rows(db, sql)[0][0];
}

test('every dataset has a description and documented, typed columns', () => {
  for (const [id, ds] of Object.entries(D.DATASETS)) {
    assert.ok(ds.description, `${id} description`);
    assert.ok(ds.rows || ds.csv, `${id} needs rows or a csv`);
    for (const c of ds.columns) {
      assert.match(c.type, /^(INTEGER|REAL|TEXT)$/, `${id}.${c.name} type`);
      assert.ok(c.desc, `${id}.${c.name} needs a description`);
    }
    if (ds.rows) ds.rows.forEach((r, i) => assert.equal(r.length, ds.columns.length, `${id} row ${i} width`));
  }
});

test('every table is in exactly one overview group', () => {
  const grouped = D.DATASET_GROUPS.flatMap(g => g.tables);
  assert.deepEqual([...grouped].sort(), [...ALL].sort());
  assert.equal(new Set(grouped).size, grouped.length);
});

test('all tables load with the expected row counts', async () => {
  const db = await lessonDb(ALL);
  const expected = { nfl_team_stats: 160, bank_statement: 124, grocery_store_data: 140, authors: 13, books: 24, customers: 20, orders: 46, order_items: 83, formats: 4, departments: 6, employees: 18, subscriptions: 25, monthly_sales: 48 };
  for (const [t, n] of Object.entries(expected)) {
    assert.equal(scalar(db, `SELECT COUNT(*) FROM ${t}`), n, t);
  }
});

test('CSV columns get real types, so numbers compare as numbers', async () => {
  const db = await lessonDb(['nfl_team_stats', 'bank_statement', 'grocery_store_data']);
  assert.equal(scalar(db, "SELECT typeof(wins) FROM nfl_team_stats LIMIT 1"), 'integer');
  assert.equal(scalar(db, "SELECT typeof(amount) FROM bank_statement LIMIT 1"), 'real');
  assert.equal(scalar(db, "SELECT typeof(revenue) FROM grocery_store_data LIMIT 1"), 'real');
  // '9' > '10' as text; 9 < 10 as numbers.
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM nfl_team_stats WHERE wins > 9') < 160, true);
});

test('foreign keys point at real rows, apart from the intended orphans', async () => {
  const db = await lessonDb(ALL);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM books b LEFT JOIN authors a ON a.author_id = b.author_id WHERE b.author_id IS NOT NULL AND a.author_id IS NULL'), 0);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM order_items oi LEFT JOIN orders o ON o.order_id = oi.order_id WHERE o.order_id IS NULL'), 0);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM order_items oi LEFT JOIN books b ON b.book_id = oi.book_id WHERE b.book_id IS NULL'), 0);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id WHERE o.customer_id IS NOT NULL AND c.customer_id IS NULL'), 0);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM employees e LEFT JOIN employees m ON m.employee_id = e.manager_id WHERE e.manager_id IS NOT NULL AND m.employee_id IS NULL'), 0);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM subscriptions s LEFT JOIN customers c ON c.customer_id = s.customer_id WHERE c.customer_id IS NULL'), 0);
});

test('order_items has no duplicate (order, book) pairs', async () => {
  const db = await lessonDb(['order_items']);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM (SELECT order_id, book_id FROM order_items GROUP BY 1, 2 HAVING COUNT(*) > 1)'), 0);
});

test('the join edge cases the lessons rely on exist', async () => {
  const db = await lessonDb(ALL);
  const ids = sql => rows(db, sql).map(r => r[0]);
  assert.deepEqual(ids('SELECT a.author_id FROM authors a WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.author_id = a.author_id) ORDER BY 1'), [9, 13]);
  assert.deepEqual(ids('SELECT book_id FROM books WHERE author_id IS NULL'), [24]);
  assert.deepEqual(ids('SELECT b.book_id FROM books b WHERE NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.book_id = b.book_id) ORDER BY 1'), [15, 20]);
  assert.deepEqual(ids('SELECT c.customer_id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id) ORDER BY 1'), [8, 12, 15, 17, 20]);
  assert.deepEqual(ids('SELECT order_id FROM orders WHERE customer_id IS NULL ORDER BY 1'), [1018, 1034]);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM employees WHERE department_id IS NULL'), 1);
  assert.equal(scalar(db, "SELECT COUNT(*) FROM departments d WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.department_id = d.department_id)"), 1);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM employees WHERE manager_id IS NULL'), 1, 'one CEO at the top of the hierarchy');
});

test('there are salary ties, for RANK vs DENSE_RANK', async () => {
  const db = await lessonDb(['employees']);
  assert.ok(scalar(db, 'SELECT COUNT(*) FROM (SELECT salary FROM employees GROUP BY salary HAVING COUNT(*) > 1)') >= 1);
});

test('monthly_sales is a full 12 months x 4 regions grid', async () => {
  const db = await lessonDb(['monthly_sales']);
  assert.equal(scalar(db, 'SELECT COUNT(DISTINCT month) FROM monthly_sales'), 12);
  assert.equal(scalar(db, 'SELECT COUNT(DISTINCT region) FROM monthly_sales'), 4);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM (SELECT month, region FROM monthly_sales GROUP BY 1, 2 HAVING COUNT(*) > 1)'), 0);
});

test('createTableSql quotes names and marks primary keys', () => {
  assert.match(D.createTableSql('authors'), /^CREATE TABLE "authors" \("author_id" INTEGER PRIMARY KEY, "name" TEXT/);
  assert.throws(() => D.createTableSql('nope'), /Unknown dataset/);
  assert.equal(D.quoteIdent('a"b'), '"a""b"');
});

test('parseCsv handles quotes, doubled quotes, CRLF and a missing final newline', () => {
  assert.deepEqual(D.parseCsv('a,b\r\n"x, y","say ""hi"""\r\n1,2'), [['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]);
  assert.deepEqual(D.parseCsv('a,b\n\n1,2\n'), [['a', 'b'], ['1', '2']]);
});

test('rowsFromCsv maps by header name and types the values', () => {
  const csv = 'format,format_id\nHardcover,1\nAudiobook,\n';
  assert.deepEqual(D.rowsFromCsv('formats', csv), [[1, 'Hardcover'], [null, 'Audiobook']]);
  assert.throws(() => D.rowsFromCsv('formats', 'format\nHardcover\n'), /missing column/);
});

test('loadInto needs fetchText only for CSV tables', async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  await D.loadInto(db, ['authors']);
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM authors'), 13);
  await assert.rejects(D.loadInto(new SQL.Database(), ['nfl_team_stats']), /fetchText/);
});

test('schemaText lists every column with its description', () => {
  const text = D.schemaText(['books']);
  assert.match(text, /^Table books:/);
  for (const c of D.DATASETS.books.columns) assert.ok(text.includes(`- ${c.name} ${c.type}`));
});
