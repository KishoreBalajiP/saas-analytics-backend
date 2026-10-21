/**
 * Email Template Controller (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   HTTP layer for `/api/v1/email-templates`: platform admins view the
 *   built-in transactional templates, override them per locale, preview
 *   them with sample data (nothing is sent), and roll changes back.
 *   Business rules live in `services/emailTemplate.service.js`.
 *
 * CODING GUIDELINES
 *   - The actor comes from the token, never from the body.
 *   - Template content is taken from the raw body so whitespace in the
 *     text part is preserved; the service validates every field.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import emailTemplateService from '../services/emailTemplate.service.js';

function actorOf(req) {
  return { type: 'admin', id: req.admin?.id ?? null, email: req.admin?.email ?? null };
}

/** GET /email-templates?locale= */
export const listTemplates = asyncHandler(async (req, res) => {
  const { locale = 'en' } = req.validated?.query ?? {};
  const templates = await emailTemplateService.listTemplates({ locale });
  return ApiResponse.ok(res, templates, 'Email templates fetched', { total: templates.length, locale });
});

/** GET /email-templates/:key?locale= */
export const getTemplate = asyncHandler(async (req, res) => {
  const { locale = 'en' } = req.validated?.query ?? {};
  const template = await emailTemplateService.getTemplate({ key: req.validated.params.key, locale });
  return ApiResponse.ok(res, template, 'Email template fetched');
});

/** PUT /email-templates/:key - save an override. */
export const updateTemplate = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const raw = req.body ?? {};
  const template = await emailTemplateService.updateTemplate({
    key: req.validated.params.key,
    locale: body.locale ?? 'en',
    subject: raw.subject,
    text: raw.text,
    html: raw.html,
    version: body.version,
    reason: body.reason ?? null,
    actor: actorOf(req),
  });
  return ApiResponse.ok(res, template, 'Email template saved');
});

/** POST /email-templates/:key/reset - back to the built-in. */
export const resetTemplate = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const template = await emailTemplateService.resetTemplate({
    key: req.validated.params.key,
    locale: body.locale ?? 'en',
    version: body.version,
    reason: body.reason ?? null,
    actor: actorOf(req),
  });
  return ApiResponse.ok(res, template, 'Email template reset to the built-in');
});

/** POST /email-templates/:key/preview - render only, never sends. */
export const previewTemplate = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const raw = req.body ?? {};
  const preview = await emailTemplateService.previewTemplate({
    key: req.validated.params.key,
    locale: body.locale ?? 'en',
    draft: raw.draft ?? null,
    variables: raw.variables,
  });
  return ApiResponse.ok(res, preview, 'Email template preview');
});

/** GET /email-templates/:key/history?locale= */
export const templateHistory = asyncHandler(async (req, res) => {
  const { locale = 'en', page = 1, limit = 20 } = req.validated?.query ?? {};
  const result = await emailTemplateService.templateHistory({ key: req.validated.params.key, locale, page, limit });
  return ApiResponse.ok(res, result.docs, 'Email template history fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /email-templates/:key/rollback */
export const rollbackTemplate = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const template = await emailTemplateService.rollbackTemplate({
    key: req.validated.params.key,
    locale: body.locale ?? 'en',
    toVersion: body.toVersion,
    version: body.version,
    reason: body.reason ?? null,
    actor: actorOf(req),
  });
  return ApiResponse.ok(res, template, `Email template rolled back to version ${body.toVersion}`);
});

export default {
  listTemplates,
  getTemplate,
  updateTemplate,
  resetTemplate,
  previewTemplate,
  templateHistory,
  rollbackTemplate,
};
