import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import ts from 'typescript';
import { readAskProgressResponse } from '../lib/rag/ask-progress-client.ts';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('./ChatMessage.tsx', import.meta.url), 'utf8');
const partition = 'a'.repeat(64);
const future = Date.now() + 3_600_000;
const citations = {
  version: 'rag-citations/v1', status: 'available', partition,
  items: [1, 2].map(number => ({ number, locator: `opaque-locator-${number}`, expiresAt: future, source: `来源${number}` })),
  diagnostics: { reason: 'ready', citationCount: 2, invalidCitationCount: 0, unavailableCitationCount: 0 },
};
const baseMessage = {
  id: 'synthetic-answer', type: 'assistant', content: '张三负责项目甲[1]。', timestamp: new Date(), citations,
  retrievalDetails: { searchResults: [{ document: { content: '不得作为授权预览回退的缓存原文', metadata: { source: '缓存来源' } } }] },
};
function compile(text, name) {
  const result = ts.transpileModule(text, {
    fileName: name, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  assert.deepEqual(result.diagnostics, []);
  return result.outputText;
}
function loadComponent(fetchImpl) {
  const isolated = { exports: {} };
  vm.runInNewContext(compile(source, 'ChatMessage.tsx'), {
    module: isolated, exports: isolated.exports, Date, AbortController, DOMException, setTimeout, clearTimeout,
    get document() { return globalThis.document; },
    fetch: fetchImpl,
    require(name) {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === '@/components/AnswerProcessingPanel') return { default: () => null, __esModule: true };
      if (name === '@/lib/rag/citations/reference-parser') {
        const parser = { exports: {} };
        vm.runInNewContext(compile(readFileSync(new URL('../lib/rag/citations/reference-parser.ts', import.meta.url), 'utf8'), 'reference-parser.ts'), {
          module: parser, exports: parser.exports,
        });
        return parser.exports;
      }
      throw new Error(`Unexpected ChatMessage runtime import: ${name}`);
    },
  });
  return isolated.exports.default;
}
async function withRenderer(run, fetchImpl = () => { throw new Error('Unexpected source fetch'); }, suppliedComponent) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const failures = [];
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container, { onUncaughtError: error => failures.push(error) });
  const Component = suppliedComponent ?? loadComponent(fetchImpl);
  try {
    await run({
      container, dom,
      async render(message = baseMessage, extra = {}) {
        await act(async () => root.render(React.createElement(Component, {
          message, currentQuery: '', highlightMatchingText: text => text,
          citationPartition: partition, citationAccessStatus: 'ready', citationClockOffsetMs: 0, ...extra,
        })));
        assert.deepEqual(failures, []);
      },
      async click(selector) {
        const button = container.querySelector(selector);
        assert.ok(button, `missing actionable element ${selector}`);
        await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
const button = number => `button[aria-label="查看引用 ${number}"]`;
const retryButton = 'button[aria-label="重试此问题"]';
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ contentTruncated: false, ...body }) }; }

test('failed question retry is placed before the user bubble and respects busy state', async () => {
  let retries = 0;
  const message = { id: 'failed-question', type: 'user', content: '今天心情很好', timestamp: new Date() };
  await withRenderer(async ui => {
    await ui.render(message);
    assert.equal(ui.container.querySelector(retryButton), null);
    await ui.render(message, { onRetry: () => retries++, retryDisabled: false });
    const retry = ui.container.querySelector(retryButton);
    assert.ok(retry);
    assert.ok(retry.nextElementSibling.textContent.includes(message.content));
    assert.equal(retry.type, 'button');
    await ui.click(retryButton);
    assert.equal(retries, 1);
    await ui.render(message, { onRetry: () => retries++, retryDisabled: true, isRetrying: true });
    assert.equal(ui.container.querySelector(retryButton).disabled, true);
    assert.equal(ui.container.querySelector(retryButton).getAttribute('aria-busy'), 'true');
    await ui.click(retryButton);
    assert.equal(retries, 1);
    await ui.render(baseMessage, { onRetry: () => retries++ });
    assert.equal(ui.container.querySelector(retryButton), null, 'assistant bubbles must not expose question retry');
  });
});

test('only server-bound citations link; repetitions survive while code, Markdown links and unknown numbers stay text', async () => {
  await withRenderer(async ui => {
    await ui.render({ ...baseMessage, content: '事实[1]，再次[1]，组合[1,2]，未知[9]。`[1]`\n```text\n[2]\n```\n[1](https://example.test) <script>plain</script>' });
    assert.equal(ui.container.querySelectorAll(button(1)).length, 3);
    assert.equal(ui.container.querySelectorAll(button(2)).length, 1);
    assert.equal(ui.container.querySelectorAll(button(9)).length, 0);
    assert.ok(ui.container.textContent.includes('未知[9]'));
    assert.equal(ui.container.querySelectorAll('script,a[href]').length, 0);
  });
});

test('click fetches authorized source on demand and renders relation text with accessible loading and dialog', async () => {
  const pending = deferred();
  const requests = [];
  await withRenderer(async ui => {
    await ui.render();
    assert.equal(requests.length, 0);
    await ui.click(button(1));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/rag-api/ask/citations/preview');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.equal(requests[0].options.cache, 'no-store');
    assert.deepEqual(JSON.parse(requests[0].options.body), { locator: 'opaque-locator-1' });
    assert.ok(ui.container.querySelector('[role="status"]'));
    await act(async () => pending.resolve(response({ success: true, source: '<script>资料</script>', page: 3, content: '服务端重新授权后的原文', relations: [{ source: '张三', predicate: '负责', target: '项目甲', fact: '张三负责项目甲' }] })));
    const dialog = ui.container.querySelector('[role="dialog"][aria-modal="true"]');
    assert.ok(dialog);
    assert.ok(dialog.textContent.includes('服务端重新授权后的原文'));
    assert.ok(dialog.textContent.includes('张三'));
    assert.ok(dialog.textContent.includes('负责'));
    assert.ok(dialog.textContent.includes('项目甲'));
    assert.ok(dialog.textContent.includes('<script>资料</script>'));
    assert.equal(dialog.querySelectorAll('script').length, 0);
    assert.ok(!dialog.textContent.includes('不得作为授权预览回退的缓存原文'));
    await ui.click('button[aria-label="关闭原文"]');
    assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  }, (url, options) => { requests.push({ url, options }); return pending.promise; });
});

test('preview failure exposes an accessible error and never falls back to cached source', async () => {
  await withRenderer(async ui => {
    await ui.render();
    await ui.click(button(1));
    const dialog = ui.container.querySelector('[role="dialog"]');
    assert.ok(dialog.querySelector('[role="alert"]'));
    assert.ok(!dialog.textContent.includes('不得作为授权预览回退的缓存原文'));
    assert.ok(!dialog.textContent.includes('secret-internal-error'));
  }, async () => response({ success: false, error: 'secret-internal-error' }, 403));
});

