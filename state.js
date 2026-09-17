    // state.js — every top-level mutable global genuinely shared across
    // the split-out files (db, tables, currentUser, etc.), declared exactly
    // once. Everything else references these as plain globals: no modules,
    // no imports, same runtime model as the single-file version — the only
    // real requirement is that this file's <script> tag loads first.

    let db;
    let aiEnabled = false;
    let csvLoaded = false;

    let currentUser = null;
    let currentCSVFile = null;
    let currentWorkspaceId = null;
    let currentWorkspaceName = null;
    let chatHistory = [];

    // ---- Multi-table workspace state ----
    // `tables` holds every table currently loaded into the shared `db`
    // instance. `activeTableName` is which table the query editor/Table
    // View is pointed at (table-chip bar). `focusedTableNames` is a
    // separate, independent set: which table(s) the AI defaults to for an
    // ambiguous question (the checkbox dropdown above chat) — a question
    // that plainly needs other tables (or a join) isn't limited to it.
    let tables = [];              // [{ name, fileName, rowCount, columns }]
    let activeTableName = null;
    let focusedTableNames = new Set();
    // Tracks the table count we last warned about, so the cross-table-AI
    // paywall notice (see crossTableAIBlocked/sendMessage) shows once per
    // table-count change instead of on every single chat message.
    let crossTableNoticeTableCount = 0;

    let SQL;
