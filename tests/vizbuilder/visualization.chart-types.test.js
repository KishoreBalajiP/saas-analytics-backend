/**
 * Doughnut and scatter widget types: validated like pie (one measure) and
 * as a two-measure scatter respectively.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVisualization } from '../../src/services/visualizationSpec.js';
import { WIDGET_TYPES } from '../../src/models/Widget.js';
import { widgetCreateSchema } from '../../src/validators/dashboard.validator.js';

const one = { groupBy: ['region'], metrics: [{ field: 'amount', op: 'sum' }] };
const two = { groupBy: ['region'], metrics: [{ field: 'amount', op: 'sum' }, { field: 'qty', op: 'sum' }] };

const codeOf = (fn) => {
  try { fn(); } catch (e) { return e.details?.code ?? e.code ?? e.message; }
  return null;
};

test('doughnut and scatter are allowed widget types', () => {
  assert.ok(WIDGET_TYPES.includes('doughnut'));
  assert.ok(WIDGET_TYPES.includes('scatter'));
  assert.ok(widgetCreateSchema.body.type.oneOf.includes('doughnut'));
  assert.ok(widgetCreateSchema.body.type.oneOf.includes('scatter'));
});

test('doughnut follows the pie one-measure rule', () => {
  assert.deepEqual(validateVisualization({ type: 'doughnut', query: one, visualization: { limit: 5 } }), { limit: 5 });
  assert.notEqual(codeOf(() => validateVisualization({ type: 'doughnut', query: two })), null);
});

test('scatter needs a groupBy and two measures', () => {
  assert.deepEqual(validateVisualization({ type: 'scatter', query: two }), {});
  assert.notEqual(codeOf(() => validateVisualization({ type: 'scatter', query: one })), null);
  assert.notEqual(codeOf(() => validateVisualization({ type: 'scatter', query: { metrics: two.metrics } })), null);
  assert.notEqual(codeOf(() => validateVisualization({ type: 'scatter', query: two, visualization: { limit: 3 } })), null);
});