test('expired handles and stale account partitions are not actionable', async () => {
  await withRenderer(async ui => {
    await ui.render(baseMessage, { citationPartition: 'b'.repeat(64) });
    assert.equal(ui.container.querySelectorAll(button(1)).length, 0);
    await ui.render({ ...baseMessage, citations: { ...citations, items: [{ ...citations.items[0], expiresAt: 1 }] } });
    assert.equal(ui.container.querySelectorAll(button(1)).length, 0);
    await ui.render(baseMessage, { citationPartition: null, citationAccessStatus: 'unavailable' });
    assert.equal(ui.container.querySelectorAll(button(1)).length, 0);
    assert.ok(ui.container.textContent.includes('引用'));
    await ui.render(baseMessage, { citationClockOffsetMs: null });
    assert.equal(ui.container.querySelectorAll(button(1)).length, 0, 'an uncalibrated browser clock must not authorize citation buttons');
  });
});

for (const offset of [86_400_000,-86_400_000]) {
  test(`citation expiry uses server time when the browser clock offset is ${offset}`, async () => {
    await withRenderer(async ui=>{
      const valid={...baseMessage,citations:{...citations,items:[{...citations.items[0],expiresAt:Date.now()-offset+60_000}]}};
      await ui.render(valid,{citationClockOffsetMs:offset});
      assert.ok(ui.container.querySelector(button(1)));
      await ui.render({...valid,citations:{...valid.citations,items:[{...valid.citations.items[0],expiresAt:Date.now()-offset-1}]}},{citationClockOffsetMs:offset});
      assert.equal(ui.container.querySelector(button(1)),null);
    });
  });
}

test('switching references aborts old preview and late responses cannot overwrite the selected source', async () => {
  const first = deferred();
  const second = deferred();
  const requests = [];
  await withRenderer(async ui => {
    await ui.render({ ...baseMessage, content: '事实一[1]，事实二[2]。' });
    await ui.click(button(1));
    await ui.click(button(2));
    assert.equal(requests[0].options.signal.aborted, true);
    await act(async () => second.resolve(response({ success: true, content: '当前引用二' })));
    await act(async () => first.resolve(response({ success: true, content: '晚到引用一' })));
    const dialog = ui.container.querySelector('[role="dialog"]');
    assert.ok(dialog.textContent.includes('当前引用二'));
    assert.ok(!dialog.textContent.includes('晚到引用一'));
    await ui.render(baseMessage, { citationPartition: 'b'.repeat(64) });
    assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  }, (url, options) => { requests.push({ url, options }); return requests.length === 1 ? first.promise : second.promise; });
});

test('legacy messages without structured citations retain literal answer text', async () => {
  await withRenderer(async ui => {
    await ui.render({ ...baseMessage, citations: undefined, content: '旧回答[1]。' });
    assert.equal(ui.container.querySelectorAll(button(1)).length, 0);
    assert.ok(ui.container.textContent.includes('旧回答[1]。'));
  });
});

function loadHomePage(fetchImpl, dbManager, messageProps, onSystemInfo) {
  const storage = { exports: {} };
  vm.runInNewContext(compile(readFileSync(new URL('../lib/indexeddb.ts', import.meta.url), 'utf8'), 'indexeddb.ts'), {
    module: storage, exports: storage.exports, Date,
  });
  const isolated = { exports: {} };
  vm.runInNewContext(compile(readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8'), 'page.tsx'), {
    module: isolated, exports: isolated.exports, Date, AbortController, AbortSignal, DOMException,
    setTimeout: () => 0, console: { log() {}, warn() {}, error() {} }, fetch: fetchImpl,
    get window() { return globalThis.window; }, get document() { return globalThis.document; },
    require(name) {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === 'next/link') return { default: props => React.createElement('a', { href: props.href }, props.children), __esModule: true };
      if (name === '@/lib/indexeddb') return { ...storage.exports, dbManager: Object.assign(storage.exports.dbManager, dbManager) };
      if (name === '@/lib/documents/document-counts') {
        const counts = { exports: {} };
        vm.runInNewContext(compile(readFileSync(new URL('../lib/documents/document-counts.ts', import.meta.url), 'utf8'), 'document-counts.ts'), { module: counts, exports: counts.exports });
        return counts.exports;
      }
      if (name === '@/lib/rag/core/request-budgets') return { RAG_CLIENT_REQUEST_TIMEOUT_MS: 120_000 };
      if (name === '@/lib/rag/ask-progress-client') return { readAskProgressResponse };
      if (name === '@/lib/rag/conversation-router') return { routeConversation: () => ({ reason: 'knowledge' }) };
      if (name === '@/lib/rag/answer-processing') return {
        classifyDirectConversation: () => null, createPendingAnswerProcessing: () => ({ mode: 'rag', steps: [] }), resolveAnswerProcessing: () => undefined,
      };
      if (name === '@/lib/model-selection') return { resolveSessionModelConfig: value => value, requestSessionModelSelection: () => { throw new Error('Unexpected model change'); } };
      if (name === '@/components/ChatMessage') return { default: props => {
        messageProps.set(props.message.id, props);
        return React.createElement('p', { 'data-message-id': props.message.id }, props.message.content);
      }, __esModule: true };
      if (name === '@/components/ResizableChatArea') return { default: props => props.children, __esModule: true };
      if (name === '@/components/AnswerProcessingPanel') return { default: props => props.isLive
        ? React.createElement('button', { 'aria-label': '取消当前请求', onClick: props.onCancel }, '取消') : null, __esModule: true };
      if (name === '@/components/SystemInfo' && onSystemInfo) return { default: props => {
        onSystemInfo(props);
        return React.createElement('button', { 'aria-label': 'retry-warmup', onClick: props.onRetryModelWarmup }, 'Retry');
      }, __esModule: true };
      if (name.startsWith('@/components/')) return { default: () => null, ModelConfigPanel: () => null, __esModule: true };
      throw new Error(`Unexpected home runtime import: ${name}`);
    },
  });
  return isolated.exports.default;
}

test('retrying model warmup never renders readiness from the previous attempt', async () => {
  const requests = []; const snapshots = [];
  const db = { init: async () => {}, getAllConversations: async () => { assert.fail('getLatestConversation owns the single history read'); }, getLatestConversation: async () => null,
    pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true, modelConfig: {
      llm: { provider: 'ollama', model: 'test-answer' }, embedding: { provider: 'ollama', model: 'test-embedding', dimension: 768 },
    } });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/documents') return response({ success: true, summary: { chunkCount: 0, searchableChunkCount: 0, disabledChunkCount: 0 } });
    if (url === '/rag-api/model-warmup') { const pending = deferred(); requests.push({ ...pending, signal: options.signal }); return pending.promise; }
    throw new Error(`Unexpected warmup test request: ${url}`);
  };
  await withRenderer(async ui => {
    Object.defineProperty(ui.dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    await ui.render();
    assert.equal(requests.length, 1);
    await act(async () => requests[0].resolve(response({ success: true, readiness: { model: 'test-answer', phase: 'ready' } })));
    assert.equal(snapshots.at(-1)?.phase, 'ready');
    snapshots.length = 0;
    await ui.click('[aria-label="retry-warmup"]');
    assert.equal(requests.length, 2);
    assert.ok(snapshots.length > 0);
    assert.ok(snapshots.every(item => item?.phase === 'loading'), 'retry must not briefly expose stale ready state');
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map(), props => snapshots.push(props.modelReadiness)));
  assert.equal(requests.at(-1).signal.aborted, true);
});

