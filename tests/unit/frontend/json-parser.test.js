// Unit tests for json-parser.js: JSON / NDJSON flattening, row caps,
// table loading into sql.js, and small helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { loadBrowserScripts } = require('../../helpers/browser-env');

const plain = v => JSON.parse(JSON.stringify(v));
function env(features = {}) {
  const calls = { premiumPanel: 0 };
  const e = loadBrowserScripts(['state.js', 'csv-parser.js', 'json-parser.js'], {
    stubs: {
      advanceLoadProgress: () => {},
      openPremiumPanel: () => { calls.premiumPanel++; },
      canUseFeature: k => features[k] !== false,
    },
  });
  e.calls = calls;
  return e;
}

test('isPlainObject: only non-null, non-array objects', () => {
  const f = env().get('isPlainObject');
  assert.equal(f({}), true);
  for (const v of [null, [], 'x', 1, undefined]) assert.equal(f(v), false);
});

test('flattenJSONRecord: nested objects become dot-notation columns', () => {
  const f = env().get('flattenJSONRecord');
  assert.deepEqual(plain(f({ id: 1, address: { city: 'Austin', geo: { lat: 30 } } }, '', {})),
    { id: '1', 'address.city': 'Austin', 'address.geo.lat': '30' });
});

test('flattenJSONRecord: arrays are stored as JSON text; null/undefined become empty', () => {
  const f = env().get('flattenJSONRecord');
  assert.deepEqual(plain(f({ tags: ['a', 'b'], n: null, flag: false }, '', {})), { tags: '["a","b"]', n: '', flag: 'false' });
});

test('parseJSONRecords: a JSON array of objects', () => {
  assert.equal(env().get('parseJSONRecords')('[{"a":1},{"a":2}]').length, 2);
});

test('parseJSONRecords: a single object is a one-row table', () => {
  assert.deepEqual(plain(env().get('parseJSONRecords')('{"a":1}')), [{ a: 1 }]);
});

test('parseJSONRecords: NDJSON, ignoring blank lines', () => {
  assert.deepEqual(plain(env().get('parseJSONRecords')('{"a":1}\n\n{"a":2}\n')), [{ a: 1 }, { a: 2 }]);
});

test('parseJSONRecords: reports the bad line number in malformed NDJSON', () => {
  assert.throws(() => env().get('parseJSONRecords')('{"a":1}\n{oops}\n{"a":3}'), /line 2/);
});

test('parseJSONRecords: empty input throws', () => {
  assert.throws(() => env().get('parseJSONRecords')('   '), /Empty JSON file/);
});

test('parseJSONText: unions keys across records, in first-seen order', async () => {
  const r = plain(await env().get('parseJSONText')('[{"a":1,"b":2},{"b":3,"c":{"d":4}}]'));
  assert.deepEqual(r.headers, ['a', 'b', 'c.d']);
  assert.deepEqual(r.rows, [['1', '2', ''], ['', '3', '4']]);
});

test('parseJSONText: a scalar array is rejected with a helpful message', async () => {
  await assert.rejects(env().get('parseJSONText')('[1,2,3]'), /object|record/i);
});

test('isJSONFile: .json, .ndjson, .jsonl (any case); not .csv', () => {
  const f = env().get('isJSONFile');
  for (const n of ['a.json', 'b.NDJSON', 'c.jsonl']) assert.equal(f(n), true, n);
  for (const n of ['a.csv', 'a.json.csv', 'a.txt']) assert.equal(f(n), false, n);
});

test('isJSONFile: a bare file name "json" (no extension) counts as JSON (documents current behaviour)', () => {
  assert.equal(env().get('isJSONFile')('json'), true);
});

test('parseUploadedFile: routes by extension', async () => {
  const f = env().get('parseUploadedFile');
  assert.deepEqual(plain(await f('x.json', '[{"a":1}]')).headers, ['a']);
  assert.deepEqual(plain(await f('x.csv', 'b\n2')).headers, ['b']);
});

test('maxTablesForTier / csvRowCapForTier follow the feature gates', () => {
  const premium = env();
  assert.equal(premium.get('maxTablesForTier')(), 10);
  assert.equal(premium.get('csvRowCapForTier')(), 500000);
  const free = env({ multiCsv: false, largeCsv: false });
  assert.equal(free.get('maxTablesForTier')(), 1);
  assert.equal(free.get('csvRowCapForTier')(), 100000);
});

test('assertRowCapOrThrow: at the cap is fine, one over throws', () => {
  const e = env();
  const f = e.get('assertRowCapOrThrow');
  assert.doesNotThrow(() => f(500000));
  assert.throws(() => f(500001), /maximum supported size/);
  assert.equal(e.calls.premiumPanel, 0);
});

test('assertRowCapOrThrow: a free account over 100k sees the upgrade panel', () => {
  const e = env({ largeCsv: false });
  assert.throws(() => e.get('assertRowCapOrThrow')(100001), /Upgrade to Premium/);
  assert.equal(e.calls.premiumPanel, 1);
});

test('formatFileSize: KB under 1 MB, MB above', () => {
  const f = env().get('formatFileSize');
  assert.equal(f({ size: 2048 }), '2.0KB');
  assert.equal(f({ size: 5 * 1024 * 1024 }), '5.0MB');
  assert.equal(f({ size: 0 }), '0.0KB');
});

test('yieldToUI resolves', async () => {
  await env().get('yieldToUI')();
});

test('loadFileAsTable: creates a TEXT table, pads short rows, truncates long ones, registers metadata', async () => {
  const SQL = await initSqlJs();
  const e = env();
  e.set('db', new SQL.Database());
  const meta = plain(await e.get('loadFileAsTable')({ name: 'people.csv' }, ['name', 'age'], [['Ada', '36'], ['Alan'], ['Grace', '85', 'extra']], 'people'));
  assert.deepEqual(meta, { name: 'people', fileName: 'people.csv', rowCount: 3, columns: ['name', 'age'] });
  const res = e.get('db').exec('SELECT name, age FROM people ORDER BY rowid');
  assert.deepEqual(plain(res[0].values), [['Ada', '36'], ['Alan', ''], ['Grace', '85']]);
  assert.equal(e.get('tables').length, 1);
});

test('loadFileAsTable: a second table with the same name gets a suffix', async () => {
  const SQL = await initSqlJs();
  const e = env();
  e.set('db', new SQL.Database());
  const load = e.get('loadFileAsTable');
  await load({ name: 'a.csv' }, ['x'], [['1']], 'sales');
  const m2 = await load({ name: 'b.csv' }, ['x'], [['2']], 'sales');
  assert.equal(m2.name, 'sales_2');
});

test('loadFileAsTable: column names with quotes/SQL are stored safely as identifiers', async () => {
  const SQL = await initSqlJs();
  const e = env();
  e.set('db', new SQL.Database());
  await e.get('loadFileAsTable')({ name: 'x.csv' }, ['a; DROP TABLE x;--'], [["'); DROP TABLE x;--"]], 'x');
  const res = e.get('db').exec('SELECT * FROM x');
  assert.equal(res[0].values[0][0], "'); DROP TABLE x;--", 'values are bound, not interpolated');
});
