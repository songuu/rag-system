import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessageChunk } from '@langchain/core/messages';
import { streamAnswerMessage } from './answer-stream.ts';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function* chunks(values) { for (const value of values) yield new AIMessageChunk(value); }

test('emits provider text before completion and aggregates the final stop reason and usage', async () => {
  const finish = deferred(); const first = deferred(); const deltas = [];
  const controller = new AbortController();
  const result = streamAnswerMessage({ signal: controller.signal, onDelta: text => { deltas.push(text); first.resolve(); },
    stream: async signal => { assert.equal(signal, controller.signal); return (async function* () {
      yield new AIMessageChunk({ id: 'answer-1', content: '真实' });
      await finish.promise;
      yield new AIMessageChunk({ content: '增量', response_metadata: { done_reason: 'stop' },
        usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
    })(); },
  });
  await first.promise;
  assert.deepEqual(deltas, ['真实']);
  finish.resolve();
  const message = await result;
  assert.equal(message.id, 'answer-1');
  assert.equal(message.content, '真实增量');
  assert.equal(message.response_metadata.done_reason, 'stop');
  assert.equal(message.usage_metadata.input_tokens, 10);
  assert.equal(message.usage_metadata.output_tokens, 2);
  assert.equal(message.usage_metadata.total_tokens, 12);
});

test('emits only answer text, suppressing reasoning blocks, metadata and split inline reasoning', async () => {
  const deltas = [];
  const message = await streamAnswerMessage({ signal: new AbortController().signal, onDelta: text => deltas.push(text),
    stream: async () => chunks([
      { content: [{ type: 'reasoning', reasoning: 'private block' }, { type: 'text', text: '<thi' }],
        additional_kwargs: { reasoning_content: 'private metadata' } },
      { content: 'nk>private inline<analysis>nested</analysis></th' },
      { content: 'ink>可见' },
      { content: [{ type: 'image_url', image_url: 'private image' }, { type: 'output_text', text: '正文' }] },
      { content: '', response_metadata: { finish_reason: 'stop' } },
    ]),
  });
  assert.equal(deltas.join(''), '可见正文');
  assert.equal(message.content, '可见正文');
  assert.equal(message.additional_kwargs.reasoning_content, 'private metadata');
});

test('preserves token-limit termination metadata for the final completeness check', async () => {
  const message = await streamAnswerMessage({ signal: new AbortController().signal, onDelta() {},
    stream: async () => chunks([{ content: 'fragment' }, { content: '', response_metadata: { finish_reason: 'length' } }]),
  });
  assert.equal(message.response_metadata.finish_reason, 'length');
});

test('a provider EOF without terminal metadata rejects its incomplete answer', async () => {
  await assert.rejects(streamAnswerMessage({ signal: new AbortController().signal, onDelta() {},
    stream: async () => chunks([{ content: 'incomplete fragment' }]),
  }), /terminal/i);
});

function responsesChunks(status, incompleteReason, answer = 'Responses answer') {
  // Match installed @langchain/openai converters/responses.js: completed and
  // incomplete copy status/details to response_metadata, with no finish_reason.
  return chunks([
    { content: [{ type: 'text', text: answer, index: 0 }] },
    { content: [], response_metadata: { model_provider: 'openai', model: 'gpt-5.4-pro', status,
      incomplete_details: incompleteReason ? { reason: incompleteReason } : null },
      usage_metadata: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } },
  ]);
}

test('accepts Responses completed metadata without a finish reason', async () => {
  const result = await streamAnswerMessage({ signal: new AbortController().signal, onDelta() {},
    stream: async () => responsesChunks('completed'),
  });
  assert.equal(result.content, 'Responses answer');
  assert.equal(result.response_metadata.status, 'completed');
  assert.equal(result.response_metadata.finish_reason, undefined);
  assert.equal(result.usage_metadata.input_tokens, 7);
  assert.equal(result.usage_metadata.output_tokens, 2);
});

test('maps Responses max_output_tokens to the existing length rejection contract', async () => {
  const result = await streamAnswerMessage({ signal: new AbortController().signal, onDelta() {},
    stream: async () => responsesChunks('incomplete', 'max_output_tokens'),
  });
  assert.equal(result.response_metadata.status, 'incomplete');
  assert.deepEqual(result.response_metadata.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(result.response_metadata.finish_reason, 'length');
  assert.equal(result.usage_metadata.output_tokens, 2);
});

test('preserves output-limit metadata when reasoning consumed the entire answer budget', async () => {
  const result = await streamAnswerMessage({ signal: new AbortController().signal, onDelta() { assert.fail('no answer text'); },
    stream: async () => responsesChunks('incomplete', 'max_output_tokens', ''),
  });
  assert.equal(result.content, '');
  assert.equal(result.response_metadata.finish_reason, 'length');
});

test('rejects filtered, failed, contradictory and unknown terminal provider states', async () => {
  for (const metadata of [
    { finish_reason: 'content_filter' }, { done_reason: 'tool_calls' }, { finish_reason: 'future_reason' },
    { status: 'failed', finish_reason: 'stop' }, { status: 'cancelled' }, { status: 'in_progress' },
    { status: 'future_status' }, { status: 'incomplete' },
    { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
    { status: 'completed', finish_reason: 'content_filter' },
  ]) {
    await assert.rejects(streamAnswerMessage({ signal: new AbortController().signal, onDelta() {},
      stream: async () => chunks([{ content: 'fragment', response_metadata: metadata }]),
    }), /terminal/i, JSON.stringify(metadata));
  }
});

test('preserves ordinary text ending with a possible reasoning tag prefix', async () => {
  const deltas = [];
  const result = await streamAnswerMessage({ signal: new AbortController().signal, onDelta: text => deltas.push(text),
    stream: async () => chunks([{ content: '比较运算符是 <' }, { content: '', response_metadata: { done_reason: 'stop' } }]),
  });
  assert.equal(result.content, '比较运算符是 <');
  assert.equal(deltas.join(''), result.content);
});

test('rejects tool calls without emitting their text or arguments', async () => {
  const deltas = [];
  await assert.rejects(streamAnswerMessage({ signal: new AbortController().signal, onDelta: text => deltas.push(text),
    stream: async () => chunks([{ content: 'private tool preface',
      tool_call_chunks: [{ name: 'read_private', args: '{"secret":true}', id: 'tool-1', index: 0 }] }]),
  }), /tool call/i);
  assert.deepEqual(deltas, []);
});

test('rejects pre-aborted work without opening a provider stream', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(streamAnswerMessage({ signal: controller.signal, onDelta() { assert.fail('late delta'); },
    stream: async () => { assert.fail('provider must not start'); },
  }), { name: 'AbortError' });
});

test('late chunks after cancellation are suppressed and iterator cleanup is awaited', async () => {
  const controller = new AbortController(); const started = deferred(); const deliver = deferred();
  const release = deferred(); const cleanup = deferred(); const deltas = []; let settled = false;
  const result = streamAnswerMessage({ signal: controller.signal, onDelta: text => deltas.push(text),
    stream: async () => ({ [Symbol.asyncIterator]() { return {
      async next() { started.resolve(); await deliver.promise; return { value: new AIMessageChunk('late'), done: false }; },
      async return() { cleanup.resolve(); await release.promise; return { done: true }; },
    }; } }),
  });
  const rejected = assert.rejects(result, { name: 'AbortError' }).then(() => { settled = true; });
  await started.promise; controller.abort(); deliver.resolve(); await cleanup.promise;
  assert.deepEqual(deltas, []); assert.equal(settled, false);
  release.resolve(); await rejected;
});

test('an aborted stream that quietly ends cannot become a completed answer', async () => {
  const controller = new AbortController();
  await assert.rejects(streamAnswerMessage({ signal: controller.signal, onDelta() {}, stream: async () => (async function* () {
    yield new AIMessageChunk('draft'); controller.abort();
  })() }), { name: 'AbortError' });
});

test('empty and excessive provider streams fail explicitly', async () => {
  await assert.rejects(streamAnswerMessage({ signal: new AbortController().signal, onDelta() {}, stream: async () => chunks([]) }), /empty/i);
  const deltas = [];
  await assert.rejects(streamAnswerMessage({ signal: new AbortController().signal, onDelta: text => deltas.push(text),
    stream: async () => chunks([{ content: 'x'.repeat(256 * 1024 + 1) }]),
  }), /limit/i);
  assert.deepEqual(deltas, []);
});
