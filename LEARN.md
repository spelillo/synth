# Learn SQL (`/learn`)

Synth's Learn page has three interactive SQL courses, with 60 lessons in total. Each lesson follows the same loop as DataCamp or Databricks Academy: read a short concept, run an example, write a query for a task, press **Check Answer**, and get specific feedback. The page is built from the same parts as the main workspace (header, upload bar, tabs, SQL editor, results grid, assistant pane), plus a few learning elements: a progress bar, a lesson stepper, Check Answer, hints, a locked solution, and an AI tutor that unlocks after your first attempt.

| Level | Course | Lessons | Covers |
|---|---|---|---|
| Beginner | SQL Foundations | 21 | `SELECT`/`FROM`, `DISTINCT`, `WHERE`, `AND`/`OR`/`NOT`, `IN`, `BETWEEN`, `LIKE`, `NULL`, `ORDER BY`, `LIMIT`, aliases, calculated columns, built-in functions, `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`, `GROUP BY`, `HAVING`, and a capstone using all six clauses |
| Intermediate | Joins & Combining Data | 20 | Keys and relationships, table aliases, `INNER`/`LEFT`/`RIGHT`/`FULL OUTER`/self/`CROSS` joins, anti-joins, joins with `GROUP BY` and `HAVING`, `UNION`, subqueries in `WHERE` and `FROM`, `IN (SELECT …)`, `EXISTS`, and a capstone report |
| Advanced | Analytics SQL | 19 | `CASE`, conditional aggregation, `COALESCE`, CTEs, chained and recursive CTEs, `OVER()`, `PARTITION BY`, `ROW_NUMBER`, `RANK`/`DENSE_RANK`, top N per group, running totals, `LAG`/`LEAD`, window frames, share of total, `NTILE`, dates, and a capstone |

## Routes

- `/learn` is the course overview. `vercel.json` rewrites it to `synth.html`.
- `/learn?lesson=b05` opens a lesson directly. Lesson ids are `b01`–`b21`, `i01`–`i20` and `a01`–`a19`.
- On a plain static server (no `vercel.json`), use `/synth.html?view=learn` and `/synth.html?view=learn&lesson=b05`.

Moving between the overview and lessons uses `history.pushState`, so the browser's Back and Forward buttons work. Leaving Learn (through the logo, a workspace, or Back) hands control back to `setActiveView()` in `app.js`. An inline script in `<head>` adds `route-learn` to `<html>` before first paint, so `/learn` never flashes the upload screen. The same script sets the page's own title, description and canonical URL for search engines.

## Files

| File | What it does | Runs in |
|---|---|---|
| `learn-datasets.js` | Table definitions with typed, documented columns. It loads the three practice CSVs from `sample-data/` and holds the inline "Page Turner Books" store. | Browser and Node |
| `learn-curriculum.js` | The three courses: every lesson's concept, example, task, starter code, reference solution, hints, takeaway and grading options | Browser and Node |
| `learn-grader.js` | Runs a learner's query safely and compares it with the reference result, explaining SQLite errors and mismatches in plain English | Browser and Node |
| `learn-progress.js` | Progress in localStorage, merging two copies, streaks, and optional Supabase sync | Browser and Node |
| `learn.js` | The page itself: routing, overview, lesson player, editor, feedback, tables tab and AI tutor | Browser |
| `learn.css` | Learn-only styles. Everything else reuses `synth.html`'s components and color tokens, including dark mode. | Browser |
| `tests/` | `npm test` (unit and curriculum tests) and `npm run test:e2e` (browser test) | Node |

The four `learn-*.js` data and logic modules use a small UMD wrapper. In the browser each is a global (`window.LearnGrader` and so on), and in Node it's a CommonJS module, so the tests run the exact code the page runs. `learn.js` follows the rest of the app's style: top-level script code that uses the shared globals from `state.js`, `chat.js` and `grid.js`.

## How grading works

When a lesson opens, `learn.js` builds a fresh in-memory sql.js database with only that lesson's tables, then runs the lesson's `solution` once to get the expected result. Check Answer runs the learner's SQL against the same database (`LearnGrader.grade`) and compares the two results:

