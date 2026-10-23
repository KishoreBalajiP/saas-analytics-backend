/** AI controller (ai-ask): /api/v1/ai. */
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { getTenantId } from "../middleware/tenant.middleware.js";
import askService from "../services/ai/ask.service.js";

const actorOf = (req) => req.user?.id ?? null;

export const status = asyncHandler(async (req, res) =>
  ApiResponse.ok(
    res,
    await askService.status({ tenantId: getTenantId(req) }),
    "AI status",
  ),
);
export const setConsent = asyncHandler(async (req, res) =>
  ApiResponse.ok(
    res,
    await askService.setConsent({
      tenantId: getTenantId(req),
      actorId: actorOf(req),
      granted: req.validated.body.granted,
    }),
    "AI consent",
  ),
);
export const ask = asyncHandler(async (req, res) =>
  ApiResponse.ok(
    res,
    await askService.ask({
      tenantId: getTenantId(req),
      actorId: actorOf(req),
      question: req.validated.body.question,
      previousQuestionId: req.validated.body.previousQuestionId ?? null,
    }),
    "AI answer",
  ),
);
export const getQuestion = asyncHandler(async (req, res) =>
  ApiResponse.ok(
    res,
    await askService.getQuestion({
      tenantId: getTenantId(req),
      id: req.validated.params.id,
    }),
    "AI question",
  ),
);
export const feedback = asyncHandler(async (req, res) =>
  ApiResponse.ok(
    res,
    await askService.feedback({
      tenantId: getTenantId(req),
      id: req.validated.params.id,
      actorId: actorOf(req),
      ...req.validated.body,
    }),
    "Feedback recorded",
  ),
);

export default { status, setConsent, ask, getQuestion, feedback };
