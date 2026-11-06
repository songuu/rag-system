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
const { createLLM } = await import('../model-config.ts');

test('Ollama sends the common output budget in its actual transport request', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: 'budget-fixture', message: { role: 'assistant', content: 'Answer' },
      done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 }) + '\n');
  };
  const model = createLLM('budget-fixture', { provider: 'ollama', requestSignal: new AbortController().signal,
    maxTokens: 77, options: { numPredict: 999 } });
  await model.invoke('Question');
  assert.equal(body.options.num_predict, 77, 'provider extras must not loosen the common output budget');
});

test('invalid explicit output budgets fail before any provider call', () => {
  for (const maxTokens of [0, -1, 1.5, Infinity, NaN, 65537]) {
    assert.throws(() => createLLM('invalid-budget', { provider: 'ollama', maxTokens }), /maxTokens/);
  }
});

test('request-owned transports cancel before the first response without cancelling another request', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const pending = [];
  globalThis.fetch = (_url, init) => new Promise((resolve, reject) => {
    const rejectAbort = () => reject(init.signal.reason);
    init.signal.addEventListener('abort', rejectAbort, { once: true });
    pending.push({ signal: init.signal, resolve: () => {
      init.signal.removeEventListener('abort', rejectAbort);
      resolve(new Response(JSON.stringify({ model: 'cancel-fixture', message: { role: 'assistant', content: 'Second' },
        done: true, done_reason: 'stop' }) + '\n'));
    } });
    if (init.signal.aborted) rejectAbort();
  });
  const first = new AbortController(); const second = new AbortController();
  const modelA = createLLM('cancel-fixture', { provider: 'ollama', requestSignal: first.signal, requestTimeoutMs: 1000 });
  const modelB = createLLM('cancel-fixture', { provider: 'ollama', requestSignal: second.signal, requestTimeoutMs: 1000 });
  assert.notEqual(modelA, modelB);
  const operationA = modelA.invoke('First', { signal: first.signal });
  const rejected = assert.rejects(operationA, error => error.name === 'AbortError');
  const operationB = modelB.invoke('Second', { signal: second.signal });
  while (pending.length < 1) await new Promise(resolve => setImmediate(resolve));
  first.abort();
  assert.equal(pending[0].signal.aborted, true);
  await rejected;
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve();
  await rejected;
  assert.equal((await operationB).content, 'Second');
});

test('truncated provider answers are not accepted as complete answers', async () => {
  const { assertCompleteAnswer } = await import('./answer-output.ts');
  for (const response_metadata of [{ done_reason: 'length' }, { finish_reason: 'length' }, { finish_reason: 'max_tokens' }]) {
    assert.throws(() => assertCompleteAnswer({ content: 'Incomplete', response_metadata }),
      error => error.code === 'RAG_GENERATION_OUTPUT_LIMIT');
  }
  assert.doesNotThrow(() => assertCompleteAnswer({ content: 'Complete', response_metadata: { done_reason: 'stop' } }));
  assert.doesNotThrow(() => assertCompleteAnswer({ content: 'No supplied metadata' }));
});
