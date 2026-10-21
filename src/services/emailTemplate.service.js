/**
 * Email Template Service (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   The transactional email template registry. Built-in templates are code
 *   (`src/templates/emails/index.js`); platform admins may override the
 *   subject / text / HTML of each template per locale over
 *   `/api/v1/email-templates`. Sending code calls
 *   `emailService.sendTemplate({ to, template, variables })`, which renders
 *   through `render()` here: the active override when there is one, the
 *   built-in otherwise (and on any storage failure).
 *
 * RESPONSIBILITY
 *   - listTemplates / getTemplate              admin reads
 *   - updateTemplate / resetTemplate /
 *     rollbackTemplate                         versioned writes (history +
 *                                              audit, 409 on a stale version)
 *   - templateHistory                          revision history
 *   - previewTemplate                          render with sample values,
 *                                              never sends anything
 *   - render                                   used by the email service
 *
 * TEMPLATE LANGUAGE
 *   `{{ variableName }}` placeholders only - no logic, no helpers, no raw
 *   output. Values are HTML-escaped in the HTML part and stripped of line
 *   breaks in the subject. An override may only use the variables its
 *   built-in declares, and every REQUIRED variable must reach the reader of
 *   each body part: in that part or in the subject (an invitation without
 *   its link is useless).
 *
 * SECURITY RULES
 *   - Admin-authored HTML may not contain scripts, frames, embedded objects,
 *     inline event handlers or `javascript:` URLs.
 *   - Variable VALUES (reset links, tokens) are never logged or audited;
 *     audit entries carry template metadata only.
 */

import { getBuiltInTemplate, listBuiltInTemplates } from '../templates/emails/index.js';
// backups: workspace data export ready template (roadmap 2.9).
import '../templates/emails/tenantDataExport.js';
// detection: package templates register themselves on import; load them
// here so listings, previews and the outbox always see them.
import '../templates/emails/securityAlert.js';
import { LOCALES } from '../models/EmailTemplate.js';
import * as cache from './cache.service.js';
import * as emailTemplateRepository from '../repositories/emailTemplate.repository.js';
import { createChildLogger } from '../utils/logger.js';
import {
  CONFIG_ERROR_CODES,
  versionConflict,
  configError,
  ensureBaseline,
  recordRevision,
  listHistory,
  getRevision,
  auditChange,
} from './configHistory.service.js';

const logger = createChildLogger({ module: 'services/email_template' });

const KIND = 'email_template';
const AUDIT_MODULE = 'platform.email_templates';
const CACHE_PREFIX = 'email-template:';
const CACHE_TTL_SECONDS = 60;

export const SUBJECT_MAX = 200;
export const TEXT_MAX = 20_000;
export const HTML_MAX = 100_000;
export const VARIABLE_VALUE_MAX = 2_000;

const TOKEN_RE = /\{\{([^{}]*)\}\}/g;
const NAME_RE = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const FORBIDDEN_HTML = [
  { re: /<\s*script\b/i, message: 'must not contain <script> elements' },
  { re: /<\s*(?:iframe|frame|frameset|object|embed|applet|base|meta|link)\b/i, message: 'must not contain frames, embedded objects, <base>, <meta> or <link> elements' },
  { re: /\son[a-z]+\s*=/i, message: 'must not contain inline event handlers (on...=)' },
  { re: /(?:javascript|vbscript)\s*:/i, message: 'must not contain javascript: or vbscript: URLs' },
  { re: /data\s*:\s*text\/html/i, message: 'must not contain data:text/html URLs' },
];

/* ------------------------------ internals ------------------------------ */

function definitionOf(key) {
  const definition = getBuiltInTemplate(String(key));
  if (!definition) {
    throw configError(404, CONFIG_ERROR_CODES.EMAIL_TEMPLATE_NOT_FOUND, `Unknown email template "${key}"`);
  }
  return definition;
}

function localeOf(locale) {
  const value = locale ?? 'en';
  if (!LOCALES.includes(value)) {
    throw configError(400, CONFIG_ERROR_CODES.EMAIL_TEMPLATE_INVALID, 'Unsupported locale', [
      { field: 'locale', message: `must be one of: ${LOCALES.join(', ')}` },
    ]);
  }
  return value;
}

const resourceKeyOf = (key, locale) => `${key}:${locale}`;
const cacheKeyOf = (key, locale) => `${CACHE_PREFIX}${key}:${locale}`;

/**
 * Placeholders used by `source`. Returns `{ names, errors }` where errors
 * are messages for malformed placeholders or stray braces.
 */
export function extractPlaceholders(source) {
  const names = new Set();
  const errors = [];
  const text = String(source ?? '');
  for (const match of text.matchAll(TOKEN_RE)) {
    const name = NAME_RE.exec(match[1]);
    if (name) names.add(name[1]);
    else errors.push(`"{{${match[1]}}}" is not a valid placeholder; use {{ variableName }}`);
  }
  if (/\{\{\{|\}\}\}/.test(text)) {
    errors.push('uses triple braces; only {{ variableName }} is supported');
  }
  const rest = text.replace(TOKEN_RE, '');
  if (rest.includes('{{') || rest.includes('}}')) {
    errors.push('has an unclosed "{{" or a stray "}}"');
  }
  return { names, errors };
}

/**
 * Validate admin-authored content against the built-in's variable
 * contract. Returns the normalised `{ subject, text, html }` or throws 400
 * EMAIL_TEMPLATE_INVALID with field errors.
 */
export function validateContent(definition, input) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const declared = new Set(definition.variables.map((variable) => variable.key));
  const required = definition.variables.filter((variable) => variable.required).map((variable) => variable.key);

  const { subject, text } = input ?? {};
  let { html } = input ?? {};

  let cleanSubject = null;
  if (typeof subject !== 'string' || !subject.trim()) add('subject', 'is required');
  else {
    cleanSubject = subject.trim();
    if (cleanSubject.length > SUBJECT_MAX) add('subject', `must be at most ${SUBJECT_MAX} characters`);
    if (/[\r\n]/.test(cleanSubject)) add('subject', 'must be a single line');
    if (CONTROL_RE.test(cleanSubject)) add('subject', 'must not contain control characters');
  }

  if (typeof text !== 'string' || !text.trim()) add('text', 'is required');
  else {
    if (text.length > TEXT_MAX) add('text', `must be at most ${TEXT_MAX} characters`);
    if (CONTROL_RE.test(text)) add('text', 'must not contain control characters');
  }

  if (html === undefined || html === null || (typeof html === 'string' && !html.trim())) html = null;
  else if (typeof html !== 'string') add('html', 'must be a string');
  else {
    if (html.length > HTML_MAX) add('html', `must be at most ${HTML_MAX} characters`);
    for (const rule of FORBIDDEN_HTML) if (rule.re.test(html)) add('html', rule.message);
  }

  // A required variable must reach the reader of each body part: it appears
  // in the subject or in that part (an invitation without its link is useless).
  const parts = [['subject', cleanSubject], ['text', typeof text === 'string' ? text : null], ['html', typeof html === 'string' ? html : null]];
  let subjectNames = new Set();
  for (const [field, source] of parts) {
    if (source === null) continue;
    const { names, errors: syntax } = extractPlaceholders(source);
    syntax.forEach((message) => add(field, message));
    for (const name of names) {
      if (!declared.has(name)) {
        add(field, `uses unknown variable "{{${name}}}"; available: ${[...declared].join(', ') || 'none'}`);
      }
    }
    if (field === 'subject') {
      subjectNames = names;
      continue;
    }
    for (const name of required) {
      if (!names.has(name) && !subjectNames.has(name)) {
        add(field, `must include the required variable "{{${name}}}" (here or in the subject)`);
      }
    }
  }

  if (errors.length) {
    throw configError(400, CONFIG_ERROR_CODES.EMAIL_TEMPLATE_INVALID, 'Invalid email template', errors);
  }
  return { subject: cleanSubject, text, html };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Substitute placeholders. `mode` is subject | text | html. */
