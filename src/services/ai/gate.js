/**
 * AI gate (ai-ask): kill switch, per-tenant flag, recorded consent, provider,
 * then the daily quota (consumed last so a refused request never spends it).
 * `analytics.view` is enforced by the route. DEPENDS: billing
 * requireFeature(ai_assistant) is wired at integration (not shimmed).
 */
import ApiError from '../../utils/ApiError.js';
import * as featureFlags from '../featureFlag.service.js';
import usageService from '../usage.service.js';
import aiRepository from '../../repositories/ai.repository.js';
import { getAiProvider, AI_ERROR_CODES } from '../aiProvider.adapter.js';

export const AI_FLAGS = Object.freeze({ ASSISTANT: 'ai.assistant', KILL_SWITCH: 'ai.kill_switch' });

export async function status({ tenantId }) {
  const [killed, enabled, consent] = await Promise.all([
    featureFlags.isEnabled(AI_FLAGS.KILL_SWITCH, { tenantId }),
    featureFlags.isEnabled(AI_FLAGS.ASSISTANT, { tenantId }),
    aiRepository.getConsent(tenantId),
  ]);
  const provider = getAiProvider();
  return {
    available: !killed && enabled && provider.isImplemented,
    killSwitch: killed,
    enabled,
    consent: Boolean(consent?.granted),
    providerConfigured: provider.isImplemented,
  };
}

export async function check({ tenantId, actorId, consume = true }) {
  const s = await status({ tenantId });
  if (s.killSwitch) throw new ApiError(503, 'The AI assistant is temporarily disabled', { code: 'AI_DISABLED' });
  if (!s.enabled) throw new ApiError(403, 'The AI assistant is not enabled for this workspace', { code: 'AI_NOT_ENABLED' });
  if (!s.consent) throw new ApiError(403, 'A workspace administrator must consent to AI processing first', { code: 'AI_CONSENT_REQUIRED' });
  if (!s.providerConfigured) throw new ApiError(501, 'AI is not configured on this platform', { code: AI_ERROR_CODES.NOT_CONFIGURED });
  if (consume) await usageService.checkAndConsume({ tenantId, metric: 'aiQuestionsPerDay', by: actorId });
  return getAiProvider();
}

export default { check, status, AI_FLAGS };