1. **Safety.** Queries are read-only. `INSERT`, `UPDATE`, `DROP`, `PRAGMA` and the like are refused before they run, and every query runs inside a savepoint that's always rolled back. The data is identical for every attempt.
2. **Errors.** SQLite errors become friendly messages, such as "Unknown column `nme`. Did you mean `name`?", "`WHERE` has to come before `ORDER BY`", or "Aggregates can't go in `WHERE`; use `HAVING`". Each one shows a collapsible box with SQLite's exact message.
3. **Columns.** The column count must match. Columns are matched by name where the names agree, and by position otherwise. Column order and aliases only matter when the lesson sets `columnOrderMatters` or `checkColumnNames`.
4. **Rows.** Rows are compared as a multiset: same rows, same number of times, in any order. Numbers compare with a 1e-6 relative tolerance, and numeric text compares equal to numbers. A mismatch is diagnosed specifically: no rows, rows missing (all correct), extra rows (with a `DISTINCT` hint when it's duplicates), different count, a value that's right but rounded wrong, integer division, a wrong column (with an example row), or values paired into the wrong rows (a bad join or `GROUP BY`).
5. **Order.** Order only matters when the reference solution's outer query has an `ORDER BY`. An `ORDER BY` inside `OVER (…)` or a subquery doesn't count. `orderKeys` makes the check tie-tolerant: only the sequence of those columns is compared, so rows that tie may come back in any order.
6. **Route.** Once the result is right, `requireFrom` (on by default) rejects typed-in constants. `mustUse` and `mustNotUse` regexes, tested against the query with strings and comments blanked out, make sure a lesson about `IN` or `LEFT JOIN` is answered with it. A wrong result is always reported as wrong first.
7. **Tips.** Some common mistakes add a tip whatever else went wrong: `= NULL`, `LIKE` without a wildcard, `NOT IN (SELECT …)` with NULLs, `COUNT(DISTINCT *)`, an aggregate with no `GROUP BY` that collapsed the table into one row, and more than one statement in the editor.

## Hints, solution and the AI tutor

- Each lesson has three hints, from a gentle nudge to nearly the answer.
- The solution unlocks after 2 attempts or after all three hints (`LEARN_SOLUTION_AFTER_ATTEMPTS`). Viewing it is recorded, and a lesson only counts as "solved first try" with no hints and no solution.
- The **AI Tutor** tab is locked for each lesson until the learner has pressed Check Answer at least once. It also needs a signed-in account, like the main AI assistant. It uses the same `/api/chat` endpoint, model and rate limits as `chat.js`. Its system prompt includes the lesson, the schema of that lesson's tables, the learner's latest query and the grader's verdict, plus the reference solution with instructions not to reveal it. The tutor may only give the full answer after 2 attempts and an explicit request. Conversations are kept per lesson for the visit, and the last 10 messages are sent.
- "Use Query" on a tutor code block fills the lesson editor (`data-query-target="learn-query-input"`), not the main workspace's editor.

## Progress

Progress is saved per lesson in localStorage under `synth_learn_progress_v1`: status, attempts, hints used, whether the solution was viewed, first-try, completion time and the editor draft. Learn works signed out and offline.

For signed-in users it also syncs to one row of `public.learn_progress`. Pushes are debounced after meaningful events (attempts, hints, solution views), not after every keystroke. The local and cloud copies are merged per lesson, keeping the furthest status, the earliest completion and the newest draft, so progress from two devices combines and is never overwritten. If the table doesn't exist yet, sync turns itself off for the visit and the overview says progress is saved in this browser. Nothing else changes.

The session lives in a size-limited shared cookie (`storage-cookie.js`), so progress is deliberately kept out of Supabase `user_metadata`.

## Usage numbers

Learn sends anonymous events through `analytics.js` to `usage_events`: `learn_open`, `learn_attempt` (Check Answer), `learn_lesson_done` and `learn_course_done` (with the lesson or course id in `detail`), and `learn_tutor`. Each is sent at most once per visitor per day (per lesson for completions). The Sunday email (`api/cron/weekly-marketing-report.js`, numbers in `api/_learnReport.js`) turns these and `learn_progress` into a Learn section. The events need `supabase/migrations/20261005000000_learn_usage_events.sql`; until it runs they're dropped and the email says so.

## Datasets

| Group | Tables | Notes |
|---|---|---|
| Practice datasets | `nfl_team_stats` (160), `grocery_store_data` (140), `bank_statement` (124) | The same CSVs as the home page's sample datasets, loaded with real column types |
| Page Turner Books | `authors` (13), `books` (24), `customers` (20), `orders` (46), `order_items` (83), `formats` (4), `subscriptions` (25) | A small bookstore, built for joins |
| Page Turner company | `departments` (6), `employees` (18), `monthly_sales` (48) | Org chart (self joins, recursive CTEs) and a 12-month × 4-region sales grid (window functions) |

The bookstore data has deliberate edge cases, listed at the top of `learn-datasets.js`. Authors 9 and 13 have no books, book 24 has no author, books 15 and 20 were never ordered, five customers never ordered, two orders are guest checkouts, one employee has no department, one department has no employees, and salaries and prices include ties. `tests/learn-datasets.test.js` checks that each one exists.

## Adding or changing a lesson

1. Add an object to a level's `lessons` array in `learn-curriculum.js`, using an existing lesson as a template. Give it a unique `id`, `module`, `title`, `minutes`, `tables`, `concept` (HTML), `example: { sql, caption }`, `task` (HTML), `starter`, `solution`, three `hints`, and a `takeaway`.
2. Add grading options only when needed: `orderMatters`, `orderKeys`, `checkColumnNames`, `columnOrderMatters`, `mustUse` / `mustNotUse` (`{ pattern, message }`), or `requireFrom: false`.
3. Run `npm test`. Every lesson is checked automatically:
   - the solution grades as correct, including with every table's rows stored in reverse, which catches answers that depend on unbroken ties in `ORDER BY` or `LIMIT` without `ORDER BY`
   - the starter and the example are not already correct
   - the example runs
   - the required fields are present
4. Add a line or two to `WRONG_ANSWERS` in `tests/learn-curriculum.test.js` for the mistakes you expect learners to make, along with the feedback code each should get.

Changing a row in `learn-datasets.js` changes the expected answer of every lesson that reads that table. `npm test` will show which lessons that affects.

## Tests

```bash
npm install
npm test           # grader, curriculum (all 60 lessons), datasets, progress
npm run test:e2e   # browser test of the whole page (needs Playwright + Chromium)
```

The browser test serves the repo with a tiny static server and runs offline. sql.js comes from `node_modules`, Supabase is replaced by a fake signed-in client, and `/api/chat` returns a canned reply. It covers the overview, a wrong then right attempt, hints and the solution lock, the tutor lock and its prompt, cloud sync writes, the main workspace working alongside Learn (tabs, Cmd/Ctrl+Enter, Back/Forward), and the phone layout. `.github/workflows/test.yml` runs `npm test` on every pull request.
