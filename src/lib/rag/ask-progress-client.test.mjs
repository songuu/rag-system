import assert from 'node:assert/strict';
import test from 'node:test';
const { readAskProgressResponse } = await import('./ask-progress-client.ts');
function stream(parts) { return new Response(new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode(parts.join(''));
  // Split inside Chinese UTF-8 sequences as real network packets can do.
  for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } }); }

test('ordered answer drafts are incremental and the final response remains authoritative', async () => {
  const deltas = [];
  const response = await readAskProgressResponse(stream([
    'event: status\ndata: {"stage":"accepted","state":"started","requestId":"draft"}\n\n',
    'event: answer_delta\ndata: {"requestId":"draft","sequence":1,"text":"中文"}\n\n',
    'event: answer_delta\ndata: {"requestId":"draft","sequence":2,"text":"草稿"}\n\n',
    'event: result\ndata: {"status":200,"body":{"success":true,"answer":"最终答案"}}\n\n',
  ]), { onAnswerDelta: delta => deltas.push(delta.text) });
  assert.deepEqual(deltas, ['中文', '草稿']);
  assert.equal((await response.json()).answer, '最终答案');
});

test('foreign, reordered and oversized drafts are rejected even without a draft callback', async () => {
  for (const payload of [
    { requestId: 'foreign', sequence: 1, text: 'secret' },
    { requestId: 'draft', sequence: 2, text: 'gap' },
    { requestId: 'draft', sequence: 1, text: '' },
    { requestId: 'draft', sequence: 1, text: 'x'.repeat(16 * 1024 + 1) },
  ]) {
    await assert.rejects(readAskProgressResponse(stream([
      'event: status\ndata: {"stage":"accepted","state":"started","requestId":"draft"}\n\n',
      `event: answer_delta\ndata: ${JSON.stringify(payload)}\n\n`,
      'event: result\ndata: {"status":200,"body":{"success":true}}\n\n',
    ])), /增量/);
  }
});

test('drafts never become a terminal success after a server error or disconnect', async () => {
  const parts = [
    'event: status\ndata: {"stage":"accepted","state":"started","requestId":"draft"}\n\n',
    'event: answer_delta\ndata: {"requestId":"draft","sequence":1,"text":"未完成"}\n\n',
  ];
  const failed = await readAskProgressResponse(stream([...parts,
    'event: error\ndata: {"status":502,"body":{"success":false,"code":"RAG_GENERATION_OUTPUT_LIMIT"}}\n\n',
  ]));
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).answer, undefined);
  await assert.rejects(readAskProgressResponse(stream(parts)), /中断/);
});
test('JSON remains unchanged', async () => {
  const response = Response.json({ success: true });
  assert.equal(await readAskProgressResponse(response), response);
});
test('reads split UTF-8 events and keeps the final validated JSON contract', async () => {
  const stages = [];
  const response = await readAskProgressResponse(stream([
    ': heartbeat\r\n\r\n', 'event: status\r\ndata: {"stage":"retrieval","state":"started"}\r\n\r\n',
    'event: result\ndata: {"status":200,"body":{"success":true,"answer":"已验证的中文答案"}}\n\n',
  ]), { onProgress: event => stages.push(event.stage) });
  assert.deepEqual(stages, ['retrieval']); assert.equal((await response.json()).answer, '已验证的中文答案');
});
test('a streamed 409 retains status for conversation identity invalidation', async () => {
  const response = await readAskProgressResponse(stream(['event: error\ndata: {"status":409,"body":{"success":false,"code":"CONVERSATION_PARTITION_MISMATCH"}}\n\n']));
  assert.equal(response.status, 409); assert.equal((await response.json()).success, false);
});

test('completed queue restores the enclosing generation progress', async () => {
  const stages = [];
  await readAskProgressResponse(stream([
    'event: status\ndata: {"stage":"generation","state":"started"}\n\n',
    'event: status\ndata: {"stage":"queue","state":"started"}\n\n',
    'event: status\ndata: {"stage":"queue","state":"completed"}\n\n',
    'event: result\ndata: {"status":200,"body":{"success":true}}\n\n',
  ]), { onProgress: progress => stages.push(progress.stage) });
  assert.deepEqual(stages, ['generation', 'queue', 'generation']);
});
test('missing terminal events and malformed terminal payloads fail explicitly', async () => {
  await assert.rejects(readAskProgressResponse(stream(['event: status\ndata: {"stage":"generation","state":"started"}\n\n'])), /中断/);
  await assert.rejects(readAskProgressResponse(stream(['event: result\ndata: {"status":200}\n\n'])), /无效/);
});
test('cancellation rejects without publishing a late result', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readAskProgressResponse(stream(['event: result\ndata: {"status":200,"body":{"success":true}}\n\n']), { signal: controller.signal }), { name: 'AbortError' });
});
