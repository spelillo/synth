    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // ---- Table rendering (shared by Query Results and Table View) ----
    // Each consumer gets its own state (columns/rows/sort/filter/search) keyed
    // by name, so sorting or filtering one table never touches the other.
    //
    // Rows are virtualized: only the <tr>s inside the current scroll
    // viewport (plus a small buffer) ever exist in the DOM, no matter how
    // large the result set is (Premium's cap is 500,000 rows). Two spacer
    // <tr>s above and below the rendered window reserve the right amount of
    // scroll height so the browser's native scrollbar still reflects the
    // true row count. Filtering/sorting/search still run over the full
    // in-memory row array (getVisibleRows) — only rendering is windowed.

    const ROW_BUFFER = 10; // extra rows rendered above/below the viewport
    const DEFAULT_ROW_HEIGHT = 41; // used until the real row height is measured
    // Browsers cap how tall a single element can render (roughly
    // 16.7M-33.5M px depending on engine) — a spacer taller than that
    // silently gets clamped, which would leave the tail of a large result
    // set permanently unreachable by scrolling. Stay safely under that.
    const MAX_VIRTUAL_HEIGHT = 15000000;

    let viewStates = {
      results: { columns: [], rows: [], sort: {}, filter: {}, search: '', filteredRows: [], rowHeight: null, scrollBarId: 'results-scroll-top', scrollInnerId: 'results-scroll-top-inner' },
      tableview: { columns: [], rows: [], sort: {}, filter: {}, search: '', filteredRows: [], rowHeight: null, scrollBarId: 'table-view-scroll-top', scrollInnerId: 'table-view-scroll-top-inner' }
    };

    function setExportButtonVisible(stateKey, visible) {
      const btn = document.getElementById(stateKey === 'tableview' ? 'export-tableview-csv-btn' : 'export-results-csv-btn');
      if (btn) btn.hidden = !visible;
    }

    function renderTable(targetId, stateKey, result) {
      const target = document.getElementById(targetId);
      const state = viewStates[stateKey];

      if (result.length === 0 || !result[0].values.length) {
        target.innerHTML = '<div class="empty">No results</div>';
        state.columns = [];
        state.rows = [];
        setExportButtonVisible(stateKey, false);
        if (stateKey === 'results') {
          const headerCountEl = document.getElementById('results-row-count');
          if (headerCountEl) headerCountEl.textContent = '';
        }
        return;
      }

      state.columns = result[0].columns;
      state.rows = result[0].values;
      state.sort = {};
      state.filter = {};
      state.search = '';
      state.rowHeight = null;
      setExportButtonVisible(stateKey, true);

      if (stateKey === 'tableview') {
        const searchInput = document.getElementById('table-search');
        if (searchInput) searchInput.value = '';
      }

      updateTable(targetId, stateKey, { forceFullRender: true });
    }

    // Applies a view's active per-column filters, search box, and sort to
    // its raw rows — shared by the table renderer and CSV export, so
    // exporting always matches exactly what's currently on screen.
    function getVisibleRows(stateKey) {
      const state = viewStates[stateKey];
      let rows = [...state.rows];

      Object.keys(state.filter).forEach(colIndex => {
        const filterValue = state.filter[colIndex].toLowerCase();
        if (filterValue) {
          rows = rows.filter(row => {
            const cellValue = String(row[colIndex] ?? '').toLowerCase();
            return cellValue.includes(filterValue);
          });
        }
      });

      if (state.search) {
        const term = state.search.toLowerCase();
        rows = rows.filter(row =>
          row.some(val => String(val ?? '').toLowerCase().includes(term))
        );
      }

      if (state.sort.column !== undefined) {
        const colIndex = state.sort.column;
        const direction = state.sort.direction;

        rows = [...rows].sort((a, b) => {
          let aVal = a[colIndex];
          let bVal = b[colIndex];

          if (aVal === null || aVal === undefined) return 1;
          if (bVal === null || bVal === undefined) return -1;

          const aNum = parseFloat(aVal);
          const bNum = parseFloat(bVal);

          if (!isNaN(aNum) && !isNaN(bNum)) {
            return direction === 'asc' ? aNum - bNum : bNum - aNum;
          }

          const aStr = String(aVal).toLowerCase();
          const bStr = String(bVal).toLowerCase();

          if (direction === 'asc') {
            return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
          } else {
            return aStr > bStr ? -1 : aStr < bStr ? 1 : 0;
          }
        });
      }

      return rows;
    }

    // Escapes a value for use inside a double-quoted HTML attribute.
    // escapeHtml() alone is only safe for text-node content — it doesn't
    // touch `"`, so a filter value containing one could otherwise break out
    // of the value="..." attribute below.
    function escapeAttr(str) {
      return escapeHtml(str).replace(/"/g, '&quot;');
    }

    function renderTableHeadHtml(state, stateKey) {
      let html = '<thead><tr>';
      state.columns.forEach((col, index) => {
        const isSorted = state.sort.column === index;
        const sortIcon = isSorted ? (state.sort.direction === 'asc' ? '▲' : '▼') : '⇅';
        const sortClass = isSorted ? 'active' : '';
        const ariaSort = isSorted ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

        html += `<th aria-sort="${ariaSort}">
          <div class="th-content">
            <button type="button" class="th-label" onclick="sortColumn('${stateKey}', ${index})">
              ${escapeHtml(col)}
              <span class="sort-icon ${sortClass}">${sortIcon}</span>
            </button>
          </div>
          <input type="text" class="column-filter" placeholder="Filter..."
                 onkeyup="filterColumn('${stateKey}', ${index}, this.value)"
                 value="${escapeAttr(state.filter[index] || '')}">
        </th>`;
      });
      html += '</tr></thead>';
      return html;
    }

    // Renders a slice of rows as bare <tr> markup (no <tbody> wrapper) —
    // callers assemble it alongside the virtual-scroll spacer rows below.
    function renderTableRowsHtml(rows) {
      let html = '';
      rows.forEach(row => {
        html += '<tr>';
        row.forEach(val => {
          html += `<td>${val !== null && val !== undefined ? escapeHtml(String(val)) : '<span class="null">NULL</span>'}</td>`;
        });
        html += '</tr>';
      });
      return html;
    }

    function updateRowCountText(target, stateKey, total) {
      const state = viewStates[stateKey];
      const text = total === state.rows.length
        ? `${total.toLocaleString()} rows`
        : `${total.toLocaleString()} of ${state.rows.length.toLocaleString()} rows`;

      const rowCountEl = target.querySelector('.row-count');
      if (rowCountEl) rowCountEl.textContent = text;

      if (stateKey === 'results') {
        const headerCountEl = document.getElementById('results-row-count');
        if (headerCountEl) headerCountEl.textContent = text;
      }
    }

    // Renders only the rows currently in (or near) the scroll viewport,
    // using two spacer <tr>s to reserve the correct total scroll height for
    // the rows that aren't rendered. Reuses state.filteredRows — this is
    // the cheap path run on every scroll/resize tick, and never re-runs
    // filter/sort/search (call updateTable() for that).
    function renderVirtualRows(target, stateKey) {
      const state = viewStates[stateKey];
      const filteredRows = state.filteredRows;
      const table = target.querySelector('table');
      if (!table) return;
      const tbody = table.querySelector('tbody');
      const colCount = Math.max(1, state.columns.length);
      const total = filteredRows.length;

      const rowHeight = state.rowHeight || DEFAULT_ROW_HEIGHT;
      const viewportHeight = target.clientHeight || (ROW_BUFFER * 2 + 20) * rowHeight;
      const visibleCount = Math.min(total, Math.ceil(viewportHeight / rowHeight) + ROW_BUFFER * 2);
      const maxStartIndex = Math.max(0, total - visibleCount);

      // Below the browser's height cap, scroll position maps to a row
      // index by exact pixels-per-row. Above it, the rendered scroll
      // height is capped at MAX_VIRTUAL_HEIGHT and the index is derived
      // from the *fraction* scrolled instead — otherwise the rows past
      // whatever the browser actually renders could never be reached.
      const naturalHeight = total * rowHeight;
      const totalHeight = Math.min(naturalHeight, MAX_VIRTUAL_HEIGHT);
      let startIndex;
      if (naturalHeight <= MAX_VIRTUAL_HEIGHT) {
        startIndex = Math.floor(target.scrollTop / rowHeight) - ROW_BUFFER;
      } else {
        const maxScrollTop = Math.max(1, totalHeight - viewportHeight);
        const fraction = Math.min(1, target.scrollTop / maxScrollTop);
        startIndex = Math.round(fraction * maxStartIndex);
      }
      startIndex = Math.min(maxStartIndex, Math.max(0, startIndex));
      const endIndex = Math.min(total, startIndex + visibleCount);

      // Splitting whatever height isn't covered by the actually-rendered
      // rows, proportionally to how far into the list startIndex is,
      // keeps topSpacer + renderedHeight + bottomSpacer pinned to
      // totalHeight exactly — so the scrollbar never jitters — and this
      // reduces to the exact startIndex * rowHeight below the height cap.
      const renderedHeight = (endIndex - startIndex) * rowHeight;
      const remainingHeight = Math.max(0, totalHeight - renderedHeight);
      const topSpacer = maxStartIndex > 0 ? remainingHeight * (startIndex / maxStartIndex) : 0;
      const bottomSpacer = remainingHeight - topSpacer;
      const spacerRow = h => `<tr class="virtual-spacer" style="height:${h}px"><td colspan="${colCount}" style="padding:0;border:0"></td></tr>`;

      tbody.innerHTML =
        (topSpacer > 0 ? spacerRow(topSpacer) : '') +
        renderTableRowsHtml(filteredRows.slice(startIndex, endIndex)) +
        (bottomSpacer > 0 ? spacerRow(bottomSpacer) : '');

      // Don't lock in an estimated row height until a hidden container
      // (e.g. an inactive tab, which measures 0) has actually become
      // visible — locking that in early would throw off the spacer math
      // for every row. The next scroll/resize tick keeps retrying.
      if (!state.rowHeight) {
        const measuredRow = tbody.querySelector('tr:not(.virtual-spacer)');
        const measuredHeight = measuredRow ? measuredRow.getBoundingClientRect().height : 0;
        if (measuredHeight > 0) {
          state.rowHeight = measuredHeight;
          renderVirtualRows(target, stateKey);
          return;
        }
      }

      updateRowCountText(target, stateKey, total);
    }

    // Wires the scroll listener (rAF-throttled) and a ResizeObserver once
    // per container element — both just re-window the already-filtered
    // rows, never re-run filter/sort. The ResizeObserver also covers a tab
    // becoming visible (0 -> real size counts as a resize) and the
    // draggable pane resizer.
    function attachVirtualScroll(target, stateKey) {
      if (target.dataset.virtualWired) return;
      target.dataset.virtualWired = 'true';

      let ticking = false;
      target.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          renderVirtualRows(target, stateKey);
        });
      }, { passive: true });

      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => renderVirtualRows(target, stateKey)).observe(target);
      }
    }

    // Re-renders a results/table-view grid. On a genuinely new result set
    // (forceFullRender, or the column list itself changed) it rebuilds the
    // whole <table>. Otherwise — a filter keystroke or a sort click — it
    // recomputes the filtered/sorted row array and re-windows the visible
    // rows, leaving the <thead> filter <input> elements untouched so they
    // don't lose focus. (They used to get destroyed and recreated on every
    // keystroke, which meant typing a second filter character required
    // re-clicking the box.)
    function updateTable(targetId, stateKey, { forceFullRender = false } = {}) {
      const target = document.getElementById(targetId);
      const state = viewStates[stateKey];
      state.filteredRows = getVisibleRows(stateKey);

      const table = target.querySelector('table');
      const columnsKey = state.columns.join('');
      const structureChanged = forceFullRender || !table || target.dataset.columnsKey !== columnsKey;

      if (structureChanged) {
        target.innerHTML = `<table>${renderTableHeadHtml(state, stateKey)}<tbody></tbody></table>
          <div class="row-count"></div>`;
        target.dataset.columnsKey = columnsKey;
        target.scrollTop = 0;
        state.rowHeight = null;
        attachVirtualScroll(target, stateKey);
      } else {
        const ths = table.querySelectorAll('thead th');
        state.columns.forEach((col, index) => {
          const th = ths[index];
          const icon = th?.querySelector('.sort-icon');
          if (!icon) return;
          const active = state.sort.column === index;
          icon.textContent = active ? (state.sort.direction === 'asc' ? '▲' : '▼') : '⇅';
          icon.classList.toggle('active', active);
          th.setAttribute('aria-sort', active ? (state.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
        });
      }

      renderVirtualRows(target, stateKey);
      syncTopScrollbar(targetId, state.scrollBarId, state.scrollInnerId);

      if (stateKey === 'tableview') {
        const meta = document.getElementById('table-view-meta');
        if (meta) meta.textContent = `${state.columns.length.toLocaleString()} columns · ${state.rows.length.toLocaleString()} rows`;
      }
    }

    function syncTopScrollbar(targetId, topBarId, topInnerId) {
      const resultsEl = document.getElementById(targetId);
      const topBar = document.getElementById(topBarId);
      const topInner = document.getElementById(topInnerId);
      const table = resultsEl.querySelector('table');

      if (!table) {
        topBar.classList.remove('visible');
        return;
      }

      const needsScroll = table.scrollWidth > resultsEl.clientWidth;
      topBar.classList.toggle('visible', needsScroll);
      topInner.style.width = table.scrollWidth + 'px';

      if (!topBar.dataset.wired) {
        topBar.addEventListener('scroll', () => {
          resultsEl.scrollLeft = topBar.scrollLeft;
        });
        resultsEl.addEventListener('scroll', () => {
          topBar.scrollLeft = resultsEl.scrollLeft;
        });
        topBar.dataset.wired = 'true';
      }
    }

    window.sortColumn = function(stateKey, colIndex) {
      const state = viewStates[stateKey];
      if (state.sort.column === colIndex) {
        state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.column = colIndex;
        state.sort.direction = 'asc';
      }
      const targetId = stateKey === 'tableview' ? 'table-view-results' : 'results';
      document.getElementById(targetId).scrollTop = 0;
      updateTable(targetId, stateKey);
    };

    window.filterColumn = function(stateKey, colIndex, value) {
      viewStates[stateKey].filter[colIndex] = value;
      const targetId = stateKey === 'tableview' ? 'table-view-results' : 'results';
      document.getElementById(targetId).scrollTop = 0;
      updateTable(targetId, stateKey);
    };

    window.tableSearch = function(value) {
      viewStates.tableview.search = value;
      document.getElementById('table-view-results').scrollTop = 0;
      updateTable('table-view-results', 'tableview');
    };

    // ---- Column stats (Table View) ----
    // Lazily computed per table and cached until the table's underlying
    // data actually changes (see the columnStatsCache = null resets in
    // uploadCSV, confirmDeleteTableSubmit, and runQuery's mutating-query
    // branch below) — a 500k-row table makes "recompute on every render"
    // the wrong tradeoff.
    let columnStatsCache = null; // { tableName, html }

    // Every column is stored as TEXT (see loadFileAsTable), so "is this
    // numeric" has to be inferred from the values themselves. Same
    // "every non-empty value must qualify" classification
    // normalizeThousandsSeparators already uses, so a column reads as
    // numeric here exactly when it would there.
    const STATS_NUMBER_RE = /^-?\d+(\.\d+)?$/;

    async function computeColumnStats(tableName) {
      const result = db.exec(`SELECT * FROM "${tableName}"`);
      if (!result.length) return [];
      const columns = result[0].columns;
      const rows = result[0].values;
      const colCount = columns.length;

      // Pass 1: a column only counts as numeric if EVERY non-empty value in
      // it qualifies — one stray "N/A" makes the whole column text.
      const isNumeric = new Array(colCount).fill(true);
      for (let start = 0; start < rows.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, rows.length);
        for (let i = start; i < end; i++) {
          const row = rows[i];
          for (let c = 0; c < colCount; c++) {
            if (!isNumeric[c]) continue;
            const val = row[c];
            if (val === null || val === undefined || val === '') continue;
            if (!STATS_NUMBER_RE.test(String(val))) isNumeric[c] = false;
          }
        }
        if (end < rows.length) await yieldToUI();
      }

      // Pass 2: compute the real stats now that every column's type is
      // known. Min/max/sum are running aggregates, not collected arrays —
      // Math.min(...vals) on a 500k-element array risks blowing the call
      // stack, and a value-count Map is only built for text columns.
      const nullCount = new Array(colCount).fill(0);
      const numericCount = new Array(colCount).fill(0);
      const min = new Array(colCount).fill(Infinity);
      const max = new Array(colCount).fill(-Infinity);
      const sum = new Array(colCount).fill(0);
      const valueCounts = columns.map(() => new Map());

      for (let start = 0; start < rows.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, rows.length);
        for (let i = start; i < end; i++) {
          const row = rows[i];
          for (let c = 0; c < colCount; c++) {
            const val = row[c];
            if (val === null || val === undefined || val === '') { nullCount[c]++; continue; }
            if (isNumeric[c]) {
              const num = parseFloat(val);
              numericCount[c]++;
              sum[c] += num;
              if (num < min[c]) min[c] = num;
              if (num > max[c]) max[c] = num;
            } else {
              const str = String(val);
              valueCounts[c].set(str, (valueCounts[c].get(str) || 0) + 1);
            }
          }
        }
        if (end < rows.length) await yieldToUI();
      }

      return columns.map((name, c) => {
        if (isNumeric[c] && numericCount[c] > 0) {
          return {
            name, nullCount: nullCount[c], totalRows: rows.length, type: 'numeric',
            min: min[c], max: max[c], mean: sum[c] / numericCount[c],
          };
        }
        let mostCommon = null, mostCommonCount = 0;
        valueCounts[c].forEach((count, value) => {
          if (count > mostCommonCount) { mostCommon = value; mostCommonCount = count; }
        });
        return {
          name, nullCount: nullCount[c], totalRows: rows.length, type: 'text',
          distinctCount: valueCounts[c].size, mostCommon, mostCommonCount,
        };
      });
    }

    function formatStatNumber(n) {
      if (!isFinite(n)) return '—';
      return (Math.round(n * 100) / 100).toLocaleString();
    }

    function truncateForStats(str, maxLen = 40) {
      const s = String(str);
      return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
    }

    // ---- Query results chart ----
    // Scoped deliberately narrow: exactly 2 columns (a label and a number),
    // the shape a GROUP BY / aggregate query actually produces. A raw
    // multi-column row dump isn't a chart-worthy shape, so this declines
    // rather than guessing which columns to plot.
    const MAX_CHART_BARS = 30;

    function getChartableRows(stateKey) {
      const state = viewStates[stateKey];
      if (!state || !state.columns || state.columns.length !== 2) {
        return { error: 'Chart needs a 2-column result — a label and a number. Try a query like SELECT region, SUM(total) FROM orders GROUP BY region.' };
      }

      const rows = getVisibleRows(stateKey);
      const parsed = [];
      for (const row of rows) {
        const raw = row[1];
        if (raw === null || raw === undefined || raw === '') continue;
        const num = parseFloat(raw);
        if (isNaN(num)) continue;
        parsed.push({ label: row[0] === null || row[0] === undefined ? '' : String(row[0]), value: num });
      }
      if (parsed.length === 0) {
        return { error: `The second column ("${state.columns[1]}") needs to be numeric to chart it.` };
      }
      return { rows: parsed, truncated: parsed.length > MAX_CHART_BARS, total: parsed.length };
    }

    function renderBarChartSVG(rows) {
      const width = 640;
      const height = 320;
      const paddingLeft = 56;
      const paddingBottom = 64;
      const paddingTop = 24;
      const paddingRight = 20;
      const chartWidth = width - paddingLeft - paddingRight;
      const chartHeight = height - paddingTop - paddingBottom;

      const maxVal = Math.max(...rows.map(r => r.value), 0);
      const minVal = Math.min(...rows.map(r => r.value), 0);
      const range = (maxVal - minVal) || 1;
      const zeroY = paddingTop + chartHeight * (maxVal / range);

      const barGap = 8;
      const barWidth = Math.max(4, (chartWidth - barGap * (rows.length - 1)) / rows.length);

      let bars = '';
      let labels = '';
      rows.forEach((r, i) => {
        const x = paddingLeft + i * (barWidth + barGap);
        const barHeight = Math.max(Math.abs(r.value) / range * chartHeight, r.value === 0 ? 0 : 1);
        const y = r.value >= 0 ? zeroY - barHeight : zeroY;
        const labelX = (x + barWidth / 2).toFixed(1);
        bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="#ff4f00" rx="2"></rect>`;
        bars += `<text x="${labelX}" y="${(y - 4).toFixed(1)}" font-size="10" text-anchor="middle" fill="#201515" font-family="'JetBrains Mono', monospace">${escapeHtml(formatStatNumber(r.value))}</text>`;
        const labelY = (height - paddingBottom + 14).toFixed(1);
        labels += `<text x="${labelX}" y="${labelY}" font-size="10" text-anchor="end" fill="#56534a" transform="rotate(-40 ${labelX} ${labelY})">${escapeHtml(truncateForStats(r.label, 14))}</text>`;
      });

      return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, sans-serif">
        <rect x="0" y="0" width="${width}" height="${height}" fill="#fffefb"></rect>
        <line x1="${paddingLeft}" y1="${zeroY.toFixed(1)}" x2="${width - paddingRight}" y2="${zeroY.toFixed(1)}" stroke="#c5c0b1" stroke-width="1"></line>
        ${bars}
        ${labels}
      </svg>`;
    }

    function renderResultsChart() {
      const panel = document.getElementById('results-chart-panel');
      if (!panel) return;
      const data = getChartableRows('results');
      if (data.error) {
        panel.innerHTML = `<div class="empty">${escapeHtml(data.error)}</div>`;
        return;
      }
      const shown = data.rows.slice(0, MAX_CHART_BARS);
      const svg = renderBarChartSVG(shown);
      const note = data.truncated
        ? `<div class="chart-note">Showing the first ${MAX_CHART_BARS} of ${data.total.toLocaleString()} rows.</div>`
        : '';
      panel.innerHTML = `
        <div class="chart-toolbar">
          <button class="save-btn" onclick="downloadChartSVG()">Download SVG</button>
        </div>
        <div id="results-chart-svg-wrap">${svg}</div>
        ${note}
      `;
    }

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

    window.downloadChartSVG = function() {
      const svgEl = document.querySelector('#results-chart-svg-wrap svg');
      if (!svgEl) return;
      const serialized = new XMLSerializer().serializeToString(svgEl);
      const blob = new Blob([serialized], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chart.svg';
      a.click();
      URL.revokeObjectURL(url);
    };

    function renderColumnStatsCard(stat) {
      const nullPct = stat.totalRows > 0 ? ((stat.nullCount / stat.totalRows) * 100).toFixed(1) : '0.0';
      const nullMetric = `<div class="stat-metric"><span class="stat-metric-label">Nulls</span><span class="stat-metric-value">${stat.nullCount.toLocaleString()} (${nullPct}%)</span></div>`;

      if (stat.type === 'numeric') {
        return `
          <div class="stat-card">
            <div class="stat-card-name">${escapeHtml(stat.name)}</div>
            <div class="stat-card-type">Numeric</div>
            <div class="stat-card-metrics">
              <div class="stat-metric"><span class="stat-metric-label">Min</span><span class="stat-metric-value">${formatStatNumber(stat.min)}</span></div>
              <div class="stat-metric"><span class="stat-metric-label">Max</span><span class="stat-metric-value">${formatStatNumber(stat.max)}</span></div>
              <div class="stat-metric"><span class="stat-metric-label">Mean</span><span class="stat-metric-value">${formatStatNumber(stat.mean)}</span></div>
              ${nullMetric}
            </div>
          </div>`;
      }

      const mostCommonText = stat.mostCommon !== null
        ? `${escapeHtml(truncateForStats(stat.mostCommon))} (${stat.mostCommonCount.toLocaleString()})`
        : '—';
      return `
        <div class="stat-card">
          <div class="stat-card-name">${escapeHtml(stat.name)}</div>
          <div class="stat-card-type">Text</div>
          <div class="stat-card-metrics">
            <div class="stat-metric"><span class="stat-metric-label">Distinct</span><span class="stat-metric-value">${stat.distinctCount.toLocaleString()}</span></div>
            <div class="stat-metric"><span class="stat-metric-label">Most common</span><span class="stat-metric-value" title="${escapeAttr(stat.mostCommon !== null ? String(stat.mostCommon) : '')}">${mostCommonText}</span></div>
            ${nullMetric}
          </div>
        </div>`;
    }

    window.toggleColumnStats = async function() {
      const panel = document.getElementById('table-view-stats-panel');
      const btn = document.getElementById('table-stats-toggle-btn');
      if (!panel.hidden) {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        return;
      }

      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');

      if (!activeTableName) {
        panel.innerHTML = '<div class="empty">Upload a file first.</div>';
        return;
      }

      if (columnStatsCache && columnStatsCache.tableName === activeTableName) {
        panel.innerHTML = columnStatsCache.html;
        return;
      }

      const requestedTable = activeTableName;
      panel.innerHTML = '<div class="loading">Computing column stats…</div>';
      const stats = await computeColumnStats(requestedTable);
      const html = `<div class="stat-card-grid">${stats.map(renderColumnStatsCard).join('')}</div>`;

      // The table could have changed while this was computing (fast table
      // switch, or the panel got closed) — don't clobber a newer state
      // with a stale result.
      if (activeTableName !== requestedTable || panel.hidden) return;
      columnStatsCache = { tableName: requestedTable, html };
      panel.innerHTML = html;
    };

    function renderTableView() {
      if (!db || !activeTableName) return;
      try {
        const result = db.exec(`SELECT * FROM "${activeTableName}"`);
        if (!result.length || !result[0].values.length) {
          document.getElementById('table-view-results').innerHTML = '<div class="empty">No data</div>';
          viewStates.tableview.columns = [];
          viewStates.tableview.rows = [];
          setExportButtonVisible('tableview', false);
          return;
        }
        renderTable('table-view-results', 'tableview', result);
      } catch (err) {
        console.error('Table view render error:', err);
      }
    }

    // Exports exactly what's currently visible for a view (respecting its
    // active filters/search/sort via getVisibleRows) as a downloaded CSV.
    window.exportResultsCSV = function(stateKey) {
      const state = viewStates[stateKey];
      if (!state.columns.length) return;

      const escapeCsvCell = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const rows = getVisibleRows(stateKey);
      const lines = [state.columns.map(escapeCsvCell).join(',')];
      rows.forEach(row => lines.push(row.map(escapeCsvCell).join(',')));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv' });

      const filename = stateKey === 'tableview'
        ? `${activeTableName || 'table'}.csv`
        : 'query_results.csv';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };

