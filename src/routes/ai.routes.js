/**
 * /api/v1/ai routes (ai-ask, roadmap 4.A2).
 *   GET  /status                    analytics.view
 *   PUT  /consent                   settings.update
 *   POST /questions                 analytics.view (+ flag, consent, quota in the service)
 *   GET  /questions/:id             analytics.view
 *   POST /questions/:id/feedback    analytics.view
 * DEPENDS: billing requireFeature(ai_assistant) on /questions - wired at integration.
 */
import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { resolveTenant } from "../middleware/tenant.middleware.js";
import { permission } from "../middleware/permission.middleware.js";
import { validate } from "../validators/index.js";
import aiController from "../controllers/ai.controller.js";
// billing: asking questions needs a plan with ai_assistant.
import { requireFeature } from "../middleware/requireFeature.middleware.js";

const router = Router();
const id = { id: "objectId|required" };

router.get(
  "/status",
  authenticate,
  resolveTenant,
  permission("analytics", "view"),
  aiController.status,
);
router.put(
  "/consent",
  authenticate,
  resolveTenant,
  permission("settings", "update"),
  validate({ body: { granted: "boolean|required" } }),
  aiController.setConsent,
);
router.post(
  "/questions",
  authenticate,
  resolveTenant,
  permission("analytics", "view"),
  requireFeature("ai_assistant"),
  validate({
    body: {
      question: { type: "string", required: true, maxLength: 2000 },
      previousQuestionId: { type: "string", required: false, maxLength: 24 },
    },
  }),
  aiController.ask,
);
router.get(
  "/questions/:id",
  authenticate,
  resolveTenant,
  permission("analytics", "view"),
  validate({ params: id }),
  aiController.getQuestion,
);
router.post(
  "/questions/:id/feedback",
  authenticate,
  resolveTenant,
  permission("analytics", "view"),
  validate({
    params: id,
    body: { rating: "string|required", comment: "string" },
  }),
  aiController.feedback,
);

export default router;
