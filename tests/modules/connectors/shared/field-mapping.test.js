/**
 * Tests for `modules/connectors/shared/field-mapping.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeValue,
  normalizeMapping,
  mapRecord,
  applyFieldMapping,
  deriveSourceRowId,
} from '../../../../src/modules/connectors/shared/field-mapping.js';

test('normalizeValue coerces types and applies transforms', () => {
  assert.equal(normalizeValue(' 12.5 ', { type: 'number', transform: 'round0' }), 13);
  assert.equal(normalizeValue('yes', { type: 'boolean' }), true);
  assert.equal(normalizeValue('2024-01-15T10:00:00Z', { type: 'date' }), '2024-01-15T10:00:00.000Z');
  assert.equal(normalizeValue('  AbC ', { type: 'string', transform: 'lower' }), 'abc');
});

test('normalizeValue returns null for un-coercible values', () => {
  assert.equal(normalizeValue('abc', { type: 'number' }), null);
  assert.equal(normalizeValue(undefined, { type: 'string' }), null);
});

test('normalizeMapping converts object form into array form', () => {
  const rules = normalizeMapping({ customerId: 'cust_id', amount: { source: 'total', type: 'number' } });
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], { source: 'cust_id', target: 'customerId' });
});

test('mapRecord maps simple object mapping', () => {
  const { data } = mapRecord({ cust_id: 'C1', total: 9.99 }, { customerId: 'cust_id', amount: 'total' });
  // Simple object form has no `type`, so values default to strings.
  assert.deepEqual(data, { customerId: 'C1', amount: '9.99' });
});

test('mapRecord coerces types via the declarative array form', () => {
  const { data } = mapRecord(
    { cust_id: 'C1', total: '9.99' },
    [
      { source: 'cust_id', target: 'customerId' },
      { source: 'total', target: 'amount', type: 'number' },
    ],
  );
  assert.deepEqual(data, { customerId: 'C1', amount: 9.99 });
});

test('mapRecord with no mapping passes the record through unchanged', () => {
  const { data, skipped } = mapRecord({ a: 1, b: 2 }, null);
  assert.deepEqual(data, { a: 1, b: 2 });
  assert.equal(skipped.length, 0);
});

test('mapRecord reports required-field errors', () => {
  const { errors } = mapRecord({ other: 1 }, [{ source: 'id', target: 'id', required: true }]);
  assert.ok(errors.some((e) => e.field === 'id'));
});

test('applyFieldMapping attaches a stable sourceRowId per record', () => {
  const mapped = applyFieldMapping([{ id: 'x', v: 1 }, { id: 'x', v: 2 }], { idField: 'id' });
  assert.equal(mapped[0].sourceRowId, mapped[1].sourceRowId);
  assert.equal(mapped[0].sourceRowId, 'id:x');
});

test('deriveSourceRowId hashes records without an idField', () => {
  const a = deriveSourceRowId({ a: 1, b: 2 }, null);
  const b = deriveSourceRowId({ b: 2, a: 1 }, null);
  assert.equal(a, b); // key order must not matter
});
