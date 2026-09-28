// bi-link.js — pick a reachable URL for Synth BI.
//
// Some orgs block newly registered domains, which takes out
// bi.synth-sql.com even when they can still reach synth-sql itself through
// its Vercel URL. So on page load we probe bi.synth-sql.com by loading its
// favicon as an image (a network-level block page isn't a PNG, so it fails
// the same way a DNS or firewall block does). If that doesn't load within a
// few seconds, every link to bi.synth-sql.com is sent to synth-bi.vercel.app
// instead. A click that lands before the probe finishes opens the tab right
// away (so popup blockers don't eat it) and points it at whichever host wins.
(function () {
  const PRIMARY = 'https://bi.synth-sql.com';
  const FALLBACK = 'https://synth-bi.vercel.app';
  const TIMEOUT_MS = 4000;
  const CACHE_KEY = 'synthBiHost';

  let chosen = null;
  try { chosen = sessionStorage.getItem(CACHE_KEY); } catch (e) {}
  if (chosen !== PRIMARY && chosen !== FALLBACK) chosen = null;

  // Started after the load event: an image request that hangs on a blocked
  // network would otherwise hold up synth-sql's own load event.
  const probe = chosen ? Promise.resolve(chosen) : new Promise((resolve) => {
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    function start() {
      const img = new Image();
      const timer = setTimeout(() => done(FALLBACK), TIMEOUT_MS);
      function done(host) {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(host);
      }
      img.onload = () => done(PRIMARY);
      img.onerror = () => done(FALLBACK);
      img.src = `${PRIMARY}/favicon.png?probe=${Date.now()}`;
    }
  });

  probe.then((host) => {
    chosen = host;
    try { sessionStorage.setItem(CACHE_KEY, host); } catch (e) {}
    if (host === FALLBACK) {
      document.querySelectorAll(`a[href^="${PRIMARY}"]`).forEach((a) => {
        a.href = toHost(a.href, host);
      });
    }
  });

  function toHost(url, host) {
    return url.startsWith(PRIMARY) ? host + url.slice(PRIMARY.length) : url;
  }

  // Build a Synth BI URL on whichever host is known to work (primary until
  // the probe says otherwise). path should start with "/" or be empty.
  window.synthBiUrl = function (path) {
    return (chosen || PRIMARY) + (path || '');
  };

  document.addEventListener('click', (event) => {
    const a = event.target.closest && event.target.closest(`a[href^="${PRIMARY}"], a[href^="${FALLBACK}"]`);
    if (!a) return;
    if (chosen) {
      a.href = toHost(a.href, chosen);
      return;
    }
    // Probe still running. Leave modified clicks (new tab/window) alone.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const url = a.href;
    const win = window.open('', '_blank');
    if (!win) { window.location.href = url; return; }
    try {
      win.opener = null;
      win.document.title = 'Opening Synth BI…';
      win.document.body.style.cssText = 'font-family:system-ui,sans-serif;background:#0b0b0b;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0';
      win.document.body.textContent = 'Opening Synth BI…';
    } catch (e) {}
    probe.then((host) => { win.location.replace(toHost(url, host)); });
  });
})();
