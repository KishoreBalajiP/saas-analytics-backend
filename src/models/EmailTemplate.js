/**
 * EmailTemplate (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Transactional email template registry. Templates store
 *   MJML/HTML/text + variables; the worker renders and sends.
 *
 * PLANNED FIELDS
 *   _id, key (unique), description,
 *   sender: { name, email },
 *   subject,                                // may contain {{var}}
 *   bodyMjml, bodyHtml?, text?,
 *   locale: 'en' | string,
 *   status: 'draft' | 'active' | 'archived',
 *   variables: Array<{ key, description, required }>,
 *   updatedAt, updatedBy
 *
 * PLANNED INDEXES
 *   - { key: 1, locale: 1 } unique
 *   - { status: 1 }
 */

export const MODEL_NAME = 'EmailTemplate';
export const LOCALES = Object.freeze(['en', 'es', 'fr', 'de']);
export const STATUSES = Object.freeze(['draft', 'active', 'archived']);

export default Object.freeze({
  name: MODEL_NAME,
  locales: LOCALES,
  statuses: STATUSES,
  renderPipeline: 'mjml -> html (server) -> text fallback',
  schemaImplemented: false,
  seeAlso: ['src/modules/platform/email-templates/README.md'],
});
