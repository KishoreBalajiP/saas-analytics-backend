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
 *   - unique(key)
 *   - { parentKey: 1 }
 *   - { isSystem: 1 }
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Module';

/** Top-level built-in module keys (the 18-module seed contract). */
export const BUILTIN_MODULES = Object.freeze([
  'iam', 'platform', 'governance',
  'analytics', 'connectors', 'tenants',
  'users', 'roles', 'settings',
  'feature_flags', 'master_data',
  'monitoring', 'notifications',
  'email_templates', 'audit_logs',
  'access_logs', 'compliance', 'support',
]);

/**
 * IAM child modules. Seeded beneath `iam` so permission keys stay
 * readable (`iam.users.view`) while grouping under one top-level module.
 */
export const IAM_MODULES = Object.freeze([
  'iam.admins', 'iam.tenants', 'iam.users',
  'iam.roles', 'iam.permissions', 'iam.sessions',
]);

const moduleSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
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

moduleSchema.plugin(softDelete);
moduleSchema.plugin(paginate);
moduleSchema.plugin(optimisticConcurrency);
moduleSchema.plugin(audit, { module: 'iam.modules' });

export const ModuleSchema = moduleSchema;
export const Module = mongoose.model(MODEL_NAME, moduleSchema);
export default Module;
