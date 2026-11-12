// Launch analytics, off until the visitor says yes. Two layers:
//  1. Vercel Web Analytics (page views and referrers), enabled in the
//     Vercel dashboard under Analytics. The script 404s harmlessly until then.
//  2. A tiny first-party counter (api/track.js -> usage_events) for the
//     numbers Vercel's free tier can't give us: who ran a query, who came
//     back, which channel they came from, and how far people get in Learn.
//     Only an event name (plus a Learn lesson or course id), a random
//     visitor id, the landing ?ref= tag, the referring site's hostname and
//     the page path are sent. Never queries, file names, or data.
//
// Consent: nothing above loads, nothing is stored and nothing is sent until
// the visitor presses "Allow" on the banner this file shows. "Don't allow"
// is just as easy, and a browser sending Global Privacy Control counts as
// "Don't allow" without asking. The choice itself is kept in localStorage
// (synth_consent) so the banner doesn't come back on every page; that's
// the only thing stored before a choice. window.synthPrivacyChoices()
// reopens the banner (the privacy policy page links to it).
(function () {
  var CONSENT_KEY = 'synth_consent';
  var CONSENT_VERSION = '1';

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  var local = store('localStorage');

  function get(key) { try { return local && local.getItem(key); } catch (e) { return null; } }
  function set(key, value) { try { local && local.setItem(key, value); } catch (e) {} }
  function remove(key) { try { local && local.removeItem(key); } catch (e) {} }

  // Read before anything else so the first-touch channel isn't lost if the
  // visitor only says yes a few pages later in the same tab.
  var params = new URLSearchParams(location.search);
  var landingRef = (params.get('ref') || params.get('utm_source') || '').slice(0, 40);

  // Which site linked here (google.com, reddit.com, ...), host only.
  var referrerHost = '';
  try {
    var r = document.referrer && new URL(document.referrer).hostname;
    if (r && r !== location.hostname) referrerHost = r.replace(/^www\./, '').slice(0, 100);
  } catch (e) {}

  function consent() {
    var saved = get(CONSENT_KEY);
    if (saved === 'granted:' + CONSENT_VERSION) return 'granted';
    if (saved === 'denied:' + CONSENT_VERSION) return 'denied';
    if (navigator.globalPrivacyControl === true) return 'denied';
    return null;
  }

  var visitorId = null;
  var started = false;

  function today() { return new Date().toISOString().slice(0, 10); }

  // Each event is sent at most once per visitor per day: enough to count
  // daily users and returns without logging every click. An optional
  // detail (a Learn lesson or course id, never user input) is deduped
  // separately, so finishing two lessons in a day sends two events.
  // Does nothing at all without consent.
  window.synthTrack = function (event, detail) {
    if (!started) return;
    var dayKey = 'synth_ev_' + event + (detail ? ':' + detail : '');
    if (get(dayKey) === today()) return;
    set(dayKey, today());
    var body = JSON.stringify({
      event: event,
      visitor_id: visitorId,
      ref: get('synth_ref') || landingRef || null,
      referrer: referrerHost || null,
      path: location.pathname.slice(0, 100),
      detail: detail || null
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
      }
    } catch (e) {}
  };

  function start() {
    if (started) return;
    started = true;

    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    var s = document.createElement('script');
    s.defer = true;
    s.src = '/_vercel/insights/script.js';
    document.head.appendChild(s);

    visitorId = get('synth_vid');
    if (!visitorId) {
      visitorId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      set('synth_vid', visitorId);
    }
    // First-touch channel: the ?ref= (or utm_source) a visitor first arrived
    // with sticks to them, so a later return visit still credits that channel.
    if (landingRef && !get('synth_ref')) set('synth_ref', landingRef);

    window.synthTrack('visit');
  }

  // Forget everything the counter stored, for a "Don't allow" after an
  // earlier "Allow". Vercel's script can't be unloaded mid-page, so it
  // stops on the next page load.
  function clearStored() {
    var doomed = [];
    try {
      for (var i = 0; local && i < local.length; i++) {
        var k = local.key(i);
        if (k === 'synth_vid' || k === 'synth_ref' || (k && k.indexOf('synth_ev_') === 0)) doomed.push(k);
      }
    } catch (e) {}
    doomed.forEach(remove);
    started = false;
    visitorId = null;
  }

  function choose(value) {
    set(CONSENT_KEY, value + ':' + CONSENT_VERSION);
    hideBanner();
    if (value === 'granted') start();
    else clearStored();
  }

  var banner = null;
  var lastFocus = null;

  function injectStyles() {
    if (document.getElementById('synth-consent-style')) return;
    var css = ''
      + '.synth-consent{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:400px;'
      + 'box-sizing:border-box;background:#fff;color:#1f1d1a;border:1px solid #d6d3cc;border-radius:12px;'
      + 'box-shadow:0 8px 28px rgba(0,0,0,.14);padding:16px 18px;font:14px/1.5 Inter,-apple-system,"Segoe UI",sans-serif}'
      + '.synth-consent h2{font-size:15px;font-weight:700;margin:0 0 6px;color:#1f1d1a}'
      + '.synth-consent p{margin:0 0 12px;color:#3d3a35}'
      + '.synth-consent a{color:#1f1d1a;text-decoration:underline}'
      + '.synth-consent-actions{display:flex;gap:8px}'
      + '.synth-consent button{flex:1;font:inherit;font-weight:600;padding:9px 12px;border-radius:8px;cursor:pointer;'
      + 'background:#fff;color:#1f1d1a;border:1.5px solid #1f1d1a}'
      + '.synth-consent button:hover{background:#f3f1ec}'
      + '.synth-consent button:focus-visible,.synth-consent a:focus-visible{outline:3px solid #2f6fdb;outline-offset:2px}'
      + '@media (max-width:480px){.synth-consent{left:8px;right:8px;bottom:8px;max-width:none}}';
    var style = document.createElement('style');
    style.id = 'synth-consent-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function showBanner() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showBanner);
      return;
    }
    injectStyles();
    if (!banner) {
      banner = document.createElement('section');
      banner.className = 'synth-consent';
      banner.setAttribute('role', 'region');
      banner.setAttribute('aria-labelledby', 'synth-consent-title');
      banner.innerHTML = ''
        + '<h2 id="synth-consent-title">Anonymous usage stats</h2>'
        + '<p>Can we count visits and actions like running a query, using a random ID stored in your browser? '
        + 'It never includes your data, queries or file names, and Synth works the same either way. '
        + '<a href="/privacy#usage-stats">Privacy Policy</a></p>'
        + '<div class="synth-consent-actions">'
        + '<button type="button" data-choice="denied">Don’t allow</button>'
        + '<button type="button" data-choice="granted">Allow</button>'
        + '</div>';
      banner.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('button[data-choice]');
        if (btn) choose(btn.getAttribute('data-choice'));
      });
      banner.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') hideBanner();
      });
    }
    if (!banner.parentNode) document.body.appendChild(banner);
  }

  function hideBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  // Reopens the banner so a visitor can change their mind. Focuses its
  // first button, since it was opened on purpose.
  window.synthPrivacyChoices = function () {
    lastFocus = document.activeElement;
    showBanner();
    var first = banner && banner.querySelector('button');
    if (first) first.focus();
  };

  var current = consent();
  if (current === 'granted') start();
  else if (current === null) showBanner();
})();