function modelWarmupFixture() {
  const requests = [];
  const snapshots = [];
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true, modelConfig: {
      llm: { provider: 'ollama', model: 'test-answer' }, embedding: { provider: 'ollama', model: 'test-embedding', dimension: 768 },
    } });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/documents') return response({ success: true, summary: { chunkCount: 0, searchableChunkCount: 0, disabledChunkCount: 0 } });
    if (url === '/rag-api/model-warmup') { const pending = deferred(); requests.push({ ...pending, signal: options.signal }); return pending.promise; }
    throw new Error(`Unexpected warmup fixture request: ${url}`);
  };
  return { requests, snapshots, fetchImpl,
    Component: loadHomePage(fetchImpl, db, new Map(), props => snapshots.push(props.modelReadiness)),
    ready: index => requests[index].resolve(response({ success: true, readiness: { model: 'test-answer', phase: 'ready' } })),
  };
}

async function setWarmupVisibility(ui, state, notify = true) {
  Object.defineProperty(ui.dom.window.document, 'visibilityState', { configurable: true, value: state });
  if (notify) await act(async () => {
    ui.dom.window.document.dispatchEvent(new ui.dom.window.Event('visibilitychange'));
    ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus'));
  });
}

test('hidden pages defer warmup, foreground events coalesce, and hiding does not cancel a started shared load', async () => {
  const fixture = modelWarmupFixture();
  await withRenderer(async ui => {
    await setWarmupVisibility(ui, 'hidden', false);
    await ui.render();
    assert.equal(fixture.requests.length, 0, 'a hidden initial render must not load models');
    await setWarmupVisibility(ui, 'visible');
    assert.equal(fixture.requests.length, 1);
    await setWarmupVisibility(ui, 'hidden');
    assert.equal(fixture.requests[0].signal.aborted, false, 'hiding must not interrupt the existing client or shared server job');
    await setWarmupVisibility(ui, 'visible');
    assert.equal(fixture.requests.length, 1, 'returning during the same load must reuse it');
    await setWarmupVisibility(ui, 'hidden');
    await act(async () => fixture.ready(0));
    assert.equal(fixture.snapshots.at(-1)?.phase, 'ready');
    await setWarmupVisibility(ui, 'visible');
    assert.equal(fixture.requests.length, 2, 'a completed background job should be refreshed once on return');
    await act(async () => fixture.ready(1));
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    assert.equal(fixture.requests.length, 2, 'a trailing focus event must not repeat a completed foreground refresh');
  }, fixture.fetchImpl, fixture.Component);
});

test('warmup heartbeat only runs while visible and clears its timer on hide and unmount', async () => {
  const fixture = modelWarmupFixture();
  const heartbeatTimers = new Map();
  let timerId = 100000;
  let finalHeartbeat;
  await withRenderer(async ui => {
    const originalSetTimeout = ui.dom.window.setTimeout.bind(ui.dom.window);
    const originalClearTimeout = ui.dom.window.clearTimeout.bind(ui.dom.window);
    ui.dom.window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 5 * 60_000) return originalSetTimeout(callback, delay, ...args);
      const id = timerId++; heartbeatTimers.set(id, callback); return id;
    };
    ui.dom.window.clearTimeout = id => { if (!heartbeatTimers.delete(id)) originalClearTimeout(id); };
    await setWarmupVisibility(ui, 'visible', false);
    await ui.render();
    await act(async () => fixture.ready(0));
    assert.equal(heartbeatTimers.size, 1);
    const staleHeartbeat = [...heartbeatTimers.values()][0];
    await setWarmupVisibility(ui, 'hidden');
    assert.equal(heartbeatTimers.size, 0, 'hiding clears scheduled model work');
    await act(async () => staleHeartbeat());
    assert.equal(fixture.requests.length, 1, 'a heartbeat racing with hide must not submit');
    await setWarmupVisibility(ui, 'visible');
    assert.equal(fixture.requests.length, 2);
    await act(async () => fixture.ready(1));
    assert.equal(heartbeatTimers.size, 1);
    const heartbeat = [...heartbeatTimers.values()][0]; heartbeatTimers.clear();
    await act(async () => heartbeat());
    assert.equal(fixture.requests.length, 3, 'a visible heartbeat refreshes the selected pair');
    await act(async () => fixture.ready(2));
    finalHeartbeat = [...heartbeatTimers.values()][0];
  }, fixture.fetchImpl, fixture.Component);
  assert.equal(heartbeatTimers.size, 0, 'unmount must clear scheduled work');
  await act(async () => finalHeartbeat());
  assert.equal(fixture.requests.length, 3, 'a queued timer callback after unmount must not send a request');
});

test('home document count refresh shares in-flight reads but invalidates on scope changes', async () => {
  const requests = [];
  const db = { init: async () => {}, getAllConversations: async () => [],
    getLatestConversation: async () => null, pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/documents') {
      const pending = deferred();
      requests.push({ ...pending, signal: options.signal });
      return pending.promise;
    }
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    assert.equal(requests.length, 1);
    Object.defineProperty(ui.dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus'));
      ui.dom.window.document.dispatchEvent(new ui.dom.window.Event('visibilitychange'));
    });
    assert.equal(requests.length, 1, 'overlapping refresh triggers must share one request');
    assert.equal(requests[0].signal.aborted, false);
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('rag-corpus-change')));
    assert.equal(requests.length, 2, 'a corpus change must start a fresh authorized read');
    assert.equal(requests[0].signal.aborted, true);
    await act(async () => requests[0].resolve(response({ success: true,
      summary: { chunkCount: 999, searchableChunkCount: 999, disabledChunkCount: 0 } })));
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    assert.equal(requests.length, 2, 'late cleanup must not discard the newer in-flight request');
    await act(async () => requests[1].resolve(response({ success: true,
      summary: { chunkCount: 7, searchableChunkCount: 7, disabledChunkCount: 0 } })));
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    assert.equal(requests.length, 3, 'a settled request must allow later freshness checks');
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('rag-auth-change')));
    assert.equal(requests.length, 4);
    assert.equal(requests[2].signal.aborted, true);
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
  assert.equal(requests.at(-1).signal.aborted, true, 'unmount must cancel the outstanding read');
});

