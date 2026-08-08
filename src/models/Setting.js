/**
 * Setting (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Hot-reloadable, typed, scoped configuration. Two scopes:
 *   `platform` (one source of truth) and `tenant` (per-tenant override).
 *   Tenant onboarding initialises the default groups (general,
 *   localization, branding, security, notification, email, feature flags,
 *   billing, storage); tenant admins read/update their own groups.
 *
 * SCOPE / TENANT OVERRIDE
 *   - Tenant override wins over platform (`resolveEffective`).
 *   - When `scope === 'platform'`, `tenantId` MUST be null.
 *   - The `tenantScope` plugin is applied with `optional: true` so a
 *     platform row (null tenantId) is legal; the unique index
 *     `{ scope, tenantId, key }` still blocks duplicate platform keys.
 *
 * VALUE TYPES
 *   `type` drives write-side coercion and read-side shape guarantees:
 *   string, number, boolean, json, duration (milliseconds, stored as
 *   number). `isSecret` values are redacted for non-privileged readers
 *   by `services/setting.service.js`.
 *
 * PLUGINS
 *   tenantScope (optional), softDelete, paginate, optimisticConcurrency,
 *   audit (module `platform.settings`).
 *
 * INDEXES
 *   - unique({ scope, tenantId, key })
 *   - { scope: 1, group: 1 }
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Setting';
export const SCOPES = Object.freeze(['platform', 'tenant']);
export const TYPES = Object.freeze([
  'string', 'number', 'boolean', 'json', 'duration',
]);

const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    scope: { type: String, enum: [...SCOPES], required: true, index: true },
    tenantId: { type: String, default: null, index: true },
    group: { type: String, default: 'general', index: true },
    type: { type: String, enum: [...TYPES], default: 'string' },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    description: { type: String, default: '' },
    isSecret: { type: Boolean, default: false },
    isReadonly: { type: Boolean, default: false },
    version: { type: Number, default: 0 },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

// A key is unique per scope: platform rows share `tenantId: null`, tenant
// rows are unique within their tenant.
settingSchema.index({ scope: 1, tenantId: 1, key: 1 }, { unique: true });

settingSchema.plugin(tenantScope, { optional: true });
settingSchema.plugin(softDelete);
settingSchema.plugin(paginate);
settingSchema.plugin(optimisticConcurrency);
settingSchema.plugin(audit, { module: 'platform.settings' });

export const SettingSchema = settingSchema;
export const Setting = mongoose.model(MODEL_NAME, settingSchema);
export default Setting;
