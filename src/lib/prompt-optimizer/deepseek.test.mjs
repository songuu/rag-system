import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const { requestOptimization, PromptOptimizerOutputLimitError, PromptOptimizerBusyError } = await import('./providers.ts');
const { promptOptimizerError } = await import('./http.ts');
const { PromptOptimizerService } = await import('./service.ts');
const profile = { profileId: 'p1', name: 'Test', provider: 'compatible', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', credential: 'test-secret', settings: { maxTokens: 1800 } };
const env = { NODE_ENV: 'production', PROMPT_OPTIMIZER_ALLOWED_MODEL_ORIGINS: 'https://api.deepseek.com' };
const response = (content, finishReason = 'stop') => Response.json({
  choices: [{ finish_reason: finishReason, message: { content, reasoning_content: 'private-reasoning' } }],
});

test('official DeepSeek uses non-thinking mode and retains the configured token budget', async () => {
  for (const [baseUrl, maxTokens] of [['https://api.deepseek.com', 1800], ['https://api.deepseek.com/v1', 1234]]) {
    let body;
    let calls = 0;
    const result = await requestOptimization({ ...profile, baseUrl, settings: { maxTokens } }, [], env, async (_url, init) => {
      body = JSON.parse(init.body);
      calls += 1;
      return body.thinking?.type === 'disabled' ? response('{"prompt":"better"}') : response('', 'length');
    });
    assert.equal(result, '{"prompt":"better"}');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, maxTokens);
    assert.equal(Object.hasOwn(body, 'response_format'), false);
    assert.equal(calls, 1);
  }
});

test('DeepSeek-specific parameters never reach compatible proxies or lookalike origins', async () => {
  for (const baseUrl of ['https://models.example.com/v1', 'https://api.deepseek.com.evil.example/v1']) {
    let body;
    await requestOptimization({ ...profile, baseUrl }, [], { ...env, PROMPT_OPTIMIZER_ALLOWED_MODEL_ORIGINS: new URL(baseUrl).origin }, async (_url, init) => {
      body = JSON.parse(init.body);
      return response('better');
    });
    assert.equal(Object.hasOwn(body, 'thinking'), false);
  }
});

test('OpenAI, OpenRouter and Ollama requests retain their existing parameter contract', async () => {
  for (const provider of ['openai', 'openrouter', 'ollama']) {
    let body;
    await requestOptimization({ ...profile, provider, baseUrl: null }, [], { NODE_ENV: 'development' }, async (_url, init) => {
      body = JSON.parse(init.body);
      return response('better');
    });
    assert.equal(Object.hasOwn(body, 'thinking'), false);
    assert.equal(Object.hasOwn(body, 'response_format'), provider === 'openai');
  }
});

test('reasoning-only and partial answers hit a safe actionable output-limit error', async () => {
  for (const content of ['', '{"prompt":"partial answer"}']) {
    let calls = 0;
    await assert.rejects(() => requestOptimization(profile, [], env, async () => {
      calls += 1;
      return response(content, 'length');
    }), error => {
      assert.ok(error instanceof PromptOptimizerOutputLimitError);
      assert.equal(error.code, 'MODEL_OUTPUT_TRUNCATED');
      assert.match(error.message, /Max tokens/);
      assert.doesNotMatch(error.message, /partial answer|private-reasoning/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('complete answers return final content without exposing reasoning', async () => {
  assert.equal(await requestOptimization(profile, [], env, async () => response('complete answer')), 'complete answer');
});

test('output-limit errors become 422 responses with a stable code and request ID', async () => {
  const http = promptOptimizerError(new PromptOptimizerOutputLimitError(), 'request-truncated');
  const body = await http.json();
  assert.equal(http.status, 422);
  assert.equal(body.success, false);
  assert.equal(body.code, 'MODEL_OUTPUT_TRUNCATED');
  assert.equal(body.requestId, 'request-truncated');
  assert.match(body.error, /Max tokens/);
  assert.match(body.error, /未保存/);
});

test('busy responses and unclassified error redaction remain unchanged', async () => {
  assert.equal(promptOptimizerError(new PromptOptimizerBusyError()).status, 429);
  const http = promptOptimizerError(new Error('upstream rejected Bearer secret-token'), 'request-unknown');
  assert.equal(http.status, 500);
  const body = await http.json();
  assert.equal(body.error, 'Prompt optimizer request failed.');
  assert.doesNotMatch(JSON.stringify(body), /secret-token/);
});

test('truncated provider output never creates a workspace or appends a version', async () => {
  for (const workspaceId of [undefined, 'existing-workspace']) {
    const writes = [];
    const service = new PromptOptimizerService({
      async getDefaultModelProfile() { return profile; },
      async createWorkspace() { writes.push('workspace'); return { workspace_id: 'new-workspace' }; },
      async appendVersion() { writes.push('version'); },
    }, (selected, messages) => requestOptimization(selected, messages, env, async () => response('{"prompt":"partial"}', 'length')));
    await assert.rejects(() => service.optimize({ prompt: 'test', workspaceId }), error => error instanceof PromptOptimizerOutputLimitError);
    assert.deepEqual(writes, []);
  }
});