function streamingHomeFixture() {
  const saved = [];
  const asks = [];
  const identities = [];
  let streamController;
  let cancelled = false;
  let identityCalls = 0;
  const encoder = new TextEncoder();
  const streamed = new Response(new ReadableStream({
    start(controller) { streamController = controller; },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'draft-test' } });
  const db = { init: async () => {}, getAllConversations: async () => [],
    getLatestConversation: async () => ({ id: 'stream-conversation', messages: [] }),
    getConversation: async () => null, pruneConversationCitations: async () => {},
    addMessageToConversation: async (_id, message) => saved.push(message) };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') {
      if (identityCalls++ === 0) return response({ success: true, partition, now: Date.now() });
      const identity = deferred(); identities.push(identity); return identity.promise;
    }
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') { asks.push(options); return asks.length === 1 ? streamed : response({ success: true, answer: '后续回答' }); }
    throw new Error(`Unexpected streaming homepage request: ${url}`);
  };
  return { saved, asks, identities, fetchImpl, Component: loadHomePage(fetchImpl, db, new Map()),
    send(event, payload) {
      if (!cancelled) streamController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
    },
    close() { if (!cancelled) streamController.close(); },
    get cancelled() { return cancelled; },
  };
}

async function sendHomeQuestion(ui, question = '普通知识问题') {
  const input = ui.container.querySelector('input[type="text"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, question);
    input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
}

async function emitDraft(fixture, text = '临时回答[1]<script>') {
  await act(async () => {
    fixture.send('status', { stage: 'accepted', state: 'started', requestId: 'draft-test' });
    fixture.send('answer_delta', { requestId: 'draft-test', sequence: 1, text });
  });
  await act(async () => new Promise(resolve => setTimeout(resolve, 60)));
}

for (const outcome of ['success', 'error', 'cancel', 'disconnect']) test(`home answer drafts are transient through ${outcome}`, async () => {
  const fixture = streamingHomeFixture();
  await withRenderer(async ui => {
    await ui.render(); await sendHomeQuestion(ui); await emitDraft(fixture);
    const draft = ui.container.querySelector('[aria-label="正在生成的回答"]');
    assert.ok(draft, 'the first answer token must be visible before the terminal response');
    assert.ok(draft.textContent.includes('临时回答[1]<script>'));
    assert.ok(draft.textContent.includes('正在生成，完成后保存'));
    assert.equal(draft.querySelectorAll('script,a,button').length, 0, 'drafts are plain text without citations');
    assert.equal(fixture.saved.filter(message => message.type === 'assistant').length, 0);
    if (outcome === 'cancel') await ui.click('button[aria-label="取消当前请求"]');
    else await act(async () => {
      if (outcome === 'disconnect') fixture.close();
      else fixture.send(outcome === 'success' ? 'result' : 'error', {
        status: outcome === 'success' ? 200 : 502,
        body: outcome === 'success' ? { success: true, answer: '完整最终回答' }
          : { success: false, code: 'RAG_GENERATION_OUTPUT_LIMIT', error: '输出未完成' },
      });
    });
    assert.equal(ui.container.querySelector('[aria-label="正在生成的回答"]'), null);
    assert.ok(!ui.container.textContent.includes('临时回答'));
    const savedAnswers = fixture.saved.filter(message => message.type === 'assistant');
    assert.deepEqual(savedAnswers.map(message => message.content), outcome === 'success' ? ['完整最终回答'] : []);
    await sendHomeQuestion(ui, '后续问题');
    const history = JSON.parse(fixture.asks[1].body).conversationHistory;
    assert.equal(JSON.stringify(history).includes('临时回答'), false);
    assert.equal(history.length, outcome === 'success' ? 2 : 0);
  }, fixture.fetchImpl, fixture.Component);
  if (outcome !== 'disconnect') assert.equal(fixture.cancelled, true);
});

for (const outcome of ['same', 'changed', 'unavailable']) test(`answer draft visibility follows pending identity revalidation: ${outcome}`, async () => {
  const fixture = streamingHomeFixture();
  await withRenderer(async ui => {
    await ui.render(); await sendHomeQuestion(ui); await emitDraft(fixture, '已有草稿');
    assert.ok(ui.container.textContent.includes('已有草稿'));
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    assert.equal(ui.container.querySelector('[aria-label="正在生成的回答"]'), null, 'verification must immediately hide existing text');
    await act(async () => fixture.send('answer_delta', { requestId: 'draft-test', sequence: 2, text: '新增草稿' }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 60)));
    assert.ok(!ui.container.textContent.includes('新增草稿'));
    await act(async () => fixture.identities[0].resolve(outcome === 'unavailable'
      ? response({ success: false }, 403)
      : response({ success: true, partition: outcome === 'same' ? partition : 'b'.repeat(64), now: Date.now() })));
    assert.equal(fixture.asks[0].signal.aborted, outcome !== 'same');
    assert.equal(ui.container.textContent.includes('已有草稿新增草稿'), outcome === 'same');
    assert.equal(fixture.saved.filter(message => message.type === 'assistant').length, 0);
    if (outcome === 'same') await ui.click('button[aria-label="取消当前请求"]');
    await act(async () => new Promise(resolve => setTimeout(resolve, 60)));
    assert.equal(ui.container.querySelector('[aria-label="正在生成的回答"]'), null);
  }, fixture.fetchImpl, fixture.Component);
});

for (const outcome of ['cancel', 'unmount']) test(`a queued answer draft cannot render after ${outcome}`, async () => {
  const fixture = streamingHomeFixture();
  await withRenderer(async ui => {
    await ui.render(); await sendHomeQuestion(ui);
    await act(async () => fixture.send('answer_delta', { requestId: 'draft-test', sequence: 1, text: '尚未渲染草稿' }));
    if (outcome === 'cancel') {
      await ui.click('button[aria-label="取消当前请求"]');
      await act(async () => new Promise(resolve => setTimeout(resolve, 60)));
      assert.ok(!ui.container.textContent.includes('尚未渲染草稿'));
    }
  }, fixture.fetchImpl, fixture.Component);
  assert.equal(fixture.asks[0].signal.aborted, true);
  assert.equal(fixture.cancelled, true);
  assert.equal(fixture.saved.filter(message => message.type === 'assistant').length, 0);
});

test('a terminal answer during identity verification permanently retires its draft', async () => {
  const fixture = streamingHomeFixture();
  await withRenderer(async ui => {
    await ui.render(); await sendHomeQuestion(ui); await emitDraft(fixture, '已结束的草稿');
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    await act(async () => fixture.send('result', { status: 200, body: { success: true, answer: '验证后最终答案' } }));
    assert.equal(ui.container.querySelector('[aria-label="正在生成的回答"]'), null);
    assert.equal(fixture.saved.filter(message => message.type === 'assistant').length, 0);
    await act(async () => fixture.identities[0].resolve(response({ success: true, partition, now: Date.now() })));
    assert.equal(ui.container.querySelector('[aria-label="正在生成的回答"]'), null);
    assert.ok(!ui.container.textContent.includes('已结束的草稿'));
    assert.ok(ui.container.textContent.includes('验证后最终答案'));
    assert.deepEqual(fixture.saved.filter(message => message.type === 'assistant').map(message => message.content), ['验证后最终答案']);
  }, fixture.fetchImpl, fixture.Component);
});

