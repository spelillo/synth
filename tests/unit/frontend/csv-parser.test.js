// Unit tests for csv-parser.js: table/column naming, the non-CSV sniffing,
// the quote-aware line parser, and thousands-separator normalization.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('../../helpers/browser-env');

const plain = v => JSON.parse(JSON.stringify(v));
function env() {
  const progress = [];
  const e = loadBrowserScripts(['state.js', 'csv-parser.js', 'json-parser.js'], {
    stubs: { advanceLoadProgress: n => progress.push(n), openPremiumPanel: () => {}, canUseFeature: () => true },
  });
  e.progress = progress;
  return e;
}
const parse = async (text) => plain(await env().get('parseCSVText')(text));

test('slugifyTableName: lower-cases, strips the extension, and underscores punctuation', () => {
  const slug = env().get('slugifyTableName');
  assert.equal(slug('Sales Report (Q1).csv'), 'sales_report_q1');
  assert.equal(slug('my.data.file.json'), 'my_data_file');
});

test('slugifyTableName: prefixes names starting with a digit (SQLite identifiers)', () => {
  assert.equal(env().get('slugifyTableName')('2024-sales.csv'), 't_2024_sales');
});

test('slugifyTableName: falls back to "table" when nothing usable is left', () => {
  const slug = env().get('slugifyTableName');
  assert.equal(slug('.csv'), 'table');
  assert.equal(slug('###.csv'), 'table');
  assert.equal(slug('日本語.csv'), 'table');
});

test('sanitizeColumnName: collapses inner whitespace to underscores and trims', () => {
  const s = env().get('sanitizeColumnName');
  assert.equal(s('  Student   ID '), 'Student_ID');
  assert.equal(s('first\tname'), 'first_name');
  assert.equal(s('already_ok'), 'already_ok');
});

test('uniqueTableName: returns the base when free, else the next free _N suffix', () => {
  const e = env();
  const u = e.get('uniqueTableName');
  assert.equal(u('sales'), 'sales');
  e.set('tables', [{ name: 'sales' }, { name: 'sales_2' }]);
  assert.equal(u('sales'), 'sales_3');
  assert.equal(u('other'), 'other');
});

test('looksLikeNonCsvFile: detects xlsx/docx (zip), legacy xls, and binary noise', () => {
  const sniff = env().get('looksLikeNonCsvFile');
  assert.match(sniff('PK\u0003\u0004 rest of zip'), /zip-based/);
  assert.match(sniff('�� binary'), /binary file/);
  assert.match(sniff('\u0000\u0001\u0002\u0003abc'), /binary file, not text/);
});

test('looksLikeNonCsvFile: plain CSV, tabs and newlines are fine', () => {
  const sniff = env().get('looksLikeNonCsvFile');
  assert.equal(sniff('a,b\n1,2\n'), null);
  assert.equal(sniff('a\tb\r\n1\t2'), null);
  assert.equal(sniff(''), null);
});

test('parseCSVText: headers and rows', async () => {
  assert.deepEqual(await parse('name,age\nAda,36\nAlan,41\n'), { headers: ['name', 'age'], rows: [['Ada', '36'], ['Alan', '41']] });
});

test('parseCSVText: quoted fields keep their commas', async () => {
  const r = await parse('city,note\n"Austin, TX","a, b, c"');
  assert.deepEqual(r.rows, [['Austin, TX', 'a, b, c']]);
});

test('parseCSVText: Windows line endings are handled', async () => {
  const r = await parse('a,b\r\n1,2\r\n3,4\r\n');
  assert.deepEqual(r, { headers: ['a', 'b'], rows: [['1', '2'], ['3', '4']] });
});

test('parseCSVText: blank lines and all-empty rows are skipped', async () => {
  const r = await parse('a,b\n\n1,2\n,\n   \n3,4');
  assert.deepEqual(r.rows, [['1', '2'], ['3', '4']]);
});

test('parseCSVText: header names are de-quoted and sanitized', async () => {
  const r = await parse('"Student ID","First Name"\n1,Ada');
  assert.deepEqual(r.headers, ['Student_ID', 'First_Name']);
});

test('parseCSVText: ragged rows are kept as-is (padding happens at insert time)', async () => {
  const r = await parse('a,b,c\n1,2\n1,2,3,4');
  assert.deepEqual(r.rows, [['1', '2'], ['1', '2', '3', '4']]);
});

test('parseCSVText: a header-only file has zero rows', async () => {
  assert.deepEqual(await parse('a,b\n'), { headers: ['a', 'b'], rows: [] });
});

test('parseCSVText: empty and whitespace-only files throw "Empty CSV file"', async () => {
  const p = env().get('parseCSVText');
  await assert.rejects(p(''), /Empty CSV file/);
  await assert.rejects(p('\n \n'), /Empty CSV file/);
});

test('parseCSVText: an .xlsx renamed to .csv gets a friendly error', async () => {
  await assert.rejects(env().get('parseCSVText')('PK\u0003\u0004....'), /doesn't look like a CSV.*Excel/);
});

test('parseCSVText: thousands separators are stripped from numeric columns', async () => {
  const r = await parse('item,amount\na,"1,200"\nb,450\nc,"12,345.50"');
  assert.deepEqual(r.rows.map(x => x[1]), ['1200', '450', '12345.50']);
});

test('parseCSVText: a text column that happens to contain commas is left alone', async () => {
  const r = await parse('item,tags\na,"red,blue"\nb,450');
  assert.deepEqual(r.rows.map(x => x[1]), ['red,blue', '450']);
});

test('parseCSVText: reports progress for every data row (loading bar)', async () => {
  const e = env();
  await e.get('parseCSVText')('a\n1\n2\n3');
  assert.ok(e.progress.reduce((x, y) => x + y, 0) >= 3);
});

test('parseCSVText: a file larger than one chunk (5,000 rows) parses completely', async () => {
  const body = Array.from({ length: 12001 }, (_, i) => `${i},row${i}`).join('\n');
  const r = await parse(`id,name\n${body}`);
  assert.equal(r.rows.length, 12001);
  assert.deepEqual(r.rows.at(-1), ['12000', 'row12000']);
});

// Known limitations of the hand-rolled parser (RFC 4180 features it does
// not support). Recorded as todo so they show up in every test report
// without failing the build; flip to `test` once the parser is fixed.
test.todo('KNOWN BUG: escaped quotes ("") inside a quoted field are dropped instead of kept as one "', async () => {
  const r = await parse('quote\n"He said ""hi"""');
  assert.equal(r.rows[0][0], 'He said "hi"');
});

test.todo('KNOWN BUG: a newline inside a quoted field splits the record in two', async () => {
  const r = await parse('a,b\n"line1\nline2",x');
  assert.deepEqual(r.rows, [['line1\nline2', 'x']]);
});

test('a UTF-8 BOM (Excel "CSV UTF-8") does not leak into the first column name', async () => {
  const r = await parse('\uFEFFid,name\n1,a');
  assert.equal(r.headers[0], 'id');
});
