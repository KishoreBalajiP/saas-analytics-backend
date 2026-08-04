/**
 * Tests for `utils/id.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { uuid, ulid, withPrefix, shortToken, PREFIXES } from '../../src/utils/id.js';

test('uuid returns a v4 UUID', () => {
  const id = uuid();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('ulid returns a 26-char ULID', () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ulids are monotonic and sortable', () => {
  const a = ulid();
  const b = ulid();
  assert.ok(b > a);
});

test('withPrefix wraps an existing id', () => {
  assert.equal(withPrefix('usr', '01HABC'), 'usr_01HABC');
});

test('withPrefix generates a new id when none provided', () => {
  const id = withPrefix('t');
  assert.match(id, /^t_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('withPrefix rejects empty prefix or id', () => {
  assert.throws(() => withPrefix(''), /non-empty prefix/);
  assert.throws(() => withPrefix('p', ''), /non-empty id/);
});

test('shortToken returns a URL-safe random string', () => {
  const t = shortToken(16);
  assert.equal(t.length, 16);
  assert.match(t, /^[A-Za-z0-9]+$/);
});

test('shortToken enforces length bounds', () => {
  assert.throws(() => shortToken(7), /integer between 8 and 128/);
  assert.throws(() => shortToken(129), /integer between 8 and 128/);
});

test('PREFIXES is frozen and exposes canonical keys', () => {
  assert.equal(PREFIXES.USER, 'usr');
  assert.equal(PREFIXES.TENANT, 't');
  assert.throws(() => { PREFIXES.USER = 'x'; }, /Cannot assign/);
});
