/** Provider-neutral AI boundary. Gemini is the only supported network provider. */
import env, { GEMINI_MODEL_PATTERN } from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

export const AI_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  PROVIDER_UNSUPPORTED: 'AI_PROVIDER_UNSUPPORTED',
  API_KEY_MISSING: 'AI_API_KEY_MISSING',
  MODEL_INVALID: 'AI_MODEL_INVALID',
  AUTH_FAILED: 'AI_AUTH_FAILED',
  MODEL_UNAVAILABLE: 'AI_MODEL_UNAVAILABLE',
  RATE_LIMITED: 'AI_RATE_LIMITED',
  UNREACHABLE: 'AI_PROVIDER_UNREACHABLE',
  PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  TIMEOUT: 'AI_TIMEOUT',
});

/**
 * What is wrong with the AI configuration, if anything (first problem wins).
 * Never includes the key; the model id is reported only as valid/invalid.
 *   NOT_CONFIGURED       AI_PROVIDER unset or `noop`
 *   PROVIDER_UNSUPPORTED AI_PROVIDER set to a name this build does not know
 *   API_KEY_MISSING      gemini without AI_API_KEY
 *   MODEL_INVALID        AI_MODEL is not a Gemini model id
 */
export function diagnoseAiConfig(cfg = env.ai) {
  const provider = cfg.provider || 'noop';
  const keyPresent = Boolean(cfg.apiKey);
  const modelValid = provider !== 'gemini' || GEMINI_MODEL_PATTERN.test(cfg.model ?? '');
  let problem = null;
  if (provider === 'noop') problem = AI_ERROR_CODES.NOT_CONFIGURED;
  else if (provider !== 'gemini') problem = AI_ERROR_CODES.PROVIDER_UNSUPPORTED;
  else if (!keyPresent) problem = AI_ERROR_CODES.API_KEY_MISSING;
  else if (!modelValid) problem = AI_ERROR_CODES.MODEL_INVALID;
  return { provider, keyPresent, modelValid, ready: problem === null, problem };
}

/** Operator-facing explanation of a configuration problem (no values echoed). */
export const AI_CONFIG_ACTIONS = Object.freeze({
  [AI_ERROR_CODES.NOT_CONFIGURED]:
    'No AI provider is configured. A platform operator must set AI_PROVIDER=gemini and AI_API_KEY on the backend.',
  [AI_ERROR_CODES.PROVIDER_UNSUPPORTED]:
    'AI_PROVIDER is set to a provider this backend does not support. A platform operator must set AI_PROVIDER=gemini.',
  [AI_ERROR_CODES.API_KEY_MISSING]:
    'AI_PROVIDER is gemini but AI_API_KEY is empty. A platform operator must set the Gemini API key on the backend.',
  [AI_ERROR_CODES.MODEL_INVALID]:
    'AI_MODEL is not a Gemini model id. A platform operator must set AI_MODEL to a Gemini model (for example gemini-2.5-flash).',
});

let GoogleGenAI = null;
async function loadSdk() {
  if (!GoogleGenAI) ({ GoogleGenAI } = await import('@google/genai'));
  return GoogleGenAI;
}

const defaultFactory = async ({ apiKey, timeoutMs }) => {
  const Client = await loadSdk();
  return new Client({ apiKey, httpOptions: { timeout: timeoutMs } });
};
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
  const u = response?.usageMetadata ?? response?.usage ?? {};
  return {
    inputTokens: u.promptTokenCount ?? u.inputTokens ?? u.input_tokens ?? 0,
    outputTokens: u.candidatesTokenCount ?? u.outputTokens ?? u.output_tokens ?? 0,
    cacheReadTokens: u.cachedContentTokenCount ?? u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0,
  };
}

