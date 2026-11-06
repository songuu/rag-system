import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c); throw e;
} } });
const { executeAskRequest } = await import('./request-execution.ts');
const { observeAskStage, readAskProviderUsage, observeProviderInvocation } = await import('./provider-usage-observer.ts');
const observer = await import('./provider-usage-observer.ts');

test('only an explicitly eligible SSE operation emits ordered request-bound answer drafts', async () => {
  const response = await executeAskRequest(new Request('http://local', { headers: { accept: 'text/event-stream' } }), {
    requestId: 'draft', execute: async () => {
      observer.emitAskAnswerDelta('ineligible');
      await observer.withAskAnswerStreamingEnabled(async () => {
        assert.equal(observer.isAskAnswerStreamingEnabled(), true);
        observer.emitAskAnswerDelta('你好');
        observer.emitAskAnswerDelta('世界');
      });
      observer.emitAskAnswerDelta('after-scope');
      return Response.json({ success: true, answer: '你好世界' });
    },
  });
  const body = await response.text();
  assert.match(body, /event: answer_delta\ndata: {"requestId":"draft","sequence":1,"text":"你好"}/);
  assert.match(body, /"sequence":2,"text":"世界"/);
  assert.doesNotMatch(body, /ineligible|after-scope/);
  assert.ok(body.indexOf('event: answer_delta') < body.indexOf('event: result'));
});

test('JSON and cancelled or completed scopes cannot publish answer drafts', async () => {
  await executeAskRequest(new Request('http://local'), { requestId: 'json', execute: () =>
    observer.withAskAnswerStreamingEnabled(async () => {
      assert.equal(observer.isAskAnswerStreamingEnabled(), false);
      return Response.json({ success: true });
    }),
  });
  const controller = new AbortController();
  let late;
  const response = await executeAskRequest(new Request('http://local', {
    headers: { accept: 'text/event-stream' }, signal: controller.signal,
  }), { requestId: 'cancel-draft', execute: () => observer.withAskAnswerStreamingEnabled(async () => {
    late = () => observer.emitAskAnswerDelta('late-secret');
    controller.abort(); late();
    return Response.json({ success: false }, { status: 499 });
  }) });
  late();
  assert.doesNotMatch(await response.text(), /answer_delta|late-secret/);
});

test('concurrent requests cannot inherit another request draft authorization', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const first = await executeAskRequest(new Request('http://local', { headers: { accept: 'text/event-stream' } }), {
    requestId: 'eligible', execute: () => observer.withAskAnswerStreamingEnabled(async () => {
      await ready;
      observer.emitAskAnswerDelta('eligible-only');
      return Response.json({ success: true });
    }),
  });
  const second = await executeAskRequest(new Request('http://local', { headers: { accept: 'text/event-stream' } }), {
    requestId: 'ineligible', execute: async () => {
      observer.emitAskAnswerDelta('must-not-escape');
      release();
      return Response.json({ success: true });
    },
  });
  assert.match(await first.text(), /eligible-only/);
  assert.doesNotMatch(await second.text(), /answer_delta|must-not-escape/);
});

test('JSON stays compatible and includes content-free phase timings and online usage', async () => {
  const response = await executeAskRequest(new Request('http://local'), { requestId: 'timing', execute: async () => {
    await observeAskStage('retrieval', async () => 42);
    await observeProviderInvocation('generation', async () => ({ usage_metadata: { input_tokens: 3, output_tokens: 2 } }));
    return Response.json({ success: true, answer: 'private answer' });
  } });
  assert.deepEqual(await response.json(), { success: true, answer: 'private answer' });
  assert.match(response.headers.get('server-timing'), /retrieval;dur=/);
  assert.doesNotMatch(response.headers.get('server-timing'), /private/);
  assert.equal(readAskProviderUsage(response).calls.generation, 1);
});

test('stream confirms immediately but sends no answer until the validated response exists', async () => {
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const response = await executeAskRequest(new Request('http://local', { headers: { accept: 'text/event-stream' } }), {
    requestId: 'stream', execute: async () => { await observeAskStage('validation', () => completed); return Response.json({ success: true, answer: 'verified' }); },
  });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: status/); assert.doesNotMatch(first, /verified/);
  finish();
  let rest = ''; for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
  assert.match(rest, /event: result/); assert.match(rest, /verified/);
});

test('published final validation failure emits its original error status and no answer', async () => {
  const response = await executeAskRequest(new Request('http://local', { headers: { accept: 'text/event-stream' } }), {
    requestId: 'revoked', execute: async () => Response.json({ success: false, code: 'PUBLICATION_VIEW_CHANGED' }, { status: 409 }),
  });
  const body = await response.text();
  assert.match(body, /event: error/); assert.match(body, /"status":409/); assert.doesNotMatch(body, /"answer"/);
});

test('absolute deadline aborts work and returns 504 even for a noncooperative operation', async () => {
  let providerSignal;
  const response = await executeAskRequest(new Request('http://local'), { requestId: 'deadline', budgetMs: 20,
    execute: async signal => { providerSignal = signal; return new Promise(() => {}); },
  });
  assert.equal(response.status, 504); assert.equal(providerSignal.aborted, true);
  assert.equal((await response.json()).code, 'RAG_REQUEST_TIMEOUT');
});

test('disconnect cancels this stream without aborting another request', async () => {
  let firstSignal; let secondSignal; let finish;
  const otherDone = new Promise(resolve => { finish = resolve; });
  const first = await executeAskRequest(new Request('http://local', { headers: { accept: 'text/event-stream' } }), {
    requestId: 'cancel', execute: async signal => { firstSignal = signal; return new Promise(() => {}); },
  });
  const other = executeAskRequest(new Request('http://local'), { requestId: 'other', execute: async signal => {
    secondSignal = signal; await otherDone; return Response.json({ success: true });
  } });
  await first.body.cancel(); assert.equal(firstSignal.aborted, true); assert.equal(secondSignal.aborted, false);
  finish(); assert.equal((await other).status, 200);
});

test('cooperative cancellation preserves the executor partial envelope', async () => {
  const controller = new AbortController(); let start;
  const started = new Promise(resolve => { start = resolve; });
  const pending = executeAskRequest(new Request('http://local', { signal: controller.signal }), {
    requestId: 'partial', execute: async signal => {
      start(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return Response.json({ success: false, code: 'RAG_REQUEST_ABORTED', partial: { stopReason: 'aborted' } }, { status: 499 });
    },
  });
  await started; controller.abort();
  assert.deepEqual((await (await pending).json()).partial, { stopReason: 'aborted' });
});

test('cancelled requests reject late success within the cancellation grace period', async () => {
  const controller = new AbortController();
  const pending = executeAskRequest(new Request('http://local', { signal: controller.signal }), {
    requestId: 'late', execute: async () => {
      controller.abort();
      return Response.json({ success: true, answer: 'must not escape' });
    },
  });
  const response = await pending;
  assert.equal(response.status, 499); assert.doesNotMatch(await response.text(), /must not escape/);
});
