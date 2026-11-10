// Integration: the client-side data path, end to end without a browser.
// File text -> parseUploadedFile (CSV or JSON) -> loadFileAsTable into a
// real sql.js database -> SQL (joins, aggregates) -> chart spec + data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { loadBrowserScripts, ROOT } = require('../helpers/browser-env');

const plain = v => JSON.parse(JSON.stringify(v));

async function workspace() {
  const SQL = await initSqlJs();
  const env = loadBrowserScripts(['state.js', 'csv-parser.js', 'json-parser.js', 'grid.js', 'charts.js'], {
    stubs: { advanceLoadProgress: () => {}, openPremiumPanel: () => {}, canUseFeature: () => true },
  });
  env.set('db', new SQL.Database());
  const upload = async (fileName, text) => {
    const { headers, rows } = await env.get('parseUploadedFile')(fileName, text);
    env.get('assertRowCapOrThrow')(rows.length);
    return plain(await env.get('loadFileAsTable')({ name: fileName }, headers, rows, env.get('slugifyTableName')(fileName)));
  };
  const query = sql => {
    const r = env.get('db').exec(sql);
    return r.length ? plain({ columns: r[0].columns, rows: r[0].values }) : { columns: [], rows: [] };
  };
  return { env, upload, query };
}

test('a CSV upload is queryable with numeric aggregates despite thousands separators', async () => {
  const { upload, query } = await workspace();
  const meta = await upload('Sales 2024.csv', 'region,amount\nEast,"1,200"\nWest,800\nEast,"2,000"\n');
  assert.equal(meta.name, 'sales_2024');
  const r = query('SELECT region, SUM(CAST(amount AS REAL)) AS total FROM sales_2024 GROUP BY region ORDER BY region');
  assert.deepEqual(r.rows, [['East', 3200], ['West', 800]]);
});

test('a JSON upload with nested objects is queryable by dot-notation column', async () => {
  const { upload, query } = await workspace();
  await upload('users.json', JSON.stringify([
    { id: 1, name: 'Ada', address: { city: 'London' }, tags: ['math'] },
    { id: 2, name: 'Grace', address: { city: 'New York' }, tags: ['navy', 'cobol'] },
  ]));
  assert.deepEqual(query('SELECT name FROM users WHERE "address.city" = \'London\'').rows, [['Ada']]);
  assert.deepEqual(query('SELECT name, json_array_length(tags) FROM users ORDER BY id').rows, [['Ada', 1], ['Grace', 2]]);
});

test('NDJSON + CSV in one workspace can be JOINed', async () => {
  const { upload, query } = await workspace();
  await upload('customers.csv', 'id,name\n1,Ada\n2,Grace\n');
  await upload('orders.ndjson', '{"order_id":10,"customer_id":1,"total":5}\n{"order_id":11,"customer_id":1,"total":7}\n{"order_id":12,"customer_id":2,"total":1}\n');
  const r = query('SELECT c.name, COUNT(*) n, SUM(o.total) t FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name ORDER BY c.name');
  assert.deepEqual(r.rows, [['Ada', 2, 12], ['Grace', 1, 1]]);
});

test('uploading the same file twice keeps both tables (sales, sales_2)', async () => {
  const { env, upload } = await workspace();
  await upload('sales.csv', 'a\n1');
  const second = await upload('sales.csv', 'a\n2');
  assert.equal(second.name, 'sales_2');
  assert.deepEqual(plain(env.get('tables')).map(t => t.name), ['sales', 'sales_2']);
});

test('an upload over the row cap is refused before anything is inserted', async () => {
  const SQL = await initSqlJs();
  const env = loadBrowserScripts(['state.js', 'csv-parser.js', 'json-parser.js'], {
    stubs: { advanceLoadProgress: () => {}, openPremiumPanel: () => {}, canUseFeature: k => k !== 'largeCsv' },
  });
  env.set('db', new SQL.Database());
  const { rows } = await env.get('parseCSVText')('a\n' + Array.from({ length: 100001 }, (_, i) => i).join('\n'));
  assert.throws(() => env.get('assertRowCapOrThrow')(rows.length), /100,000-row limit/);
  assert.equal(env.get('tables').length, 0);
});

test('every bundled sample dataset loads and returns its full row count', async () => {
  const { upload, query } = await workspace();
  const dir = path.join(ROOT, 'sample-data');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.csv'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const meta = await upload(f, text);
    const [[n]] = query(`SELECT COUNT(*) FROM "${meta.name}"`).rows;
    assert.equal(n, meta.rowCount, f);
    assert.ok(n > 0, f);
  }
});

test('query results feed straight into a chart: SQL -> analyze -> heuristic spec -> SVG', async () => {
  const { env, upload, query } = await workspace();
  await upload('grocery.csv', fs.readFileSync(path.join(ROOT, 'sample-data', 'grocery_store_data.csv'), 'utf8'));
  const cols = query('SELECT * FROM grocery LIMIT 1').columns;
  const textCol = cols[1];
  const r = query(`SELECT "${textCol}" AS category, COUNT(*) AS n FROM grocery GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
  const info = env.get('analyzeChartColumns')(r.columns, r.rows);
  const spec = plain(env.get('heuristicChartSpec')(info, r.rows.length));
  assert.ok(!spec.error, spec.error);
  assert.deepEqual(spec.values, [1]);
  const data = env.get('buildChartData')(spec, r.columns, r.rows);
  const svg = env.get('renderChartSVG')(spec, data, { surface: '#fff', text: '#000', text2: '#555', grid: '#eee', axis: '#ccc', series: ['#111', '#222', '#333', '#444', '#555', '#666'] });
  assert.match(svg, /<svg/);
});

test('user SQL cannot escape the in-browser database (no file system / ATTACH side effects)', async () => {
  const { upload, query } = await workspace();
  await upload('t.csv', 'a\n1');
  assert.throws(() => query("ATTACH DATABASE '/etc/passwd' AS x"), /./);
  assert.deepEqual(query('SELECT COUNT(*) FROM t').rows, [[1]]);
});
