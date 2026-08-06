/**
 * Tenant (Sprint 1 - implemented).
 *
 * PURPOSE
 *   The unit of multi-tenancy, billing and data scoping. Every business
 *   record carries a `tenantId`; every request resolves a `tenantId`
 *   via `tenantIsolation.middleware.js`.
 *
 * NOTES
 *   - A Tenant does NOT carry a `tenantId` field: it IS the tenancy unit,
 *     so the `tenantScope` plugin is intentionally not applied.
 *   - `slug` is immutable once set (use `name` for rename).
 *   - Soft-delete only (30-day retention + GDPR purge window); the
 *     `softDelete` plugin provides `softDelete()` / `restore()`.
 *   - Suspending a tenant MUST cascade to all user sessions via queue
 *     (enforced in the service layer, Sprint 2).
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit (module `iam.tenants`).
 *
 * INDEXES
 *   - unique(slug)
 *   - { status: 1, createdAt: -1 }
 *   - { planId: 1 }
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Tenant';
export const TENANT_STATUSES = Object.freeze(['trial', 'active', 'suspended', 'churned']);

const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, immutable: true, trim: true, lowercase: true },
    logoUrl: { type: String, default: null },
    planId: { type: String, default: null },
    status: { type: String, enum: [...TENANT_STATUSES], default: 'trial', index: true },
    billingEmail: { type: String, default: null, lowercase: true, trim: true },
    country: { type: String, default: null, minlength: 2, maxlength: 2 },
    defaultLocale: { type: String, default: 'en' },
    defaultTimezone: { type: String, default: 'UTC' },
    defaultCurrency: { type: String, default: 'USD' },
    trialEndsAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

tenantSchema.index({ status: 1, createdAt: -1 });
tenantSchema.index({ planId: 1 });

tenantSchema.plugin(softDelete);
tenantSchema.plugin(paginate);
tenantSchema.plugin(optimisticConcurrency);
tenantSchema.plugin(audit, { module: 'iam.tenants' });

export const TenantSchema = tenantSchema;
export const Tenant = mongoose.model(MODEL_NAME, tenantSchema);
export default Tenant;
