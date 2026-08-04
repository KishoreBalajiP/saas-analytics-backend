/**
 * Setting Service (architecture placeholder).
 *
 * PURPOSE
 *   Business logic for hot-reloadable, typed, scoped settings. Resolves
 *   effective value (tenant overrides platform) with caching.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - list(scope), get(key, scope), create, update, remove
 *   - resolveEffective(key, { tenantId })    # for hot-path reads
 *
 * CODING GUIDELINES
 *   - `isSecret` settings NEVER leave the service in plaintext for
 *     non-admin callers; service returns redacted values.
 *   - Cache key: `settings:<scope>:<tenantId|platform>:<key>` (TTL 60s).
 *   - Writes invalidate the cache for that key.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const list = notImplementedStub('setting.service', 'list');
export const get = notImplementedStub('setting.service', 'get');
export const create = notImplementedStub('setting.service', 'create');
export const update = notImplementedStub('setting.service', 'update');
export const remove = notImplementedStub('setting.service', 'remove');
export const resolveEffective = notImplementedStub('setting.service', 'resolveEffective');

export default {
  list, get, create, update, remove, resolveEffective,
  _meta: { cachedReads: true, cacheKeyPattern: 'settings:<scope>:<tenantId|platform>:<key>' },
};
