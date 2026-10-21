/**
 * Module (Sprint 2 - implemented).
 *
 * PURPOSE
 *   A logical capability area in the platform (e.g. `iam`,
 *   `analytics`). Permissions and roles group under a module. Modules
 *   are registered at runtime via `/permissions/modules`.
 *
 * HIERARCHY
 *   `parentKey` enables a two-level tree: top-level modules (`iam`,
 *   `analytics`, ...) and dotted child modules (`iam.admins`,
 *   `iam.users`, `iam.roles`, ...). The dotted keys mirror the `module`
 *   strings the audit plugin emits (e.g. `iam.users`), so audit entries
 *   resolve directly to a registered module.
 *
 * DESIGN CONSTRAINTS
 *   - `key` is immutable once created; use `name` for display changes.
 *   - Soft-delete only; the compliance cron hard-deletes after retention.
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit (module `iam.modules`).
 *
 * INDEXES
 *   - unique partial(key) over live rows (`deletedAt: null`)
 *   - { parentKey: 1 }
 *   - { isSystem: 1 }
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Module';

/**
 * Top-level built-in module keys (the 21-module seed contract).
 *
 * `dashboards` was added in Sprint 6 so the dashboard permission keys the
 * default roles reference (`dashboards.view/create/update/delete`) are
 * actually registered during onboarding; without the module the permission
 * lookup in `tenantInitialization.ensurePermissions` silently skips them.
 *
 * `api_keys` and `embed` were added in Sprint 9 to register the permission
 * keys the API-key and embed surfaces reference (`api_keys.view/create/
 * update/delete`, `embed.view/create/delete`).
 */
export const BUILTIN_MODULES = Object.freeze([
  'iam', 'platform', 'governance',
  'analytics', 'connectors', 'tenants',
  'users', 'roles', 'settings',
  'feature_flags', 'master_data',
  'monitoring', 'notifications',
  'email_templates', 'audit_logs',
  'access_logs', 'compliance', 'support',
  'dashboards', 'reports', 'alerts',
  'api_keys', 'embed',
  // backups: workspace data export (roadmap 2.9).
  'data_exports',
  // ai-catalogue: metric definitions (metrics.view / manage / approve).
  'metrics',
  // rls: dataset grants + row-level security (tenant data_access.view/configure).
  'data_access',
  // mfa-tenant: workspace security policy (tenant key security.view/configure).
  'security',
]);

/**
 * IAM child modules. Seeded beneath `iam` so permission keys stay
 * readable (`iam.users.view`) while grouping under one top-level module.
 */
export const IAM_MODULES = Object.freeze([
  'iam.admins', 'iam.tenants', 'iam.users',
  'iam.roles', 'iam.permissions', 'iam.sessions',
  // Workspace billing self-service (subscription.routes.js).
  'iam.subscriptions', 'iam.entitlements',
  // roles: access-request review (roadmap 2.1): view + approve (approve/reject).
  'iam.access_requests',
]);

/**
 * Platform billing administration modules (admin-plan / admin-subscription /
 * admin-entitlement routes). Granted to platform bootstrap roles only.
 */
export const BILLING_MODULES = Object.freeze([
  'billing.plans', 'billing.subscriptions', 'billing.entitlements',
]);

// config: platform configuration child modules (roadmap 2.4). Secret
// platform/tenant settings have their own permission module so reading or
// writing a secret never rides on the plain `settings.*` keys.
export const CONFIG_MODULES = Object.freeze(['settings.secrets']);

// members: tenant-only workspace module (roadmap 2.10). Its permissions
// (`workspace.transfer`, `workspace.delete`) are Owner-only tenant powers;
// it is not part of the platform catalogue.
export const MEMBERS_MODULES = Object.freeze(['workspace']);

// detection: platform security alert triage (roadmap 2.6). Platform-only;
// permission keys `security.alerts.view` / `security.alerts.update`.
export const SECURITY_MODULES = Object.freeze(['security.alerts']);

const moduleSchema = new mongoose.Schema(
  {
    // members (db.07): unique among live rows, see the partial index below.
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      immutable: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    parentKey: { type: String, default: null, index: true },
    isSystem: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

// members (db.07): a module key is unique among live modules only, so a
// deleted module does not block re-seeding the same key.
moduleSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

moduleSchema.plugin(softDelete);
moduleSchema.plugin(paginate);
moduleSchema.plugin(optimisticConcurrency);
moduleSchema.plugin(audit, { module: 'iam.modules' });

export const ModuleSchema = moduleSchema;
export const Module = mongoose.model(MODEL_NAME, moduleSchema);
export default Module;