function fill(source, values, mode) {
  return String(source).replace(TOKEN_RE, (_match, inner) => {
    const name = NAME_RE.exec(inner)?.[1];
    const value = name && Object.prototype.hasOwnProperty.call(values, name) ? values[name] : '';
    if (mode === 'html') return escapeHtml(value);
    if (mode === 'subject') return String(value).replace(/[\r\n]+/g, ' ');
    return String(value);
  });
}

/**
 * Resolve variable values: provided > sample (preview only) > default > ''.
 * Returns `{ values, missing }` (required variables without a value).
 */
function resolveValues(definition, provided = {}, { useSamples = false } = {}) {
  const values = {};
  const missing = [];
  for (const variable of definition.variables) {
    const raw = provided?.[variable.key];
    const given = raw !== undefined && raw !== null && raw !== '';
    if (given) values[variable.key] = String(raw);
    else if (useSamples) values[variable.key] = variable.sample || variable.default || '';
    else if (variable.default !== undefined) values[variable.key] = variable.default;
    else {
      values[variable.key] = '';
      if (variable.required) missing.push(variable.key);
    }
  }
  return { values, missing };
}

/** Validate preview variable values (strings / numbers, declared names). */
function checkPreviewVariables(definition, variables) {
  if (variables === undefined || variables === null) return {};
  const errors = [];
  if (typeof variables !== 'object' || Array.isArray(variables)) {
    throw configError(400, CONFIG_ERROR_CODES.EMAIL_TEMPLATE_INVALID, 'Invalid preview variables', [
      { field: 'variables', message: 'must be an object of variable values' },
    ]);
  }
  const declared = new Set(definition.variables.map((variable) => variable.key));
  for (const [name, value] of Object.entries(variables)) {
    if (!declared.has(name)) errors.push({ field: `variables.${name}`, message: 'is not a variable of this template' });
    else if (!['string', 'number', 'boolean'].includes(typeof value)) errors.push({ field: `variables.${name}`, message: 'must be a string' });
    else if (String(value).length > VARIABLE_VALUE_MAX) errors.push({ field: `variables.${name}`, message: `must be at most ${VARIABLE_VALUE_MAX} characters` });
  }
  if (errors.length) throw configError(400, CONFIG_ERROR_CODES.EMAIL_TEMPLATE_INVALID, 'Invalid preview variables', errors);
  return variables;
}

/** Load the active override for (key, locale) through the cache. */
async function loadActive(key, locale) {
  const cached = await cache.getOrSet(
    cacheKeyOf(key, locale),
    async () => ({ row: await emailTemplateRepository.findActive(key, locale) }),
    CACHE_TTL_SECONDS,
  );
  return cached?.row ?? null;
}

/**
 * The content used for a send: the active override for the locale, then
 * the English override, then the built-in. A storage failure falls back to
 * the built-in so email keeps working.
 */
async function activeContent(definition, locale) {
  const builtIn = { subject: definition.subject, text: definition.text, html: definition.html, source: 'built_in', version: 0 };
  try {
    const row = (await loadActive(definition.key, locale))
      ?? (locale !== 'en' ? await loadActive(definition.key, 'en') : null);
    if (row) return { subject: row.subject, text: row.text, html: row.html ?? null, source: 'override', version: row.version ?? 0 };
  } catch (error) {
    logger.warn({ err: { message: error?.message }, template: definition.key }, 'email template override unavailable; using built-in');
  }
  return builtIn;
}

async function invalidate(key, locale) {
  try {
    await cache.del(cacheKeyOf(key, locale));
  } catch (error) {
    logger.warn({ err: { message: error?.message }, template: key }, 'email template cache invalidation failed');
  }
}

