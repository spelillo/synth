    // ---- JSON / NDJSON parsing (shared by fresh uploads and "+ Add table",
    // same as parseCSVText) ----
    //
    // Returns the exact same { headers, rows } shape as parseCSVText, so
    // loadFileAsTable, assertRowCapOrThrow, and the chunked insert path all
    // work completely unchanged regardless of which parser produced them.
    //
    // Two input shapes are supported — a single JSON array of objects, or
    // newline-delimited JSON (one object per line) — because those are the
    // two shapes real API exports and log dumps actually come in.
    //
    // Column shape decision (documented here since it's the one real design
    // choice in this parser): a nested plain object flattens into dot-notation
    // columns ("address.city"), matching how you'd already write a query
    // against it. An array value stores as its JSON text in a single column
    // instead — turning it into N more columns would explode the schema for
    // no benefit — queryable with SQLite's own json_extract()/json_each().

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function flattenJSONRecord(record, prefix, out) {
      for (const key of Object.keys(record)) {
        const value = record[key];
        const flatKey = prefix ? `${prefix}.${key}` : key;
        if (isPlainObject(value)) {
          flattenJSONRecord(value, flatKey, out);
        } else if (Array.isArray(value)) {
          out[flatKey] = JSON.stringify(value);
        } else {
          out[flatKey] = (value === null || value === undefined) ? '' : String(value);
        }
      }
      return out;
    }

    // Tries a single JSON document first (array of objects, or one bare
    // object treated as a single-row table); falls back to NDJSON — one
    // JSON object per line — if that fails, since a real NDJSON file is a
    // SyntaxError as a whole document (concatenated JSON values aren't
    // valid JSON on their own).
    function parseJSONRecords(text) {
      const trimmed = text.trim();
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        if (isPlainObject(parsed)) return [parsed];
        throw new Error('not array/object');
      } catch {
        const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) throw new Error('Empty JSON file');
        const records = [];
        for (let i = 0; i < lines.length; i++) {
          let record;
          try {
            record = JSON.parse(lines[i]);
          } catch {
            throw new Error(`This doesn't look like valid JSON or newline-delimited JSON (line ${i + 1} isn't valid JSON either).`);
          }
          if (!isPlainObject(record)) {
            throw new Error(`Line ${i + 1} isn't a JSON object — newline-delimited JSON needs one object per line.`);
          }
          records.push(record);
        }
        return records;
      }
    }

    async function parseJSONText(text) {
      const records = parseJSONRecords(text);
      if (records.length === 0) throw new Error('Empty JSON file');

      // Pass 1: flatten every record. Kept as its own array (rather than
      // re-flattening below) since flattening is the expensive part.
      const flatRecords = [];
      for (let start = 0; start < records.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, records.length);
        for (let i = start; i < end; i++) {
          if (!isPlainObject(records[i])) {
            throw new Error(`Record ${i + 1} isn't a JSON object — every element must be an object to become a row.`);
          }
          flatRecords.push(flattenJSONRecord(records[i], '', {}));
        }
        advanceLoadProgress(end - start);
        if (end < records.length) await yieldToUI();
      }

      // Pass 2: union of every key across every record, in first-seen
      // order — JSON records aren't guaranteed uniform shape the way a CSV
      // header row is, so the column list has to be discovered, not assumed.
      const headerKeys = [];
      const seenKeys = new Set();
      for (let start = 0; start < flatRecords.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, flatRecords.length);
        for (let i = start; i < end; i++) {
          for (const key of Object.keys(flatRecords[i])) {
            if (!seenKeys.has(key)) { seenKeys.add(key); headerKeys.push(key); }
          }
        }
        advanceLoadProgress(end - start);
        if (end < flatRecords.length) await yieldToUI();
      }
      const headers = headerKeys.map(k => sanitizeColumnName(k));

      // Pass 3: build rows in header order, filling any key a given record
      // didn't have with '' (same convention parseCSVText's ragged-row
      // handling in loadFileAsTable already uses).
      const rows = [];
      for (let start = 0; start < flatRecords.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, flatRecords.length);
        for (let i = start; i < end; i++) {
          const flat = flatRecords[i];
          rows.push(headerKeys.map(k => flat[k] ?? ''));
        }
        advanceLoadProgress(end - start);
        if (end < flatRecords.length) await yieldToUI();
      }

      return { headers, rows: await normalizeThousandsSeparators(rows) };
    }

    function isJSONFile(fileName) {
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      return ext === 'json' || ext === 'ndjson' || ext === 'jsonl';
    }

    // Single entry point uploadCSV/addTablesCSV both call — keeps the
    // format decision in one place instead of duplicated at each call site.
    async function parseUploadedFile(fileName, text) {
      return isJSONFile(fileName) ? parseJSONText(text) : parseCSVText(text);
    }

    // Loads one file into the shared `db` as a new table and returns its
    // metadata. Assumes `db` already exists — callers create it first. The
    // insert loop is wrapped in one transaction (previously implicit
    // per-statement commits) and yields between chunks, same reasoning as
    // parseCSVText above.
    async function loadFileAsTable(file, headers, rows, proposedName) {
      const name = uniqueTableName(proposedName);

      const columnDefs = headers.map(h => `"${h}" TEXT`).join(', ');
      db.run(`CREATE TABLE "${name}" (${columnDefs})`);

      db.run('BEGIN TRANSACTION');
      const stmt = db.prepare(`INSERT INTO "${name}" VALUES (${headers.map(() => '?').join(', ')})`);
      for (let start = 0; start < rows.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, rows.length);
        for (let i = start; i < end; i++) {
          const row = rows[i];
          if (row.length === headers.length) {
            stmt.run(row);
          } else if (row.length < headers.length) {
            stmt.run([...row, ...Array(headers.length - row.length).fill('')]);
          } else {
            stmt.run(row.slice(0, headers.length));
          }
        }
        advanceLoadProgress(end - start);
        if (end < rows.length) await yieldToUI();
      }
      stmt.free();
      db.run('COMMIT');

      const meta = { name, fileName: file.name, rowCount: rows.length, columns: headers };
      tables.push(meta);
      return meta;
    }

    const MAX_TABLES_PER_WORKSPACE = 10;
    const CSV_ROW_CAP_STANDARD = 100000;
    const CSV_ROW_CAP_PREMIUM = 500000;

    function maxTablesForTier() {
      return canUseFeature('multiCsv') ? MAX_TABLES_PER_WORKSPACE : 1;
    }

    function csvRowCapForTier() {
      return canUseFeature('largeCsv') ? CSV_ROW_CAP_PREMIUM : CSV_ROW_CAP_STANDARD;
    }

    // Throws a friendly error (caught by uploadCSV/addTablesCSV's existing
    // try/catch, which already surfaces err.message in the status line) if
    // this file is over the account's row cap. Also pops the relevant gate
    // modal so a blocked upload is a clear moment, not just status text.
    function assertRowCapOrThrow(rowCount) {
      const cap = csvRowCapForTier();
      if (rowCount <= cap) return;
      if (!canUseFeature('largeCsv')) {
        openPremiumPanel();
        throw new Error(`This file has ${rowCount.toLocaleString()} rows, over the ${cap.toLocaleString()}-row limit for free accounts. Upgrade to Premium for files up to ${CSV_ROW_CAP_PREMIUM.toLocaleString()} rows.`);
      }
      throw new Error(`This file has ${rowCount.toLocaleString()} rows, over the maximum supported size (${cap.toLocaleString()} rows).`);
    }

    // Yields to the browser's event loop so a large parse/insert doesn't
    // block it for one long uninterrupted stretch — keeps the loading
    // overlay animating and the tab responsive instead of appearing hung.
    function yieldToUI() {
      return new Promise(resolve => setTimeout(resolve, 0));
    }
    const CSV_CHUNK_SIZE = 5000;

    function formatFileSize(file) {
      const sizeKB = (file.size / 1024).toFixed(1);
      return sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)}MB` : `${sizeKB}KB`;
    }

