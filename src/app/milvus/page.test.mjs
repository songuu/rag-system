import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import ts from 'typescript';

const pagePath = fileURLToPath(new URL('./page.tsx', import.meta.url));
const source = await readFile(pagePath, 'utf8');
const selectionSource = await readFile(new URL('./embedding-model-selection.ts', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);

function compile(sourceText, filename) {
  const result = ts.transpileModule(sourceText, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
    fileName: filename,
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics, []);
  return result.outputText;
}

const compiledPage = compile(source, 'page.tsx');
const compiledSelection = compile(selectionSource, 'embedding-model-selection.ts');
const status = {
  success: true, connected: true, health: { healthy: true, message: 'synthetic healthy' },
  stats: { name: 'synthetic', rowCount: 3, embeddingDimension: 768, indexType: 'IVF_FLAT', metricType: 'COSINE', loaded: true },
  config: { address: 'synthetic:19530', database: 'synthetic', collectionName: 'synthetic', embeddingDimension: 768, indexType: 'IVF_FLAT', metricType: 'COSINE' },
};
const models = [
  { name: 'nomic-embed-text:latest', size: 1024, modified_at: '2026-10-20T00:00:00Z' },
  { name: 'bge-m3', size: 2048, modified_at: '2026-10-20T00:00:00Z' },
];
const results = [{ id: 'synthetic-document', content: '合成检索正文', metadata: { source: '合成来源', extra: { retained: true } }, score: 0.875, distance: 0.125 }];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function withPage(run, overrides = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const requests = [];
  const timers = [];
  const logs = [];
  const uncaught = [];
  const synchronousEffectUpdates = [];
  const lateUpdates = [];
  let unmounted = false;
  let inEffect = false;
  let confirmResult = true;
  let confirmCalls = 0;
  const react = {
    ...require('react'),
    useState(initial) {
      const [value, setValue] = React.useState(initial);
      return [value, update => {
        if (inEffect) synchronousEffectUpdates.push(update);
        if (unmounted) lateUpdates.push(update);
        setValue(update);
      }];
    },
    useEffect(effect, dependencies) {
      const wrappedEffect = () => {
        inEffect = true;
        try { return effect(); }
        finally { inEffect = false; }
      };
      return Reflect.apply(React.useEffect, React, [wrappedEffect, dependencies]);
    },
  };
  const selectionModule = { exports: {} };
  vm.runInNewContext(compiledSelection, { module: selectionModule, exports: selectionModule.exports });
  const pageModule = { exports: {} };
  vm.runInNewContext(compiledPage, {
    module: pageModule, exports: pageModule.exports,
    require(specifier) {
      if (specifier === 'react') return react;
      if (specifier === 'next/link') return function Link({ children, ...props }) { return React.createElement('a', props, children); };
      if (specifier === './embedding-model-selection') return selectionModule.exports;
      throw new Error(`Unexpected runtime import: ${specifier}`);
    },
    async fetch(url, options) {
      const request = { url, method: options?.method ?? 'GET', body: typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body };
      requests.push(request);
      if (overrides.fetch) {
        const response = await overrides.fetch(request);
        if (response !== undefined) return { json: async () => response };
      }
      if (url === '/rag-api/milvus?action=status') return { json: async () => overrides.status ?? status };
      if (url === '/rag-api/model-config') return { json: async () => ({ config: { embedding: { provider: 'ollama', model: 'nomic-embed-text', dimension: 768 } } }) };
      if (url === '/rag-api/ollama/models') return { json: async () => ({ success: true, embeddingModels: models }) };
      throw new Error(`Unexpected synthetic request: ${url}`);
    },
    console: { log: (...values) => logs.push(values), error: (...values) => logs.push(values), warn: (...values) => logs.push(values) },
    setTimeout(callback, milliseconds) { timers.push({ callback, milliseconds }); return timers.length; },
    confirm() { confirmCalls += 1; return confirmResult; },
    FormData: dom.window.FormData,
    Error,
  }, { filename: 'milvus-page.compiled.cjs' });
  const { createRoot } = await import('react-dom/client');
  const container = document.getElementById('root');
  const root = createRoot(container, { onUncaughtError: error => uncaught.push(error) });
  async function click(button) {
    assert.ok(button, 'expected visible button');
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.deepEqual(uncaught, []);
  }
  function buttons(label) { return [...container.querySelectorAll('button')].filter(button => button.textContent.trim() === label); }
  async function fill(selector, value) {
    const input = container.querySelector(selector);
    assert.ok(input, selector);
    const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  }
  try {
    await act(async () => root.render(React.createElement(pageModule.exports.default)));
    assert.deepEqual(uncaught, []);
    await run({ container, requests, timers, logs, synchronousEffectUpdates, lateUpdates, click, buttons, fill,
      async flush(action) { await act(action); assert.deepEqual(uncaught, []); },
      async unmount() { await act(async () => root.unmount()); unmounted = true; },
      setConfirm(value) { confirmResult = value; },
      get confirmCalls() { return confirmCalls; },
    });
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('consumed response and tab types contain no explicit any escapes', () => {
  const syntax = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const anyNodes = [];
  function visit(node) { if (node.kind === ts.SyntaxKind.AnyKeyword) anyNodes.push(node); ts.forEachChild(node, visit); }
  visit(syntax);
  assert.equal(anyNodes.length, 0);
});

test('initialization subscribes to real requests without synchronous effect setters', async () => {
  const configRequest = deferred();
  await withPage(async ({ container, requests, synchronousEffectUpdates, flush }) => {
    assert.deepEqual(synchronousEffectUpdates, []);
    assert.equal(container.querySelector('[title="刷新模型列表"]').disabled, true);
    assert.equal(requests.filter(request => request.url === '/rag-api/milvus?action=status').length, 1);
    assert.equal(requests.filter(request => request.url === '/rag-api/model-config').length, 1);
    assert.equal(requests.filter(request => request.url === '/rag-api/ollama/models').length, 0);
    await flush(async () => configRequest.resolve({ config: { embedding: { provider: 'ollama', model: 'nomic-embed-text', dimension: 768 } } }));
    assert.equal(container.querySelector('[title="刷新模型列表"]').disabled, false);
    assert.equal(requests.filter(request => request.url === '/rag-api/ollama/models').length, 1);
  }, { fetch: request => request.url === '/rag-api/model-config' ? configRequest.promise : undefined });
});

test('initial status, configured local model, and tab transitions preserve loaded state', async () => {
  await withPage(async ({ container, requests, click, buttons }) => {
    assert.match(container.textContent, /合成|synthetic/);
    assert.match(container.textContent, /nomic-embed-text:latest/);
    assert.equal(container.querySelector('select').value, 'nomic-embed-text:latest');
    for (const [tab, expected] of [['📥 导入', 'Pipeline 配置'], ['🔍 搜索', '向量相似度搜索'], ['🎨 可视化', '向量空间可视化'], ['⚙️ 配置', 'Milvus 连接配置'], ['📊 仪表盘', 'RAG Pipeline 架构']]) {
      await click(buttons(tab)[0]);
      assert.ok(container.textContent.includes(expected));
    }
    assert.equal(requests.length, 3, 'tab switches must not reload model/status requests');
  });
});

test('late initialization results after unmount never update React state or start the local models request', async () => {
  const pendingStatus = deferred();
  const pendingConfig = deferred();
  await withPage(async ({ unmount, flush, lateUpdates, requests }) => {
    await unmount();
    await flush(async () => {
      pendingStatus.resolve(status);
      pendingConfig.resolve({ config: { embedding: { provider: 'ollama', model: 'nomic-embed-text', dimension: 768 } } });
    });
    assert.deepEqual(lateUpdates, []);
    assert.equal(requests.filter(request => request.url === '/rag-api/ollama/models').length, 0);
  }, { fetch(request) {
    if (request.url === '/rag-api/milvus?action=status') return pendingStatus.promise;
    if (request.url === '/rag-api/model-config') return pendingConfig.promise;
  } });
});

test('remote configuration skips local model I/O, preserves configured dimensions, and supports manual refresh', async () => {
  let configurationCalls = 0;
  await withPage(async ({ container, requests, click }) => {
    assert.match(container.textContent, /SiliconFlow/);
    assert.match(container.textContent, /BAAI\/bge-m3/);
    assert.match(container.textContent, /1024D/);
    assert.equal(requests.filter(request => request.url === '/rag-api/ollama/models').length, 0);
    await click(container.querySelector('[title="刷新模型列表"]'));
    assert.equal(configurationCalls, 2);
    assert.equal(requests.filter(request => request.url === '/rag-api/ollama/models').length, 0);
  }, { fetch(request) { if (request.url === '/rag-api/model-config') { configurationCalls += 1; return { config: { embedding: { provider: 'siliconflow', model: 'BAAI/bge-m3', dimension: 1024 } } }; } } });
});

test('manual model refresh stays busy for real I/O and releases after rejection without resetting the selected model', async () => {
  const refreshing = deferred();
  let configurationCalls = 0;
  await withPage(async ({ container, click, flush, logs }) => {
    const refreshButton = container.querySelector('[title="刷新模型列表"]');
    assert.equal(refreshButton.disabled, false);
    await click(refreshButton);
    assert.equal(refreshButton.disabled, true);
    await flush(async () => refreshing.reject(new Error('合成配置错误')));
    assert.equal(refreshButton.disabled, false);
    assert.equal(container.querySelector('select').value, 'nomic-embed-text:latest');
    assert.equal(logs.filter(entry => entry[0] === 'Failed to load Ollama models:').length, 1);
  }, { fetch(request) { if (request.url === '/rag-api/model-config' && ++configurationCalls === 2) return refreshing.promise; } });
});

test('local provider-config model override still takes precedence and preserves installed-name selection', async () => {
  await withPage(async ({ container }) => {
    assert.equal(container.querySelector('select').value, 'bge-m3');
    assert.match(container.textContent, /向量维度不匹配/);
  }, { fetch: request => request.url === '/rag-api/ollama/models' ? { success: true, embeddingModels: models, providerConfig: { embedding: { provider: 'ollama', model: 'bge-m3:latest', dimension: 1024 } } } : undefined });
});

test('status and configuration failures keep the existing invisible-status-error boundary and release loading', async () => {
  await withPage(async ({ container, buttons }) => {
    assert.equal(buttons('连接 Milvus').length, 1);
    assert.equal(buttons('连接 Milvus')[0].disabled, false);
    assert.equal(container.querySelector('[title="刷新模型列表"]').disabled, false);
    assert.equal(container.textContent.includes('合成状态错误'), false, 'status errors were stored but not rendered before this scoped cleanup');
  }, { status: { success: false, error: '合成状态错误' }, fetch(request) { if (request.url === '/rag-api/model-config') throw new Error('合成配置错误'); } });
});

test('late local-model responses and rejections after unmount never update state', async () => {
  for (const reject of [false, true]) {
    const pendingModels = deferred();
    await withPage(async ({ unmount, flush, lateUpdates }) => {
      await unmount();
      await flush(async () => {
        if (reject) pendingModels.reject(new Error('合成迟到错误'));
        else pendingModels.resolve({ success: true, embeddingModels: models });
      });
      assert.deepEqual(lateUpdates, []);
    }, { fetch: request => request.url === '/rag-api/ollama/models' ? pendingModels.promise : undefined });
  }
});

test('search preserves untrimmed query, selected model, parameters, result formatting, and existing score bins', async () => {
  await withPage(async ({ container, requests, click, buttons, fill }) => {
    await click(buttons('🔍 搜索')[0]);
    await fill('input[placeholder="输入搜索内容..."]', '  合成查询  ');
    const numeric = container.querySelectorAll('input[type="number"]');
    await fill('input[type="number"]', '7');
    assert.equal(numeric[0].value, '7');
    await click(buttons('🔍 搜索')[1]);
    const request = requests.find(request => request.body?.action === 'search');
    assert.deepEqual(request.body, { action: 'search', query: '  合成查询  ', topK: 7, threshold: 0, embeddingModel: 'nomic-embed-text:latest' });
    for (const text of ['合成检索正文', '合成来源', '87.50%', '0.125000', '80-90%', '找到 1 个结果']) assert.ok(container.textContent.includes(text), text);
  }, { fetch: request => request.body?.action === 'search' ? { success: true, results, embeddingModel: 'nomic-embed-text:latest', dimension: 768, collectionDimension: 768 } : undefined });
});

test('dimension mismatch blocks search before any POST and follows selected model changes', async () => {
  await withPage(async ({ container, requests, click, buttons, fill }) => {
    await click(buttons('bge-m3')[0]);
    assert.match(container.textContent, /向量维度不匹配/);
    await click(buttons('🔍 搜索')[0]);
    await fill('input[placeholder="输入搜索内容..."]', '合成查询');
    await click(buttons('🔍 搜索')[1]);
    assert.match(container.textContent, /维度不匹配! 集合: 768维, 模型: 1024维/);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
  });
});

test('failed and rejected search requests preserve public error messages and release the busy state', async () => {
  let searches = 0;
  await withPage(async ({ container, click, buttons, fill }) => {
    await click(buttons('🔍 搜索')[0]);
    await fill('input[placeholder="输入搜索内容..."]', '合成查询');
    await click(buttons('🔍 搜索')[1]);
    assert.match(container.textContent, /❌ 合成检索失败/);
    await click(buttons('🔍 搜索')[1]);
    assert.match(container.textContent, /合成网络错误/);
    assert.equal(buttons('🔍 搜索')[1].disabled, false);
  }, { fetch(request) { if (request.body?.action === 'search') { searches += 1; if (searches === 1) return { success: false, error: '合成检索失败' }; throw new Error('合成网络错误'); } } });
});

test('text and URL import tabs keep drafts and preserve pipeline payloads and status refresh', async () => {
  await withPage(async ({ container, requests, click, buttons, fill }) => {
    await click(buttons('📥 导入')[0]);
    await fill('textarea', '合成导入正文');
    await click(buttons('🌐URL')[0]);
    await fill('input[type="url"]', 'https://example.invalid/synthetic');
    await click(buttons('📺YouTube')[0]);
    assert.equal(container.querySelector('input[type="url"]').value, 'https://example.invalid/synthetic');
    await click(buttons('📄文本')[0]);
    assert.equal(container.querySelector('textarea').value, '合成导入正文');
    await click(buttons('📥 导入到 Milvus')[0]);
    const imported = requests.find(request => request.body?.action === 'process-text').body;
    assert.deepEqual({ ...imported, source: '<timestamp>' }, { action: 'process-text', text: '合成导入正文', source: '<timestamp>', chunkSize: 500, chunkOverlap: 50, embeddingModel: 'nomic-embed-text:latest' });
    assert.match(imported.source, /^text-import-\d+$/);
    assert.equal(container.querySelector('textarea').value, '');
    assert.match(container.textContent, /成功导入 2 个文档块/);
    assert.equal(requests.filter(request => request.url === '/rag-api/milvus?action=status').length, 2);
  }, { fetch: request => request.body?.action === 'process-text' ? { success: true, chunks: 2, documentId: '合成文档', metadata: { type: 'text' } } : undefined });
});

test('query-path, similarity distribution, and vector-space payloads render actual SVG points and selected details', async () => {
  await withPage(async ({ container, requests, click, buttons, fill }) => {
    await click(buttons('🎨 可视化')[0]);
    await fill('input[placeholder="输入查询文本进行可视化分析..."]', '合成分析');
    await click(buttons('🔍分析')[0]);
    assert.match(container.textContent, /耗时: 7ms \(嵌入: 3ms, 搜索: 4ms\)/);
    assert.equal(container.querySelectorAll('svg[viewBox="-5 -5 10 10"] line').length, 1);
    assert.equal(container.querySelectorAll('svg[viewBox="-5 -5 10 10"] circle').length, 2);
    await click(container.querySelectorAll('svg[viewBox="-5 -5 10 10"] circle')[1]);
    assert.match(container.textContent, /合成节点详情/);
    assert.match(container.textContent, /87.5%/);
    await click(buttons('更新分布')[0]);
    assert.match(container.textContent, /87.50%/);
    assert.match(container.textContent, /合成检索正文/);
    await click(buttons('🌐加载空间')[0]);
    const point = container.querySelector('svg[viewBox="-1.5 -1.5 3 3"] circle');
    assert.equal(point.getAttribute('cx'), '0.2');
    assert.equal(point.getAttribute('fill'), '#123456');
    await click(point);
    assert.equal(point.getAttribute('r'), '0.08');
    assert.deepEqual(requests.filter(request => request.url === '/rag-api/milvus/visualize').map(request => request.body), [
      { action: 'query-path', query: '合成分析', topK: 10 },
      { action: 'similarity-distribution', query: '合成分析', topK: 50 },
      { action: 'vector-space', sampleSize: 100 },
    ]);
  }, { fetch(request) {
    if (request.body?.action === 'query-path') return { success: true, visualization: { nodes: [{ id: 'query', type: 'query', x: 0, y: 0, label: '合成分析' }, { id: 'doc', type: 'document', x: 1, y: 2, label: '合成节点详情', source: '合成节点来源', score: 0.875 }], edges: [{ source: 'query', target: 'doc', weight: 0.875 }] }, timing: { embedding: 3, search: 4, total: 7 } };
    if (request.body?.action === 'similarity-distribution') return { success: true, distribution: { '0.8-0.9': 1 }, statistics: { max: 0.875, mean: 0.875, min: 0.875, median: 0.875 }, results };
    if (request.body?.action === 'vector-space') return { success: true, points: [{ id: 'point', x: 0.2, y: -0.3, content: '合成点', source: '合成', cluster: 1 }], clusters: [{ id: 1, name: '合成聚类', color: '#123456' }] };
  } });
});

test('clear confirmation and disconnect keep their existing action payloads', async () => {
  await withPage(async context => {
    const { container, requests, click, buttons, setConfirm } = context;
    setConfirm(false);
    await click(buttons('清空')[0]);
    assert.equal(context.confirmCalls, 1);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    setConfirm(true);
    await click(buttons('清空')[0]);
    await click(buttons('断开')[0]);
    assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => request.body), [{ action: 'clear' }, { action: 'disconnect' }]);
    assert.match(container.textContent, /未连接/);
    assert.match(container.textContent, /已断开 Milvus 连接/);
  }, { fetch: request => ['clear', 'disconnect'].includes(request.body?.action) ? { success: true } : undefined });
});

test('strict page-only TypeScript uses explicit files and never enumerates project directories', () => {
  const projectRoot = path.resolve(path.dirname(pagePath), '../../..');
  const configFile = ts.readConfigFile(path.join(projectRoot, 'tsconfig.json'), ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  let directoryReads = 0;
  const parsed = ts.parseJsonConfigFileContent({ ...configFile.config, files: [pagePath], include: [], exclude: [] }, {
    ...ts.sys,
    readDirectory() { directoryReads += 1; throw new Error('Narrow page typecheck must not enumerate project directories'); },
  }, projectRoot);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fileNames.map(file => path.resolve(file)), [pagePath]);
  assert.equal(directoryReads, 0);
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, incremental: false });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => projectRoot, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
});
