import { Router } from 'express';
import { strictLimiter } from '../middleware/rateLimiter.middleware.js';
import { validate } from '../validators/index.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { optionalAuthenticate } from '../middleware/auth.middleware.js';
import validator from '../validators/accessRequest.validator.js';
import controller from '../controllers/accessRequest.controller.js';

const router = Router();
router.post('/', optionalAuthenticate, strictLimiter, validate(validator.submitSchema), controller.submit);
router.get('/', adminAuth, validate(validator.listSchema), controller.list);
router.post('/:id/approve', adminAuth, validate(validator.decisionSchema), controller.approve);
router.post('/:id/reject', adminAuth, validate(validator.rejectSchema), controller.reject);
export default router;
