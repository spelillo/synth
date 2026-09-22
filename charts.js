    // ---- Query results charts ----
    // A chart "spec" drives both the in-app SVG and the Excel export:
    //   { type, title, category, values, xAxisTitle, yAxisTitle }
    // category/values are column indexes (category -1 = row number).
    // xAxisTitle always names the category axis and yAxisTitle the value
    // axis, whichever way the chart is oriented (matches Excel's model).
    //
    // A local heuristic draws a chart instantly; if the user is signed in,
    // the AI then refines type/title/axis names. The AI only ever sees
    // column names, detected types, row count, and the SQL — never row
    // values, same boundary as the chat assistant.

    const CHART_TYPES = [
      { id: 'column', label: 'Column' },
      { id: 'bar', label: 'Bar (horizontal)' },
      { id: 'line', label: 'Line' },
      { id: 'area', label: 'Area' },
      { id: 'pie', label: 'Pie' },
      { id: 'doughnut', label: 'Doughnut' },
      { id: 'scatter', label: 'Scatter' },
    ];
    const CHART_TYPE_IDS = CHART_TYPES.map(t => t.id);
    const MAX_SERIES = 6;
    const MAX_SCATTER_SERIES = 3;
    const MAX_PIE_SLICES = 6;
    const MAX_POINTS = { column: 50, bar: 60, line: 1000, area: 1000, scatter: 2000, pie: MAX_PIE_SLICES, doughnut: MAX_PIE_SLICES };

    // Brand-orange-led order of the validated categorical palette (passes
    // adjacent-pair colorblind checks in both modes for these 6 slots; the
    // first 3 pass all-pairs, hence the scatter series cap).
    const CHART_PALETTE_LIGHT = ['#eb6834', '#2a78d6', '#1baf7a', '#4a3aa7', '#eda100', '#e87ba4'];
    const CHART_PALETTE_DARK = ['#d95926', '#3987e5', '#199e70', '#9085e9', '#c98500', '#d55181'];

    let lastResultsSql = '';
    let chartState = { key: null, info: null, spec: null, userEdited: false, aiStatus: 'idle', error: null };
    const aiChartSpecCache = new Map();

    function chartTheme() {
      const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const css = getComputedStyle(document.documentElement);
      const v = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
      return {
        dark,
        surface: v('--color-bg', dark ? '#1a1512' : '#fffefb'),
        text: v('--color-text', dark ? '#f0ebe3' : '#201515'),
        text2: v('--color-text-muted-2', dark ? '#b8b2a3' : '#605d52'),
        grid: dark ? '#332c26' : '#ebe7dd',
        axis: v('--color-border', dark ? '#4a4238' : '#c5c0b1'),
        series: dark ? CHART_PALETTE_DARK : CHART_PALETTE_LIGHT,
      };
    }

    // "1,200", "$4.50", "(300)", "45%" all read as numbers; anything else is null.
    function parseChartNumber(v) {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number') return isFinite(v) ? v : null;
      let s = String(v).trim();
      if (!s) return null;
      let neg = false;
      if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
      s = s.replace(/[,\s$€£¥%]/g, '');
      if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
      const n = parseFloat(s);
      return neg ? -n : n;
    }

    const DATE_RE = /^(\d{4}-\d{1,2}(-\d{1,2})?([ T].*)?|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}\/\d{1,2}(\/\d{1,2})?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}|\d{4}-q[1-4]|q[1-4][ -]\d{4})$/i;

    function analyzeChartColumns(columns, rows) {
      const sample = rows.length > 5000 ? rows.slice(0, 5000) : rows;
      return columns.map((name, c) => {
        let nonEmpty = 0, numeric = 0, dates = 0, leadingZero = 0, yearLike = 0, totalLen = 0, absMax = 0;
        const distinct = new Set();
        for (const row of sample) {
          const v = row[c];
          if (v === null || v === undefined || v === '') continue;
          nonEmpty++;
          const s = String(v).trim();
          totalLen += s.length;
          if (distinct.size < 1000) distinct.add(s);
          const n = parseChartNumber(v);
          if (n !== null) {
            numeric++;
            if (Math.abs(n) > absMax) absMax = Math.abs(n);
            if (/^0\d/.test(s)) leadingZero++;
            if (Number.isInteger(n) && n >= 1900 && n <= 2100) yearLike++;
          } else if (DATE_RE.test(s)) {
            dates++;
          }
        }
        const lname = String(name).toLowerCase();
        const idLike = /(^|_|\b)id$|^id_|uuid|zip|postal|phone/.test(lname);
        let kind = 'text';
        if (nonEmpty > 0 && numeric >= 0.9 * nonEmpty && leadingZero === 0) kind = 'numeric';
        else if (nonEmpty > 0 && dates >= 0.9 * nonEmpty) kind = 'date';
        const temporal = kind === 'date' ||
          (kind === 'numeric' && yearLike === numeric && /(year|yr|fy|season)/.test(lname)) ||
          (kind === 'text' && /(month|week|quarter|date|day|period)/.test(lname));
        return { index: c, name: String(name), kind, temporal, idLike: kind === 'numeric' && idLike, distinct: distinct.size, nonEmpty, avgLen: nonEmpty ? totalLen / nonEmpty : 0, absMax };
      });
    }

    function prettifyColumnName(name) {
      let s = String(name).trim().replace(/^["'`\[]|["'`\]]$/g, '');
      const agg = s.match(/^(sum|avg|average|count|min|max|total|median)\s*\(\s*(distinct\s+)?(.*?)\s*\)$/i);
      if (agg) {
        const fn = { sum: 'Total', total: 'Total', avg: 'Average', average: 'Average', count: 'Count', min: 'Minimum', max: 'Maximum', median: 'Median' }[agg[1].toLowerCase()];
        const inner = agg[3];
        if (!inner || inner === '*' || fn === 'Count') return inner && inner !== '*' ? `Count of ${prettifyColumnName(inner)}` : 'Count';
        return `${fn} ${prettifyColumnName(inner)}`;
      }
      const wrapped = s.match(/^(cast|round|replace|coalesce|abs|lower|upper|trim)\s*\(\s*([^,()]+)/i);
      if (wrapped) return prettifyColumnName(wrapped[2]);
      s = s.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
      if (!s) return String(name);
      return s.split(' ').map(w => (w.length <= 3 && w === w.toUpperCase() && /[A-Z]/.test(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }

    function numericCandidates(info, excludeIndex) {
      return info.filter(c => c.kind === 'numeric' && !c.idLike && c.index !== excludeIndex);
    }

    // Forces a spec into something drawable for these columns: valid
    // type, category, and 1..N numeric value columns.
    function normalizeChartSpec(spec, info, rowCount) {
      const s = { ...spec };
      if (!CHART_TYPE_IDS.includes(s.type)) s.type = 'column';
      if (!(Number.isInteger(s.category) && s.category >= -1 && s.category < info.length)) s.category = -1;

      if (s.type === 'scatter' && (s.category < 0 || info[s.category].kind !== 'numeric')) {
        const x = info.find(c => c.kind === 'numeric' && !(s.values || []).includes(c.index));
        if (x) s.category = x.index; else s.type = 'column';
      }

      let values = (s.values || []).filter((v, i, arr) => Number.isInteger(v) && info[v] && info[v].kind === 'numeric' && v !== s.category && arr.indexOf(v) === i);
      if (!values.length) {
        const first = numericCandidates(info, s.category)[0] || info.find(c => c.kind === 'numeric' && c.index !== s.category);
        if (first) values = [first.index];
      }
      if (s.type === 'scatter') values = values.slice(0, MAX_SCATTER_SERIES);
      else if (s.type === 'pie' || s.type === 'doughnut') values = values.slice(0, 1);
      else values = values.slice(0, MAX_SERIES);
      s.values = values;

      if ((s.type === 'pie' || s.type === 'doughnut') && rowCount > MAX_PIE_SLICES) s.type = 'column';
      if (!s.title) s.title = defaultChartTitle(s, info);
      if (s.xAxisTitle === undefined) s.xAxisTitle = s.category >= 0 ? prettifyColumnName(info[s.category].name) : 'Row';
      if (s.yAxisTitle === undefined) s.yAxisTitle = values.length === 1 ? prettifyColumnName(info[values[0]].name) : 'Value';
      return s;
    }

    function defaultChartTitle(s, info) {
      if (!s.values || !s.values.length) return 'Chart';
      const ys = s.values.map(v => prettifyColumnName(info[v].name));
      const x = s.category >= 0 ? prettifyColumnName(info[s.category].name) : null;
      let yPart = ys.length <= 2 ? ys.join(' and ') : `${ys.slice(0, -1).join(', ')} and ${ys[ys.length - 1]}`;
      if (yPart.length > 45) yPart = `${ys.slice(0, 2).join(', ')} and more`;
      if (s.type === 'scatter') return `${yPart} vs. ${x}`;
      if (!x) return yPart;
      return `${yPart} by ${x}`;
    }

    // One value axis only: a series 10x smaller than the lead series would
    // flatten into the baseline, so auto-picked specs drop it. The user can
    // still add it back by hand from the Values picker.
    function keepComparableSeries(values, info) {
      if (values.length < 2) return values;
      const lead = info[values[0]].absMax || 0;
      return values.filter((v, i) => i === 0 || !lead || (info[v].absMax >= lead / 10 && info[v].absMax <= lead * 10));
    }

    function heuristicChartSpec(info, rowCount) {
      const temporal = info.find(c => c.temporal);
      const texts = info.filter(c => c.kind !== 'numeric');
      let spec;
      if (temporal) {
        spec = { type: 'line', category: temporal.index, values: numericCandidates(info, temporal.index).map(c => c.index) };
      } else if (texts.length) {
        const cat = texts[0];
        let type = 'column';
        if (rowCount > MAX_POINTS.bar) type = 'line';
        else if (rowCount > 15 || cat.avgLen > 14) type = 'bar';
        spec = { type, category: cat.index, values: numericCandidates(info, cat.index).map(c => c.index) };
      } else {
        const nums = numericCandidates(info, -1);
        if (nums.length >= 2 && rowCount > 1) spec = { type: 'scatter', category: nums[0].index, values: nums.slice(1).map(c => c.index) };
        else spec = { type: rowCount > MAX_POINTS.column ? 'line' : 'column', category: -1, values: nums.map(c => c.index) };
      }
      spec.values = keepComparableSeries(spec.values, info);
      const normalized = normalizeChartSpec(spec, info, rowCount);
      if (!normalized.values.length) {
        return { error: 'Charts need at least one numeric column to plot. Try an aggregate query, e.g. SELECT category, COUNT(*) FROM your_table GROUP BY category.' };
      }
      return normalized;
    }

    function currentChartKey() {
      const st = viewStates.results;
      return JSON.stringify([lastResultsSql, st.columns, st.rows.length]);
    }

    // ---- AI refinement ----
    async function requestAiChartSpec(info, rowCount) {
      const cacheKey = JSON.stringify([lastResultsSql, info.map(c => [c.name, c.kind]), rowCount]);
      if (aiChartSpecCache.has(cacheKey)) return aiChartSpecCache.get(cacheKey);

      const promise = (async () => {
        const { data: { session } } = sb ? await sb.auth.getSession() : { data: { session: null } };
        if (!session) return { signedOut: true };

        const columns = info.map(c => ({ name: c.name, kind: c.temporal && c.kind !== 'date' ? `${c.kind} (time)` : c.kind, distinctValues: c.distinct }));
        const system = `You design one chart for the result of a SQL query. You only see column metadata, never data values.
Reply with ONLY a JSON object, no prose, no code fence:
{"type": "column|bar|line|area|pie|doughnut|scatter", "title": "...", "category": "<column name or null>", "values": ["<numeric column name>", ...], "xAxisTitle": "...", "yAxisTitle": "..."}
Rules:
- "values" must be numeric columns (1 to 6; scatter at most 3; pie/doughnut exactly 1). "category" labels the points: a text, date, or time column (or null to use row numbers). For scatter, "category" is the numeric X column.
- line or area when the category is a date/time/sequence; column for comparing up to ~15 categories; bar (horizontal) for long labels or 15-60 categories; pie/doughnut only for parts of a whole (sums/counts, never averages) with at most 6 rows; scatter for relating two numeric measures with no category.
- title: Title Case, under 60 characters, plain English a business reader understands. Use the SQL's filters/grouping for context (e.g. "2024 Revenue by Region"). Never include SQL syntax or function names like SUM( or COUNT(*).
- xAxisTitle names the category axis, yAxisTitle the value axis; short, plain English, include a unit only if the column name makes it explicit. For several value columns, yAxisTitle describes what they have in common.`;
        const user = JSON.stringify({ sql: lastResultsSql.slice(0, 4000), rowCount, columns });

        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            temperature: 0.2,
          }),
        });
        if (!response.ok) return { failed: true, status: response.status };
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return { failed: true };
        return { raw: JSON.parse(match[0]) };
      })().catch(() => ({ failed: true }));

      aiChartSpecCache.set(cacheKey, promise);
      const result = await promise;
      if (result.failed) aiChartSpecCache.delete(cacheKey);
      return result;
    }

    function aiRawToSpec(raw, info, rowCount) {
      const byName = name => {
        if (name === null || name === undefined) return -1;
        const exact = info.find(c => c.name === name);
        if (exact) return exact.index;
        const loose = info.find(c => c.name.toLowerCase() === String(name).toLowerCase());
        return loose ? loose.index : -2;
      };
      const category = byName(raw.category);
      const requested = (Array.isArray(raw.values) ? raw.values : []).map(byName).filter(i => i >= 0 && info[i].kind === 'numeric');
      const values = keepComparableSeries(requested, info);
      const clean = t => typeof t === 'string' ? t.replace(/\s+/g, ' ').trim().slice(0, 90) : undefined;
      if (!values.length || category === -2) return null;
      // If a series the AI named got dropped, its title/value-axis wording
      // may mention it, so fall back to the generated ones for those.
      const pruned = values.length !== requested.length;
      return normalizeChartSpec({
        type: CHART_TYPE_IDS.includes(raw.type) ? raw.type : 'column',
        category,
        values,
        title: pruned ? undefined : clean(raw.title),
        xAxisTitle: clean(raw.xAxisTitle),
        yAxisTitle: pruned ? undefined : clean(raw.yAxisTitle),
      }, info, rowCount);
    }

    function refineChartWithAi() {
      const key = chartState.key;
      const info = chartState.info;
      const rowCount = viewStates.results.rows.length;
      chartState.aiStatus = 'loading';
      updateChartStatus();
      requestAiChartSpec(info, rowCount).then(result => {
        if (chartState.key !== key) return;
        if (result.signedOut) { chartState.aiStatus = 'signed-out'; updateChartStatus(); return; }
        const spec = result.raw ? aiRawToSpec(result.raw, info, rowCount) : null;
        if (!spec) { chartState.aiStatus = 'failed'; updateChartStatus(); return; }
        chartState.aiStatus = 'done';
        if (!chartState.userEdited) {
          chartState.spec = spec;
          renderChartControls();
          renderChartBody();
        }
        updateChartStatus();
      });
    }

    // ---- Data prep ----
    function buildChartData(spec, columns, rows) {
      const cap = MAX_POINTS[spec.type] || 50;
      const series = spec.values.map((vc, i) => ({ name: prettifyColumnName(columns[vc]), rawName: columns[vc], colorIndex: i }));
      if (spec.type === 'scatter') {
        const points = [];
        for (const row of rows) {
          const x = parseChartNumber(row[spec.category]);
          if (x === null) continue;
          points.push({ x, ys: spec.values.map(vc => parseChartNumber(row[vc])) });
          if (points.length >= cap) break;
        }
        return { series, points, total: rows.length, shown: points.length };
      }
      let used = rows.slice(0, cap);
      let dropped = 0;
      if (spec.type === 'pie' || spec.type === 'doughnut') {
        const before = used.length;
        used = used.filter(r => (parseChartNumber(r[spec.values[0]]) || 0) > 0);
        dropped = before - used.length;
      }
      const categories = used.map((row, i) => {
        if (spec.category < 0) return String(i + 1);
        const v = row[spec.category];
        return v === null || v === undefined || v === '' ? '(blank)' : String(v);
      });
      series.forEach(s => {
        const vc = spec.values[s.colorIndex];
        s.values = used.map(row => parseChartNumber(row[vc]));
      });
      return { series, categories, total: rows.length, shown: used.length, dropped };
    }

    // ---- SVG rendering ----
    function niceScale(min, max, count = 5) {
      if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
      if (min === max) {
        if (min === 0) max = 1;
        else { const pad = Math.abs(min) * 0.1; min -= pad; max += pad; }
      }
      const rough = (max - min) / count;
      const mag = Math.pow(10, Math.floor(Math.log10(rough)));
      const norm = rough / mag;
      const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
      const lo = Math.floor(min / step + 1e-9) * step;
      const hi = Math.ceil(max / step - 1e-9) * step;
      const ticks = [];
      for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toPrecision(12));
      return { lo, hi: hi === lo ? lo + step : hi, ticks, step };
    }

    function formatTick(n, step) {
      if (Math.abs(n) >= 10000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
      const decimals = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
      return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }

    function formatChartValue(n) {
      if (n === null || n === undefined) return '—';
      if (Math.abs(n) >= 100000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
      return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    const textW = (s, size) => String(s).length * size * 0.58;
    const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const f1 = n => (+n).toFixed(1);

    // Rounded 4px data-end, square at the baseline.
    function barPath(x, y, w, h, end) {
      if (w <= 0 || h <= 0) return '';
      const r = Math.min(4, end === 'up' || end === 'down' ? w / 2 : h / 2, end === 'up' || end === 'down' ? h : w);
      if (end === 'up') return `M${f1(x)},${f1(y + h)}V${f1(y + r)}Q${f1(x)},${f1(y)} ${f1(x + r)},${f1(y)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y)} ${f1(x + w)},${f1(y + r)}V${f1(y + h)}Z`;
      if (end === 'down') return `M${f1(x)},${f1(y)}V${f1(y + h - r)}Q${f1(x)},${f1(y + h)} ${f1(x + r)},${f1(y + h)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y + h)} ${f1(x + w)},${f1(y + h - r)}V${f1(y)}Z`;
      if (end === 'right') return `M${f1(x)},${f1(y)}H${f1(x + w - r)}Q${f1(x + w)},${f1(y)} ${f1(x + w)},${f1(y + r)}V${f1(y + h - r)}Q${f1(x + w)},${f1(y + h)} ${f1(x + w - r)},${f1(y + h)}H${f1(x)}Z`;
      return `M${f1(x + w)},${f1(y)}H${f1(x + r)}Q${f1(x)},${f1(y)} ${f1(x)},${f1(y + r)}V${f1(y + h - r)}Q${f1(x)},${f1(y + h)} ${f1(x + r)},${f1(y + h)}H${f1(x + w)}Z`;
    }

    function svgText(x, y, str, { size = 11, fill, anchor = 'start', weight = 400, rotate = null, family = null, edit = null } = {}) {
      const t = rotate !== null ? ` transform="rotate(${rotate} ${f1(x)} ${f1(y)})"` : '';
      const ff = family ? ` font-family="${family}"` : '';
      const ed = edit ? ` class="chart-editable" data-edit="${edit}"` : '';
      return `<text x="${f1(x)}" y="${f1(y)}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}"${ff}${t}${ed}>${escapeHtml(String(str))}</text>`;
    }

    // Title + legend block; returns [svg, heightUsed].
    function renderChartHeader(spec, data, theme, W, legendItems) {
      let out = svgText(20, 32, clip(spec.title || 'Untitled chart', 100), { size: 17, fill: spec.title ? theme.text : theme.text2, weight: 600, edit: 'title' });
      let y = 44;
      if (legendItems.length >= 2) {
        let x = 20;
        y += 14;
        legendItems.forEach(item => {
          const w = 16 + textW(item.label, 12) + 18;
          if (x + w > W - 20 && x > 20) { x = 20; y += 20; }
          out += `<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${item.color}"></rect>`;
          out += svgText(x + 16, y, item.label, { size: 12, fill: theme.text2 });
          x += w;
        });
        y += 6;
      }
      return [out, y + 16];
    }

    function renderCartesianSVG(spec, data, theme, size) {
      const W = size.width;
      const horizontal = spec.type === 'bar';
      const scatter = spec.type === 'scatter';
      const nSeries = data.series.length;
      const legend = data.series.map((s, i) => ({ label: s.name, color: theme.series[i] }));
      const [header, top] = renderChartHeader(spec, data, theme, W, legend);

      const allVals = scatter
        ? data.points.flatMap(p => p.ys).filter(v => v !== null)
        : data.series.flatMap(s => s.values).filter(v => v !== null);
      let vMin = Math.min(...allVals), vMax = Math.max(...allVals);
      if (!allVals.length) { vMin = 0; vMax = 1; }
      const forceZero = spec.type === 'column' || spec.type === 'bar' || spec.type === 'area' || (vMin >= 0 && vMin <= vMax * 0.5);
      if (forceZero) { vMin = Math.min(0, vMin); vMax = Math.max(0, vMax); }
      const vs = niceScale(vMin, vMax);
      const tickLabels = vs.ticks.map(t => formatTick(t, vs.step));

      let out = '';
      const catTitle = spec.xAxisTitle, valTitle = spec.yAxisTitle;

      if (horizontal) {
        const n = data.categories.length;
        const catLabels = data.categories.map(c => clip(c, 22));
        const catLabelW = Math.max(...catLabels.map(l => textW(l, 11)), 10);
        const left = 20 + (catTitle ? 22 : 0) + catLabelW + 10;
        const tipLabels = nSeries === 1 && n <= 30;
        const tipW = tipLabels ? Math.max(...data.series[0].values.map(v => textW(formatChartValue(v), 10))) + 8 : 0;
        const right = W - 28 - tipW;
        const plotTop = top + 4;
        const footer = 26 + (valTitle ? 26 : 0) + 8;
        // Rows stretch to fill a taller canvas (full screen), up to 48px each.
        const rowH = Math.max(24, nSeries * 12 + 12, Math.min(48, (size.height - plotTop - footer) / n));
        const plotH = n * rowH;
        const bottom = plotTop + plotH;
        const H = bottom + footer;
        const sx = v => left + (v - vs.lo) / (vs.hi - vs.lo) * (right - left);
        vs.ticks.forEach((t, i) => {
          const x = sx(t);
          out += `<line x1="${f1(x)}" y1="${plotTop}" x2="${f1(x)}" y2="${bottom}" stroke="${t === 0 ? theme.axis : theme.grid}" stroke-width="1"></line>`;
          out += svgText(x, bottom + 16, tickLabels[i], { size: 11, fill: theme.text2, anchor: 'middle' });
        });
        const thick = Math.min(24, (rowH * 0.72 - (nSeries - 1) * 2) / nSeries);
        data.categories.forEach((cat, i) => {
          const y0 = plotTop + i * rowH;
          const groupH = nSeries * thick + (nSeries - 1) * 2;
          let tip = `${cat}`;
          let bars = '';
          data.series.forEach((s, k) => {
            const v = s.values[i];
            tip += `\n${s.name}: ${formatChartValue(v)}`;
            if (v === null) return;
            const y = y0 + (rowH - groupH) / 2 + k * (thick + 2);
            const x0 = sx(0), x1 = sx(v);
            bars += `<path class="chart-mark" d="${barPath(Math.min(x0, x1), y, Math.abs(x1 - x0), thick, v >= 0 ? 'right' : 'left')}" fill="${theme.series[k]}"></path>`;
            if (tipLabels) out += svgText(v >= 0 ? x1 + 5 : x1 - 5, y + thick / 2 + 4, formatChartValue(v), { size: 10, fill: theme.text2, anchor: v >= 0 ? 'start' : 'end' });
          });
          out += `<g><title>${escapeHtml(tip)}</title><rect x="${left}" y="${f1(y0)}" width="${right - left}" height="${rowH}" fill="transparent"></rect>${bars}</g>`;
          out += svgText(left - 8, y0 + rowH / 2 + 4, catLabels[i], { size: 11, fill: theme.text2, anchor: 'end' });
        });
        out += `<line x1="${left}" y1="${plotTop}" x2="${left}" y2="${bottom}" stroke="${theme.axis}" stroke-width="1"></line>`;
        if (catTitle) out += svgText(28, plotTop + plotH / 2, catTitle, { size: 12, fill: theme.text2, anchor: 'middle', rotate: -90, weight: 500, edit: 'xAxisTitle' });
        if (valTitle) out += svgText((left + right) / 2, bottom + 44, valTitle, { size: 12, fill: theme.text2, anchor: 'middle', weight: 500, edit: 'yAxisTitle' });
        return wrapSvg(W, H, theme, header + out);
      }

      // Vertical layouts: column / line / area / scatter.
      const yLabelW = Math.max(...tickLabels.map(l => textW(l, 11)));
      const left = 20 + (valTitle ? 22 : 0) + yLabelW + 10;
      const right = W - 28;
      const plotW = right - left;
      let xLabelArea = 22, rotate = false, every = 1;
      let xs;
      let catLabels = [];
      if (scatter) {
        const xVals = data.points.map(p => p.x);
        xs = niceScale(Math.min(...xVals), Math.max(...xVals));
      } else {
        const n = data.categories.length;
        catLabels = data.categories.map(c => clip(c, 18));
        const band = plotW / n;
        const maxLabelW = Math.max(...catLabels.map(l => textW(l, 11)), 1);
        if (maxLabelW > band - 6) {
          // Rotated -40deg labels need ~26px of horizontal room each to
          // not overlap; thin them to every Nth category past that.
          rotate = true;
          every = Math.max(1, Math.ceil(n / Math.floor(plotW / 26)));
          xLabelArea = Math.min(maxLabelW, textW('x'.repeat(18), 11)) * 0.66 + 22;
        }
      }
      const plotTop = top + 4;
      const H = Math.max(size.height, plotTop + 300 + xLabelArea + (catTitle ? 28 : 0));
      const bottom = H - xLabelArea - (catTitle ? 28 : 0) - 10;
      const sy = v => bottom - (v - vs.lo) / (vs.hi - vs.lo) * (bottom - plotTop);

      vs.ticks.forEach((t, i) => {
        const y = sy(t);
        out += `<line x1="${left}" y1="${f1(y)}" x2="${right}" y2="${f1(y)}" stroke="${t === 0 ? theme.axis : theme.grid}" stroke-width="1"></line>`;
        out += svgText(left - 8, y + 4, tickLabels[i], { size: 11, fill: theme.text2, anchor: 'end' });
      });
      if (valTitle) out += svgText(28, (plotTop + bottom) / 2, valTitle, { size: 12, fill: theme.text2, anchor: 'middle', rotate: -90, weight: 500, edit: 'yAxisTitle' });
      if (catTitle) out += svgText((left + right) / 2, H - 14, catTitle, { size: 12, fill: theme.text2, anchor: 'middle', weight: 500, edit: 'xAxisTitle' });

      if (scatter) {
        const sx = v => left + (v - xs.lo) / (xs.hi - xs.lo) * plotW;
        xs.ticks.forEach(t => {
          const x = sx(t);
          out += `<line x1="${f1(x)}" y1="${plotTop}" x2="${f1(x)}" y2="${bottom}" stroke="${theme.grid}" stroke-width="1"></line>`;
          out += svgText(x, bottom + 16, formatTick(t, xs.step), { size: 11, fill: theme.text2, anchor: 'middle' });
        });
        data.points.forEach(p => {
          p.ys.forEach((y, k) => {
            if (y === null) return;
            out += `<circle class="chart-mark" cx="${f1(sx(p.x))}" cy="${f1(sy(y))}" r="4.5" fill="${theme.series[k]}" stroke="${theme.surface}" stroke-width="2"><title>${escapeHtml(`${data.series[k].name}: ${formatChartValue(y)}\n${catTitle || 'X'}: ${formatChartValue(p.x)}`)}</title></circle>`;
          });
        });
        return wrapSvg(W, H, theme, header + out);
      }

      const n = data.categories.length;
      const band = plotW / n;
      const cx = i => left + band * (i + 0.5);
      catLabels.forEach((label, i) => {
        if (i % every !== 0) return;
        out += rotate
          ? svgText(cx(i) + 3, bottom + 14, label, { size: 11, fill: theme.text2, anchor: 'end', rotate: -40 })
          : svgText(cx(i), bottom + 16, label, { size: 11, fill: theme.text2, anchor: 'middle' });
      });

      // Per-category hover band carrying every series' value.
      let hover = '';
      data.categories.forEach((cat, i) => {
        const tip = [cat, ...data.series.map(s => `${s.name}: ${formatChartValue(s.values[i])}`)].join('\n');
        hover += `<rect x="${f1(left + band * i)}" y="${plotTop}" width="${f1(band)}" height="${f1(bottom - plotTop)}" fill="transparent"><title>${escapeHtml(tip)}</title></rect>`;
      });

      if (spec.type === 'column') {
        const thick = Math.min(24, (band * 0.72 - (nSeries - 1) * 2) / nSeries);
        const groupW = nSeries * thick + (nSeries - 1) * 2;
        data.series.forEach((s, k) => {
          s.values.forEach((v, i) => {
            if (v === null) return;
            const x = left + band * i + (band - groupW) / 2 + k * (thick + 2);
            const y0 = sy(0), y1 = sy(v);
            out += `<path class="chart-mark" d="${barPath(x, Math.min(y0, y1), thick, Math.abs(y1 - y0), v >= 0 ? 'up' : 'down')}" fill="${theme.series[k]}"></path>`;
            if (nSeries === 1 && n <= 20) out += svgText(x + thick / 2, v >= 0 ? y1 - 6 : y1 + 14, formatChartValue(v), { size: 10, fill: theme.text2, anchor: 'middle' });
          });
        });
        return wrapSvg(W, H, theme, header + out + hover);
      }

      // line / area
      const markers = n <= 40;
      data.series.forEach((s, k) => {
        const color = theme.series[k];
        const pts = s.values.map((v, i) => v === null ? null : [cx(i), sy(v)]);
        const segments = [];
        let cur = [];
        pts.forEach(p => { if (p) cur.push(p); else if (cur.length) { segments.push(cur); cur = []; } });
        if (cur.length) segments.push(cur);
        segments.forEach(seg => {
          const d = seg.map((p, j) => `${j ? 'L' : 'M'}${f1(p[0])},${f1(p[1])}`).join('');
          if (spec.type === 'area') {
            const base = sy(Math.max(vs.lo, Math.min(0, vs.hi)));
            out += `<path d="${d}L${f1(seg[seg.length - 1][0])},${f1(base)}L${f1(seg[0][0])},${f1(base)}Z" fill="${color}" fill-opacity="0.12"></path>`;
          }
          out += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>`;
        });
        if (markers) pts.forEach(p => { if (p) out += `<circle cx="${f1(p[0])}" cy="${f1(p[1])}" r="4" fill="${color}" stroke="${theme.surface}" stroke-width="2"></circle>`; });
        const lastIdx = s.values.map((v, i) => v === null ? -1 : i).filter(i => i >= 0).pop();
        if (nSeries === 1 && lastIdx !== undefined) {
          out += svgText(pts[lastIdx][0], pts[lastIdx][1] - 10, formatChartValue(s.values[lastIdx]), { size: 10, fill: theme.text2, anchor: 'middle', weight: 600 });
        }
      });
      return wrapSvg(W, H, theme, header + out + hover);
    }

    function relativeLuminance(hex) {
      const c = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map(i => {
        const v = parseInt(c.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function renderPieSVG(spec, data, theme, size) {
      const W = size.width;
      const [header, top] = renderChartHeader(spec, data, theme, W, []);
      const values = data.series[0].values.map(v => v || 0);
      const total = values.reduce((a, b) => a + b, 0) || 1;
      const H = Math.max(420, size.height);
      const legendW = 380;
      const r = Math.max(80, Math.min(260, (H - top - 24) / 2, (W - legendW - 120) / 2));
      const groupW = 2 * r + 48 + legendW;
      const cx = Math.max(40, (W - groupW) / 2) + r;
      const cy = top + 8 + Math.max(r, (H - top - 24) / 2);
      const inner = spec.type === 'doughnut' ? r * 0.58 : 0;
      let out = '';
      let angle = -Math.PI / 2;
      const pt = (a, rad) => [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad];
      values.forEach((v, i) => {
        const sweep = v / total * Math.PI * 2;
        const a0 = angle, a1 = angle + sweep;
        angle = a1;
        const large = sweep > Math.PI ? 1 : 0;
        const color = theme.series[i];
        let d;
        if (sweep >= Math.PI * 2 - 1e-6) {
          d = inner
            ? `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0ZM${cx - inner},${cy}a${inner},${inner} 0 1,1 ${2 * inner},0a${inner},${inner} 0 1,1 ${-2 * inner},0Z`
            : `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;
        } else {
          const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
          if (inner) {
            const [ix0, iy0] = pt(a0, inner), [ix1, iy1] = pt(a1, inner);
            d = `M${f1(x0)},${f1(y0)}A${r},${r} 0 ${large},1 ${f1(x1)},${f1(y1)}L${f1(ix1)},${f1(iy1)}A${f1(inner)},${f1(inner)} 0 ${large},0 ${f1(ix0)},${f1(iy0)}Z`;
          } else {
            d = `M${cx},${cy}L${f1(x0)},${f1(y0)}A${r},${r} 0 ${large},1 ${f1(x1)},${f1(y1)}Z`;
          }
        }
        const pct = v / total * 100;
        out += `<path class="chart-mark" d="${d}" fill="${color}" fill-rule="evenodd" stroke="${theme.surface}" stroke-width="2"><title>${escapeHtml(`${data.categories[i]}: ${formatChartValue(v)} (${pct.toFixed(1)}%)`)}</title></path>`;
        if (pct >= 6) {
          const [lx, ly] = pt((a0 + a1) / 2, inner ? (r + inner) / 2 : r * 0.64);
          const ink = relativeLuminance(color) > 0.35 ? '#201515' : '#ffffff';
          out += svgText(lx, ly + 4, `${Math.round(pct)}%`, { size: 11, fill: ink, anchor: 'middle', weight: 600 });
        }
      });
      if (inner) {
        out += svgText(cx, cy - 2, formatChartValue(total), { size: 20, fill: theme.text, anchor: 'middle', weight: 600 });
        out += svgText(cx, cy + 18, clip(spec.yAxisTitle || 'Total', 22), { size: 11, fill: theme.text2, anchor: 'middle' });
      }
      const lx = cx + r + 48;
      const rowH = 30;
      const ly0 = cy - (values.length * rowH) / 2 + 12;
      values.forEach((v, i) => {
        const y = ly0 + i * rowH;
        out += `<rect x="${lx}" y="${y - 10}" width="12" height="12" rx="2" fill="${theme.series[i]}"></rect>`;
        out += svgText(lx + 20, y, clip(data.categories[i], 30), { size: 12, fill: theme.text });
        out += svgText(Math.min(W - 24, lx + legendW), y, `${formatChartValue(v)}  ·  ${(v / total * 100).toFixed(1)}%`, { size: 12, fill: theme.text2, anchor: 'end' });
      });
      return wrapSvg(W, H, theme, header + out);
    }

    function wrapSvg(W, H, theme, body) {
      return `<svg viewBox="0 0 ${W} ${f1(H)}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif" role="img">
        <rect x="0" y="0" width="${W}" height="${f1(H)}" fill="${theme.surface}"></rect>${body}</svg>`;
    }

    function renderChartSVG(spec, data, theme, size = { width: 760, height: 420 }) {
      if (spec.type === 'pie' || spec.type === 'doughnut') return renderPieSVG(spec, data, theme, size);
      return renderCartesianSVG(spec, data, theme, size);
    }

    // ---- Panel UI ----
    function chartTypeAllowed(type, info, rowCount) {
      if (type === 'pie' || type === 'doughnut') return rowCount <= MAX_PIE_SLICES;
      if (type === 'scatter') return info.filter(c => c.kind === 'numeric').length >= 2;
      return true;
    }

    // The chart tool lives in exactly one place at a time: the inline
    // results panel, or the full-screen modal while that's open (its
    // element ids stay unique that way).
    function chartFullscreenOpen() {
      const modal = document.getElementById('chart-fullscreen-modal');
      return !!modal && !modal.hidden;
    }

    function renderResultsChart() {
      const inline = document.getElementById('results-chart-panel');
      if (!inline) return;
      let panel = inline;
      if (chartFullscreenOpen()) {
        inline.innerHTML = '<div class="empty">This chart is open in full screen.</div>';
        panel = document.getElementById('chart-fullscreen-body');
      }
      const st = viewStates.results;
      if (!st.columns.length || !st.rows.length) {
        chartState = { key: null, info: null, spec: null, userEdited: false, aiStatus: 'idle', error: null };
        panel.innerHTML = '<div class="empty">Run a query to chart its results.</div>';
        return;
      }
      const key = currentChartKey();
      if (key !== chartState.key) {
        const info = analyzeChartColumns(st.columns, st.rows);
        const spec = heuristicChartSpec(info, st.rows.length);
        chartState = { key, info, spec: spec.error ? null : spec, userEdited: false, aiStatus: 'idle', error: spec.error || null };
        if (!spec.error) refineChartWithAi();
      }
      if (chartState.error) {
        panel.innerHTML = `<div class="empty">${escapeHtml(chartState.error)}</div>`;
        return;
      }
      panel.innerHTML = `
        <div class="chart-controls" id="chart-controls"></div>
        <div id="results-chart-svg-wrap" onclick="onChartCanvasClick(event)"></div>
        <div class="chart-note" id="chart-note"></div>`;
      renderChartControls();
      renderChartBody();
    }

    function renderChartControls() {
      const el = document.getElementById('chart-controls');
      if (!el || !chartState.spec) return;
      const { info, spec } = chartState;
      const rowCount = viewStates.results.rows.length;
      const typeOptions = CHART_TYPES.map(t => {
        const ok = chartTypeAllowed(t.id, info, rowCount);
        const why = !ok ? (t.id === 'scatter' ? ' — needs 2 numeric columns' : ` — max ${MAX_PIE_SLICES} rows`) : '';
        return `<option value="${t.id}"${t.id === spec.type ? ' selected' : ''}${ok ? '' : ' disabled'}>${t.label}${why}</option>`;
      }).join('');
      const catOptions = (spec.type === 'scatter' ? info.filter(c => c.kind === 'numeric') : info)
        .map(c => `<option value="${c.index}"${c.index === spec.category ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
      const numeric = info.filter(c => c.kind === 'numeric' && c.index !== spec.category);
      const maxSeries = spec.type === 'scatter' ? MAX_SCATTER_SERIES : (spec.type === 'pie' || spec.type === 'doughnut') ? 1 : MAX_SERIES;
      const seriesChecks = numeric.map(c => {
        const checked = spec.values.includes(c.index);
        const disabled = !checked && spec.values.length >= maxSeries;
        return `<label class="chart-series-option"><input type="checkbox" value="${c.index}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''} onchange="onChartSeriesToggle(this)"> ${escapeHtml(c.name)}</label>`;
      }).join('');
      const ySummary = spec.values.length === 1 ? escapeHtml(info[spec.values[0]].name) : `${spec.values.length} columns`;
      const isPie = spec.type === 'pie' || spec.type === 'doughnut';

      el.innerHTML = `
        <div class="chart-controls-row">
          <label class="chart-control"><span>Type</span>
            <select id="chart-type-select" onchange="onChartTypeChange(this.value)">${typeOptions}</select></label>
          <label class="chart-control"><span>${isPie ? 'Slices' : spec.type === 'scatter' ? 'X axis' : 'Categories'}</span>
            <select id="chart-x-select" onchange="onChartCategoryChange(this.value)">${spec.type === 'scatter' ? '' : `<option value="-1"${spec.category === -1 ? ' selected' : ''}>(row number)</option>`}${catOptions}</select></label>
          <details class="chart-control chart-series-picker"><summary><span>${isPie ? 'Value' : 'Values'}</span> <b>${ySummary}</b></summary>
            <div class="chart-series-list">${seriesChecks || '<span class="chart-muted">No other numeric columns</span>'}</div></details>
          <div class="chart-actions">
            <button class="save-btn" onclick="downloadChartSVG()">Download SVG</button>
            <button class="save-btn chart-excel-btn" id="chart-excel-btn" onclick="exportChartToExcel()">Export to Excel</button>
            ${chartFullscreenOpen() ? '' : `<button type="button" class="chart-icon-btn" onclick="openChartFullscreen()" title="Full screen" aria-label="Open chart full screen">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>`}
          </div>
        </div>
        <div class="chart-title-fields">
          <label class="chart-title-field-main">Chart title<input type="text" id="chart-title-input" value="${escapeAttr(spec.title)}" placeholder="Untitled chart" oninput="onChartTitleInput('title', this.value)"></label>
          ${isPie ? '' : `<label>${spec.type === 'bar' ? 'Category axis (left)' : 'X-axis title'}<input type="text" id="chart-xAxisTitle-input" value="${escapeAttr(spec.xAxisTitle || '')}" oninput="onChartTitleInput('xAxisTitle', this.value)"></label>
          <label>${spec.type === 'bar' ? 'Value axis (bottom)' : 'Y-axis title'}<input type="text" id="chart-yAxisTitle-input" value="${escapeAttr(spec.yAxisTitle || '')}" oninput="onChartTitleInput('yAxisTitle', this.value)"></label>`}
        </div>
        <div class="chart-status-row">
          <span class="chart-ai-status" id="chart-ai-status"></span>
          <span class="chart-excel-status" id="chart-excel-status"></span>
        </div>`;
      updateChartStatus();
    }

    function renderChartBody() {
      const wrap = document.getElementById('results-chart-svg-wrap');
      const noteEl = document.getElementById('chart-note');
      if (!wrap || !chartState.spec) return;
      const st = viewStates.results;
      const rows = getVisibleRows('results');
      const data = buildChartData(chartState.spec, st.columns, rows);
      const empty = chartState.spec.type === 'scatter' ? !data.points.length : !data.categories.length;
      // Full screen draws at the canvas's real pixel size (1:1 text, more
      // room) instead of scaling up the 760px inline drawing.
      const size = chartFullscreenOpen()
        ? { width: Math.max(760, Math.min(1800, Math.floor(wrap.clientWidth) - 2)), height: Math.max(420, Math.floor(wrap.clientHeight) - 8) }
        : { width: 760, height: 420 };
      wrap.innerHTML = empty
        ? '<div class="empty">Nothing to plot — the selected value column has no numbers in the visible rows.</div>'
        : renderChartSVG(chartState.spec, data, chartTheme(), size);
      // Full screen keeps text at real size; on a phone-width screen the
      // canvas scrolls sideways rather than shrinking the chart unreadably.
      const svgEl = wrap.querySelector('svg');
      if (svgEl && chartFullscreenOpen()) svgEl.style.width = `${size.width}px`;
      const notes = [];
      if (data.shown < data.total && !(data.dropped && data.shown + data.dropped >= data.total)) {
        notes.push(`Showing the first ${data.shown.toLocaleString()} of ${data.total.toLocaleString()} rows here. The Excel export charts all of them.`);
      }
      if (data.dropped) notes.push(`${data.dropped} row${data.dropped === 1 ? '' : 's'} with zero or negative values left out of the ${chartState.spec.type}.`);
      if (noteEl) noteEl.textContent = notes.join(' ');
    }

    function updateChartStatus() {
      const el = document.getElementById('chart-ai-status');
      if (!el) return;
      const s = chartState.aiStatus;
      el.className = 'chart-ai-status' + (s === 'loading' ? ' is-loading' : '');
      el.textContent = s === 'loading' && !chartState.userEdited ? 'Generating titles…' : '';
    }

    function applyChartEdit(mutator, { rerenderControls = true } = {}) {
      const next = { ...chartState.spec };
      mutator(next);
      chartState.spec = normalizeChartSpec(next, chartState.info, viewStates.results.rows.length);
      chartState.userEdited = true;
      if (rerenderControls) renderChartControls();
      else updateChartStatus();
      renderChartBody();
    }

    window.onChartTypeChange = function(type) {
      applyChartEdit(s => { s.type = type; });
    };

    window.onChartCategoryChange = function(value) {
      const idx = parseInt(value, 10);
      applyChartEdit(s => {
        s.category = idx;
        s.values = s.values.filter(v => v !== idx);
        s.xAxisTitle = idx >= 0 ? prettifyColumnName(chartState.info[idx].name) : 'Row';
        s.title = '';
      });
    };

    window.onChartSeriesToggle = function(input) {
      const idx = parseInt(input.value, 10);
      applyChartEdit(s => {
        s.values = input.checked ? [...s.values, idx] : s.values.filter(v => v !== idx);
        s.yAxisTitle = s.values.length === 1 ? prettifyColumnName(chartState.info[s.values[0]].name) : 'Value';
        s.title = '';
      });
      const picker = document.querySelector('.chart-series-picker');
      if (picker) picker.open = true;
    };

    window.onChartTitleInput = function(field, value) {
      applyChartEdit(s => { s[field] = value; }, { rerenderControls: false });
    };

    // Clicking the chart title or an axis title on the canvas jumps to its field.
    window.onChartCanvasClick = function(event) {
      const target = event.target.closest && event.target.closest('[data-edit]');
      if (!target) return;
      const input = document.getElementById(`chart-${target.dataset.edit}-input`);
      if (input) { input.focus(); input.select(); }
    };

    let chartResizeObserver = null;

    window.openChartFullscreen = function() {
      const modal = document.getElementById('chart-fullscreen-modal');
      if (!modal) return;
      modal.hidden = false;
      renderResultsChart();
      const body = document.getElementById('chart-fullscreen-body');
      if (typeof ResizeObserver !== 'undefined' && body) {
        let lastW = 0, lastH = 0;
        chartResizeObserver = new ResizeObserver(() => {
          const wrap = document.getElementById('results-chart-svg-wrap');
          if (!wrap || !chartFullscreenOpen()) return;
          const w = Math.round(wrap.clientWidth), h = Math.round(wrap.clientHeight);
          if (Math.abs(w - lastW) < 8 && Math.abs(h - lastH) < 8) return;
          lastW = w; lastH = h;
          renderChartBody();
        });
        chartResizeObserver.observe(body);
      }
      const close = modal.querySelector('.modal-close');
      if (close) close.focus();
    };

    window.closeChartFullscreen = function() {
      const modal = document.getElementById('chart-fullscreen-modal');
      if (!modal || modal.hidden) return;
      if (chartResizeObserver) { chartResizeObserver.disconnect(); chartResizeObserver = null; }
      modal.hidden = true;
      const body = document.getElementById('chart-fullscreen-body');
      if (body) body.innerHTML = '';
      const inline = document.getElementById('results-chart-panel');
      if (inline && !inline.hidden) renderResultsChart();
    };

    window.downloadChartSVG = function() {
      const svgEl = document.querySelector('#results-chart-svg-wrap svg');
      if (!svgEl) return;
      const serialized = new XMLSerializer().serializeToString(svgEl);
      triggerDownload(new Blob([serialized], { type: 'image/svg+xml' }), `${chartFileSlug()}.svg`);
    };

    function chartFileSlug() {
      const t = (chartState.spec && chartState.spec.title) || 'chart';
      return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chart';
    }

    function triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ---- Excel export (Python in the browser via Pyodide + XlsxWriter) ----
    // Loaded only on the first export click. The query results are handed
    // to excel_chart.py in-process — nothing is uploaded anywhere.
    const PYODIDE_VERSION = '0.29.5';
    const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
    const XLSXWRITER_WHEEL = '/vendor/xlsxwriter-3.2.9-py3-none-any.whl';
    let excelEnginePromise = null;

    function loadScriptOnce(src) {
      return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Couldn't load ${src}`));
        document.head.appendChild(s);
      });
    }

    function loadExcelEngine(onStatus) {
      if (!excelEnginePromise) {
        excelEnginePromise = (async () => {
          onStatus('Loading Python (first export only, a few seconds)…');
          await loadScriptOnce(`${PYODIDE_BASE}pyodide.js`);
          const py = await loadPyodide({ indexURL: PYODIDE_BASE });
          onStatus('Loading Excel writer…');
          const [wheel, source] = await Promise.all([
            fetch(XLSXWRITER_WHEEL).then(r => { if (!r.ok) throw new Error('XlsxWriter download failed'); return r.arrayBuffer(); }),
            fetch('/excel_chart.py').then(r => { if (!r.ok) throw new Error('Excel exporter download failed'); return r.text(); }),
          ]);
          py.unpackArchive(wheel, 'zip', { extractDir: '/opt/xlsxwriter' });
          py.runPython("import sys\nif '/opt/xlsxwriter' not in sys.path: sys.path.insert(0, '/opt/xlsxwriter')");
          py.runPython(source);
          return py;
        })().catch(err => { excelEnginePromise = null; throw err; });
      }
      return excelEnginePromise;
    }

    window.exportChartToExcel = async function() {
      const btn = document.getElementById('chart-excel-btn');
      const statusEl = document.getElementById('chart-excel-status');
      const setStatus = msg => { if (statusEl) statusEl.textContent = msg; };
      if (!chartState.spec || !btn) return;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = 'Preparing…';
      try {
        const st = viewStates.results;
        const rows = getVisibleRows('results');
        const numericCols = chartState.info.filter(c => c.kind === 'numeric').map(c => c.index);
        const numericSet = new Set(numericCols);
        const outRows = rows.map(row => row.map((v, c) => {
          if (v === null || v === undefined) return null;
          if (numericSet.has(c)) { const n = parseChartNumber(v); return n === null ? String(v) : n; }
          return String(v);
        }));
        const spec = chartState.spec;
        const payload = JSON.stringify({
          columns: st.columns.map(String),
          rows: outRows,
          numericColumns: numericCols,
          spec: {
            type: spec.type,
            title: spec.title || 'Chart',
            category: spec.category,
            values: spec.values,
            xAxisTitle: spec.xAxisTitle || '',
            yAxisTitle: spec.yAxisTitle || '',
          },
        });
        const py = await loadExcelEngine(setStatus);
        setStatus('Building workbook…');
        await new Promise(r => setTimeout(r, 0));
        const build = py.globals.get('build_xlsx');
        const result = build(payload);
        const bytes = result.toJs();
        result.destroy();
        build.destroy();
        triggerDownload(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${chartFileSlug()}.xlsx`);
        setStatus(`Downloaded ${chartFileSlug()}.xlsx: sheet 1 is your data, sheet 2 is a live chart linked to it.`);
      } catch (err) {
        console.error('Excel export failed:', err);
        setStatus(`Excel export failed: ${err.message || err}`);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    };

    // The chart replaces the results table (rather than sitting above it)
    // so it gets the table's full scrollable space — the button's own
    // label doubles as the way back, flipping to "Results" while the
    // chart is showing.
    window.toggleResultsChart = function() {
      const panel = document.getElementById('results-chart-panel');
      const btn = document.getElementById('results-chart-toggle-btn');
      const label = document.getElementById('results-chart-toggle-label');
      const newBadge = document.getElementById('results-chart-new-badge');
      const errorEl = document.getElementById('error');
      const scrollTopEl = document.getElementById('results-scroll-top');
      const resultsEl = document.getElementById('results');

      if (!panel.hidden) {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        label.textContent = 'Chart';
        // Restores whatever display value runQuery's own error handling
        // had set before the chart hid it, rather than assuming none/block.
        if (errorEl) errorEl.style.display = errorEl.dataset.prevDisplay || '';
        if (scrollTopEl) scrollTopEl.style.display = '';
        if (resultsEl) resultsEl.style.display = '';
        return;
      }

      if (!currentUser) {
        openAccountModal('signup');
        return;
      }

      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      label.textContent = 'Results';
      if (newBadge) newBadge.hidden = true;
      if (errorEl) {
        errorEl.dataset.prevDisplay = errorEl.style.display;
        errorEl.style.display = 'none';
      }
      if (scrollTopEl) scrollTopEl.style.display = 'none';
      if (resultsEl) resultsEl.style.display = 'none';
      renderResultsChart();
    };

    // Charts need an account. Called on every auth change: shows the lock
    // on the Chart button while signed out, and closes any open chart view
    // when someone signs out mid-session.
    window.syncChartAccess = function() {
      const signedIn = !!currentUser;
      const btn = document.getElementById('results-chart-toggle-btn');
      const lock = document.getElementById('results-chart-lock');
      if (lock) lock.hidden = signedIn;
      if (btn) btn.title = signedIn ? '' : 'Sign up to use charts';
      if (signedIn) return;
      closeChartFullscreen();
      const panel = document.getElementById('results-chart-panel');
      if (panel && !panel.hidden) toggleResultsChart();
    };