function isTimeout(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timeout|timed out/i.test(err?.message ?? '');
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Map an SDK failure to a typed, tenant-safe error. The SDK's ApiError has
 * the HTTP status in `status` and Google's error status in the message
 * (PERMISSION_DENIED, NOT_FOUND, RESOURCE_EXHAUSTED, "API key not valid").
 * Provider messages are never passed through; only the class is logged.
 */
export function classifyProviderError(err) {
  const status = Number(err?.status ?? err?.response?.status) || null;
  const text = String(err?.message ?? '');
  const netCode = err?.cause?.code ?? err?.code;
  let code;
  if (isTimeout(err)) code = AI_ERROR_CODES.TIMEOUT;
  else if (status === 401 || status === 403 || /api[_ ]key[_ ]?(not[_ ]valid|invalid)|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) code = AI_ERROR_CODES.AUTH_FAILED;
  else if (status === 404 || /\bNOT_FOUND\b|is not found for API version|not supported for generateContent/i.test(text)) code = AI_ERROR_CODES.MODEL_UNAVAILABLE;
  else if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(text)) code = AI_ERROR_CODES.RATE_LIMITED;
  else if (!status && (NETWORK_CODES.has(netCode) || /fetch failed|network|socket hang up/i.test(text))) code = AI_ERROR_CODES.UNREACHABLE;
  else code = AI_ERROR_CODES.PROVIDER_ERROR;
  switch (code) {
    case AI_ERROR_CODES.TIMEOUT:
      return new ApiError(504, 'The AI provider timed out', { code });
    case AI_ERROR_CODES.AUTH_FAILED:
      return new ApiError(502, 'The AI provider rejected the platform credentials. Ask your platform operator to check the AI configuration.', { code });
    case AI_ERROR_CODES.MODEL_UNAVAILABLE:
      return new ApiError(502, 'The configured AI model is not available from the provider. Ask your platform operator to check AI_MODEL.', { code });
    case AI_ERROR_CODES.RATE_LIMITED:
      return new ApiError(429, 'The AI provider is rate limiting requests or its quota is used up. Try again later.', { code });
    case AI_ERROR_CODES.UNREACHABLE:
      return new ApiError(503, 'The AI provider could not be reached. Try again later.', { code });
    default:
      return new ApiError(502, 'The AI provider could not answer', { code });
  }
}

async function structuredCall({ system, prompt, schema, maxTokens }) {
  let response;
  try {
    const request = (await sdk()).models.generateContent({
      model: env.ai.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseSchema: schema,
        maxOutputTokens: Math.min(maxTokens ?? env.ai.maxOutputTokens, env.ai.maxOutputTokens),
      },
    });
    response = await Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('AI timeout'), { name: 'TimeoutError' })), env.ai.timeoutMs)),
    ]);
  } catch (err) {
    const mapped = classifyProviderError(err);
    logger.warn({ aiErrorCode: mapped.code, providerStatus: Number(err?.status) || null, model: env.ai.model }, 'ai provider call failed');
    throw mapped;
  }
  const usage = usageOf(response);
  const finishReason = response?.candidates?.[0]?.finishReason ?? response?.finishReason ?? response?.stop_reason ?? null;
  if (['SAFETY', 'RECITATION', 'MAX_TOKENS', 'REFUSAL'].includes(String(finishReason).toUpperCase())) {
    return { ok: false, reason: String(finishReason).toLowerCase(), usage, stopReason: finishReason };
  }
  const text = typeof response?.text === 'function'
    ? response.text()
    : response?.text ?? response?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
      ?? response?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { ok: true, output: JSON.parse(text), usage, stopReason: finishReason };
  } catch {
    return { ok: false, reason: 'invalid_output', usage, stopReason: finishReason };
  }
}

const notConfigured = async () => {
  throw new ApiError(501, 'AI is not configured on this platform', { code: AI_ERROR_CODES.NOT_CONFIGURED });
};


const providers = {
  noop: { name: 'noop', isImplemented: false, plan: notConfigured, narrate: notConfigured, setSdkFactory },
  gemini: { name: 'gemini', isImplemented: true, plan: structuredCall, narrate: structuredCall, setSdkFactory },
};

let forced = null;
export function _forceProvider(name) { forced = name; }
/** Diagnosis of the live configuration (a provider forced by tests counts as keyed). */
export function aiConfigDiagnosis() {
  return forced ? diagnoseAiConfig({ provider: forced, apiKey: 'forced', model: env.ai.model }) : diagnoseAiConfig();
}
export function getAiProvider() { return providers[forced ?? env.ai.provider] ?? providers.noop; }
export function _providerByName(name) { return providers[name] ?? providers.noop; }

export default { getAiProvider, setSdkFactory, diagnoseAiConfig, aiConfigDiagnosis, classifyProviderError, AI_ERROR_CODES };
