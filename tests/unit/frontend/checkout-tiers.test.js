// Unit tests for checkout.js's tier gating. Production currently ships with
// ALL_TIERS_UNLOCKED = true; the gating logic is still tested (with the
// switch flipped off) so it works the day it's turned back on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadBrowserScripts, ROOT } = require('../../helpers/browser-env');

function env({ unlocked = false } = {}) {
  const e = loadBrowserScripts(['state.js', 'checkout.js'], {
    html: '<body><div id="signin-required-modal" hidden></div><div id="premium-signin-modal" hidden></div><div id="premium-modal" hidden></div></body>',
    transform: (file, src) => (file === 'checkout.js' && !unlocked ? src.replace('const ALL_TIERS_UNLOCKED = true;', 'const ALL_TIERS_UNLOCKED = false;') : src),
  });
  e.checkoutStarts = 0;
  e.set('startPremiumCheckout', () => { e.checkoutStarts++; });
  const shown = id => !e.document.getElementById(id).hidden;
  Object.defineProperty(e, 'calls', { get: () => ({ signin: shown('signin-required-modal') ? 1 : 0, premium: shown('premium-modal') || shown('premium-signin-modal') ? 1 : 0 }) });
  e.run = code => e.get(code);
  return e;
}

test('production switch: every account currently clears every gate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'checkout.js'), 'utf8');
  assert.match(src, /const ALL_TIERS_UNLOCKED = true;/, 'if this flips, the gated tests below become the live behaviour');
  const e = env({ unlocked: true });
  assert.equal(e.get('getUserTier')(), 'premium');
  assert.equal(e.get('canUseFeature')('largeCsv'), true);
});

test('signed out -> lite: no save, no multi-CSV', () => {
  const e = env();
  assert.equal(e.get('getUserTier')(), 'lite');
  assert.equal(e.get('canUseFeature')('saveQuery'), false);
  assert.equal(e.get('canUseFeature')('multiCsv'), false);
});

test('signed in, not premium -> normal: can save, cannot use premium features', () => {
  const e = env();
  e.set('currentUser', { id: 'u1' });
  e.run('isPremium = false');
  assert.equal(e.get('getUserTier')(), 'normal');
  assert.equal(e.get('canUseFeature')('saveQuery'), true);
  assert.equal(e.get('canUseFeature')('largeCsv'), false);
});

test('premium -> everything', () => {
  const e = env();
  e.set('currentUser', { id: 'u1' });
  e.run('isPremium = true');
  for (const f of ['saveQuery', 'dashboard', 'multiCsv', 'tableRename', 'crossTableAI', 'largeCsv', 'relationshipDetection']) {
    assert.equal(e.get('canUseFeature')(f), true, f);
  }
});

test('requireFeature: lite user hitting a normal feature gets the sign-in prompt', () => {
  const e = env();
  assert.equal(e.get('requireFeature')('saveQuery'), false);
  assert.equal(e.calls.signin, 1);
  assert.equal(e.calls.premium, 0);
});

test('requireFeature: normal user hitting a premium feature gets the upgrade panel', () => {
  const e = env();
  e.set('currentUser', { id: 'u1' });
  e.run('isPremium = false');
  assert.equal(e.get('requireFeature')('multiCsv'), false);
  assert.equal(e.calls.premium, 1);
  assert.equal(e.checkoutStarts, 1, 'the embedded Stripe form starts loading');
});

test('requireFeature: allowed features return true with no prompt', () => {
  const e = env();
  e.set('currentUser', { id: 'u1' });
  e.run('isPremium = true');
  assert.equal(e.get('requireFeature')('largeCsv'), true);
  assert.deepEqual({ ...e.calls }, { signin: 0, premium: 0 });
});

test('the publishable key is a publishable key, never a secret key', () => {
  const src = fs.readFileSync(path.join(ROOT, 'checkout.js'), 'utf8');
  assert.doesNotMatch(src, /sk_(live|test)_/);
});
