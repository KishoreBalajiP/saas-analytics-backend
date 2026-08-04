/**
 * Setting Repository (architecture placeholder).
 *
 * PURPOSE
 *   Stable data-access surface for hot-reloadable settings.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - list(scope), findByKey(scope, key, tenantId?)
 *   - create(doc), update(key, scope, patch, { ifMatch }), softDelete
 *   - resolveEffective(key, { tenantId }) -> value  (handles platform vs
 *     tenant override + inheritance; hot-path)
 *
 * CODING GUIDELINES
 *   - `value` typed via `type: 'string'|'number'|'boolean'|'json'|
 *     'duration'` - repository coerces on read.
 *   - Optimistic concurrency via version column.
 *   - `isSecret` rows are NEVER auto-resolved by the hot path; they
 *     require an explicit privileged fetch.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const list = notImplementedStub('setting.repository', 'list');
export const findByKey = notImplementedStub('setting.repository', 'findByKey');
export const create = notImplementedStub('setting.repository', 'create');
export const update = notImplementedStub('setting.repository', 'update');
export const softDelete = notImplementedStub('setting.repository', 'softDelete');
export const resolveEffective = notImplementedStub('setting.repository', 'resolveEffective');

export default {
  list, findByKey, create, update, softDelete, resolveEffective,
  _meta: { hotPath: ['resolveEffective'] },
};
