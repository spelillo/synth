// Every lesson in learn-curriculum.js, checked against the real lesson
// data: the reference solution passes, the starter doesn't, the example
// runs, the answer doesn't depend on physical row order, and typical
// wrong answers get the feedback a learner should see.

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearnCurriculum: C, LearnGrader: G, LearnDatasets: D, lessonDb, reversedLessonDb, gradeCtx } = require('./helpers/learn-env');

test('three levels with 10 to 25 lessons each, 60 in total', () => {
  assert.deepEqual(C.LEVELS.map(l => l.id), ['beginner', 'intermediate', 'advanced']);
  for (const level of C.LEVELS) {
    assert.ok(level.lessons.length >= 10 && level.lessons.length <= 25, `${level.id} has ${level.lessons.length} lessons`);
  }
  assert.equal(C.LESSONS.length, 60);
});

test('lesson ids are unique and every lesson is complete', () => {
  const ids = new Set();
  for (const l of C.LESSONS) {
    assert.ok(!ids.has(l.id), `duplicate id ${l.id}`);
    ids.add(l.id);
    for (const field of ['id', 'module', 'title', 'concept', 'task', 'solution', 'takeaway']) {
      assert.ok(typeof l[field] === 'string' && l[field].trim(), `${l.id} is missing ${field}`);
    }
    assert.equal(typeof l.starter, 'string', `${l.id} starter`);
    assert.ok(l.minutes > 0, `${l.id} minutes`);
    assert.ok(l.example && l.example.sql && l.example.caption, `${l.id} example`);
    assert.equal(l.hints.length, 3, `${l.id} should have 3 hints`);
    assert.ok(l.tables.length >= 1, `${l.id} tables`);
    l.tables.forEach(t => assert.ok(D.DATASETS[t], `${l.id} uses unknown table ${t}`));
  }
});

test('the beginner course covers the six clauses, aggregates and aliases', () => {
  const sql = C.getLevel('beginner').lessons.map(l => l.solution).join('\n').toUpperCase();
  for (const kw of ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'COUNT(', 'SUM(', 'AVG(', 'MIN(', 'MAX(', ' AS ']) {
    assert.ok(sql.includes(kw), `beginner course never uses ${kw.trim()}`);
  }
});

test('the intermediate course covers every join type', () => {
  const sql = C.getLevel('intermediate').lessons.map(l => l.solution).join('\n').toUpperCase();
  for (const kw of [/\bJOIN\b/, /LEFT JOIN/, /RIGHT JOIN/, /FULL OUTER JOIN/, /CROSS JOIN/, /UNION/, /EXISTS/]) {
    assert.match(sql, kw);
  }
});

