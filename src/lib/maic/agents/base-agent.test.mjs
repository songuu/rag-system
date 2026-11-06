import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//u.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { BaseAgent } = await import('./base-agent.ts');
const state = { P_t: 0, H_t: [{ speaker_name: '学生', content: '请解释一下' }] };
const action = { type: 'AskQuestion', value: { question: '为什么？' } };

test('classroom speech uses the neutral client and preserves domain output', async () => {
  const controller = new AbortController();
  const agent = new BaseAgent('teacher', 0.7, { async complete(request) {
    assert.equal(request.operation, 'maic.classroom.respond');
    assert.equal(request.signal, controller.signal);
    assert.equal(request.messages[0].role, 'system');
    assert.match(request.messages[1].content, /学生: 请解释一下/);
    assert.match(request.messages[1].content, /为什么？/);
    return { text: '共同讨论一下。' };
  } });
  const result = await agent.respond(state, action, undefined, { signal: controller.signal });
  assert.equal(result.speaker, 'teacher');
  assert.equal(result.content, '共同讨论一下。');
  assert.deepEqual(result.action, action);
});

test('provider failure retains the classroom fallback', async () => {
  const agent = new BaseAgent('teacher', 0.7, { async complete() { throw new Error('offline'); } });
  assert.equal((await agent.respond(state, action, undefined)).content, '为什么？');
});

test('classroom cancellation never becomes a fallback utterance', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  const agent = new BaseAgent('teacher', 0.7, { async complete() {
    controller.abort(reason);
    throw reason;
  } });
  await assert.rejects(agent.respond(state, action, undefined, { signal: controller.signal }), error => error === reason);
});
