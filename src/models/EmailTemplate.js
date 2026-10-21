/**
 * EmailTemplate (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Platform-admin overrides of the built-in transactional email templates
 *   (`src/templates/emails/`). One row per (key, locale). The email service
 *   renders the active override and falls back to the built-in template.
 *
 * FIELDS
 *   key, locale, subject, text, html (optional), status, version, updatedBy.
 *   - `status: 'active'`   the override is used for sends.
 *   - `status: 'archived'` reverted to the built-in; the row is kept so the
 *     version history continues.
 *   - `version` is bumped on every change (optimistic concurrency +
 *     `ConfigRevision` history, kind `email_template`).
 *
 * DESIGN CONSTRAINTS
 *   - Platform-global (no tenantId), so `tenantScope` is not applied.
 *   - Variables are NOT stored: the contract (names, required) belongs to
 *     the built-in definition the sending code was written against.
 *
 * PLUGINS
 *   paginate. Changes are audited explicitly by the service.
 *
 * INDEXES
 *   - unique({ key, locale })
 *   - { status: 1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'EmailTemplate';
export const LOCALES = Object.freeze(['en', 'es', 'fr', 'de']);
export const STATUSES = Object.freeze(['draft', 'active', 'archived']);

const emailTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 100 },
    locale: { type: String, enum: [...LOCALES], default: 'en' },
    subject: { type: String, required: true, maxlength: 200 },
    text: { type: String, required: true, maxlength: 20_000 },
    html: { type: String, default: null, maxlength: 100_000 },
    status: { type: String, enum: [...STATUSES], default: 'active' },
    version: { type: Number, default: 0 },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

emailTemplateSchema.index({ key: 1, locale: 1 }, { unique: true });
emailTemplateSchema.index({ status: 1 });

emailTemplateSchema.plugin(paginate);

export const EmailTemplateSchema = emailTemplateSchema;
export const EmailTemplate =
  mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, emailTemplateSchema);
export default EmailTemplate;
