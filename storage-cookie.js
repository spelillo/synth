// storage-cookie.js — cookie-backed storage for the Supabase auth client,
// scoped to .synth-sql.com so a signed-in session survives across
// synth-sql.com and bi.synth-sql.com (Supabase's default storage is
// localStorage, which can't cross an origin boundary the way a cookie can).
// Off that domain — localhost, preview deploys — there's no shared parent
// domain to scope a cookie to, so it falls back to a plain per-origin
// cookie, same as today's localStorage behavior.
//
// Chunks the value across numbered cookies (key, key.0, key.1, ...) when it
// doesn't fit in one, the same approach Supabase's own @supabase/ssr package
// uses — a session's access + refresh token routinely exceeds the ~4KB
// single-cookie limit. Keep this file identical between the synth-sql and
// synth-bi repos; both apps read and write the same cookies.
window.sharedAuthStorage = (function () {
  const CHUNK_SIZE = 3600;
  const SHARED_DOMAIN = '.synth-sql.com';
  const isSharedHost = /(^|\.)synth-sql\.com$/.test(location.hostname);

  function cookieMap() {
    const out = {};
    document.cookie.split('; ').forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf('=');
      if (i === -1) return;
      out[pair.slice(0, i)] = pair.slice(i + 1);
    });
    return out;
  }

  function writeCookie(name, value, maxAgeSeconds) {
    let cookie = `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; Secure`;
    if (isSharedHost) cookie += `; Domain=${SHARED_DOMAIN}`;
    document.cookie = cookie;
  }

  function clearCookie(name) {
    writeCookie(name, '', 0);
  }

  return {
    getItem(key) {
      const cookies = cookieMap();
      if (cookies[key] !== undefined) return Promise.resolve(decodeURIComponent(cookies[key]));
      if (cookies[`${key}.0`] === undefined) return Promise.resolve(null);
      let value = '';
      for (let i = 0; cookies[`${key}.${i}`] !== undefined; i++) {
        value += decodeURIComponent(cookies[`${key}.${i}`]);
      }
      return Promise.resolve(value);
    },
    setItem(key, value) {
      const encoded = encodeURIComponent(value);
      const maxAge = 60 * 60 * 24 * 100; // 100 days; renewed on every token refresh anyway
      // Drop whatever was there before (a plain cookie, old chunks, or
      // both) against a snapshot taken before any writes, so this doesn't
      // re-read document.cookie mid-loop.
      const existing = cookieMap();
      clearCookie(key);
      for (let i = 0; existing[`${key}.${i}`] !== undefined; i++) clearCookie(`${key}.${i}`);
      if (encoded.length <= CHUNK_SIZE) {
        writeCookie(key, encoded, maxAge);
        return Promise.resolve();
      }
      const chunks = Math.ceil(encoded.length / CHUNK_SIZE);
      for (let i = 0; i < chunks; i++) {
        writeCookie(`${key}.${i}`, encoded.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), maxAge);
      }
      return Promise.resolve();
    },
    removeItem(key) {
      clearCookie(key);
      for (let i = 0; cookieMap()[`${key}.${i}`] !== undefined; i++) clearCookie(`${key}.${i}`);
      return Promise.resolve();
    },
  };
})();
