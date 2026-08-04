/**
 * Dashboard (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Tenant-scoped, versioned, shareable interactive view of analytics.
 *   Every save creates a new version; published versions are immutable.
 *
 * PLANNED FIELDS
 *   _id, tenantId, ownerId,
 *   name, description?,
 *   layout: { columns: number, items: Array<LayoutItem> },
 *   queries: Array<{
 *     id, chart, source,                    // chart id + connector ref
 *     config: json,
 *   }>,
 *   version: number,                        // optimistic concurrency
 *   status: 'draft' | 'published' | 'archived',
 *   sharedWith: Array<{
 *     principalType: 'user' | 'role' | 'tenant',
 *     principalId, permission: 'view' | 'edit',
 *   }>,
 *   lastViewedAt, viewCount,
 *   createdAt, updatedAt, createdBy, updatedBy
 *
 * PLANNED INDEXES
 *   - { tenantId: 1, status: 1 }
 *   - { tenantId: 1, ownerId: 1 }
 *
 * VERSIONING
 *   - Append-only; never mutate a published version.
 */

export const MODEL_NAME = 'Dashboard';
export const STATUSES = Object.freeze(['draft', 'published', 'archived']);

export default Object.freeze({
  name: MODEL_NAME,
  statuses: STATUSES,
  appendOnlyVersions: true,
  schemaImplemented: false,
  seeAlso: ['src/modules/analytics/dashboards/README.md'],
});
