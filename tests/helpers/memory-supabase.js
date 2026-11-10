// An in-memory stand-in for Supabase (Postgres via PostgREST, Auth, and
// Storage), used by every test tier:
//
//  - unit and integration tests: `mock.module('@supabase/supabase-js')`
//    returns `createClient(() => backend)` so the API handlers talk to
//    `backend` directly;
//  - the browser E2E suite: the page's supabase-js is replaced with this
//    same file, and its client sends every query to the test server
//    (`/__supabase`), which runs it on the one Node-side `backend`. The UI,
//    the API routes and the Stripe webhook therefore all read and write the
//    same "database", the way they share one Postgres in production.
//
// It implements only the slice of the supabase-js surface Synth uses
// (grep for `sb.from(`, `supabaseAdmin.from(`), with Postgres-like
// behaviour where it matters for correctness: unique constraints, upsert
// on conflict, `.single()` / `.maybeSingle()` cardinality errors, embedded
// selects for the two relations the app reads, ON DELETE CASCADE for
// organizations, and `count: 'exact', head: true`.
//
// Error injection: `backend.failNext(table, action, message)` makes the
// next matching operation return `{ error: { message } }`, so handlers'
// error branches can be exercised.

(function (root) {
  'use strict';

  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  let idCounter = 0;
  function newId(prefix) {
    idCounter += 1;
    const rand = Math.random().toString(16).slice(2, 10);
    return `${prefix || 'id'}-${idCounter.toString(16).padStart(4, '0')}-${rand}`;
  }

  // Unique constraints per table (each entry is a column set). The first one
  // is the primary key, which upsert uses when no onConflict is given.
  const UNIQUE = {
    profiles: [['id']],
    organizations: [['id'], ['domain'], ['stripe_subscription_id']],
    org_members: [['id'], ['user_id']],
    org_join_links: [['id'], ['token']],
    org_enabled_templates: [['id'], ['org_id', 'template_id']],
    workroom_members: [['id'], ['workroom_id', 'user_id']],
    learn_progress: [['user_id']],
  };

  // Embedded selects the app uses: `parent.select('..., child(cols)')`.
  const RELATIONS = {
    'workspaces.datasets': { many: true, local: 'id', foreign: 'workspace_id' },
    'workspaces.chat_sessions': { many: true, local: 'id', foreign: 'workspace_id' },
    'org_enabled_templates.dataset_library_templates': { many: false, local: 'template_id', foreign: 'id' },
  };

  // ON DELETE CASCADE from organizations (supabase/migrations/*organizations.sql).
  const CASCADE = {
    organizations: [['org_members', 'org_id'], ['org_join_links', 'org_id'], ['org_enabled_templates', 'org_id'], ['workrooms', 'org_id']],
    workrooms: [['workroom_members', 'workroom_id']],
    workspaces: [['datasets', 'workspace_id'], ['workspace_relationships', 'workspace_id'], ['chat_sessions', 'workspace_id']],
    chat_sessions: [['chat_messages', 'session_id']],
  };

  // Row-level security for requests made with the browser's anon key
  // (the E2E transport): a row is visible/writable only to the user whose id
  // is in the owner column, mirroring the "user_id = auth.uid()" policies in
  // supabase/schema.sql. The service-role client (API routes) bypasses it,
  // as in production. This is a model of the policies, not the policies
  // themselves: tests/real-services/rls.test.mjs checks the real ones.
  const RLS_OWNER = {
    workspaces: 'user_id', datasets: 'user_id', chat_sessions: 'user_id',
    profiles: 'id', learn_progress: 'user_id', ai_usage_events: 'user_id',
  };
  const RLS_STORAGE = { csvs: true };

  // Columns that get a default when an insert leaves them out.
  const DEFAULTS = {
    organizations: () => ({ ai_enabled: true, cancel_at_period_end: false, notice_3mo_sent_at: null, notice_1mo_sent_at: null, notice_1wk_sent_at: null }),
    profiles: () => ({ is_premium: false }),
    pending_organizations: () => ({ status: 'pending' }),
    org_members: () => ({ joined_at: new Date().toISOString() }),
  };

  // ---------- filtering ----------

  function matches(row, f) {
    const v = row[f.col];
    switch (f.op) {
      case 'eq': return v === f.val;
      case 'neq': return v !== f.val;
      case 'gt': return v != null && v > f.val;
      case 'gte': return v != null && v >= f.val;
      case 'lt': return v != null && v < f.val;
      case 'lte': return v != null && v <= f.val;
      case 'in': return Array.isArray(f.val) && f.val.includes(v);
      case 'is': return f.val === null ? v == null : v === f.val;
      case 'not': return !matches(row, { op: f.inner, col: f.col, val: f.val });
      default: throw new Error(`memory-supabase: unsupported filter ${f.op}`);
    }
  }

  // "a, b, child(x, y)" -> { cols: ['a','b'], embeds: [{ name:'child', cols:['x','y'] }], star }
  function parseSelect(sel) {
    const out = { cols: [], embeds: [], star: false };
    if (!sel || sel.trim() === '*') { out.star = true; return out; }
    let depth = 0; let cur = '';
    const parts = [];
    for (const ch of sel) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    for (const raw of parts) {
      const p = raw.trim();
      const m = /^([a-z_]+)\((.*)\)$/i.exec(p);
      if (m) out.embeds.push({ name: m[1], cols: m[2].split(',').map(s => s.trim()) });
      else if (p === '*') out.star = true;
      else out.cols.push(p);
    }
    return out;
  }

  function project(row, cols) {
    if (!cols || cols.includes('*')) return clone(row);
    const out = {};
    for (const c of cols) out[c] = row[c] === undefined ? null : clone(row[c]);
    return out;
  }

  class MemoryBackend {
    constructor() { this.reset(); }

    reset() {
      this.tables = {};
      this.users = [];          // { id, email, password, confirmed, created_at }
      this.tokens = {};         // access_token -> user id
      this.otps = {};           // email -> code
      this.storage = {};        // bucket -> { path -> { body, contentType } }
      this.failures = [];
      this.log = [];            // every executed operation, for assertions
      this.mail = [];           // auth emails "sent" (confirm codes, resets)
      this.requireEmailConfirmation = true;
    }

    table(name) {
      if (!this.tables[name]) this.tables[name] = [];
      return this.tables[name];
    }

    seed(name, rows) {
      for (const r of rows) this.insertRow(name, r);
      return this;
    }

    rows(name) { return clone(this.table(name)); }

    failNext(table, action, message) {
      this.failures.push({ table, action, message: message || `${action} on ${table} failed (injected)` });
    }

    takeFailure(table, action) {
      const i = this.failures.findIndex(f => f.table === table && (f.action === action || f.action === '*'));
      if (i === -1) return null;
      return this.failures.splice(i, 1)[0];
    }

    insertRow(name, values) {
      const row = Object.assign({}, DEFAULTS[name] ? DEFAULTS[name]() : {}, clone(values));
      const pk = (UNIQUE[name] || [['id']])[0];
      if (pk.length === 1 && pk[0] === 'id' && row.id === undefined) row.id = newId(name);
      if (row.created_at === undefined) row.created_at = new Date().toISOString();
      const violated = this.uniqueViolation(name, row);
      if (violated) return { error: { code: '23505', message: `duplicate key value violates unique constraint "${name}_${violated.join('_')}_key"` } };
      this.table(name).push(row);
      return { row };
    }

    uniqueViolation(name, row, ignore) {
      for (const cols of UNIQUE[name] || []) {
        if (cols.some(c => row[c] == null)) continue;
        const clash = this.table(name).find(r => r !== ignore && cols.every(c => r[c] === row[c]));
        if (clash) return cols;
      }
      return null;
    }

    deleteCascade(name, row) {
      for (const [child, col] of CASCADE[name] || []) {
        const keep = []; const gone = [];
        for (const r of this.table(child)) (r[col] === row.id ? gone : keep).push(r);
        this.tables[child] = keep;
        gone.forEach(g => this.deleteCascade(child, g));
      }
    }

    embed(name, row, embeds) {
      const out = {};
      for (const e of embeds) {
        const rel = RELATIONS[`${name}.${e.name}`];
        if (!rel) throw new Error(`memory-supabase: no relation ${name}.${e.name}`);
        const related = this.table(e.name).filter(r => r[rel.foreign] === row[rel.local]).map(r => project(r, e.cols));
        out[e.name] = rel.many ? related : (related[0] || null);
      }
      return out;
    }

    // q: { table, action, values, options, filters, select, order, range, limit, single, maybeSingle, count, head }
    // ctx.rls: apply RLS_OWNER as ctx.userId (null = anonymous).
    execute(q, ctx) {
      this.log.push(clone(q));
      const fail = this.takeFailure(q.table, q.action);
      if (fail) return { data: null, error: { message: fail.message }, count: null };
      if (ctx && ctx.rls && RLS_OWNER[q.table]) {
        const owner = RLS_OWNER[q.table];
        if (q.action === 'insert' || q.action === 'upsert') {
          const list = Array.isArray(q.values) ? q.values : [q.values];
          if (!ctx.userId || list.some(v => v[owner] !== ctx.userId)) {
            return { data: null, error: { code: '42501', message: `new row violates row-level security policy for table "${q.table}"` }, count: null };
          }
        }
        q = Object.assign({}, q, { filters: (q.filters || []).concat([{ op: 'eq', col: owner, val: ctx.userId || '__nobody__' }]) });
      }

      const name = q.table;
      let affected = [];

      if (q.action === 'insert' || q.action === 'upsert') {
        const list = Array.isArray(q.values) ? q.values : [q.values];
        for (const values of list) {
          if (q.action === 'upsert') {
            const conflictCols = q.options && q.options.onConflict
              ? q.options.onConflict.split(',').map(s => s.trim())
              : (UNIQUE[name] || [['id']])[0];
            const existing = conflictCols.every(c => values[c] != null)
              && this.table(name).find(r => conflictCols.every(c => r[c] === values[c]));
            if (existing) {
              if (!(q.options && q.options.ignoreDuplicates)) Object.assign(existing, clone(values));
              affected.push(existing);
              continue;
            }
          }
          const { row, error } = this.insertRow(name, values);
          if (error) return { data: null, error, count: null };
          affected.push(row);
        }
      } else {
        let rows = this.table(name).filter(r => (q.filters || []).every(f => matches(r, f)));
        if (q.action === 'update') {
          for (const r of rows) {
            const next = Object.assign({}, r, clone(q.values));
            const violated = this.uniqueViolation(name, next, r);
            if (violated) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${name}_${violated.join('_')}_key"` }, count: null };
            Object.assign(r, clone(q.values));
          }
          affected = rows;
        } else if (q.action === 'delete') {
          this.tables[name] = this.table(name).filter(r => !rows.includes(r));
          rows.forEach(r => this.deleteCascade(name, r));
          affected = rows;
        } else {
          affected = rows;
        }
      }

      // Writes only return rows when chained with .select().
      if (q.action !== 'select' && q.select === undefined) {
        return { data: null, error: null, count: null };
      }

      let rows = affected.slice();
      for (const o of (q.order || []).slice().reverse()) {
        rows.sort((a, b) => {
          const x = a[o.col]; const y = b[o.col];
          if (x === y) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (x < y ? -1 : 1) * (o.ascending === false ? -1 : 1);
        });
      }
      const count = rows.length;
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      if (q.limit != null) rows = rows.slice(0, q.limit);

      const sel = parseSelect(q.select);
      let data = rows.map(r => Object.assign(sel.star ? clone(r) : project(r, sel.cols), this.embed(name, r, sel.embeds)));
      if (q.head) data = null;

      if (q.single || q.maybeSingle) {
        if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, count: null };
        if (data.length === 0) {
          return q.single
            ? { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, count: null }
            : { data: null, error: null, count: null };
        }
        data = data[0];
      }
      return { data, error: null, count: q.count ? count : null };
    }

    // ---------- auth ----------

    createUser({ email, password = 'password123', confirmed = true, id, created_at }) {
      const user = { id: id || newId('user'), email: email.toLowerCase(), password, confirmed, created_at: created_at || new Date().toISOString() };
      this.users.push(user);
      return user;
    }

    issueSession(user) {
      const access_token = `tok_${user.id}_${Math.random().toString(36).slice(2)}`;
      this.tokens[access_token] = user.id;
      return { access_token, refresh_token: `ref_${access_token}`, token_type: 'bearer', user: this.publicUser(user) };
    }

    // Lets tests build an Authorization header for a seeded user.
    tokenFor(userOrId) {
      const user = typeof userOrId === 'string' ? this.users.find(u => u.id === userOrId) : userOrId;
      return this.issueSession(user).access_token;
    }

    publicUser(u) { return u ? { id: u.id, email: u.email, created_at: u.created_at, email_confirmed_at: u.confirmed ? u.created_at : null } : null; }

    auth(op, args) {
      this.log.push({ auth: op, args: clone(args) });
      const fail = this.takeFailure('auth', op);
      if (fail) return { data: { user: null, session: null }, error: { message: fail.message } };
      const byEmail = e => this.users.find(u => u.email === String(e || '').toLowerCase());
      switch (op) {
        case 'signUp': {
          if (byEmail(args.email)) return { data: { user: null, session: null }, error: { message: 'User already registered' } };
          if (!args.password || args.password.length < 8) return { data: { user: null, session: null }, error: { message: 'Password should be at least 8 characters.' } };
          const user = this.createUser({ email: args.email, password: args.password, confirmed: !this.requireEmailConfirmation });
          if (!user.confirmed) {
            this.otps[user.email] = String(100000 + Math.floor(Math.random() * 899999));
            this.mail.push({ to: user.email, kind: 'confirm', code: this.otps[user.email] });
            return { data: { user: this.publicUser(user), session: null }, error: null };
          }
          return { data: { user: this.publicUser(user), session: this.issueSession(user) }, error: null };
        }
        case 'signInWithPassword': {
          const user = byEmail(args.email);
          if (!user || user.password !== args.password) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
          if (!user.confirmed) return { data: { user: null, session: null }, error: { message: 'Email not confirmed' } };
          return { data: { user: this.publicUser(user), session: this.issueSession(user) }, error: null };
        }
        case 'verifyOtp': {
          const user = byEmail(args.email);
          if (!user || this.otps[user.email] !== String(args.token)) return { data: { user: null, session: null }, error: { message: 'Token has expired or is invalid' } };
          delete this.otps[user.email];
          user.confirmed = true;
          return { data: { user: this.publicUser(user), session: this.issueSession(user) }, error: null };
        }
        case 'resend': {
          const user = byEmail(args.email);
          if (user && !user.confirmed) {
            this.otps[user.email] = String(100000 + Math.floor(Math.random() * 899999));
            this.mail.push({ to: user.email, kind: 'confirm', code: this.otps[user.email] });
          }
          return { data: {}, error: null };
        }
        case 'resetPasswordForEmail': {
          const user = byEmail(args.email);
          if (user) {
            this.otps[`reset:${user.email}`] = String(100000 + Math.floor(Math.random() * 899999));
            this.mail.push({ to: user.email, kind: 'reset', code: this.otps[`reset:${user.email}`] });
          }
          return { data: {}, error: null };
        }
        case 'updateUser': {
          const user = this.users.find(u => u.id === this.tokens[args.access_token]);
          if (!user) return { data: { user: null }, error: { message: 'Auth session missing!' } };
          if (args.attributes.password) user.password = args.attributes.password;
          return { data: { user: this.publicUser(user) }, error: null };
        }
        case 'getUser': {
          const user = this.users.find(u => u.id === this.tokens[args.token]);
          return user ? { data: { user: this.publicUser(user) }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } };
        }
        case 'signOut': {
          delete this.tokens[args.access_token];
          return { error: null };
        }
        case 'admin.getUserById': {
          const user = this.users.find(u => u.id === args.id);
          return user ? { data: { user: this.publicUser(user) }, error: null } : { data: { user: null }, error: { message: 'User not found' } };
        }
        case 'admin.listUsers': {
          const page = args.page || 1; const perPage = args.perPage || 50;
          const users = this.users.slice((page - 1) * perPage, page * perPage).map(u => this.publicUser(u));
          return { data: { users }, error: null };
        }
        default: throw new Error(`memory-supabase: unsupported auth op ${op}`);
      }
    }

    // ---------- storage ----------

    storageOp(op, bucket, args, ctx) {
      this.log.push({ storage: op, bucket, args: op === 'upload' ? { path: args.path } : clone(args) });
      const fail = this.takeFailure(`storage:${bucket}`, op);
      if (fail) return { data: null, error: { message: fail.message } };
      if (ctx && ctx.rls && RLS_STORAGE[bucket]) {
        const own = p => !!ctx.userId && String(p || '').startsWith(`${ctx.userId}/`);
        const paths = op === 'remove' ? args.paths : [op === 'list' ? `${args.prefix}/` : args.path];
        if (!paths.every(own)) return { data: op === 'list' ? [] : null, error: op === 'list' ? null : { message: 'new row violates row-level security policy' } };
      }
      const files = this.storage[bucket] || (this.storage[bucket] = {});
      switch (op) {
        case 'upload':
          if (files[args.path] && !(args.options && args.options.upsert)) return { data: null, error: { message: 'The resource already exists' } };
          files[args.path] = { body: args.body, contentType: (args.options && args.options.contentType) || 'application/octet-stream' };
          return { data: { path: args.path }, error: null };
        case 'download':
          return files[args.path] ? { data: files[args.path].body, error: null } : { data: null, error: { message: 'Object not found' } };
        case 'list': {
          const prefix = args.prefix ? args.prefix.replace(/\/$/, '') + '/' : '';
          const names = Object.keys(files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
          return { data: names.map(p => ({ name: p.slice(prefix.length) })), error: null };
        }
        case 'remove':
          for (const p of args.paths) delete files[p];
          return { data: args.paths.map(name => ({ name })), error: null };
        case 'createSignedUrl':
          if (!files[args.path]) return { data: null, error: { message: 'Object not found' } };
          return { data: { signedUrl: `/__storage/${bucket}/${args.path}?expires=${args.expiresIn}` }, error: null };
        default: throw new Error(`memory-supabase: unsupported storage op ${op}`);
      }
    }

    // One entry point for serialized requests. `opts.rls` marks a request
    // from the browser (anon key + the user's access token in msg.accessToken).
    handle(msg, opts) {
      const ctx = opts && opts.rls ? { rls: true, userId: this.tokens[msg.accessToken] || null } : null;
      if (msg.kind === 'query') return this.execute(msg.query, ctx);
      if (msg.kind === 'auth') return this.auth(msg.op, msg.args || {});
      if (msg.kind === 'storage') return this.storageOp(msg.op, msg.bucket, msg.args || {}, ctx);
      if (msg.kind === 'rpc') return { data: null, error: null };
      throw new Error(`memory-supabase: unknown message kind ${msg.kind}`);
    }
  }

  // ---------- client (supabase-js lookalike) ----------
  //
  // `transport(msg)` returns (a promise of) the backend's reply. Node tests
  // pass `msg => backend.handle(clone(msg))`; the browser posts to the test
  // server. Everything is JSON-cloned on the way through so a handler can't
  // accidentally mutate stored rows by reference.

  function createClient(transport, opts) {
    opts = opts || {};
    const send = msg => {
      const s = loadSession();
      const out = clone(msg);
      if (s && s.access_token) out.accessToken = s.access_token;
      return Promise.resolve(transport(out)).then(clone);
    };
    const sessionKey = opts.sessionKey || 'memory-supabase-session';
    const storage = opts.sessionStorage || null;
    let session = null;
    const listeners = [];

    function loadSession() {
      if (!storage) return session;
      try { const raw = storage.getItem(sessionKey); session = raw ? JSON.parse(raw) : null; } catch (e) { session = null; }
      return session;
    }
    function saveSession(s, event) {
      session = s;
      if (storage) {
        try { if (s) storage.setItem(sessionKey, JSON.stringify(s)); else storage.removeItem(sessionKey); } catch (e) { /* private mode */ }
      }
      listeners.forEach(cb => { try { cb(event, s); } catch (e) { /* listener error */ } });
    }

    function builder(table) {
      const q = { table, action: 'select', filters: [] };
      const b = {
        select(cols, o) {
          if (q.action === 'select') q.action = 'select';
          q.select = cols || '*';
          if (o && o.count) q.count = o.count;
          if (o && o.head) q.head = true;
          return b;
        },
        insert(values) { q.action = 'insert'; q.values = values; return b; },
        upsert(values, o) { q.action = 'upsert'; q.values = values; q.options = o || {}; return b; },
        update(values) { q.action = 'update'; q.values = values; return b; },
        delete() { q.action = 'delete'; return b; },
        order(col, o) { (q.order = q.order || []).push({ col, ascending: !(o && o.ascending === false) }); return b; },
        limit(n) { q.limit = n; return b; },
        range(a, z) { q.range = [a, z]; return b; },
        single() { q.single = true; return b; },
        maybeSingle() { q.maybeSingle = true; return b; },
        not(col, op, val) { q.filters.push({ op: 'not', inner: op, col, val }); return b; },
        then(ok, fail) { return send({ kind: 'query', query: q }).then(ok, fail); },
        catch(fail) { return b.then(undefined, fail); },
      };
      ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is'].forEach(op => {
        b[op] = (col, val) => { q.filters.push({ op, col, val }); return b; };
      });
      return b;
    }

    function sessionResult(r, event) {
      if (r && r.data && r.data.session) saveSession(r.data.session, event || 'SIGNED_IN');
      return r;
    }

    async function blobToText(body) {
      if (body && typeof body.text === 'function') return body.text();
      return typeof body === 'string' ? body : String(body);
    }

    const client = {
      // Test hook: what supabase-js does when the user lands from an emailed
      // link (e.g. PASSWORD_RECOVERY with the recovery session).
      __emitAuthEvent(event, s) { saveSession(s, event); },
      from: builder,
      rpc: (fn, args) => send({ kind: 'rpc', fn, args }),
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
      auth: {
        getSession: () => Promise.resolve({ data: { session: loadSession() }, error: null }),
        getUser: async (token) => send({ kind: 'auth', op: 'getUser', args: { token: token || (loadSession() || {}).access_token } }),
        onAuthStateChange(cb) {
          listeners.push(cb);
          return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } } } };
        },
        signUp: args => send({ kind: 'auth', op: 'signUp', args }).then(r => sessionResult(r)),
        signInWithPassword: args => send({ kind: 'auth', op: 'signInWithPassword', args }).then(r => sessionResult(r)),
        verifyOtp: args => send({ kind: 'auth', op: 'verifyOtp', args }).then(r => sessionResult(r)),
        resend: args => send({ kind: 'auth', op: 'resend', args }),
        resetPasswordForEmail: email => send({ kind: 'auth', op: 'resetPasswordForEmail', args: { email } }),
        updateUser: attributes => send({ kind: 'auth', op: 'updateUser', args: { attributes, access_token: (loadSession() || {}).access_token } })
          .then(r => { if (!r.error) saveSession(loadSession(), 'USER_UPDATED'); return r; }),
        signOut: async () => {
          const s = loadSession();
          const r = await send({ kind: 'auth', op: 'signOut', args: { access_token: s && s.access_token } });
          saveSession(null, 'SIGNED_OUT');
          return r;
        },
        admin: {
          getUserById: id => send({ kind: 'auth', op: 'admin.getUserById', args: { id } }),
          listUsers: o => send({ kind: 'auth', op: 'admin.listUsers', args: o || {} }),
        },
      },
      storage: {
        from(bucket) {
          const op = (name, args) => send({ kind: 'storage', op: name, bucket, args });
          return {
            upload: async (path, body, options) => op('upload', { path, body: await blobToText(body), options }),
            download: async path => {
              const r = await op('download', { path });
              if (r.data != null && typeof Blob !== 'undefined') r.data = new Blob([r.data], { type: 'text/csv' });
              return r;
            },
            list: prefix => op('list', { prefix }),
            remove: paths => op('remove', { paths }),
            createSignedUrl: (path, expiresIn) => op('createSignedUrl', { path, expiresIn }),
          };
        },
      },
    };
    return client;
  }

  const api = { MemoryBackend, createClient, parseSelect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MemorySupabase = api;
})(typeof window !== 'undefined' ? window : globalThis);
