// Unit tests for small pure helpers in grid.js and app.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('../../helpers/browser-env');

const plain = v => JSON.parse(JSON.stringify(v));
const env = loadBrowserScripts(['state.js', 'csv-parser.js', 'json-parser.js', 'storage-cookie.js', 'checkout.js', 'grid.js', 'charts.js', 'chat.js', 'app.js']);
const fn = name => env.get(name);

test('escapeHtml: escapes &, <, > and leaves quotes for text nodes', () => {
  assert.equal(fn('escapeHtml')('<a href="x">&</a>'), '&lt;a href="x"&gt;&amp;&lt;/a&gt;');
  assert.equal(fn('escapeHtml')(''), '');
});

test('escapeAttr: also escapes double quotes for attribute values', () => {
  assert.doesNotMatch(fn('escapeAttr')('" onmouseover="x'), /"/);
});

test('formatStatNumber / truncateForStats', () => {
  assert.equal(typeof fn('formatStatNumber')(1234.5678), 'string');
  assert.equal(fn('truncateForStats')('x'.repeat(50), 10).length <= 11, true);
  assert.equal(fn('truncateForStats')('short'), 'short');
});

test('timeAgo: just now / minutes / hours / days / falls back to a date', () => {
  const ago = ms => new Date(Date.now() - ms).toISOString();
  assert.equal(fn('timeAgo')(ago(10e3)), 'just now');
  assert.equal(fn('timeAgo')(ago(5 * 60e3)), '5m ago');
  assert.equal(fn('timeAgo')(ago(3 * 3600e3)), '3h ago');
  assert.equal(fn('timeAgo')(ago(2 * 86400e3)), '2d ago');
  assert.match(fn('timeAgo')(ago(60 * 86400e3)), /\d/);
});

test('singularize: ies -> y, ses -> s, s -> "", ss unchanged', () => {
  const s = fn('singularize');
  assert.equal(s('categories'), 'category');
  assert.equal(s('classes'), 'class');
  assert.equal(s('students'), 'student');
  assert.equal(s('glass'), 'glass');
  assert.equal(s('staff'), 'staff');
});

test('relationshipKey is stable and direction-sensitive', () => {
  const k = fn('relationshipKey');
  const a = { fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' };
  assert.equal(k(a), 'orders.customer_id|customers.id');
  assert.notEqual(k(a), k({ fromTable: 'customers', fromColumn: 'id', toTable: 'orders', toColumn: 'customer_id' }));
});

test('inferRelationships: suggests foo_id -> foos.id (plural and singular table names)', () => {
  env.set('tables', [
    { name: 'students', columns: ['id', 'name', 'major_id'] },
    { name: 'majors', columns: ['id', 'title'] },
    { name: 'category', columns: ['id'] },
    { name: 'items', columns: ['id', 'category_id', 'student_id'] },
  ]);
  const r = plain(fn('inferRelationships')()).map(fn('relationshipKey'));
  assert.deepEqual(r.sort(), ['items.category_id|category.id', 'items.student_id|students.id', 'students.major_id|majors.id']);
});

test('inferRelationships: never links a table\'s id to itself', () => {
  env.set('tables', [{ name: 'ids', columns: ['id'] }]);
  assert.deepEqual(plain(fn('inferRelationships')()), []);
});

// singularize() strips "es" from every "-ses" word, so courses -> "cours",
// houses -> "hous", purchases -> "purchas", and course_id -> courses.id is
// never suggested.
test.todo('KNOWN BUG: singularize("courses") should be "course" (breaks students.course_id -> courses.id)', () => {
  assert.equal(fn('singularize')('courses'), 'course');
  env.set('tables', [{ name: 'students', columns: ['id', 'course_id'] }, { name: 'courses', columns: ['id'] }]);
  assert.equal(plain(fn('inferRelationships')()).length, 1);
});

test('inferRelationships: no suggestion when the target has no id column', () => {
  env.set('tables', [{ name: 'orders', columns: ['customer_id'] }, { name: 'customers', columns: ['email'] }]);
  assert.deepEqual(plain(fn('inferRelationships')()), []);
});

test('rubberband: zero at zero, monotonic, bounded by the dimension', () => {
  const r = fn('rubberband');
  assert.equal(r(0, 300), 0);
  assert.ok(r(100, 300) < r(200, 300));
  assert.ok(r(1e6, 300) < 300 / 0.55 * 0.55 + 1);
  assert.ok(r(-100, 300) < 0);
});

test('cssEscapeId: anything outside [A-Za-z0-9_-] becomes _', () => {
  assert.equal(fn('cssEscapeId')('a.b c#d'), 'a_b_c_d');
});

test('the page init handlers are registered (not run) when the scripts load', () => {
  assert.ok(env.readyHandlers.length >= 1);
});