test('the advanced course covers CASE, CTEs and window functions', () => {
  const sql = C.getLevel('advanced').lessons.map(l => l.solution).join('\n').toUpperCase();
  for (const kw of [/\bCASE\b/, /COALESCE/, /^WITH\b/m, /RECURSIVE/, /OVER \(/, /PARTITION BY/, /ROW_NUMBER/, /DENSE_RANK/, /\bLAG\(/, /ROWS BETWEEN/, /NTILE/]) {
    assert.match(sql, kw);
  }
});

test('getLesson, getLevel, neighbors and modulesOf', () => {
  assert.equal(C.getLesson('b01').title, 'Your first query');
  assert.equal(C.getLesson('nope'), null);
  assert.equal(C.getLevel('advanced').title, 'Analytics SQL');
  const first = C.neighbors('b01');
  assert.equal(first.prev, null);
  assert.equal(first.next.id, 'b02');
  // Navigation stays inside a level.
  assert.equal(C.neighbors('b21').next, null);
  assert.equal(C.neighbors('i01').prev, null);
  const modules = C.modulesOf(C.getLevel('beginner'));
  assert.ok(modules.length > 1);
  assert.equal(modules.reduce((n, m) => n + m.lessons.length, 0), 21);
});

for (const lesson of C.LESSONS) {
  test(`${lesson.id} ${lesson.title}: solution passes, starter fails, example runs`, async () => {
    const db = await lessonDb(lesson.tables);
    const ctx = gradeCtx(lesson);
    const expected = G.runQuery(db, lesson.solution);
    assert.ok(expected.rows.length > 0, 'the expected result should not be empty');

    const self = G.grade(db, lesson.solution, lesson, expected, ctx);
    assert.equal(self.code, 'correct', `solution grades as ${self.code}: ${self.message}`);

    const starter = G.grade(db, lesson.starter, lesson, expected, ctx);
    assert.notEqual(starter.code, 'correct', 'the starter code should not already be correct');

    const example = G.runQuery(db, lesson.example.sql);
    assert.ok(example.columns.length > 0, 'example should return a result');
    assert.notEqual(G.grade(db, lesson.example.sql, lesson, expected, ctx).code, 'correct', 'the example should not be the answer');

    db.close();
  });

  test(`${lesson.id} ${lesson.title}: answer doesn't depend on row storage order`, async () => {
    const db = await lessonDb(lesson.tables);
    const expected = G.runQuery(db, lesson.solution);
    db.close();
    const rev = await reversedLessonDb(lesson.tables);
    const r = G.grade(rev, lesson.solution, lesson, expected, gradeCtx(lesson));
    assert.equal(r.code, 'correct', `with rows reversed the solution grades as ${r.code}: ${r.message}`);
    rev.close();
  });
}

// Typical mistakes, and the feedback each should produce.
const WRONG_ANSWERS = [
  ['b02', 'SELECT team, wins, season, losses FROM nfl_team_stats', 'wrong_values'],
  ['b02', 'SELECT team, season, wins, FROM nfl_team_stats', 'sql_error'],
  ['b03', 'SELECT date, description, amount FROM bank_statement', 'column_names'],
  ['b04', 'SELECT category FROM grocery_store_data', 'too_many_rows'],
  ['b05', 'SELECT team, season, wins FROM nfl_team_stats WHERE wins > 14', 'no_rows'],
  ['b06', "SELECT date, description, amount FROM bank_statement WHERE category = 'dining out'", 'no_rows'],
  ['b06', 'SELECT date, description, amount FROM bank_statement WHERE category = Dining', 'sql_error'],
  ['b07', "SELECT team, division, wins FROM nfl_team_stats WHERE season = 2023 AND conference = 'AFC' OR made_playoffs = 'Yes'", 'too_many_rows'],
  ['b08', "SELECT product_name, category, revenue FROM grocery_store_data WHERE category = 'Dairy' OR category = 'Bakery' OR category = 'Frozen'", 'missing_construct'],
  ['b10', "SELECT DISTINCT product_name, unit_price FROM grocery_store_data WHERE product_name LIKE 'pack'", 'no_rows'],
  ['b11', 'SELECT customer_id, first_name, last_name FROM customers WHERE referred_by = NULL', 'no_rows'],
  ['b12', 'SELECT date, description, amount FROM bank_statement WHERE amount > 500 ORDER BY amount', 'wrong_order'],
  ['b13', 'SELECT team, wins, point_differential FROM nfl_team_stats WHERE season = 2022 ORDER BY wins DESC, point_differential DESC', 'too_many_rows'],
  ['b14', 'SELECT team, wins, losses, wins / (wins + losses + ties) AS win_pct FROM nfl_team_stats WHERE season = 2023', 'integer_division'],
  ['b16', "SELECT COUNT(*) FROM bank_statement WHERE type = 'debit'", 'column_names'],
  ['b17', "SELECT SUM(revenue) AS total_revenue, AVG(quantity_sold) AS avg_quantity FROM grocery_store_data WHERE category = 'Produce'", 'rounding'],
  ['b19', 'SELECT category, ROUND(SUM(revenue), 2) AS total_revenue FROM grocery_store_data GROUP BY category ORDER BY total_revenue', 'wrong_order'],
  ['b20', "SELECT category, ROUND(SUM(amount), 2) AS total_spent FROM bank_statement WHERE type = 'debit' AND SUM(amount) > 1000 GROUP BY category", 'sql_error'],
  ['i03', 'SELECT b.title, a.name, a.country FROM books AS b LEFT JOIN authors AS a ON b.author_id = a.author_id', 'too_many_rows'],
  ['i03', 'SELECT title, name, country FROM books JOIN authors ON author_id = author_id', 'sql_error'],
  ['i03', 'SELECT b.title, a.name, a.country FROM books AS b, authors AS a', 'too_many_rows'],
  ['i06', 'SELECT a.name, b.title FROM authors AS a JOIN books AS b ON b.author_id = a.author_id', 'too_few_rows'],
  ['i07', 'SELECT c.customer_id, c.first_name, c.last_name FROM customers AS c JOIN orders AS o ON o.customer_id = c.customer_id WHERE o.order_id IS NULL', 'no_rows'],
  ['i07', 'SELECT c.customer_id, c.first_name, c.last_name FROM customers AS c LEFT JOIN orders AS o ON o.customer_id = c.customer_id WHERE o.order_id = NULL', 'no_rows'],
  ['i08', 'SELECT c.first_name, c.last_name, o.order_id FROM customers AS c LEFT JOIN orders AS o ON c.customer_id = o.customer_id', 'missing_construct'],
  ['i12', 'SELECT a.name, COUNT(*) AS book_count FROM authors AS a LEFT JOIN books AS b ON b.author_id = a.author_id GROUP BY a.author_id, a.name ORDER BY book_count DESC, a.name', 'wrong_values'],
  ['i12', 'SELECT a.name, COUNT(b.book_id) AS book_count FROM authors AS a JOIN books AS b ON b.author_id = a.author_id GROUP BY a.author_id, a.name ORDER BY book_count DESC, a.name', 'too_few_rows'],
  ['i15', "SELECT first_name, last_name, 'customer' AS role FROM customers UNION ALL SELECT first_name, last_name FROM employees", 'sql_error'],
  ['i19', 'SELECT b.book_id, b.title FROM books AS b LEFT JOIN order_items AS oi ON oi.book_id = b.book_id WHERE oi.order_id IS NULL', 'missing_construct'],
  ['a01', "SELECT title, price, CASE WHEN price < 15 THEN 'budget' WHEN price < 20 THEN 'standard' END AS price_tier FROM books", 'wrong_values'],
  ['a03', 'SELECT e.first_name, e.last_name, d.name AS department FROM employees AS e LEFT JOIN departments AS d ON d.department_id = e.department_id', 'wrong_values'],
  ['a04', 'SELECT order_id, ROUND(SUM(quantity * unit_price), 2) AS order_total FROM order_items GROUP BY order_id HAVING SUM(quantity * unit_price) > 50 ORDER BY order_total DESC', 'missing_construct'],
  ['a07', 'SELECT title, price, ROUND(AVG(price), 2) AS avg_price, ROUND(price - AVG(price), 2) AS diff_from_avg FROM books', 'too_few_rows', /OVER \(\)/],
  ['a09', 'SELECT customer_id, order_id, order_date, ROW_NUMBER() OVER (ORDER BY order_date) AS order_number FROM orders WHERE customer_id IS NOT NULL', 'wrong_values'],
  ['a10', 'SELECT first_name, salary, RANK() OVER (ORDER BY salary DESC) AS salary_rank, RANK() OVER (ORDER BY salary DESC) AS salary_dense_rank FROM employees', 'wrong_values'],
  ['a11', 'SELECT genre, title, MAX(price) AS price FROM books GROUP BY genre HAVING price = MAX(price) AND genre = genre AND 0', 'no_rows'],
  ['a11', 'SELECT genre, title, price, RANK() OVER (PARTITION BY genre ORDER BY price DESC) AS rnk FROM books WHERE rnk = 1', 'sql_error'],
  ['a12', "SELECT month, revenue, SUM(revenue) OVER () AS running_total FROM monthly_sales WHERE region = 'East' ORDER BY month", 'wrong_values'],
  ['a14', "SELECT month, revenue, ROUND(AVG(revenue) OVER (ORDER BY month ROWS BETWEEN 3 PRECEDING AND CURRENT ROW), 2) AS moving_avg_3m FROM monthly_sales WHERE region = 'North' ORDER BY month", 'wrong_values'],
  ['a15', "SELECT region, revenue, ROUND(revenue / SUM(revenue) OVER (), 1) AS pct_of_month FROM monthly_sales WHERE month = '2024-12' ORDER BY pct_of_month DESC", 'wrong_values'],
  ['a18', "SELECT start_date AS month, COUNT(*) AS new_subscriptions, SUM(monthly_price) AS new_mrr FROM subscriptions GROUP BY month ORDER BY month", 'row_count'],
];

for (const [id, sql, code, tipPattern] of WRONG_ANSWERS) {
  test(`${id} wrong answer → ${code}: ${sql.slice(0, 70)}`, async () => {
    const lesson = C.getLesson(id);
    const db = await lessonDb(lesson.tables);
    const expected = G.runQuery(db, lesson.solution);
    const r = G.grade(db, sql, lesson, expected, gradeCtx(lesson));
    assert.equal(r.code, code, `${r.title}: ${r.message} ${r.tip || ''}`);
    assert.ok(r.title && r.message, 'feedback has a title and a message');
    if (tipPattern) assert.ok([r.tip, ...r.tips].some(t => tipPattern.test(t || '')), `no tip matching ${tipPattern}`);
    db.close();
  });
}

test('venn() draws every join kind', () => {
  for (const kind of ['inner', 'left', 'right', 'full', 'anti']) {
    const svg = C.venn(kind, 'a', 'b');
    assert.match(svg, /<svg/);
  }
});
