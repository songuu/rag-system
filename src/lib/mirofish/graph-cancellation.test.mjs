import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const { createLLMFromOverride } = await import('./model-override.ts');

test('request-scoped Ollama models never share cached cancellation signals', () => {
  const override = { provider: 'ollama', modelName: 'graph-cancellation-model' };
  const first = createLLMFromOverride(override, { requestSignal: new AbortController().signal });
  const second = createLLMFromOverride(override, { requestSignal: new AbortController().signal });
  assert.notEqual(first, second);
  assert.equal(createLLMFromOverride(override), createLLMFromOverride(override));
});

test('Ollama cancellation closes HTTP before the first response token and permits recovery', { timeout: 5000 }, async t => {
  let received;
  let closed;
  const requestReceived = new Promise(resolve => { received = resolve; });
  const requestClosed = new Promise(resolve => { closed = resolve; });
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; }
    requests++;
    if (requests === 1) {
      response.on('close', () => closed(true));
      received();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(`${JSON.stringify({ model: 'graph-cancellation-model', message: { role: 'assistant', content: 'recovered' }, done: true })}\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const override = { provider: 'ollama', modelName: 'graph-cancellation-model', baseUrl: `http://127.0.0.1:${server.address().port}` };
  const controller = new AbortController();
  const llm = createLLMFromOverride(override, { requestTimeoutMs: 300_000, requestSignal: controller.signal });
  const pending = llm.invoke('cancel during loading', { signal: controller.signal });
  const rejected = assert.rejects(pending);
  await requestReceived;
  controller.abort(new Error('graph operation cancelled'));
  await rejected;
  let timer;
  try {
    assert.equal(await Promise.race([requestClosed, new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]), true);
  } finally { clearTimeout(timer); }
  const recovery = createLLMFromOverride(override, { requestSignal: new AbortController().signal });
  assert.equal((await recovery.invoke('retry')).content, 'recovered');
});
