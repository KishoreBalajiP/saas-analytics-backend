import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _providerByName,
  setSdkFactory,
  AI_ERROR_CODES,
} from '../src/services/aiProvider.adapter.js';

const request = { system: 'system', prompt: 'prompt', schema: { type: 'object' }, maxTokens: 100 };

afterEach(() => setSdkFactory(null));

test('Gemini adapter parses structured JSON and usage metadata', async () => {
  setSdkFactory(async () => ({
    models: {
      generateContent: async () => ({
        text: '{"ok":true}',
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 },
      }),
    },
  }));
  const result = await _providerByName('gemini').plan(request);
  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 3, cacheReadTokens: 0 });
});

test('Gemini adapter rejects malformed structured output without fabricating a result', async () => {
  setSdkFactory(async () => ({ models: { generateContent: async () => ({ text: 'not-json' }) } }));
  const result = await _providerByName('gemini').plan(request);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_output');
});

test('Gemini adapter maps provider and timeout failures to safe error codes', async () => {
  setSdkFactory(async () => ({ models: { generateContent: async () => { throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' }); } } }));
  await assert.rejects(_providerByName('gemini').plan(request), (err) => err.code === AI_ERROR_CODES.TIMEOUT);

  setSdkFactory(async () => ({ models: { generateContent: async () => { throw new Error('provider rejected request'); } } }));
  await assert.rejects(_providerByName('gemini').plan(request), (err) => err.code === AI_ERROR_CODES.PROVIDER_ERROR);
});

test('noop provider fails clearly when no Gemini key/provider is configured', async () => {
  await assert.rejects(_providerByName('noop').plan(request), (err) => err.code === AI_ERROR_CODES.NOT_CONFIGURED);
});
