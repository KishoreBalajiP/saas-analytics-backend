/**
 * /api/v1/email-templates routes - transactional email template registry
 * (roadmap 2.4 - implemented).
 *
 * WHY IT EXISTS
 *   Transactional emails (password reset, verification, invitations,
 *   alerts) are built-in templates in `src/templates/emails/`. Platform
 *   admins override their subject / text / HTML per locale without a
 *   deploy; `emailService.sendTemplate` uses the active override and falls
 *   back to the built-in.
 *
 * ENDPOINTS (adminAuth -> requirePlatformScope -> permission -> validate)
 *   - GET  /                     list (?locale)                email_templates.view
 *   - GET  /:key                 detail (?locale)              email_templates.view
 *   - PUT  /:key                 save override                 email_templates.update
 *   - POST /:key/reset           back to the built-in          email_templates.update
 *   - POST /:key/preview         render sample, never sends    email_templates.view
 *   - GET  /:key/history         versions (?locale)            email_templates.view
 *   - POST /:key/rollback        restore { toVersion }         email_templates.update
 *
 * RULES
 *   - Overrides may only use the variables the built-in declares and must
 *     keep every required variable; HTML may not carry scripts/handlers.
 *   - Every change is versioned (409 VERSION_CONFLICT), recorded in the
 *     history and audited (metadata only).
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { requirePlatformScope } from '../middleware/configAccess.middleware.js';
import { validate } from '../validators/index.js';
import emailTemplateValidator from '../validators/emailTemplate.validator.js';
import emailTemplateController from '../controllers/emailTemplate.controller.js';

const router = Router();

router.get(
  '/',
  adminAuth,
  requirePlatformScope,
  permission('email_templates', 'view'),
  validate(emailTemplateValidator.listSchema),
  emailTemplateController.listTemplates,
);
router.get(
  '/:key',
  adminAuth,
  requirePlatformScope,
  permission('email_templates', 'view'),
  validate(emailTemplateValidator.getSchema),
  emailTemplateController.getTemplate,
);
router.put(
  '/:key',
  adminAuth,
  requirePlatformScope,
  permission('email_templates', 'update'),
  validate(emailTemplateValidator.updateSchema),
  emailTemplateController.updateTemplate,
);
router.post(
  '/:key/reset',
  adminAuth,
  requirePlatformScope,
  permission('email_templates', 'update'),
  validate(emailTemplateValidator.resetSchema),
  emailTemplateController.resetTemplate,
);
router.post(
  '/:key/preview',
  adminAuth,
  requirePlatformScope,
  permission('email_templates', 'view'),
  validate(emailTemplateValidator.previewSchema),
  emailTemplateController.previewTemplate,
);
router.get(
  '/:key/history',
  adminAuth,
  requirePlatformScope,
  permission('email_templates', 'view'),
  validate(emailTemplateValidator.historySchema),
  emailTemplateController.templateHistory,
);
router.post(
  '/:key/rollback',
  adminAuth,
  requirePlatformScope,
  permission('email_templates', 'update'),
  validate(emailTemplateValidator.rollbackSchema),
  emailTemplateController.rollbackTemplate,
);

export default router;
