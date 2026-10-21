/**
 * ConfigRevision (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Append-only version history for platform configuration: platform
 *   settings, feature flags and email templates. Every change made through
 *   the configuration services records the resulting state here, so an
 *   operator can see who changed what and roll a resource back to the exact
 *   state of an earlier version.
 *
 * SHAPE
 *   - `kind` + `resourceKey` identify the resource
 *     (`setting` / `platform:<key>`, `feature_flag` / `<key>`,
 *     `email_template` / `<key>:<locale>`).
 *   - `version` is the resource's version AFTER the change; unique per
 *     resource so two concurrent writers can never record the same version.
 *   - `state` is the managed state after the change (never a secret).
 *   - `secret` holds the AES-GCM envelope of a secret setting's value, so a
 *     rollback restores the exact prior secret without the history ever
 *     holding plaintext. The field name matches the audit redaction list.
 *
 * DESIGN CONSTRAINTS
 *   - Platform-global (no tenantId), so `tenantScope` is not applied.
 *   - Append-only: no soft delete, no audit plugin (each change is audited
 *     explicitly by the owning service with secrets redacted).
 *   - Retention is declared in `src/constants/retention.config.js`.
 *
 * PLUGINS
 *   paginate.
 *
 * INDEXES
 *   - unique({ kind, resourceKey, version })
 *   - { kind, resourceKey, createdAt: -1 }
 *   - { createdAt: 1 } (retention sweeps)
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'ConfigRevision';
export const REVISION_KINDS = Object.freeze(['setting', 'feature_flag', 'email_template']);
export const REVISION_ACTIONS = Object.freeze([
  'baseline', 'create', 'update', 'reset', 'delete', 'rollback',
]);

const configRevisionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: [...REVISION_KINDS], required: true },
    resourceKey: { type: String, required: true, trim: true, maxlength: 200 },
    version: { type: Number, required: true, min: 0 },
    action: { type: String, enum: [...REVISION_ACTIONS], required: true },
    state: { type: mongoose.Schema.Types.Mixed, default: null },
    isSecret: { type: Boolean, default: false },
    secret: { type: String, default: null },
    rolledBackFrom: { type: Number, default: null },
    reason: { type: String, default: null, maxlength: 500 },
    changedBy: {
      type: { type: String, default: 'system' },
      id: { type: String, default: null },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

configRevisionSchema.index({ kind: 1, resourceKey: 1, version: 1 }, { unique: true });
configRevisionSchema.index({ kind: 1, resourceKey: 1, createdAt: -1 });
configRevisionSchema.index({ createdAt: 1 });

configRevisionSchema.plugin(paginate);

export const ConfigRevisionSchema = configRevisionSchema;
export const ConfigRevision =
  mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, configRevisionSchema);
export default ConfigRevision;
