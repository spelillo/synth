// Unit tests for api/_mailer.js: never throws, reports why mail wasn't sent.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installApiMocks, resetAll, importFresh, mailState } from '../../helpers/api-harness.mjs';

installApiMocks(mock);

let sendMail;
beforeEach(async () => {
  resetAll();
  ({ sendMail } = await importFresh('api/_mailer.js'));
});

const msg = { to: 'admin@acme.edu', subject: 'Hello', text: 'plain', html: '<p>html</p>' };

test('sends through Gmail SMTP with the configured account as From', async () => {
  assert.deepEqual(await sendMail(msg), { sent: true });
  assert.equal(mailState.transports[0].service, 'gmail');
  assert.deepEqual(mailState.transports[0].auth, { user: 'synth-test@example.com', pass: 'app-password-test' });
  assert.deepEqual(mailState.sent[0], { from: 'synth-test@example.com', ...msg });
});

test('returns sent:false with a reason when credentials are missing', async () => {
  resetAll({ GMAIL_APP_PASSWORD: undefined });
  ({ sendMail } = await importFresh('api/_mailer.js'));
  const r = await sendMail(msg);
  assert.equal(r.sent, false);
  assert.match(r.reason, /not configured/);
  assert.equal(mailState.sent.length, 0);
});

test('an SMTP failure is returned, not thrown', async () => {
  mailState.failNextWith = 'Invalid login: 535';
  assert.deepEqual(await sendMail(msg), { sent: false, reason: 'Invalid login: 535' });
});

test('reuses one transport across sends', async () => {
  await sendMail(msg);
  await sendMail(msg);
  assert.equal(mailState.transports.length, 1);
  assert.equal(mailState.sent.length, 2);
});
