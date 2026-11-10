// Unit tests for analytics.js: anonymous, deduplicated event beacons.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBrowserScripts } = require('../../helpers/browser-env');

function env(url = 'https://synth-sql.com/learn?ref=Reddit') {
  const beacons = [];
  const e = loadBrowserScripts(['analytics.js'], {
    url,
    before: (w) => {
      Object.defineProperty(w.navigator, 'sendBeacon', { value: (u, blob) => { beacons.push({ u, blob }); return true; } });
      w.Blob = class { constructor(parts) { this.text = parts.join(''); } };
    },
  });
  e.beacons = () => beacons.map(b => ({ url: b.u, ...JSON.parse(b.blob.text) }));
  return e;
}

test('sends one "visit" with a stable visitor id, the ?ref tag and the path', () => {
  const e = env();
  const [v] = e.beacons();
  assert.equal(v.url, '/api/track');
  assert.equal(v.event, 'visit');
  assert.match(v.visitor_id, /^[A-Za-z0-9-]{8,64}$/, 'matches the server-side validator');
  assert.equal(v.ref, 'Reddit');
  assert.equal(v.path, '/learn');
});

test('the same event is sent at most once per day', () => {
  const e = env();
  e.window.synthTrack('query_run');
  e.window.synthTrack('query_run');
  assert.equal(e.beacons().filter(b => b.event === 'query_run').length, 1);
});

test('events with different details are deduped separately', () => {
  const e = env();
  e.window.synthTrack('learn_lesson_done', 'b01');
  e.window.synthTrack('learn_lesson_done', 'b02');
  e.window.synthTrack('learn_lesson_done', 'b01');
  assert.deepEqual(e.beacons().filter(b => b.event === 'learn_lesson_done').map(b => b.detail), ['b01', 'b02']);
});

test('never sends query text or data, only the whitelisted fields', () => {
  const e = env();
  e.window.synthTrack('query_run');
  for (const b of e.beacons()) assert.deepEqual(Object.keys(b).sort(), ['detail', 'event', 'path', 'ref', 'referrer', 'url', 'visitor_id']);
});

test('falls back to fetch(keepalive) when sendBeacon is unavailable', () => {
  const sent = [];
  loadBrowserScripts(['analytics.js'], {
    url: 'https://synth-sql.com/',
    before: (w) => {
      Object.defineProperty(w.navigator, 'sendBeacon', { value: undefined });
      w.fetch = (url, init) => { sent.push({ url, init }); return Promise.resolve(); };
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/track');
  assert.equal(sent[0].init.keepalive, true);
  assert.equal(JSON.parse(sent[0].init.body).event, 'visit');
});

test('a blocked localStorage (private mode) does not break tracking', () => {
  const beacons = [];
  loadBrowserScripts(['analytics.js'], {
    before: (w) => {
      Object.defineProperty(w, 'localStorage', { get() { throw new Error('SecurityError'); } });
      Object.defineProperty(w.navigator, 'sendBeacon', { value: () => { beacons.push(1); return true; } });
      w.Blob = class { constructor(p) { this.text = p.join(''); } };
    },
  });
  assert.equal(beacons.length, 1);
});