/** Secret-free, exact state recorded in history. */
function stateOf(row) {
  if (row?.status === 'active') {
    return { customized: true, subject: row.subject, text: row.text, html: row.html ?? null };
  }
  return { customized: false, subject: null, text: null, html: null };
}

/** Metadata recorded in the audit trail (no bodies). */
function auditState(row, version) {
  const state = stateOf(row);
  return {
    customized: state.customized,
    subject: state.subject,
    textLength: state.text ? state.text.length : 0,
    htmlLength: state.html ? state.html.length : 0,
    version,
  };
}

function present(definition, locale, row) {
  const builtIn = { subject: definition.subject, text: definition.text, html: definition.html };
  const customized = row?.status === 'active';
  const override = customized ? { subject: row.subject, text: row.text, html: row.html ?? null } : null;
  return {
    key: definition.key,
    name: definition.name,
    description: definition.description,
    locale,
    variables: definition.variables.map((variable) => ({ ...variable })),
    customized,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
    builtIn,
    override,
    effective: override ?? builtIn,
  };
}

/** The (key, locale) row, created as "not customized" when absent. */
async function ensureRow(definition, locale, actorId) {
  return emailTemplateRepository.insertIfAbsent({
    key: definition.key,
    locale,
    subject: definition.subject,
    text: definition.text,
    html: definition.html,
    status: 'archived',
    version: 0,
    updatedBy: actorId ?? null,
  });
}

async function applyChange({ definition, locale, row, expectedVersion, set, action, actor, reason = null, rolledBackFrom = null }) {
  const current = row.version ?? 0;
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== current) {
    throw versionConflict(current);
  }
  const resourceKey = resourceKeyOf(definition.key, locale);
  await ensureBaseline({ kind: KIND, resourceKey, version: current, state: stateOf(row) });
  const updated = await emailTemplateRepository.updateIfVersion(row._id, current, {
    ...set,
    updatedBy: actor?.id != null ? String(actor.id) : null,
  });
  if (!updated) {
    const latest = await emailTemplateRepository.findByKeyLocale(definition.key, locale);
    throw versionConflict(latest?.version ?? current);
  }
  await recordRevision({
    kind: KIND,
    resourceKey,
    version: updated.version,
    action,
    state: stateOf(updated),
    rolledBackFrom,
    reason,
    actor,
  });
  await invalidate(definition.key, locale);
  await auditChange({
    actor,
    action: `email_template.${{ update: 'updated', reset: 'reset', rollback: 'rolled_back' }[action] ?? action}`,
    module: AUDIT_MODULE,
    resource: { type: 'email_template', id: resourceKey },
    before: auditState(row, current),
    after: { ...auditState(updated, updated.version), ...(rolledBackFrom != null ? { rolledBackFrom } : {}) },
    reason,
  });
  return updated;
}

/* ------------------------------ public API ------------------------------ */

/** Every built-in template with its override state for `locale`. */
export async function listTemplates({ locale = 'en' } = {}) {
  const loc = localeOf(locale);
  const rows = await emailTemplateRepository.listByLocale(loc);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return listBuiltInTemplates().map((definition) => present(definition, loc, byKey.get(definition.key) ?? null));
}

/** One template (built-in, override and effective content). */
export async function getTemplate({ key, locale = 'en' }) {
  const definition = definitionOf(key);
  const loc = localeOf(locale);
  return present(definition, loc, await emailTemplateRepository.findByKeyLocale(definition.key, loc));
}

/** Save an override (validated against the variable contract). */
export async function updateTemplate({ key, locale = 'en', subject, text, html, version, reason = null, actor }) {
  const definition = definitionOf(key);
  const loc = localeOf(locale);
  const content = validateContent(definition, { subject, text, html });
  const row = await ensureRow(definition, loc, actor?.id);
  const updated = await applyChange({
    definition, locale: loc, row, expectedVersion: version, set: { ...content, status: 'active' }, action: 'update', actor, reason,
  });
  return present(definition, loc, updated);
}

