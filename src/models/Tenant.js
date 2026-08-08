/**
 * Tenant (Sprint 1 - implemented, Sprint 3 - extended).
 *
 * PURPOSE
 *   The unit of multi-tenancy, billing and data scoping. Every business
 *   record carries a `tenantId`; every request resolves a `tenantId`
 *   via `tenantIsolation.middleware.js`.
 *
 * LIFECYCLE (Sprint 3)
 *   A tenant is created in `pending` and flips to `active` only after the
 *   onboarding sequence (owner + default roles/permissions/settings/flags)
 *   completes. From `active` it can be `suspended` (temporary, reversible),
 *   `disabled` (longer-term block, reversible) or `archived` (terminal,
 *   read-only). Only `active` tenants may authenticate.
 *
 * NOTES
 *   - A Tenant does NOT carry a `tenantId` field: it IS the tenancy unit,
 *     so the `tenantScope` plugin is intentionally not applied.
 *   - `slug` is immutable once set (use `name` for rename).
 *   - Soft-delete only (30-day retention + GDPR purge window); the
 *     `softDelete` plugin provides `softDelete()` / `restore()`.
 *   - Suspending a tenant MUST cascade to all user sessions (enforced in
 *     `services/tenantLifecycle.service.js`, Sprint 3).
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit (module `iam.tenants`).
 *
 * INDEXES
 *   - unique(slug)
 *   - { status: 1, createdAt: -1 }
 *   - { planId: 1 }
 *   - { ownerId: 1 }
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Tenant';

/** Canonical tenant lifecycle statuses (Sprint 3). */
export const TENANT_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'disabled', 'archived']);

/** Onboarding state machine for the Sprint 3 initialisation sequence. */
export const ONBOARDING_STATUSES = Object.freeze(['not_started', 'initializing', 'ready', 'failed']);

const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, immutable: true, trim: true, lowercase: true },
    logoUrl: { type: String, default: null },
    planId: { type: String, default: null },
    status: { type: String, enum: [...TENANT_STATUSES], default: 'pending', index: true },
    billingEmail: { type: String, default: null, lowercase: true, trim: true },
    country: { type: String, default: null, minlength: 2, maxlength: 2 },
    defaultLocale: { type: String, default: 'en' },
    defaultTimezone: { type: String, default: 'UTC' },
    defaultCurrency: { type: String, default: 'USD' },
    trialEndsAt: { type: Date, default: null },
    // Ownership + onboarding (Sprint 3)
    ownerId: { type: String, default: null, index: true },
    onboardingStatus: { type: String, enum: [...ONBOARDING_STATUSES], default: 'not_started', index: true },
    // Lifecycle timestamps
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: null },
    disabledAt: { type: Date, default: null },
    disabledReason: { type: String, default: null },
    archivedAt: { type: Date, default: null },
    archivedReason: { type: String, default: null },
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
