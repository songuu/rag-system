import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//u.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { createLangChainTextModelClient } = await import('./langchain-text-model.ts');
const { TextModelError } = await import('./text-model.ts');
const { AIMessage } = await import('@langchain/core/messages');

const request = { operation: 'report.chat', messages: [{ role: 'user', content: 'Question' }] };

test('passes messages and signal without exposing framework messages', async () => {
  const controller = new AbortController();
  const client = createLangChainTextModelClient({ async invoke(messages, options) {
    assert.deepEqual(messages, request.messages);
    assert.equal(options.signal, controller.signal);
    return { content: 'Answer', response_metadata: { finish_reason: 'stop' },
      usage_metadata: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } };
  } });
  assert.deepEqual(await client.complete({ ...request, signal: controller.signal }), {
    text: 'Answer', stopReason: 'stop',
    usage: { measurement: 'provider', inputTokenCount: 12, outputTokenCount: 3 },
  });
});

test('extracts text blocks without leaking reasoning or metadata', async () => {
  const client = createLangChainTextModelClient({ async invoke() {
    return { content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'First' },
      { type: 'image', url: 'PRIVATE' }, { type: 'text', text: 'Second' }],
    response_metadata: { done_reason: 'length', secret: 'PRIVATE' } };
  } });
  assert.deepEqual(await client.complete(request), {
    text: 'First\nSecond', stopReason: 'length', usage: { measurement: 'unavailable' },
  });
});

test('does not invent missing or invalid token counts', async () => {
  for (const [metadata, usage] of [
    [undefined, { measurement: 'unavailable' }],
    [{ input_tokens: 0 }, { measurement: 'partial', inputTokenCount: 0 }],
    [{ output_tokens: 8 }, { measurement: 'partial', outputTokenCount: 8 }],
    [{ input_tokens: -1, output_tokens: NaN }, { measurement: 'unavailable' }],
    [{ input_tokens: '12', output_tokens: 1.5 }, { measurement: 'unavailable' }],
  ]) {
    const client = createLangChainTextModelClient({ async invoke() {
      return { content: 'Answer', usage_metadata: metadata };
    } });
    assert.deepEqual((await client.complete(request)).usage, usage);
  }
});

test('pre-cancelled calls never start a provider request', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  controller.abort(reason);
  let calls = 0;
  const client = createLangChainTextModelClient({ async invoke() { calls++; } });
  await assert.rejects(client.complete({ ...request, signal: controller.signal }), error => error === reason);
  assert.equal(calls, 0);
});

test('a cancelled call cannot return a late provider result', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const client = createLangChainTextModelClient({ async invoke() {
    controller.abort(reason);
    return { content: 'Late answer' };
  } });
  await assert.rejects(client.complete({ ...request, signal: controller.signal }), error => error === reason);
});

test('preserves provider AbortError without retrying', async () => {
  const reason = new DOMException('cancelled', 'AbortError');
  let calls = 0;
  const client = createLangChainTextModelClient({ async invoke() { calls++; throw reason; } });
  await assert.rejects(client.complete(request), error => error === reason);
  assert.equal(calls, 1);
});

test('provider failures carry operation and cause without copying provider text', async () => {
  const cause = new Error('PRIVATE provider credential');
  let calls = 0;
  const client = createLangChainTextModelClient({ async invoke() { calls++; throw cause; } });
  await assert.rejects(client.complete(request), error => {
    assert.ok(error instanceof TextModelError);
    assert.equal(error.code, 'MODEL_INVOCATION_FAILED');
    assert.equal(error.operation, 'report.chat');
    assert.equal(error.cause, cause);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  assert.equal(calls, 1);
});

test('rejects non-text results and unexpected tool requests', async () => {
  for (const response of [
    { content: { text: 'not a message' } },
    { content: [{ type: 'thinking', thinking: 'PRIVATE' }] },
    { content: 'Partial answer', tool_calls: [{ name: 'write' }] },
    new AIMessage({ content: 'Partial text', additional_kwargs: {
      function_call: { name: 'write', arguments: '{}' },
    } }),
    { content: '', additional_kwargs: { function_call: { name: 'write', arguments: '{}' } } },
    { content: 'Partial answer', additional_kwargs: { tool_calls: [{ function: { name: 'write' } }] } },
  ]) {
    const client = createLangChainTextModelClient({ async invoke() { return response; } });
    await assert.rejects(client.complete(request), { code: 'MODEL_RESPONSE_INVALID' });
  }
});
