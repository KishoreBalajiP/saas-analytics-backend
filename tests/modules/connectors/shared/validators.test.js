/**
 * Tests for `modules/connectors/shared/validators.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validateFieldMapping } from '../../../../src/modules/connectors/shared/validators.js';

test('validateConfig accepts a valid csv config', () => {
  const { valid, errors } = validateConfig('csv', { delimiter: ';', hasHeader: true });
  assert.equal(valid, true);
  assert.equal(errors.length, 0);
});

test('validateConfig rejects a bad csv delimiter', () => {
  const { valid, errors } = validateConfig('csv', { delimiter: '::' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.field === 'config.delimiter'));
});

test('validateConfig accepts a valid webhook config', () => {
  const { valid } = validateConfig('webhook', { signingSecret: 'super-secret-12345678', toleranceSeconds: 120, requireTimestamp: true });
  assert.equal(valid, true);
});

test('validateConfig rejects a webhook config without a signingSecret', () => {
  const { valid, errors } = validateConfig('webhook', {});
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.field === 'config.signingSecret'));
});

test('validateConfig rejects a short signingSecret', () => {
  const { valid } = validateConfig('webhook', { signingSecret: 'short' });
  assert.equal(valid, false);
});

test('validateConfig rejects unknown types', () => {
  const { valid, errors } = validateConfig('postgres', {});
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.field === 'type'));
});

test('validateConfig rejects a non-object config', () => {
  const { valid } = validateConfig('csv', 'nope');
  assert.equal(valid, false);
});

test('validateFieldMapping accepts object and array forms', () => {
  assert.equal(validateFieldMapping({ customerId: 'cust_id', amount: { source: 'total', type: 'number' } }).valid, true);
  assert.equal(validateFieldMapping([{ source: 'cust_id', target: 'customerId' }]).valid, true);
});

test('validateFieldMapping accepts null / undefined / empty mapping', () => {
  assert.equal(validateFieldMapping(undefined).valid, true);
  assert.equal(validateFieldMapping(null).valid, true);
});

test('validateFieldMapping rejects malformed mappings', () => {
  assert.equal(validateFieldMapping('x').valid, false);
  assert.equal(validateFieldMapping([{ target: '' }]).valid, false);
  assert.equal(validateFieldMapping([{ target: 'a', type: 'bogus' }]).valid, false);
  assert.equal(validateFieldMapping({ a: 123 }).valid, false);
});
