    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // ---- Table rendering (shared by Query Results and Table View) ----
    // Each consumer gets its own state (columns/rows/sort/filter/search) keyed
    // by name, so sorting or filtering one table never touches the other.

    const TABLE_PAGE_SIZE = 200;

    let viewStates = {
      results: { columns: [], rows: [], sort: {}, filter: {}, search: '', page: 0, scrollBarId: 'results-scroll-top', scrollInnerId: 'results-scroll-top-inner' },
      tableview: { columns: [], rows: [], sort: {}, filter: {}, search: '', page: 0, scrollBarId: 'table-view-scroll-top', scrollInnerId: 'table-view-scroll-top-inner' }
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
        return;
      }

      state.columns = result[0].columns;
      state.rows = result[0].values;
      state.sort = {};
      state.filter = {};
      state.search = '';
      state.page = 0;
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
        const sortIcon = state.sort.column === index
          ? (state.sort.direction === 'asc' ? '▲' : '▼')
          : '⇅';
        const sortClass = state.sort.column === index ? 'active' : '';

        html += `<th>
          <div class="th-content">
            <div class="th-label" onclick="sortColumn('${stateKey}', ${index})">
              ${escapeHtml(col)}
              <span class="sort-icon ${sortClass}">${sortIcon}</span>
            </div>
          </div>
          <input type="text" class="column-filter" placeholder="Filter..."
                 onkeyup="filterColumn('${stateKey}', ${index}, this.value)"
                 value="${escapeAttr(state.filter[index] || '')}">
        </th>`;
      });
      html += '</tr></thead>';
      return html;
    }

    function renderTableBodyHtml(filteredRows) {
      let html = '<tbody>';
      filteredRows.forEach(row => {
        html += '<tr>';
        row.forEach(val => {
          html += `<td>${val !== null && val !== undefined ? escapeHtml(String(val)) : '<span class="null">NULL</span>'}</td>`;
        });
        html += '</tr>';
      });
      html += '</tbody>';
      return html;
    }

    // Re-renders a results/table-view grid. On a genuinely new result set
    // (forceFullRender, or the column list itself changed) it rebuilds the
    // whole <table>. Otherwise — a filter keystroke or a sort click — it
    // only replaces <tbody> and patches the sort icons in place, leaving the
    // <thead> filter <input> elements untouched so they don't lose focus.
    // (They used to get destroyed and recreated on every keystroke, which
    // meant typing a second filter character required re-clicking the box.)
    function updateTable(targetId, stateKey, { forceFullRender = false } = {}) {
      const target = document.getElementById(targetId);
      const state = viewStates[stateKey];
      const filteredRows = getVisibleRows(stateKey);

      const totalPages = Math.max(1, Math.ceil(filteredRows.length / TABLE_PAGE_SIZE));
      state.page = Math.min(Math.max(state.page || 0, 0), totalPages - 1);
      const pageStart = state.page * TABLE_PAGE_SIZE;
      const pageRows = filteredRows.slice(pageStart, pageStart + TABLE_PAGE_SIZE);

      const table = target.querySelector('table');
      const columnsKey = state.columns.join('');
      const structureChanged = forceFullRender || !table || target.dataset.columnsKey !== columnsKey;

      if (structureChanged) {
        target.innerHTML = `<table>${renderTableHeadHtml(state, stateKey)}${renderTableBodyHtml(pageRows)}</table>
          <div class="row-count"></div>
          <div class="row-pagination"></div>`;
        target.dataset.columnsKey = columnsKey;
      } else {
        const ths = table.querySelectorAll('thead th');
        state.columns.forEach((col, index) => {
          const icon = ths[index]?.querySelector('.sort-icon');
          if (!icon) return;
          const active = state.sort.column === index;
          icon.textContent = active ? (state.sort.direction === 'asc' ? '▲' : '▼') : '⇅';
          icon.classList.toggle('active', active);
        });
        table.querySelector('tbody').outerHTML = renderTableBodyHtml(pageRows);
      }

      const rowCountEl = target.querySelector('.row-count');
      if (rowCountEl) {
        rowCountEl.textContent = totalPages > 1
          ? `${(pageStart + 1).toLocaleString()}–${Math.min(pageStart + TABLE_PAGE_SIZE, filteredRows.length).toLocaleString()} of ${filteredRows.length.toLocaleString()} rows (${state.rows.length.toLocaleString()} total)`
          : `${filteredRows.length.toLocaleString()} of ${state.rows.length.toLocaleString()} rows`;
      }

      const paginationEl = target.querySelector('.row-pagination');
      if (paginationEl) {
        paginationEl.innerHTML = totalPages > 1 ? `
          <button type="button" onclick="changeTablePage('${stateKey}', -1)" ${state.page === 0 ? 'disabled' : ''}>‹ Prev</button>
          <span>Page ${state.page + 1} of ${totalPages.toLocaleString()}</span>
          <button type="button" onclick="changeTablePage('${stateKey}', 1)" ${state.page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
        ` : '';
      }

      syncTopScrollbar(targetId, state.scrollBarId, state.scrollInnerId);

      if (stateKey === 'tableview') {
        const meta = document.getElementById('table-view-meta');
        if (meta) meta.textContent = `${state.columns.length.toLocaleString()} columns · ${state.rows.length.toLocaleString()} rows`;
      }
    }

    window.changeTablePage = function(stateKey, delta) {
      viewStates[stateKey].page += delta;
      const targetId = stateKey === 'tableview' ? 'table-view-results' : 'results';
      updateTable(targetId, stateKey);
    };

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
      state.page = 0;
      const targetId = stateKey === 'tableview' ? 'table-view-results' : 'results';
      updateTable(targetId, stateKey);
    };

    window.filterColumn = function(stateKey, colIndex, value) {
      viewStates[stateKey].filter[colIndex] = value;
      viewStates[stateKey].page = 0;
      const targetId = stateKey === 'tableview' ? 'table-view-results' : 'results';
      updateTable(targetId, stateKey);
    };

    window.tableSearch = function(value) {
      viewStates.tableview.search = value;
      viewStates.tableview.page = 0;
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

    window.toggleResultsChart = function() {
      const panel = document.getElementById('results-chart-panel');
      const btn = document.getElementById('results-chart-toggle-btn');
      if (!panel.hidden) {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
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