for (const outcome of ['focus', 'storage', 401, 403]) test(`document counts discard old scope after identity revalidation (${outcome})`, async () => {
  const requests=[];
  let identity=partition;
  let status=200;
  const db={init:async()=>{},getAllConversations:async()=>[],getLatestConversation:async()=>null,pruneConversationCitations:async()=>{}};
  const fetchImpl=async(url,options)=>{
    if(url==='/rag-api/documents'){
      const pending=deferred();requests.push({...pending,signal:options.signal});return pending.promise;
    }
    if(url==='/rag-api/ask/citations/preview')return response({success:status===200,partition:identity,now:Date.now()},status);
    if(url==='/rag-api/health')return response({success:true});
    if(url==='/rag-api/milvus?action=status')return response({success:true,connected:true});
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui=>{
    await ui.render();assert.equal(requests.length,1);
    if(typeof outcome==='number')status=outcome;else identity='b'.repeat(64);
    await act(async()=>ui.dom.window.dispatchEvent(new ui.dom.window.Event(typeof outcome==='string'?outcome:'focus')));
    assert.equal(requests[0].signal.aborted,true,'a revalidated different or unauthorized identity must cancel the old read');
    await act(async()=>requests[0].resolve(response({success:true,summary:{chunkCount:999,searchableChunkCount:999,disabledChunkCount:0}})));
    if(typeof outcome==='number')assert.equal(requests.length,1,'unauthorized identity must not start another catalog read');
    else {
      assert.equal(requests.length,2,'a newly verified scope must get fresh counts');
      assert.equal(requests[1].signal.aborted,false,'old cleanup must preserve the current read');
    }
  },fetchImpl,loadHomePage(fetchImpl,db,new Map()));
});

for (const retrySucceeds of [true, false]) test(`home retries the original failed question without duplicates (${retrySucceeds ? 'success' : 'failure'})`, async () => {
  const asks = [];
  const messageProps = new Map();
  const savedMessages = [];
  const pending = deferred();
  const db = { init: async () => {}, getAllConversations: async () => [],
    getLatestConversation: async () => ({ id: 'retry-conversation', messages: [] }),
    getConversation: async () => null, pruneConversationCitations: async () => {},
    addMessageToConversation: async (_id, message) => savedMessages.push(message) };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') {
      asks.push(JSON.parse(options.body));
      return asks.length === 1 ? response({ success: false, error: '嵌入模型预加载失败' }, 503) : pending.promise;
    }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const input = ui.container.querySelector('input[type="text"]');
    const type = async value => act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    await type('原来的问题');
    await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    const original = [...messageProps.values()].find(props => props.message.type === 'user');
    assert.equal(typeof original.onRetry, 'function');
    assert.ok(ui.container.textContent.includes('嵌入模型预加载失败'));
    await type('尚未发送的新问题');
    let retry;
    await act(async () => { retry = original.onRetry(); original.onRetry(); });
    assert.equal(asks.length, 2, 'rapid clicks must not send duplicate requests');
    assert.equal(asks[1].question, '原来的问题');
    assert.deepEqual(asks[1].conversationHistory, [], 'failed turns must not enter model history');
    assert.equal(messageProps.get(original.message.id).retryDisabled, true);
    assert.equal(messageProps.get(original.message.id).isRetrying, true);
    assert.ok(!ui.container.textContent.includes('嵌入模型预加载失败'), 'remove the previous error when retry starts');
    await act(async () => {
      pending.resolve(retrySucceeds ? response({ success: true, answer: '重试回答' })
        : response({ success: false, error: '嵌入模型仍不可用' }, 503));
      await retry;
    });
    assert.equal(input.value, '尚未发送的新问题', 'retry must preserve the composer draft');
    const rendered = [...ui.container.querySelectorAll('[data-message-id]')];
    assert.equal(rendered.filter(element => element.textContent === '原来的问题').length, 1);
    assert.equal(rendered.length, 2, 'reuse the original user bubble and replace the previous failure');
    assert.equal(savedMessages.filter(message => message.type === 'user').length, 1);
    const finished = messageProps.get(original.message.id);
    assert.equal(finished.isRetrying, false);
    if (retrySucceeds) {
      assert.equal(finished.onRetry, undefined);
      assert.ok(ui.container.textContent.includes('重试回答'));
    } else {
      assert.equal(typeof finished.onRetry, 'function');
      assert.equal(finished.retryDisabled, false);
      assert.ok(ui.container.textContent.includes('嵌入模型仍不可用'));
    }
  }, fetchImpl, loadHomePage(fetchImpl, db, messageProps));
});

test('identity changes during retry cannot leave the question permanently busy', async () => {
  const messageProps = new Map();
  const pending = deferred();
  let identity = partition;
  let askCount = 0;
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'retry-identity' }), getConversation: async () => null,
    addMessageToConversation: async () => {}, pruneConversationCitations: async () => {} };
  const fetchImpl = async (url) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition: identity, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') return ++askCount === 1
      ? response({ success: false, error: '首次失败' }, 503) : pending.promise;
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const input = ui.container.querySelector('input[type="text"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, '重试中的问题');
      input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    const question = [...messageProps.values()].find(props => props.message.type === 'user');
    let retry;
    await act(async () => { retry = question.onRetry(); });
    assert.equal(messageProps.get(question.message.id).isRetrying, true);
    identity = 'b'.repeat(64);
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    await act(async () => { pending.resolve(response({ success: true, answer: '旧身份的过期回答' })); await retry; });
    assert.ok(!ui.container.textContent.includes('旧身份的过期回答'));
    assert.equal(messageProps.get(question.message.id).isRetrying, false);
    assert.equal(messageProps.get(question.message.id).retryDisabled, false);
  }, fetchImpl, loadHomePage(fetchImpl, db, messageProps));
});

test('a newer question retires the older retry action so completed turns stay in order', async () => {
  const messageProps = new Map();
  let askCount = 0;
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'retry-latest' }), getConversation: async () => null,
    addMessageToConversation: async () => {}, pruneConversationCitations: async () => {} };
  const fetchImpl = async (url) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') return ++askCount === 1
      ? response({ success: false, error: '首次失败' }, 503) : response({ success: true, answer: '第二个问题的回答' });
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const input = ui.container.querySelector('input[type="text"]');
    const send = async value => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
      });
      await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    };
    await send('第一个问题');
    const first = [...messageProps.values()].find(props => props.message.type === 'user');
    assert.equal(typeof first.onRetry, 'function');
    await send('第二个问题');
    assert.equal(messageProps.get(first.message.id).onRetry, undefined);
    assert.deepEqual([...ui.container.querySelectorAll('[data-message-id]')].map(element => element.textContent), [
      '第一个问题', '抱歉，处理您的问题时出现了错误：首次失败', '第二个问题', '第二个问题的回答',
    ]);
    assert.equal(askCount, 2);
  }, fetchImpl, loadHomePage(fetchImpl, db, messageProps));
});

