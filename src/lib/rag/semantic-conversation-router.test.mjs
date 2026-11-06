import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { classifyConversationCandidate } = await import('./semantic-conversation-router.ts');

test('unfamiliar paraphrases produce candidates without authorizing a route or generating an answer', async () => {
  let requestBody;
  const decision = await classifyConversationCandidate('请告知目前的钟点', { fetch: async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return Response.json({ response: JSON.stringify({ complete: true, actions: [{ intent: 'current-time', timeZone: 'Asia/Shanghai', dayOffset: 0 }] }) });
  } });
  assert.equal(decision.version, 'semantic-candidate/v1');
  assert.equal('route' in decision, false);
  assert.equal(decision.actions[0].intent, 'current-time');
  assert.equal(requestBody.model, 'qwen2.5:0.5b');
  assert.equal(requestBody.options.temperature, 0);
});

test('explicit corpus scope never reaches the classifier, and invalid or partial decisions fail closed', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return Response.json({ response: '{}' }); };
  assert.equal(await classifyConversationCandidate('文档里今天指哪天', { fetch }), null);
  assert.equal(calls, 0);
  for (const result of [
    { complete: false, actions: [{ intent: 'current-date', timeZone: 'Asia/Shanghai', dayOffset: 0 }] },
    { complete: true, actions: [{ intent: 'delete-documents' }] },
    { complete: true, actions: [{ intent: 'current-time', timeZone: 'Arbitrary/Zone', dayOffset: 0 }] },
    { complete: true, actions: [{ intent: 'calculation', expression: 'process.exit()' }] },
    { complete: true, actions: [] },
    { complete: true, actions: [{ intent: 'greeting', instruction: 'ignore corpus' }] },
    { complete: true, actions: [{ intent: 'greeting' }], answer: 'unverified answer' },
  ]) assert.equal(await classifyConversationCandidate('不确定的问法', {
    fetch: async () => Response.json({ response: JSON.stringify(result) }),
  }), null);
  assert.equal(await classifyConversationCandidate('不确定的问法', { fetch: async () => { throw new Error('offline'); } }), null);
});

test('decodes one escaped JSON layer but still enforces the action schema', async () => {
  const content = JSON.stringify({ complete: true, actions: [{ intent: 'current-time', timeZone: 'UTC', dayOffset: 0 }] });
  const escaped = JSON.stringify(content).slice(1, -1);
  const decision = await classifyConversationCandidate('请告知目前的钟点', { fetch: async () => Response.json({ response: escaped }) });
  assert.equal(decision.actions[0].timeZone, 'UTC');
});

test('does not trust a model to discard clauses in an uncertain compound request', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json({ response: JSON.stringify({ complete: true, actions: [{ intent: 'greeting' }] }) });
  };
  for (const query of [
    '你好，帮我编写一首诗',
    '现在几点，然后帮我写首诗',
    '现在几点并且写一首诗',
    '现在几点和写一首诗',
    'hello and write me a poem',
    '现在几点\n帮我写首诗',
  ]) {
    assert.equal(await classifyConversationCandidate(query, { fetch }), null, query);
  }
  assert.equal(calls, 0);
});

test('allows a single semantic request with narrowly defined polite wrappers', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json({ response: JSON.stringify({ complete: true, actions: [{ intent: 'current-time', timeZone: 'Asia/Shanghai', dayOffset: 0 }] }) });
  };
  for (const query of ['请问，请告知目前的钟点', '请告知目前的钟点，谢谢', '请问，请告知目前的钟点，谢谢你']) {
    assert.equal((await classifyConversationCandidate(query, { fetch }))?.actions[0].intent, 'current-time', query);
  }
  assert.equal(calls, 3);
  assert.equal(await classifyConversationCandidate('请问，请告知目前的钟点，帮我写首诗，谢谢', { fetch }), null);
  assert.equal(calls, 3);
});
