/**
 * Persistent auth cooldowns (auth.15, adminauth): the verification resend
 * cooldown lives in MongoDB (AuthCooldown), so it holds across service
 * instances and restarts instead of in the process-local cache.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from '../helpers/mongo.js';
import { factories } from '../helpers/factories.js';
import authCooldownService from '../../src/services/authCooldown.service.js';
import emailVerificationService from '../../src/services/emailVerification.service.js';
import emailService from '../../src/services/email.service.js';
import cacheService from '../../src/services/cache.service.js';
import { AuthCooldown } from '../../src/models/AuthCooldown.js';

let sink = [];

before(async () => {
  await startMongo();
});

beforeEach(async () => {
  await resetMongo();
  sink = [];
  emailService.captureInto(sink);
});

after(async () => {
  emailService.stopCapture();
  await stopMongo();
});

test('acquire: exactly one of several concurrent callers wins', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => authCooldownService.acquire('k:concurrent', 60_000)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.ok((await authCooldownService.remainingMs('k:concurrent')) > 0);
});

test('acquire: an ended cooldown is taken over even before the TTL monitor purges it', async () => {
  assert.equal(await authCooldownService.acquire('k:expiry', 60_000), true);
  assert.equal(await authCooldownService.acquire('k:expiry', 60_000), false);
  await AuthCooldown.updateOne({ key: 'k:expiry' }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  assert.equal(await authCooldownService.acquire('k:expiry', 60_000), true);
  assert.equal(await AuthCooldown.countDocuments({ key: 'k:expiry' }), 1);
});

test('acquire: a zero cooldown always allows; a missing key is a programming error', async () => {
  assert.equal(await authCooldownService.acquire('k:zero', 0), true);
  assert.equal(await authCooldownService.acquire('k:zero', 0), true);
  await assert.rejects(authCooldownService.acquire('', 1000));
});

test('the verification resend cooldown survives a cleared process cache (another instance)', async () => {
  const tenant = await factories.tenant.create({ status: 'pending' });
  const user = await factories.user.create({ tenantId: String(tenant._id), status: 'unverified' });
  const first = await emailVerificationService.resend({ tenantIdentifier: tenant.slug, email: user.email });
  assert.equal(first.ok, true);
  assert.equal(sink.length, 1, 'a fresh link was sent');
  assert.match(sink[0].text, /expires in 1 day/, 'the email states the configured 24 h lifetime');

  await cacheService.flushAll();
  await assert.rejects(
    emailVerificationService.resend({ tenantIdentifier: tenant.slug, email: user.email }),
    (err) => err.statusCode === 429,
  );
  assert.equal(sink.length, 1);
  assert.equal(await AuthCooldown.countDocuments({}), 1);
  const [row] = await AuthCooldown.find({}).lean();
  assert.ok(!row.key.includes(user.email), 'the key never carries the raw email');
});