for (const unified of [false, true]) test(`home sends a question with ${unified ? 'published' : 'disconnected Milvus'} retrieval`, async () => {
  const requests = [];
  let healthReads = 0;
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'routing-test' }), pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') {
      if (unified && healthReads++ > 0) throw new Error('health temporarily unavailable');
      return response({ success: true, ...(unified ? { publication: { mode: 'active', check: 'control-plane' } } : {}) });
    }
    if (url === '/rag-api/milvus?action=status') return response({ success: false, connected: false });
    if (url === '/rag-api/ask') return response({ success: false, error: 'server decision' }, 503);
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const input = ui.container.querySelector('input[type="text"]');
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, '介绍下你自己');
      input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    const request = requests.find(item => item.url === '/rag-api/ask');
    assert.ok(request, 'the server must decide how to handle the question');
    assert.equal(JSON.parse(request.options.body).question, '介绍下你自己');
    if (unified) {
      assert.equal(requests.some(item => item.url === '/rag-api/milvus?action=status'), false);
      assert.ok(ui.container.textContent.includes('文档经过三库验证后统一发布'));
      assert.ok(!ui.container.textContent.includes('正在检查 Milvus 连接状态'));
      await act(async () => ui.container.querySelector('button[aria-label="刷新知识库状态"]').click());
      assert.equal(requests.some(item => item.url === '/rag-api/milvus?action=status'), false,
        'a health transport failure cannot switch a known publication session to the legacy probe');
    }
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
});

test('maintenance still permits identity-bound conversation while citations remain unavailable', async () => {
  const asks = [];
  const messages = new Map();
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'maintenance-chat' }), addMessageToConversation: async () => {},
    getConversation: async () => null, pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: false }, 503);
    if (url === '/rag-api/ask/conversation-identity') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true, vectorBackend: { disabled: true } });
    if (url === '/rag-api/ask') { asks.push(options); return response({ success: true, answer: '你好', conversationMode: 'direct' }); }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const input = ui.container.querySelector('input[type="text"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, '你好');
      input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(asks.length, 1);
    assert.equal(asks[0].headers['x-rag-conversation-partition'], partition);
    const answer = [...messages.values()].find(value => value.message.type === 'assistant');
    assert.equal(answer.citationAccessStatus, 'unavailable');
    assert.equal(answer.citationPartition, null);
  }, fetchImpl, loadHomePage(fetchImpl, db, messages));
});

test('identity verification failure while submitting is visible and sends no question', async () => {
  const pendingIdentity = deferred();
  const asks = [];
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'identity-failure' }), pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return pendingIdentity.promise;
    if (url === '/rag-api/ask/conversation-identity') return response({ success: false }, 503);
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') { asks.push(options); return response({ success: true }); }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const input = ui.container.querySelector('input[type="text"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, '你好');
      input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => pendingIdentity.resolve(response({ success: false }, 503)));
    assert.equal(asks.length, 0);
    assert.ok(ui.container.textContent.includes('无法验证会话身份'));
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
});

test('home sends only completed current-session turns and clears them on account change', async () => {
  const asks = [];
  const askHeaders = [];
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'history-test' }), addMessageToConversation: async () => {}, getConversation: async () => null,
    pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') {
      asks.push(JSON.parse(options.body));
      askHeaders.push(options.headers);
      return asks.length === 2 ? response({ success: false, error: 'failure' }, 503)
        : response({ success: true, answer: `answer ${asks.length}`, conversationMode: 'direct' });
    }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const send = async value => {
      const input = ui.container.querySelector('input[type="text"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
      });
      await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    };
    await send('first');
    await send('failed');
    await send('third');
    assert.deepEqual(asks[0].conversationHistory, []);
    assert.deepEqual(asks[1].conversationHistory, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer 1' }]);
    assert.equal(askHeaders[0]['x-rag-conversation-partition'], partition);
    assert.equal(askHeaders[1]['x-rag-conversation-partition'], partition);
    assert.deepEqual(asks[2].conversationHistory, asks[1].conversationHistory);
    for (let i = 0; i < 5; i++) await send(`turn ${i}`);
    assert.equal(asks[7].conversationHistory.length, 8);
    assert.equal(asks[7].conversationHistory[0].content, 'turn 0');
    await send('x'.repeat(1001));
    await send('after oversized turn');
    assert.deepEqual(asks[9].conversationHistory, []);
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('rag-auth-change')));
    await send('after account change');
    assert.deepEqual(asks[10].conversationHistory, []);
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
});

test('a late response after account change cannot become the next turn history', async () => {
  const asks = [];
  const pending = deferred();
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'late-test' }), addMessageToConversation: async () => {}, getConversation: async () => null,
    pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') {
      asks.push({ body: JSON.parse(options.body), signal: options.signal });
      return asks.length === 1 ? pending.promise : response({ success: true, answer: 'new', conversationMode: 'direct' });
    }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const send = async value => {
      const input = ui.container.querySelector('input[type="text"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
      });
      await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    };
    await send('old account');
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('rag-auth-change')));
    assert.equal(asks[0].signal.aborted, true);
    await act(async () => pending.resolve(response({ success: true, answer: 'old answer', conversationMode: 'direct' })));
    await send('new account');
    assert.deepEqual(asks[1].body.conversationHistory, []);
    assert.ok(!ui.container.textContent.includes('old answer'));
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
});

for (const identityOutcome of ['same', 'changed', 'changed-storage', 401, 403]) {
  test(`identity refresh ${identityOutcome} preserves history only for the same account`, async () => {
    const asks = [];
    let identityStatus = 200;
    let currentPartition = partition;
    const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
      createNewConversation: async () => ({ id: 'focus-history' }), addMessageToConversation: async () => {}, getConversation: async () => null,
      pruneConversationCitations: async () => {} };
    const fetchImpl = async (url, options) => {
      if (url === '/rag-api/ask/citations/preview') return response({ success: identityStatus === 200, partition: currentPartition, now: Date.now() }, identityStatus);
      if (url === '/rag-api/health') return response({ success: true });
      if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
      if (url === '/rag-api/ask') {
        asks.push(JSON.parse(options.body));
        return response({ success: true, answer: 'answer', conversationMode: 'direct' });
      }
      throw new Error(`Unexpected homepage network access: ${url}`);
    };
    await withRenderer(async ui => {
      await ui.render();
      const send = async value => {
        const input = ui.container.querySelector('input[type="text"]');
        await act(async () => {
          Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
          input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
        });
        await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
      };
      await send('previous question');
      if (identityOutcome === 'changed' || identityOutcome === 'changed-storage') currentPartition = 'b'.repeat(64);
      else if (typeof identityOutcome === 'number') identityStatus = identityOutcome;
      await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event(identityOutcome === 'changed-storage' ? 'storage' : 'focus')));
      await send('next question');
      if (typeof identityOutcome === 'number') {
        assert.equal(asks.length, 1);
        assert.ok(ui.container.textContent.includes('无法验证会话身份'));
        return;
      }
      assert.deepEqual(asks[1].conversationHistory, identityOutcome === 'same'
        ? [{ role: 'user', content: 'previous question' }, { role: 'assistant', content: 'answer' }]
        : []);
    }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
  });
}

