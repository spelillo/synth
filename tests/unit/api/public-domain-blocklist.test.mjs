// Unit tests for api/_publicDomainBlocklist.js: keeps gmail.com & co. from
// being claimed as an Enterprise org domain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicEmailDomain, extractDomain } from '../../../api/_publicDomainBlocklist.js';

test('isPublicEmailDomain: flags common consumer providers', () => {
  for (const d of ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'aol.com']) {
    assert.equal(isPublicEmailDomain(d), true, d);
  }
});

test('isPublicEmailDomain: is case-insensitive', () => {
  assert.equal(isPublicEmailDomain('GMail.COM'), true);
});

test('isPublicEmailDomain: allows school and company domains', () => {
  for (const d of ['stanford.edu', 'acme.co.uk', 'synth-sql.com']) assert.equal(isPublicEmailDomain(d), false, d);
});

test('isPublicEmailDomain: a subdomain of a public provider is not on the list (exact match only)', () => {
  assert.equal(isPublicEmailDomain('mail.gmail.com'), false);
});

test('isPublicEmailDomain: non-string input is coerced, not thrown on', () => {
  assert.equal(isPublicEmailDomain(undefined), false);
  assert.equal(isPublicEmailDomain(null), false);
  assert.equal(isPublicEmailDomain(42), false);
});

test('extractDomain: returns the lower-cased domain', () => {
  assert.equal(extractDomain('Ada@Stanford.EDU'), 'stanford.edu');
});

test('extractDomain: trims surrounding whitespace', () => {
  assert.equal(extractDomain('  ada@acme.com \n'), 'acme.com');
});

test('extractDomain: rejects strings that are not a single email', () => {
  for (const bad of ['', 'no-at-sign', '@acme.com', 'ada@', 'a@b@c.com', 'ada @acme.com', 'ada@ac me.com']) {
    assert.equal(extractDomain(bad), null, JSON.stringify(bad));
  }
});

test('extractDomain: null/undefined are invalid, not "not public"', () => {
  assert.equal(extractDomain(null), null);
  assert.equal(extractDomain(undefined), null);
});
