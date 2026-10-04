// Shared setup for the Learn tests: sql.js (the same 1.8.0 build the
// browser loads from the CDN), plus helpers that build lesson databases
// from learn-datasets.js exactly the way learn.js does in the page.

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const ROOT = path.join(__dirname, '..', '..');
const LearnDatasets = require(path.join(ROOT, 'learn-datasets.js'));
const LearnGrader = require(path.join(ROOT, 'learn-grader.js'));
const LearnCurriculum = require(path.join(ROOT, 'learn-curriculum.js'));
const LearnProgress = require(path.join(ROOT, 'learn-progress.js'));

// learn.js fetches sample-data/*.csv over HTTP; here they're read from disk.
const fetchText = relPath => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

let sqlPromise = null;
function getSQL() {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise;
}

async function lessonDb(tableIds) {
  const SQL = await getSQL();
  const db = new SQL.Database();
  await LearnDatasets.loadInto(db, tableIds, { fetchText });
  return db;
}

// Same tables, rows inserted in reverse. A lesson whose answer depends on
// physical row order (an unbroken tie in ORDER BY, LIMIT without ORDER BY)
// grades differently here than on the normal database.
async function reversedLessonDb(tableIds) {
  const SQL = await getSQL();
  const source = await lessonDb(tableIds);
  const db = new SQL.Database();
  for (const t of tableIds) {
    db.run(LearnDatasets.createTableSql(t));
    const res = source.exec(`SELECT * FROM ${LearnDatasets.quoteIdent(t)}`);
    const rows = res.length ? res[0].values.slice().reverse() : [];
    const cols = LearnDatasets.DATASETS[t].columns;
    const stmt = db.prepare(`INSERT INTO ${LearnDatasets.quoteIdent(t)} VALUES (${cols.map(() => '?').join(', ')})`);
    rows.forEach(r => stmt.run(r));
    stmt.free();
  }
  source.close();
  return db;
}

function gradeCtx(lesson) {
  return {
    tables: lesson.tables.map(t => ({ name: t, columns: LearnDatasets.DATASETS[t].columns.map(c => c.name) })),
  };
}

module.exports = { ROOT, LearnDatasets, LearnGrader, LearnCurriculum, LearnProgress, fetchText, getSQL, lessonDb, reversedLessonDb, gradeCtx };
