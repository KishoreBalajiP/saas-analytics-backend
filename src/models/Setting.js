/**
 * Setting (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Hot-reloadable, typed, scoped configuration. Two scopes:
 *   `platform` (one source of truth) and `tenant` (per-tenant override).
 *
 * PLANNED FIELDS
 *   _key: string,                           // e.g. 'analytics.cache.ttl'
 *   scope: 'platform' | 'tenant',
 *   tenantId?: string,                      // present iff scope='tenant'
 *   type: 'string' | 'number' | 'boolean' | 'json' | 'duration',
 *   value: any,                             // typed to match `type`
 *   description?, isSecret: boolean, isReadonly: boolean,
 *   version: number,                        // optimistic concurrency
 *   updatedBy, updatedAt
 *
 * PLANNED INDEXES
 *   - unique(scope, tenantId, _key)
 *
 * SCOPE / TENANT OVERRIDE
 *   - Tenant override wins over platform.
 *   - When `scope === 'platform'`, `tenantId` MUST be null.
 */

export const MODEL_NAME = 'Setting';
export const SCOPES = Object.freeze(['platform', 'tenant']);
export const TYPES = Object.freeze([
  'string', 'number', 'boolean', 'json', 'duration',
]);

export default Object.freeze({
  name: MODEL_NAME,
  scopes: SCOPES,
  types: TYPES,
  optimisticConcurrency: true,
  schemaImplemented: false,
  seeAlso: ['src/modules/platform/settings/README.md'],
});
