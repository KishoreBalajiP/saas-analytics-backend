/**
 * AI gate (ai-ask): kill switch, provider, plan entitlement, recorded
 * consent, then the daily quota (consumed last so a refused request never
 * spends it). `analytics.view` and requireFeature(ai_assistant) are enforced
 * by the route. The `ai.assistant` flag is an operator allow-list that can
 * switch Ask on in addition to the plan; the plan entitlement is authoritative.
 */
import ApiError from "../../utils/ApiError.js";
import * as featureFlags from "../featureFlag.service.js";
import usageService from "../usage.service.js";
import aiRepository from "../../repositories/ai.repository.js";
import {
  getAiProvider,
  aiConfigDiagnosis,
  AI_CONFIG_ACTIONS,
} from "../aiProvider.adapter.js";
import entitlementService from "../entitlement.service.js";

export const AI_FLAGS = Object.freeze({
  ASSISTANT: "ai.assistant",
  KILL_SWITCH: "ai.kill_switch",
});

export async function status({ tenantId }) {
  const [killed, flagged, entitled, consent] = await Promise.all([
    featureFlags.isEnabled(AI_FLAGS.KILL_SWITCH, { tenantId }),
    featureFlags.isEnabled(AI_FLAGS.ASSISTANT, { tenantId }),
    tenantId
      ? entitlementService.hasFeature({
          tenantId: String(tenantId),
          feature: "ai_assistant",
        })
      : false,
    aiRepository.getConsent(tenantId),
  ]);
  // The configuration problem (unset/unsupported provider, missing key,
  // invalid model) is reported as itself, never as a generic "not configured".
  const config = aiConfigDiagnosis();
  const granted = Boolean(consent?.granted);
  // Why Ask is unavailable (first failing gate) and what to do about it.
  let reason = null;
  let action = null;
  if (killed) {
    reason = "AI_DISABLED";
    action =
      "The AI assistant is temporarily disabled by the platform operator. Try again later.";
  } else if (!config.ready) {
    reason = config.problem;
    action = AI_CONFIG_ACTIONS[config.problem];
  } else if (!entitled) {
    reason = "FEATURE_NOT_AVAILABLE";
    action =
      "Your plan does not include the AI assistant. Upgrade the workspace plan to use Ask.";
  } else if (!granted) {
    reason = "AI_CONSENT_REQUIRED";
    action =
      "A workspace administrator must allow AI processing before questions can be asked.";
  }
  return {
    available: reason === null,
    killSwitch: killed,
    enabled: entitled || flagged,
    entitled,
    consent: granted,
    providerConfigured: config.ready,
    reason,
    action,
  };
}

export async function check({ tenantId, actorId, consume = true }) {
  const s = await status({ tenantId });
  if (s.killSwitch)
    throw new ApiError(503, "The AI assistant is temporarily disabled", {
      code: "AI_DISABLED",
    });
  if (!s.providerConfigured)
    throw new ApiError(501, "AI is not configured on this platform", {
      code: s.reason,
    });
  if (!s.entitled)
    throw new ApiError(403, "Your plan does not include the AI assistant", {
      code: "FEATURE_NOT_AVAILABLE",
    });
  if (!s.consent)
    throw new ApiError(
      403,
      "A workspace administrator must consent to AI processing first",
      { code: "AI_CONSENT_REQUIRED" },
    );
  if (consume)
    await usageService.checkAndConsume({
      tenantId,
      metric: "aiQuestionsPerDay",
      by: actorId,
    });
  return getAiProvider();
}

export default { check, status, AI_FLAGS };