test('identity revalidation waits before submitting and binds the validated partition', async () => {
  const asks = [];
  const headers = [];
  const pendingIdentity = deferred();
  let identityCalls = 0;
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'identity-pending' }), addMessageToConversation: async () => {}, getConversation: async () => null,
    pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return ++identityCalls === 1
      ? response({ success: true, partition, now: Date.now() }) : pendingIdentity.promise;
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') { asks.push(JSON.parse(options.body)); headers.push(options.headers); return response({ success: true, answer: 'answer', conversationMode: 'direct' }); }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const send = async value => {
      const input = ui.container.querySelector('input[type="text"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
      });
      await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    };
    await send('verified');
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    await act(async () => ui.container.querySelector('form').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await send('unverified');
    assert.equal(asks.length, 1);
    await act(async () => pendingIdentity.resolve(response({ success: true, partition, now: Date.now() })));
    assert.equal(headers[1]['x-rag-conversation-partition'], partition);
    assert.deepEqual(asks[1].conversationHistory, [{ role: 'user', content: 'verified' }, { role: 'assistant', content: 'answer' }]);
    await send('verified again');
    assert.deepEqual(asks[2].conversationHistory, [
      { role: 'user', content: 'verified' }, { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'unverified' }, { role: 'assistant', content: 'answer' },
    ]);
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
});

test('partition mismatch clears history and refreshes identity before later requests', async () => {
  const asks = [];
  let identityCalls = 0;
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'mismatch-test' }), addMessageToConversation: async () => {}, getConversation: async () => null,
    pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition: ++identityCalls === 1 ? partition : 'b'.repeat(64), now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') {
      asks.push({ body: JSON.parse(options.body), headers: options.headers });
      return asks.length === 2 ? response({ success: false, code: 'CONVERSATION_PARTITION_MISMATCH' }, 409)
        : response({ success: true, answer: 'answer', conversationMode: 'direct' });
    }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const send = async value => {
      const input = ui.container.querySelector('input[type="text"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
      });
      await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    };
    await send('before change');
    await send('after silent identity change');
    assert.equal(asks[1].headers['x-rag-conversation-partition'], partition);
    assert.equal(identityCalls, 2);
    await send('retry');
    assert.deepEqual(asks[2].body.conversationHistory, []);
    assert.equal(asks[2].headers['x-rag-conversation-partition'], 'b'.repeat(64));
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
});

for (const outcome of ['same', 'changed', 'unavailable']) {
test(`a long answer waits for identity refresh: ${outcome}`, async () => {
  const ask = deferred();
  const identity = deferred();
  let identityCalls = 0;
  let signal;
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'long-test' }), addMessageToConversation: async () => {}, getConversation: async () => null,
    pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return ++identityCalls === 1 ? response({ success: true, partition, now: Date.now() }) : identity.promise;
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') { signal = options.signal; return ask.promise; }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const input = ui.container.querySelector('input[type="text"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'question');
      input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    assert.equal(signal.aborted, false);
    await act(async () => ask.resolve(response({ success: true, answer: 'long answer', conversationMode: 'direct' })));
    assert.ok(!ui.container.textContent.includes('long answer'));
    await act(async () => identity.resolve(outcome === 'unavailable'
      ? response({ success: false }, 403)
      : response({ success: true, partition: outcome === 'same' ? partition : 'b'.repeat(64), now: Date.now() })));
    assert.equal(signal.aborted, outcome !== 'same');
    assert.equal(ui.container.textContent.includes('long answer'), outcome === 'same');
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
});
}

test('silent A to B to A identity changes cannot bind B answers to A history', async () => {
  const asks = [];
  const db = { init: async () => {}, getAllConversations: async () => [], getLatestConversation: async () => null,
    createNewConversation: async () => ({ id: 'aba-test' }), addMessageToConversation: async () => {}, getConversation: async () => null,
    pruneConversationCitations: async () => {} };
  const fetchImpl = async (url, options) => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') {
      asks.push({ headers: options.headers, body: JSON.parse(options.body) });
      return asks.length === 1 ? response({ success: false, code: 'CONVERSATION_PARTITION_MISMATCH' }, 409)
        : response({ success: true, answer: 'A answer', conversationMode: 'direct' });
    }
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const send = async value => {
      const input = ui.container.querySelector('input[type="text"]');
      await act(async () => {
        Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
      });
      await act(async () => input.form.dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    };
    await send('first request');
    assert.equal(asks[0].headers['x-rag-conversation-partition'], partition);
    assert.deepEqual(asks[0].body.conversationHistory, []);
    await send('back to A');
    assert.deepEqual(asks[1].body.conversationHistory, []);
    assert.equal(asks[1].headers['x-rag-conversation-partition'], partition);
  }, fetchImpl, loadHomePage(fetchImpl, db, new Map()));
});

