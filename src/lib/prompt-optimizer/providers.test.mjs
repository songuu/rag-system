import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const { resolveProviderRuntime, requestOptimization } = await import('./providers.ts');
const profile = { profileId: 'p1', name: 'Local', provider: 'ollama', model: 'qwen3:8b', baseUrl: null, settings: {} };

test('Ollama is local-development only and constrained to loopback', () => {
  assert.equal(resolveProviderRuntime(profile, { NODE_ENV: 'development' }).endpoint, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.throws(() => resolveProviderRuntime(profile, { NODE_ENV: 'production' }), /development only/i);
  assert.throws(() => resolveProviderRuntime({ ...profile, baseUrl: 'http://10.0.0.8:11434/v1' }, { NODE_ENV: 'development' }), /loopback/i);
});

test('production compatible endpoints require an HTTPS origin allowlist', () => {
  const compatible = { ...profile, provider: 'compatible', baseUrl: 'https://models.example.com/v1' };
  assert.throws(() => resolveProviderRuntime(compatible, { NODE_ENV: 'production' }), /allowlist/i);
  assert.equal(resolveProviderRuntime(compatible, {
    NODE_ENV: 'production', PROMPT_OPTIMIZER_ALLOWED_MODEL_ORIGINS: 'https://models.example.com',
    PROMPT_OPTIMIZER_COMPATIBLE_API_KEY: 'secret',
  }).endpoint, 'https://models.example.com/v1/chat/completions');
});

test('compatible endpoints reject embedded credentials and require allowlisting outside loopback', () => {
  const compatible = { ...profile, provider: 'compatible', baseUrl: 'https://internal.example/v1' };
  assert.throws(() => resolveProviderRuntime(compatible, { NODE_ENV: 'development', PROMPT_OPTIMIZER_COMPATIBLE_API_KEY: 'x' }), /allowlist/i);
  assert.throws(() => resolveProviderRuntime({ ...compatible, baseUrl: 'https://user:secret@internal.example/v1' }, { NODE_ENV: 'development', PROMPT_OPTIMIZER_ALLOWED_MODEL_ORIGINS: 'https://internal.example', PROMPT_OPTIMIZER_COMPATIBLE_API_KEY: 'x' }), /invalid/i);
});

test('requestOptimization sends bounded settings and returns only model content', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"prompt":"better"}' } }] }), { status: 200 });
  };
  const result = await requestOptimization(
    { ...profile, provider: 'openai', model: 'gpt-4.1-mini', settings: { temperature: 0.4, maxTokens: 900 } },
    [{ role: 'user', content: 'improve this' }],
    { PROMPT_OPTIMIZER_OPENAI_API_KEY: 'secret' }, fetcher
  );
  assert.equal(result, '{"prompt":"better"}');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].init.body).max_tokens, 900);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
});

test('compatible providers do not receive OpenAI-specific JSON response format', async () => {
  let requestBody;
  await requestOptimization(
    { ...profile, provider: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1' },
    [{ role: 'user', content: 'improve this' }],
    { NODE_ENV: 'development', PROMPT_OPTIMIZER_COMPATIBLE_API_KEY: 'secret' },
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'better' } }] }), { status: 200 });
    }
  );
  assert.equal(Object.hasOwn(requestBody, 'response_format'), false);
});
