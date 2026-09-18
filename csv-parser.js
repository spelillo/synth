    function slugifyTableName(filename) {
      let base = filename.replace(/\.[^/.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (!base) base = 'table';
      if (/^[0-9]/.test(base)) base = 't_' + base;
      return base;
    }

    // A raw CSV header like "Student ID" is a valid *quoted* SQL identifier
    // (Synth's own generated queries always quote it), but typing it
    // unquoted in the query editor — "SELECT Student ID FROM ..." — parses
    // as two separate identifiers and fails with "no such column: Student".
    // Collapsing whitespace to underscores at load time means every column
    // name is a bare, unquoted-safe token everywhere: the editor, the AI
    // assistant's generated SQL, and hand-typed queries alike.
    function sanitizeColumnName(header) {
      return header.trim().replace(/\s+/g, '_');
    }

    function uniqueTableName(base) {
      const existing = new Set(tables.map(t => t.name));
      if (!existing.has(base)) return base;
      let n = 2;
      while (existing.has(`${base}_${n}`)) n++;
      return `${base}_${n}`;
    }

    // ---- CSV parsing (shared by fresh uploads and "+ Add table") ----

    // Catches the most common upload mistake early: an Excel/Word/zip file
    // saved or renamed with a .csv extension. Those are binary (zip-based)
    // under the hood, so reading them as text produces garbage that used to
    // reach the SQL layer and fail there with a cryptic "unrecognized
    // token" error instead of a message that explains what's wrong.
    function looksLikeNonCsvFile(text) {
      if (text.startsWith('PK')) return 'a zip-based file (like Excel .xlsx or Word .docx)';
      if (text.startsWith('ÐÏà') || text.charCodeAt(0) === 0xFFFD) return 'a binary file (like an older .xls)';
      const sample = text.slice(0, 1000);
      const controlChars = (sample.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
      if (sample.length > 0 && controlChars / sample.length > 0.05) return 'a binary file, not text';
      return null;
    }

    async function parseCSVText(text) {
      const nonCsvReason = looksLikeNonCsvFile(text);
      if (nonCsvReason) {
        throw new Error(`This doesn't look like a CSV. It looks like ${nonCsvReason}. Export or save it as CSV, then try again.`);
      }

      const lines = text.split('\n').filter(line => line.trim());
      if (lines.length === 0) {
        throw new Error('Empty CSV file');
      }

      const headers = lines[0].split(',').map(h => sanitizeColumnName(h.trim().replace(/"/g, '')));

      // Parsed in chunks, yielding to the browser between them, so a large
      // file doesn't block the main thread for one long uninterrupted
      // stretch — previously this ran as a single synchronous pass over
      // every line, which is part of why a 100k+ row CSV made the tab feel
      // hung rather than just busy.
      const rows = [];
      for (let start = 1; start < lines.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, lines.length);
        for (let i = start; i < end; i++) {
          const line = lines[i];
          const values = [];
          let current = '';
          let inQuotes = false;

          for (let c = 0; c < line.length; c++) {
            const char = line[c];
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
              values.push(current.trim().replace(/^"|"$/g, ''));
              current = '';
            } else {
              current += char;
            }
          }
          values.push(current.trim().replace(/^"|"$/g, ''));
          if (values.some(val => val)) rows.push(values);
        }
        advanceLoadProgress(end - start);
        if (end < lines.length) await yieldToUI();
      }

      return { headers, rows: await normalizeThousandsSeparators(rows) };
    }

    // A column full of values like "1,200" keeps the thousands separator as
    // part of the stored text, which silently breaks numeric handling
    // everywhere downstream — SQLite's CAST("1,200" AS INTEGER) reads only
    // the leading digit run (1), and the client-side column sort's
    // parseFloat() does the same. Strip the separator once, here, for any
    // column where every non-empty value is a plain or comma-grouped
    // number (a real column mixes both, e.g. "450" and "1,200" together —
    // requiring literally every value to contain a comma would miss that),
    // so every consumer (hand-written SQL, the AI assistant's generated
    // SQL, sort) sees a plain number instead of hitting that trap
    // independently.
    const NUMBER_RE = /^-?\d{1,3}(,\d{3})*(\.\d+)?$/;

    async function normalizeThousandsSeparators(rows) {
      if (!rows.length) return rows;
      const columnCount = rows[0].length;
      const qualifies = new Array(columnCount).fill(true);
      const sawComma = new Array(columnCount).fill(false);

      for (let start = 0; start < rows.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, rows.length);
        for (let i = start; i < end; i++) {
          const row = rows[i];
          for (let colIndex = 0; colIndex < columnCount; colIndex++) {
            if (!qualifies[colIndex]) continue;
            const val = row[colIndex];
            if (!val) continue;
            if (!NUMBER_RE.test(val)) { qualifies[colIndex] = false; continue; }
            if (val.includes(',')) sawComma[colIndex] = true;
          }
        }
        advanceLoadProgress(end - start);
        if (end < rows.length) await yieldToUI();
      }

      const finalQualifies = qualifies.map((q, i) => q && sawComma[i]);
      if (!finalQualifies.some(Boolean)) return rows;

      for (let start = 0; start < rows.length; start += CSV_CHUNK_SIZE) {
        const end = Math.min(start + CSV_CHUNK_SIZE, rows.length);
        for (let i = start; i < end; i++) {
          const row = rows[i];
          for (let colIndex = 0; colIndex < columnCount; colIndex++) {
            if (finalQualifies[colIndex] && row[colIndex]) {
              row[colIndex] = row[colIndex].replace(/,/g, '');
            }
          }
        }
        if (end < rows.length) await yieldToUI();
      }

      return rows;
    }