/** Drop the override: sends use the built-in again (a normal, versioned change). */
export async function resetTemplate({ key, locale = 'en', version, reason = null, actor }) {
  const definition = definitionOf(key);
  const loc = localeOf(locale);
  const row = await ensureRow(definition, loc, actor?.id);
  const updated = await applyChange({
    definition, locale: loc, row, expectedVersion: version, set: { status: 'archived' }, action: 'reset', actor, reason,
  });
  return present(definition, loc, updated);
}

/** Revision history for (key, locale), newest first. */
export async function templateHistory({ key, locale = 'en', page = 1, limit = 20 }) {
  const definition = definitionOf(key);
  const loc = localeOf(locale);
  return listHistory({ kind: KIND, resourceKey: resourceKeyOf(definition.key, loc), page, limit });
}

/** Restore the exact state of an earlier version. */
export async function rollbackTemplate({ key, locale = 'en', toVersion, version, reason = null, actor }) {
  const definition = definitionOf(key);
  const loc = localeOf(locale);
  const target = await getRevision({ kind: KIND, resourceKey: resourceKeyOf(definition.key, loc), version: toVersion });
  const state = target.state ?? {};
  const set = state.customized
    ? { ...validateContent(definition, state), status: 'active' }
    : { status: 'archived' };
  const row = await ensureRow(definition, loc, actor?.id);
  const updated = await applyChange({
    definition, locale: loc, row, expectedVersion: version, set, action: 'rollback', actor, reason, rolledBackFrom: toVersion,
  });
  return present(definition, loc, updated);
}

/**
 * Render a template with sample values (overridable per variable) WITHOUT
 * sending anything. `draft` previews unsaved content (validated first);
 * otherwise the effective content for the locale is used.
 */
export async function previewTemplate({ key, locale = 'en', draft = null, variables = undefined }) {
  const definition = definitionOf(key);
  const loc = localeOf(locale);
  const provided = checkPreviewVariables(definition, variables);
  const content = draft
    ? { ...validateContent(definition, draft), source: 'draft' }
    : await activeContent(definition, loc);
  const { values } = resolveValues(definition, provided, { useSamples: true });
  return {
    key: definition.key,
    locale: loc,
    source: content.source,
    subject: fill(content.subject, values, 'subject'),
    text: fill(content.text, values, 'text'),
    html: content.html ? fill(content.html, values, 'html') : null,
    variables: values,
  };
}

/**
 * Render a template for sending. Throws 404 for an unknown template and
 * 400 EMAIL_TEMPLATE_VARIABLES_MISSING when a required variable is absent.
 *
 * @returns {Promise<{ subject: string, text: string, html: string|null, source: 'override'|'built_in', version: number }>}
 */
export async function render(key, variables = {}, { locale = 'en' } = {}) {
  const definition = definitionOf(key);
  const loc = LOCALES.includes(locale) ? locale : 'en';
  const { values, missing } = resolveValues(definition, variables);
  if (missing.length) {
    throw configError(
      400,
      CONFIG_ERROR_CODES.EMAIL_TEMPLATE_VARIABLES_MISSING,
      `Email template "${definition.key}" is missing required variables: ${missing.join(', ')}`,
      missing.map((name) => ({ field: `variables.${name}`, message: 'is required' })),
    );
  }
  const content = await activeContent(definition, loc);
  return {
    subject: fill(content.subject, values, 'subject'),
    text: fill(content.text, values, 'text'),
    html: content.html ? fill(content.html, values, 'html') : null,
    source: content.source,
    version: content.version,
  };
}

export default {
  listTemplates,
  getTemplate,
  updateTemplate,
  resetTemplate,
  templateHistory,
  rollbackTemplate,
  previewTemplate,
  render,
  validateContent,
  extractPlaceholders,
};
