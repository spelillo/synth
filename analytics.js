// Launch analytics. Two layers, both cookie-free:
//  1. Vercel Web Analytics (page views and referrers), enabled in the
//     Vercel dashboard under Analytics. The script 404s harmlessly until then.
//  2. A tiny first-party counter (api/track.js -> usage_events) for the
//     numbers Vercel's free tier can't give us: who ran a query, who came
//     back, and which channel they came from. Only an event name, a random
//     visitor id, the landing ?ref= tag and the page path are sent. Never
//     queries, file names, or data.
(function () {
  window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
  var s = document.createElement('script');
  s.defer = true;
  s.src = '/_vercel/insights/script.js';
  document.head.appendChild(s);

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  var local = store('localStorage');

  function get(key) { try { return local && local.getItem(key); } catch (e) { return null; } }
  function set(key, value) { try { local && local.setItem(key, value); } catch (e) {} }

  var visitorId = get('synth_vid');
  if (!visitorId) {
    visitorId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    set('synth_vid', visitorId);
  }

  // First-touch channel: the ?ref= (or utm_source) a visitor first arrived
  // with sticks to them, so a later return visit still credits that channel.
  var params = new URLSearchParams(location.search);
  var landingRef = (params.get('ref') || params.get('utm_source') || '').slice(0, 40);
  if (landingRef && !get('synth_ref')) set('synth_ref', landingRef);

  function today() { return new Date().toISOString().slice(0, 10); }

  // Each event is sent at most once per visitor per day: enough to count
  // daily users and returns without logging every click.
  window.synthTrack = function (event) {
    var dayKey = 'synth_ev_' + event;
    if (get(dayKey) === today()) return;
    set(dayKey, today());
    var body = JSON.stringify({
      event: event,
      visitor_id: visitorId,
      ref: get('synth_ref') || landingRef || null,
      path: location.pathname.slice(0, 100)
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
      }
    } catch (e) {}
  };

  window.synthTrack('visit');
})();
