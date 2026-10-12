import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../../src/config/env.js', import.meta.url).href;
const base = {
  NODE_ENV: 'production',
  JWT_SECRET: 'production-jwt-secret-with-more-than-32-characters',
  ENCRYPTION_KEY: 'production-encryption-key-with-more-than-32-characters',
  MONGODB_URI: 'mongodb+srv://example.invalid/analytics',
  REDIS_URL: 'redis://example.invalid:6379',
  STORAGE_PROVIDER: 's3',
  S3_BUCKET: 'analivo-production',
  CLIENT_URL: 'https://app.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  SOCKET_CORS_ORIGIN: 'https://app.example.com',
  MAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  MAIL_PASSWORD: 'not-a-real-password',
  COOKIE_SECURE: 'true',
};

function load(overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(moduleUrl)})`], {
    env: { ...process.env, ...base, ...overrides },
    encoding: 'utf8',
  });
}

test('production configuration loads only when durable dependencies are configured', () => {
  const result = load();
  assert.equal(result.status, 0, result.stderr);
});

test('production configuration rejects ephemeral or insecure fallbacks', () => {
  const result = load({ REDIS_URL: '', STORAGE_PROVIDER: 'local' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REDIS_URL|STORAGE_PROVIDER/);
});

test('production configuration allows Razorpay to stay disabled (paywall off is valid)', () => {
  // With Razorpay disabled, no Razorpay vars are required.
  const result = load({ RAZORPAY_ENABLED: 'false' });
  assert.equal(result.status, 0, result.stderr);
});

test('production configuration rejects Razorpay enabled without credentials', () => {
  const result = load({
    RAZORPAY_ENABLED: 'true',
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET: '',
    RAZORPAY_ENVIRONMENT: 'test',
    RAZORPAY_PLAN_MAPPING_JSON: '',
  });
  assert.notEqual(result.status, 0);
  const stderr = result.stderr;
  assert.match(stderr, /RAZORPAY_KEY_ID/);
  assert.match(stderr, /RAZORPAY_KEY_SECRET/);
  assert.match(stderr, /RAZORPAY_WEBHOOK_SECRET/);
  assert.match(stderr, /RAZORPAY_PLAN_MAPPING_JSON/);
});

test('production configuration accepts Razorpay enabled with full credentials', () => {
  const result = load({
    RAZORPAY_ENABLED: 'true',
    RAZORPAY_KEY_ID: 'rzp_test_abcdefghijklmn',
    RAZORPAY_KEY_SECRET: 'test-secret-not-real',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret-not-real',
    RAZORPAY_ENVIRONMENT: 'test',
    RAZORPAY_PLAN_MAPPING_JSON:
      '{"starter":{"amountMinor":49900,"currency":"INR","interval":"one-time"},"pro":{"amountMinor":99900,"currency":"INR","interval":"one-time"}}',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('production configuration rejects Razorpay with invalid environment value', () => {
  const result = load({
    RAZORPAY_ENABLED: 'true',
    RAZORPAY_KEY_ID: 'rzp_test_abcdefghijklmn',
    RAZORPAY_KEY_SECRET: 'test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook',
    RAZORPAY_ENVIRONMENT: 'staging',
    RAZORPAY_PLAN_MAPPING_JSON: '{"pro":{"amountMinor":99900,"currency":"INR","interval":"one-time"}}',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RAZORPAY_ENVIRONMENT/);
});
