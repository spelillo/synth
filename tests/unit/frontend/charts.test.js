// Unit tests for the pure parts of charts.js: number parsing, column
// analysis, spec heuristics/normalization, data prep, scales and SVG output.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('../../helpers/browser-env');

const plain = v => JSON.parse(JSON.stringify(v));
const env = loadBrowserScripts(['state.js', 'grid.js', 'charts.js']);
const fn = name => env.get(name);
const info = (cols, rows) => plain(fn('analyzeChartColumns')(cols, rows));

test('parseChartNumber: plain, grouped, currency, percent and accounting negatives', () => {
  const p = fn('parseChartNumber');
  assert.equal(p('1,200'), 1200);
  assert.equal(p('$4.50'), 4.5);
  assert.equal(p('45%'), 45);
  assert.equal(p('(300)'), -300);
  assert.equal(p('-2.5e3'), -2500);
  assert.equal(p('.5'), 0.5);
  assert.equal(p(7), 7);
});

test('parseChartNumber: non-numbers are null', () => {
  const p = fn('parseChartNumber');
  for (const v of [null, undefined, '', '  ', 'abc', '12abc', '1.2.3', NaN, Infinity, '2024-01-01']) assert.equal(p(v), null, String(v));
});

test('analyzeChartColumns: numeric vs text vs date, with id/zip detection', () => {
  const cols = info(['region', 'sales', 'zip', 'order_date'], [
    ['East', '1,200', '78701', '2024-01-05'],
    ['West', '900', '94105', '2024-02-05'],
  ]);
  assert.deepEqual(cols.map(c => c.kind), ['text', 'numeric', 'numeric', 'date']);
  assert.equal(cols[2].idLike, true);
  assert.equal(cols[3].temporal, true);
  assert.equal(cols[1].absMax, 1200);
});

test('analyzeChartColumns: numbers with leading zeros (codes) stay text', () => {
  assert.equal(info(['code'], [['007'], ['012']])[0].kind, 'text');
});

test('analyzeChartColumns: a year column named "year" is temporal; a month-name text column too', () => {
  const cols = info(['year', 'month', 'n'], [['2021', 'Jan', '1'], ['2022', 'Feb', '2']]);
  assert.equal(cols[0].temporal, true);
  assert.equal(cols[1].temporal, true);
  assert.equal(cols[2].temporal, false);
});

test('analyzeChartColumns: an all-empty column is text with no values', () => {
  const [c] = info(['x'], [[''], [null]]);
  assert.equal(c.kind, 'text');
  assert.equal(c.nonEmpty, 0);
});

test('prettifyColumnName: snake/camel case and SQL aggregates read as English', () => {
  const p = fn('prettifyColumnName');
  assert.equal(p('total_sales'), 'Total Sales');
  assert.equal(p('orderDate'), 'Order Date');
  assert.equal(p('SUM(amount)'), 'Total Amount');
  assert.equal(p('avg(unit_price)'), 'Average Unit Price');
  assert.equal(p('COUNT(*)'), 'Count');
  assert.equal(p('count(distinct user_id)'), 'Count of User Id');
  assert.equal(p('ROUND(price, 2)'), 'Price');
  assert.equal(p('NFL_team'), 'NFL Team');
  assert.equal(p('___'), '___');
});

test('heuristicChartSpec: category + number -> column chart with sensible titles', () => {
  const i = info(['region', 'sales'], [['East', '10'], ['West', '20']]);
  const s = plain(fn('heuristicChartSpec')(i, 2));
  assert.equal(s.type, 'column');
  assert.equal(s.category, 0);
  assert.deepEqual(s.values, [1]);
  assert.equal(s.title, 'Sales by Region');
});

test('heuristicChartSpec: a date column makes a line chart', () => {
  const i = info(['day', 'visits'], [['2024-01-01', '5'], ['2024-01-02', '7']]);
  assert.equal(fn('heuristicChartSpec')(i, 2).type, 'line');
});

test('heuristicChartSpec: many categories -> horizontal bar; very many -> line', () => {
  const rows = n => Array.from({ length: n }, (_, k) => [`c${k}`, String(k)]);
  assert.equal(fn('heuristicChartSpec')(info(['c', 'v'], rows(20)), 20).type, 'bar');
  assert.equal(fn('heuristicChartSpec')(info(['c', 'v'], rows(100)), 100).type, 'line');
});

test('heuristicChartSpec: two numeric columns only -> scatter', () => {
  const i = info(['height', 'weight'], [['1', '2'], ['3', '4']]);
  assert.equal(fn('heuristicChartSpec')(i, 2).type, 'scatter');
});

test('heuristicChartSpec: no numeric column -> a helpful error', () => {
  const r = fn('heuristicChartSpec')(info(['a', 'b'], [['x', 'y']]), 1);
  assert.match(r.error, /at least one numeric column/);
});

test('heuristicChartSpec: a series 10x smaller than the lead is dropped', () => {
  const i = info(['c', 'big', 'small'], [['a', '1000', '1'], ['b', '2000', '2']]);
  assert.deepEqual(plain(fn('heuristicChartSpec')(i, 2).values), [1]);
});

test('normalizeChartSpec: repairs an invalid type/category/values', () => {
  const i = info(['c', 'v'], [['a', '1']]);
  const s = plain(fn('normalizeChartSpec')({ type: 'radar', category: 99, values: [0, 0, 'x'] }, i, 1));
  assert.equal(s.type, 'column');
  assert.equal(s.category, -1);
  assert.deepEqual(s.values, [1]);
});