test('home shares one identity request across restored messages and clears handles on an account/scope change', async () => {
  const messageProps = new Map();
  const requests = [];
  const pruneCalls = [];
  let currentPartition = partition;
  const history = { id: 'synthetic-conversation', messages: [baseMessage, { ...baseMessage, id: 'second-answer' }] };
  const db = {
    init: async () => {}, getAllConversations: async () => [history], getLatestConversation: async () => history,
    pruneConversationCitations: async (...args) => pruneCalls.push(args),
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition: currentPartition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true, ragSystem: { documentCount: 1 } });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    throw new Error(`Unexpected homepage network access: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    assert.equal(requests.filter(value => value.url === '/rag-api/ask/citations/preview').length, 1);
    assert.equal(messageProps.get(baseMessage.id).citationPartition, partition);
    assert.equal(messageProps.get('second-answer').citationPartition, partition);
    assert.equal(messageProps.get(baseMessage.id).message.citations.items.length, 2);
    currentPartition = 'b'.repeat(64);
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('rag-auth-change')));
    assert.equal(messageProps.get(baseMessage.id).citationPartition, currentPartition);
    assert.equal(messageProps.get(baseMessage.id).message.citations, undefined);
    assert.equal(messageProps.get(baseMessage.id).message.content, baseMessage.content);
    assert.ok(pruneCalls.some(call => call[0] === currentPartition));
  }, fetchImpl, loadHomePage(fetchImpl, db, messageProps));
});

for (const [status,eventName,clear] of [[401,'focus',true],[403,'focus',true],[503,'focus',false],[503,'rag-auth-change',true],[503,'rag-corpus-change',true]]) {
  test(`home identity ${status} on ${eventName} ${clear ? 'clears' : 'retains'} persisted citation handles`, async () => {
    const messageProps = new Map();
    const pruneCalls = [];
    let identityStatus = 200;
    const history = {id:'auth-cleanup-fixture',messages:[baseMessage]};
    const db = {init:async()=>{},getAllConversations:async()=>[history],getLatestConversation:async()=>history,pruneConversationCitations:async(...args)=>pruneCalls.push(args)};
    const fetchImpl = async url => {
      if(url === '/rag-api/ask/citations/preview')return response({success:identityStatus===200,partition,now:Date.now()},identityStatus);
      if(url === '/rag-api/health' || url === '/rag-api/milvus?action=status')return response({success:true});
      throw new Error(`Unexpected homepage request: ${url}`);
    };
    await withRenderer(async ui=>{
      await ui.render();
      identityStatus=status;
      await act(async()=>ui.dom.window.dispatchEvent(new ui.dom.window.Event(eventName)));
      assert.equal(pruneCalls.some(call=>call[0]===null),clear);
      assert.equal(messageProps.get(baseMessage.id).citationAccessStatus,'unavailable');
      assert.equal(messageProps.get(baseMessage.id).message.content,baseMessage.content);
      if(clear)assert.equal(messageProps.get(baseMessage.id).message.citations,undefined);
    },fetchImpl,loadHomePage(fetchImpl,db,messageProps));
  });
}

test('home ignores a late identity response from the previous account', async () => {
  const firstIdentity = deferred();
  const messageProps = new Map();
  const history = { id: 'synthetic-race', messages: [baseMessage] };
  let calls = 0;
  const db = { init: async () => {}, getAllConversations: async () => [history], getLatestConversation: async () => history, pruneConversationCitations: async () => {} };
  const fetchImpl = async url => {
    if (url === '/rag-api/ask/citations/preview') {
      calls++;
      return calls === 1 ? firstIdentity.promise : response({ success: true, partition: 'b'.repeat(64), now: Date.now() });
    }
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    throw new Error(`Unexpected homepage request: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('rag-auth-change')));
    assert.equal(messageProps.get(baseMessage.id).citationPartition, 'b'.repeat(64));
    await act(async () => firstIdentity.resolve(response({ success: true, partition, now: Date.now() })));
    assert.equal(messageProps.get(baseMessage.id).citationPartition, 'b'.repeat(64));
    assert.equal(messageProps.get(baseMessage.id).message.citations, undefined);
  }, fetchImpl, loadHomePage(fetchImpl, db, messageProps));
});

test('a late 401 from a superseded identity request cannot clear the new account', async () => {
  const firstIdentity = deferred();
  const messageProps = new Map();
  const pruneCalls = [];
  const history = { id: 'synthetic-late-401', messages: [baseMessage] };
  let calls = 0;
  const db = { init: async () => {}, getAllConversations: async () => [history], getLatestConversation: async () => history,
    pruneConversationCitations: async (...args) => pruneCalls.push(args) };
  const fetchImpl = async url => {
    if (url === '/rag-api/ask/citations/preview') {
      calls++;
      return calls === 1 ? firstIdentity.promise : response({ success: true, partition: 'b'.repeat(64), now: Date.now() });
    }
    if (url === '/rag-api/health' || url === '/rag-api/milvus?action=status') return response({ success: true });
    throw new Error(`Unexpected homepage request: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('rag-auth-change')));
    const clearCount = pruneCalls.filter(call => call[0] === null).length;
    await act(async () => firstIdentity.resolve(response({ success: false }, 401)));
    assert.equal(messageProps.get(baseMessage.id).citationPartition, 'b'.repeat(64));
    assert.equal(messageProps.get(baseMessage.id).citationAccessStatus, 'ready');
    assert.equal(pruneCalls.filter(call => call[0] === null).length, clearCount);
  }, fetchImpl, loadHomePage(fetchImpl, db, messageProps));
});

test('a focus refresh cannot cancel persistent cleanup already required by an identity change', async () => {
  const messageProps = new Map();
  const pruneCalls = [];
  const pendingInit = deferred();
  let delayInit = false;
  let identityStatus = 200;
  const history = { id: 'pending-clear', messages: [baseMessage] };
  const db = { init: async () => { if (delayInit) await pendingInit.promise; },
    getAllConversations: async () => [history], getLatestConversation: async () => history,
    pruneConversationCitations: async (...args) => pruneCalls.push(args) };
  const fetchImpl = async url => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: identityStatus === 200, partition, now: Date.now() }, identityStatus);
    if (url === '/rag-api/health' || url === '/rag-api/milvus?action=status') return response({ success: true });
    throw new Error(`Unexpected homepage request: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    delayInit = true; identityStatus = 503;
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('rag-auth-change')));
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('focus')));
    delayInit = false;
    await act(async () => pendingInit.resolve());
    assert.equal(pruneCalls.filter(call => call[0] === null).length, 1);
    assert.equal(messageProps.get(baseMessage.id).message.citations, undefined);
    assert.equal(messageProps.get(baseMessage.id).message.content, baseMessage.content);
  }, fetchImpl, loadHomePage(fetchImpl, db, messageProps));
});

test('home forwards newly served citations into rendering and storage without private preview fields', async () => {
  const messageProps = new Map();
  const saved = [];
  const history = { id: 'synthetic-submit', messages: [{ id: 'old', type: 'user', content: '旧问题', timestamp: new Date() }] };
  const db = {
    init: async () => {}, getAllConversations: async () => [history], getLatestConversation: async () => history,
    getConversation: async () => history, saveConversation: async () => {}, pruneConversationCitations: async () => {},
    addMessageToConversation: async (id, message) => { assert.equal(id, history.id); saved.push(message); },
  };
  const fetchImpl = async url => {
    if (url === '/rag-api/ask/citations/preview') return response({ success: true, partition, now: Date.now() });
    if (url === '/rag-api/health') return response({ success: true });
    if (url === '/rag-api/milvus?action=status') return response({ success: true, connected: true });
    if (url === '/rag-api/ask') return response({ success: true, answer: '张三负责项目甲[1]。', storageBackend: 'milvus', citations: {
      ...citations, content: '不得写入引用存储的原文', items: citations.items.map(item => ({ ...item, content: '私密预览内容', relations: ['私密关系'] })),
    } });
    throw new Error(`Unexpected homepage request: ${url}`);
  };
  await withRenderer(async ui => {
    await ui.render();
    const input = ui.container.querySelector('input[placeholder="请输入您的问题..."]');
    assert.ok(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, 'value').set.call(input, '张三负责哪些项目？');
      input.dispatchEvent(new ui.dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => ui.container.querySelector('form').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true })));
    const assistant = saved.find(message => message.type === 'assistant');
    assert.ok(assistant, 'successful Ask response must be persisted as an assistant message');
    const storedCitations = { ...citations, items: citations.items.map(item => ({ number: item.number, locator: item.locator, expiresAt: item.expiresAt })) };
    assert.deepEqual(JSON.parse(JSON.stringify(assistant.citations)), storedCitations);
    assert.deepEqual(JSON.parse(JSON.stringify(messageProps.get(assistant.id).message.citations)), storedCitations);
    assert.ok(!JSON.stringify(assistant.citations).includes('私密'));
  }, fetchImpl, loadHomePage(fetchImpl, db, messageProps));
});
