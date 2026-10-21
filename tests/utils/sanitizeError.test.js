/**
 * sanitizeError: job/sync run records never store credentials, stack traces
 * or unbounded driver output (roadmap 1.4).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeError, redactSecrets } from '../../src/utils/sanitizeError.js';

test('keeps a well-formed code and the first line of the message', () => {
  const err = new Error('Sync failed: bad header\n    at parse (file.js:1:1)');
  err.code = 'PAYLOAD_INVALID';
  assert.deepEqual(sanitizeError(err), { code: 'PAYLOAD_INVALID', message: 'Sync failed: bad header' });
});

test('falls back to a default code for numeric or odd codes', () => {
  const err = new Error('x');
  err.code = 11000;
  assert.equal(sanitizeError(err).code, 'JOB_FAILED');
  assert.equal(sanitizeError(err, { fallbackCode: 'SYNC_FAILED' }).code, 'SYNC_FAILED');
  const lower = new Error('y');
  lower.code = 'econnrefused';
  assert.equal(sanitizeError(lower).code, 'JOB_FAILED');
});

test('masks credentials in URIs, key=value secrets and bearer tokens', () => {
  const message = redactSecrets('mongodb+srv://admin:s3cr3t@cluster0.example.net/db password=hunter2 token: abc.def Bearer eyJhbGciOi.xyz');
  assert.doesNotMatch(message, /s3cr3t|hunter2|abc\.def|eyJhbGciOi/);
  assert.match(message, /mongodb\+srv:\/\/\*\*\*@cluster0/);
});

test('caps the message length and handles non-Error values', () => {
  assert.equal(sanitizeError(new Error('a'.repeat(5000))).message.length, 500);
  assert.deepEqual(sanitizeError('plain string'), { code: 'JOB_FAILED', message: 'plain string' });
  assert.equal(sanitizeError(null), null);
});
