import { Router } from 'express';
import { strictLimiter } from '../middleware/rateLimiter.middleware.js';
import { validate } from '../validators/index.js';
import invitationValidator from '../validators/invitation.validator.js';
import invitationController from '../controllers/invitation.controller.js';

const router = Router();

router.get('/preview', // ci:routes-exempt: public token preview, rate-limited
  strictLimiter, validate(invitationValidator.previewSchema), invitationController.preview);
router.post('/accept', // ci:routes-exempt: public token acceptance, rate-limited
  strictLimiter, validate(invitationValidator.acceptSchema), invitationController.accept);

export default router;