test('normalizeChartSpec: pie with too many slices falls back to column; pie keeps one series', () => {
  const rows = Array.from({ length: 8 }, (_, k) => [`c${k}`, String(k + 1), String(k + 2)]);
  const i = info(['c', 'a', 'b'], rows);
  assert.equal(fn('normalizeChartSpec')({ type: 'pie', category: 0, values: [1, 2] }, i, 8).type, 'column');
  const s = plain(fn('normalizeChartSpec')({ type: 'pie', category: 0, values: [1, 2] }, i, 5));
  assert.equal(s.type, 'pie');
  assert.deepEqual(s.values, [1]);
});

test('aiRawToSpec: maps AI column names (case-insensitive) and rejects unknown categories', () => {
  const i = info(['Region', 'Sales'], [['East', '1']]);
  const s = plain(fn('aiRawToSpec')({ type: 'bar', category: 'region', values: ['SALES'], title: '  Sales   by region ' }, i, 1));
  assert.equal(s.type, 'bar');
  assert.equal(s.category, 0);
  assert.equal(s.title, 'Sales by region');
  assert.equal(fn('aiRawToSpec')({ category: 'nope', values: ['Sales'] }, i, 1), null);
  assert.equal(fn('aiRawToSpec')({ category: 'Region', values: ['Region'] }, i, 1), null, 'text value column is refused');
});

test('buildChartData: caps points per chart type and labels blanks', () => {
  const rows = Array.from({ length: 80 }, (_, k) => [k === 0 ? '' : `c${k}`, String(k)]);
  const d = plain(fn('buildChartData')({ type: 'column', category: 0, values: [1] }, ['cat', 'n'], rows));
  assert.equal(d.shown, 50);
  assert.equal(d.total, 80);
  assert.equal(d.categories[0], '(blank)');
  assert.equal(d.series[0].name, 'N');
});

test('buildChartData: pie drops zero/negative slices and counts them', () => {
  const d = plain(fn('buildChartData')({ type: 'pie', category: 0, values: [1] }, ['c', 'v'], [['a', '5'], ['b', '0'], ['c', '-1']]));
  assert.deepEqual(d.categories, ['a']);
  assert.equal(d.dropped, 2);
});

test('buildChartData: scatter skips rows with a non-numeric x', () => {
  const d = plain(fn('buildChartData')({ type: 'scatter', category: 0, values: [1] }, ['x', 'y'], [['1', '2'], ['bad', '3'], ['4', '5']]));
  assert.equal(d.points.length, 2);
});

test('niceScale: round ticks that cover the data', () => {
  const s = plain(fn('niceScale')(3, 97));
  assert.equal(s.lo, 0);
  assert.equal(s.hi, 100);
  assert.deepEqual(s.ticks, [0, 20, 40, 60, 80, 100]);
});

test('niceScale: degenerate inputs (equal, zero, NaN) still produce a usable axis', () => {
  const n = fn('niceScale');
  assert.ok(n(0, 0).hi > 0);
  const s = n(50, 50);
  assert.ok(s.lo < 50 && s.hi > 50);
  assert.ok(n(NaN, Infinity).ticks.length > 1);
});

test('formatTick / formatChartValue: compact for big numbers, decimals for small steps, dash for null', () => {
  assert.equal(fn('formatTick')(25000, 5000), '25K');
  assert.equal(fn('formatTick')(0.25, 0.05), '0.25');
  assert.equal(fn('formatChartValue')(1234.567), '1,234.57');
  assert.equal(fn('formatChartValue')(2500000), '2.5M');
  assert.equal(fn('formatChartValue')(null), '—');
});

test('relativeLuminance: black is 0, white is 1', () => {
  assert.equal(fn('relativeLuminance')('#000000'), 0);
  assert.equal(fn('relativeLuminance')('#ffffff'), 1);
});

test('chartTypeAllowed: pie needs few rows, scatter needs two numeric columns', () => {
  const i = info(['c', 'v'], [['a', '1']]);
  assert.equal(fn('chartTypeAllowed')('pie', i, 6), true);
  assert.equal(fn('chartTypeAllowed')('pie', i, 7), false);
  assert.equal(fn('chartTypeAllowed')('scatter', i, 1), false);
  assert.equal(fn('chartTypeAllowed')('line', i, 1000), true);
});

const theme = { dark: false, surface: '#fff', text: '#000', text2: '#555', grid: '#eee', axis: '#ccc', series: ['#eb6834', '#2a78d6', '#1baf7a', '#4a3aa7', '#eda100', '#e87ba4'] };

for (const type of ['column', 'bar', 'line', 'area', 'scatter', 'pie', 'doughnut']) {
  test(`renderChartSVG(${type}): produces a well-formed SVG with one mark per point`, () => {
    const rows = [['a', '3', '4'], ['b', '5', '6'], ['c', '7', '8']];
    const spec = plain(fn('normalizeChartSpec')({ type, category: type === 'scatter' ? 1 : 0, values: [type === 'scatter' ? 2 : 1] }, info(['c', 'x', 'y'], rows), 3));
    const svg = fn('renderChartSVG')(spec, fn('buildChartData')(spec, ['c', 'x', 'y'], rows), theme);
    assert.match(svg, /^<svg viewBox="0 0 760 /);
    const doc = new env.window.DOMParser().parseFromString(svg, 'image/svg+xml');
    assert.equal(doc.getElementsByTagName('parsererror').length, 0, 'valid XML');
    assert.ok(doc.querySelectorAll('.chart-mark, path, circle').length >= 3);
  });
}

test('renderChartSVG escapes category labels (no markup injection from data)', () => {
  const rows = [['<script>alert(1)</script>', '3']];
  const spec = plain(fn('normalizeChartSpec')({ type: 'column', category: 0, values: [1] }, info(['c', 'v'], rows), 1));
  const svg = fn('renderChartSVG')(spec, fn('buildChartData')(spec, ['c', 'v'], rows), theme);
  assert.doesNotMatch(svg, /<script>/);
});
