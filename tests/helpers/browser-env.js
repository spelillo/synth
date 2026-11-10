// Runs Synth's plain browser scripts (no modules, shared globals) inside a
// jsdom window so their functions can be unit-tested from Node.
//
//   const env = loadBrowserScripts(['state.js', 'csv-parser.js', 'json-parser.js']);
//   env.get('slugifyTableName')('My File.csv');   // any top-level binding
//   env.set('currentUser', { id: 'u1' });          // reassign a top-level let
//
// Scripts run in the same order synth.html loads them; top-level `let` and
// `const` bindings are shared between them exactly as in the page. jsdom
// fires DOMContentLoaded before these run, so the page's init handlers
// (which need sql.js, Supabase, etc.) are registered but never called.
//
// `stubs` defines globals that a script calls but that live in a file this
// test doesn't load (e.g. advanceLoadProgress from app.js).
//
// `before(window)` runs after the window exists and before any script, for
// things a stub can't set (e.g. navigator.sendBeacon).
//
// `transform(file, source)` can rewrite a script before it runs. Used once:
// to flip checkout.js's ALL_TIERS_UNLOCKED switch so the dormant tier
// gating can be tested.

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function loadBrowserScripts(files, { html = '<!doctype html><html><head></head><body></body></html>', url = 'https://synth-sql.com/', stubs = {}, transform, before } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  // Scripts must run as classic *scripts* in the window's context (not via
  // window.eval) so their top-level let/const land in the shared global
  // lexical scope, as they do with <script> tags.
  const ctx = dom.getInternalVMContext();
  const run = code => new vm.Script(code).runInContext(ctx);
  for (const [k, v] of Object.entries(stubs)) w[k] = v;
  if (before) before(w);
  const readyHandlers = [];
  for (const target of [w, w.document]) {
    const orig = target.addEventListener.bind(target);
    target.addEventListener = (type, fn, opts) => {
      if (type === 'DOMContentLoaded' || type === 'load') { readyHandlers.push(fn); return; }
      orig(type, fn, opts);
    };
  }
  for (const file of files) {
    let src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (transform) src = transform(file, src);
    new vm.Script(src, { filename: path.join(ROOT, file) }).runInContext(ctx);
  }
  let setCounter = 0;
  return {
    window: w,
    document: w.document,
    readyHandlers,
    get: expr => run(expr),
    set(name, value) {
      const key = `__set_${++setCounter}`;
      w[key] = value;
      run(`${name} = window.${key}; delete window.${key};`);
    },
    close: () => w.close(),
  };
}

module.exports = { ROOT, loadBrowserScripts };
