/**
 * Tenant (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   The unit of multi-tenancy, billing and data scoping. Every business
 *   record carries a `tenantId`; every request resolves a `tenantId`
 *   via `tenantIsolation.middleware.js`.
 *
 * PLANNED FIELDS
 *   _id, name, slug (unique, immutable), logoUrl?,
 *   planId (ref: master_data.subscription_plans),
 *   status: 'trial' | 'active' | 'suspended' | 'churned',
 *   billingEmail?, country (ISO-3166 alpha-2), defaultLocale,
 *   defaultTimezone, defaultCurrency,
 *   trialEndsAt?, suspendedAt?, suspendedReason?,
 *   createdAt, updatedAt, createdBy, updatedBy
 *
 * PLANNED INDEXES
 *   - unique(slug)
 *   - { status: 1, createdAt: -1 }
 *   - { planId: 1 }
 *
 * CASCADE RULES
 *   - Suspending a tenant MUST cascade to all user sessions via queue.
 *   - Soft delete only (30-day retention + GDPR purge window).
 */

export const MODEL_NAME = 'Tenant';
export const TENANT_STATUSES = Object.freeze([
  'trial', 'active', 'suspended', 'churned',
]);

export default Object.freeze({
  name: MODEL_NAME,
  statuses: TENANT_STATUSES,
  slugImmutable: true,
  schemaImplemented: false,
  seeAlso: [
    'src/modules/iam/tenants/README.md',
    'src/routes/tenant.routes.js',
  ],
});
