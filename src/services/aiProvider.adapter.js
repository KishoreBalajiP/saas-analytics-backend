/**
 * AI provider adapter (ai-ask, roadmap 4.A2; owner of the AI provider contract).
 *
 * Modelled on paymentProvider.adapter.js: a provider-neutral boundary with
 * an honest `noop` default (callers answer 501 AI_NOT_CONFIGURED) and an
 * `anthropic` provider on the official @anthropic-ai/sdk.
 *
 * CONTRACT
 *   getAiProvider() -> { name, isImplemented, plan(args), narrate(args), setSdkFactory(fn) }
 *   plan/narrate({ system, prompt, schema, maxTokens }) ->
 *     { ok: true, output, usage, stopReason }               structured output, parsed
 *     { ok: false, reason: 'refusal'|'max_tokens'|'invalid_output', usage, stopReason }
 *   Transport failures throw ApiError 502 AI_PROVIDER_ERROR / 504 AI_TIMEOUT
 *   with a generic message: provider payloads, prompts and keys are never echoed.
 *
 * SDK USE
 *   messages.create with adaptive thinking, `output_config.format`
 *   (json_schema) and an explicit stop_reason check before reading content.
 *   The stable system prompt is sent as a cached block (prompt caching).
 *   Tests inject a fake client through setSdkFactory; nothing here reaches
 *   the network unless AI_PROVIDER=anthropic with a key.
 */

// The SDK is loaded on first use, so the app starts (with the noop
// provider) on installs that do not have @anthropic-ai/sdk.
let Anthropic = null;
async function loadSdk() {
  if (!Anthropic) Anthropic = (await import('@anthropic-ai/sdk')).default;
  return Anthropic;
}
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';

export const AI_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  TIMEOUT: 'AI_TIMEOUT',
});

const defaultFactory = async ({ apiKey, timeoutMs }) => new (await loadSdk())({ apiKey, timeout: timeoutMs, maxRetries: 1 });
let sdkFactory = defaultFactory;
let client = null;

export function setSdkFactory(fn) {
  sdkFactory = typeof fn === 'function' ? fn : defaultFactory;
  client = null;
}

async function sdk() {
  if (!client) client = await sdkFactory({ apiKey: env.ai.apiKey, timeoutMs: env.ai.timeoutMs });
  return client;
}

function usageOf(response) {
  const u = response?.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

async function structuredCall({ system, prompt, schema, maxTokens }) {
  let response;
  try {
    response = await (await sdk()).messages.create({
      model: env.ai.model,
      max_tokens: Math.min(maxTokens ?? env.ai.maxOutputTokens, env.ai.maxOutputTokens),
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err?.name === 'APIConnectionTimeoutError' || (Anthropic && err instanceof Anthropic.APIConnectionTimeoutError)) {
      throw new ApiError(504, 'The AI provider timed out', { code: AI_ERROR_CODES.TIMEOUT });
    }
    throw new ApiError(502, 'The AI provider could not answer', { code: AI_ERROR_CODES.PROVIDER_ERROR });
  }
  const usage = usageOf(response);
  const stopReason = response?.stop_reason ?? null;
  if (stopReason === 'refusal' || stopReason === 'max_tokens') return { ok: false, reason: stopReason, usage, stopReason };
  const text = (response?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { ok: true, output: JSON.parse(text), usage, stopReason };
  } catch {
    return { ok: false, reason: 'invalid_output', usage, stopReason };
  }
}

const notConfigured = async () => {
  throw new ApiError(501, 'AI is not configured on this platform', { code: AI_ERROR_CODES.NOT_CONFIGURED });
};

const providers = {
  noop: { name: 'noop', isImplemented: false, plan: notConfigured, narrate: notConfigured, setSdkFactory },
  anthropic: { name: 'anthropic', isImplemented: true, plan: structuredCall, narrate: structuredCall, setSdkFactory },
};

let forced = null;
/** Tests: force a provider by name (null restores the configured one). */
export function _forceProvider(name) { forced = name; }

/** The configured provider (unknown names fall back to noop). */
export function getAiProvider() {
  return providers[forced ?? env.ai.provider] ?? providers.noop;
}

/** Tests: provider by name, independent of env. */
export function _providerByName(name) {
  return providers[name] ?? providers.noop;
}

export default { getAiProvider, setSdkFactory, AI_ERROR_CODES };
