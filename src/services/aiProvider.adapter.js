/** Provider-neutral AI boundary. Gemini is the only supported network provider. */
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';

export const AI_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  TIMEOUT: 'AI_TIMEOUT',
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
    if (isTimeout(err)) throw new ApiError(504, 'The AI provider timed out', { code: AI_ERROR_CODES.TIMEOUT });
    throw new ApiError(502, 'The AI provider could not answer', { code: AI_ERROR_CODES.PROVIDER_ERROR });
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
export function getAiProvider() { return providers[forced ?? env.ai.provider] ?? providers.noop; }
export function _providerByName(name) { return providers[name] ?? providers.noop; }

export default { getAiProvider, setSdkFactory, AI_ERROR_CODES };
