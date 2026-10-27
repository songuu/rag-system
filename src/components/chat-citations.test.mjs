import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import ts from 'typescript';

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
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => ({ contentTruncated: false, ...body }) }; }

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

function loadHomePage(fetchImpl, dbManager, messageProps) {
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
      if (name === '@/lib/rag/conversation-router') return { routeConversation: () => ({ reason: 'knowledge' }) };
      if (name === '@/lib/rag/answer-processing') return {
        classifyDirectConversation: () => null, createPendingAnswerProcessing: () => ({ mode: 'rag', steps: [] }), resolveAnswerProcessing: () => undefined,
      };
      if (name === '@/lib/model-selection') return { resolveSessionModelConfig: value => value, requestSessionModelSelection: () => { throw new Error('Unexpected model change'); } };
      if (name === '@/components/ChatMessage') return { default: props => {
        messageProps.set(props.message.id, props);
        return React.createElement('p', { 'data-message-id': props.message.id }, props.message.content);
      }, __esModule: true };
      if (name.startsWith('@/components/')) return { default: () => null, ModelConfigPanel: () => null, __esModule: true };
      throw new Error(`Unexpected home runtime import: ${name}`);
    },
  });
  return isolated.exports.default;
}

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
