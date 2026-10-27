import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const requireDependency = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);

function loadSource(path, overrides = {}, globals = {}) {
  const filename = new URL(path, root);
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename.pathname,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(compiled, {
    module: testModule,
    exports: testModule.exports,
    require(specifier) {
      if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
      if (['react', 'react/jsx-runtime', 'clsx', 'tailwind-merge'].includes(specifier)) {
        return requireDependency(specifier);
      }
      throw new Error(`Unexpected UI test import: ${specifier}`);
    },
    Error,
    console: { error() {} },
    ...globals,
  }, { filename: filename.pathname });
  return testModule.exports;
}

// Exercise the real handlers without a DOM, timers, network or global React mutation.
function createHooks(initialStateOverrides = {}) {
  const slots = [];
  const pendingEffects = [];
  let cursor = 0;
  let stateWrites = 0;
  const sameDependencies = (before, after) => before && after && before.length === after.length
    && before.every((value, index) => Object.is(value, after[index]));
  function memo(factory, dependencies) {
    const index = cursor++;
    if (!(index in slots) || !sameDependencies(slots[index].dependencies, dependencies)) {
      slots[index] = { value: factory(), dependencies };
    }
    return slots[index].value;
  }
  return {
    react: {
      ...React,
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = Object.hasOwn(initialStateOverrides, index)
          ? initialStateOverrides[index] : typeof initial === 'function' ? initial() : initial;
        return [slots[index], (next) => {
          stateWrites++;
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        }];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
      useMemo: memo,
      useCallback: (callback, dependencies) => memo(() => callback, dependencies),
      useEffect(effect, dependencies) {
        const index = cursor++;
        if (!(index in slots) || !sameDependencies(slots[index], dependencies)) pendingEffects.push(effect);
        slots[index] = dependencies;
      },
    },
    render(component, props = {}) {
      cursor = 0;
      return component(props);
    },
    flushEffects() { return pendingEffects.splice(0).map((effect) => effect()); },
    get stateWrites() { return stateWrites; },
  };
}

function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, predicate));
  if (!React.isValidElement(tree)) return [];
  return [
    ...(predicate(tree) ? [tree] : []),
    ...elements(tree.props.children, predicate),
  ];
}

const utils = loadSource('src/lib/utils.ts');

for (const [name, path, tag, props] of [
  ['Input', 'src/components/ui/input.tsx', 'input', { type: 'search', defaultValue: 'query', required: true }],
  ['Textarea', 'src/components/ui/textarea.tsx', 'textarea', { rows: 4, defaultValue: 'notes', required: true }],
]) {
  test(`${name} retains native attributes, merged classes and forwarded ref`, () => {
    const component = loadSource(path, { '@/lib/utils': utils })[name];
    const ref = React.createRef();
    const element = component.render({ ...props, id: 'native-control', className: 'custom-control', disabled: true }, ref);
    assert.equal(element.type, tag);
    assert.equal(element.props.ref, ref);
    assert.equal(element.props.id, 'native-control');
    assert.equal(element.props.disabled, true);
    assert.equal(element.props.required, true);
    assert.match(element.props.className, /custom-control/);
    for (const [key, value] of Object.entries(props)) assert.equal(element.props[key], value);
    const html = renderToStaticMarkup(element);
    assert.match(html, /id="native-control"/);
    assert.match(html, /disabled=""/);
    assert.match(html, /custom-control/);
  });
}

test('corrective visualizer retains all three tab transitions with opaque payloads', () => {
  const hooks = createHooks();
  const component = loadSource('src/components/SelfCorrectiveRAGVisualizer.tsx', { react: hooks.react }).default;
  const props = {
    query: { original: 'synthetic query', final: 'synthetic query', wasRewritten: false, rewriteCount: 0 },
    workflow: {
      nodeExecutions: [{ node: 'retrieve', status: 'completed', input: null, output: ['opaque'] }],
      decisionPath: ['RETRIEVE', 'GENERATE'], totalDuration: 7,
    },
    retrieval: { totalDocuments: 1, filteredDocuments: 1, documents: [{
      id: 'fixture', content: 'synthetic evidence', score: 0.9, metadata: { opaque: null },
    }] },
    answer: 'synthetic answer',
  };
  const labels = ['工作流', '详细信息', '结果'];
  for (let index = 0; index < labels.length; index++) {
    let tree = hooks.render(component, props);
    const tabs = elements(tree, (element) => element.type === 'button' && labels.includes(element.props.children?.[2]));
    assert.equal(tabs.length, 3);
    tabs[index].props.onClick();
    tree = hooks.render(component, props);
    const selected = elements(tree, (element) => element.type === 'button' && /shadow-md/.test(element.props.className));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].props.children[2], labels[index]);
    const html = renderToStaticMarkup(tree);
    assert.match(html, [/4 节点质量控制闭环/, /synthetic evidence/, /synthetic answer/][index]);
  }
});

test('Self-RAG initial controls retain an idle, disabled submit without invoking services', () => {
  const hooks = createHooks();
  const component = loadSource('src/components/SelfRAGVisualization.tsx', { react: hooks.react }).default;
  const tree = hooks.render(component);
  const submit = elements(tree, (element) => element.type === 'button' && element.props.onClick?.name === 'runSelfRAG');
  assert.equal(submit.length, 1);
  assert.equal(submit[0].props.disabled, true);
  assert.match(renderToStaticMarkup(tree), /Self-RAG/);
});

function createPage(fetch) {
  const hooks = createHooks();
  const stub = () => null;
  const component = loadSource('src/app/self-corrective-rag/page.tsx', {
    react: hooks.react,
    'next/link': stub,
    '@/components/SelfCorrectiveRAGVisualizer': stub,
    '@/components/SCRAGLangSmithViewer': stub,
  }, { fetch }).default;
  return () => hooks.render(component);
}

for (const [name, rejection, expected] of [
  ['Error', new Error('synthetic service failure'), 'synthetic service failure'],
  ['null', null, '未知错误'],
  ['opaque object', { get message() { throw new Error('must not inspect opaque rejection'); } }, '未知错误'],
]) {
  test(`corrective page handles ${name} rejection and clears loading`, async () => {
    let calls = 0;
    const render = createPage(async (url, request) => {
      calls++;
      assert.equal(url, '/rag-api/self-corrective-rag');
      assert.equal(request.method, 'POST');
      assert.equal(JSON.parse(request.body).query, 'synthetic question');
      throw rejection;
    });
    let tree = render();
    elements(tree, (element) => element.type === 'textarea')[0].props.onChange({ target: { value: 'synthetic question' } });
    tree = render();
    await assert.doesNotReject(elements(tree, (element) => element.type === 'form')[0].props.onSubmit());
    tree = render();
    assert.equal(calls, 1);
    assert.equal(elements(tree, (element) => element.type === 'textarea')[0].props.disabled, false);
    const messages = elements(tree, (element) => element.type === 'p' && element.props.className === 'whitespace-pre-wrap');
    assert.equal(messages.length, 2);
    assert.equal(messages[1].props.children, `请求失败: ${expected}`);
  });
}

test('corrective page ignores empty input and retains a successful assistant answer', async () => {
  let calls = 0;
  const render = createPage(async () => {
    calls++;
    return { json: async () => ({ answer: 'synthetic success' }) };
  });
  let tree = render();
  await elements(tree, (element) => element.type === 'form')[0].props.onSubmit();
  assert.equal(calls, 0);
  elements(tree, (element) => element.type === 'textarea')[0].props.onChange({ target: { value: 'question' } });
  tree = render();
  await elements(tree, (element) => element.type === 'form')[0].props.onSubmit();
  tree = render();
  assert.equal(calls, 1);
  const messages = elements(tree, (element) => element.type === 'p' && element.props.className === 'whitespace-pre-wrap');
  assert.equal(messages[1].props.children, 'synthetic success');
  assert.equal(elements(tree, (element) => element.type === 'textarea')[0].props.disabled, false);
});

test('realtime monitor preserves partial progress, bounded width and top-three preview', () => {
  const component = loadSource('src/components/RealtimeMonitoring.tsx').default;
  const html = renderToStaticMarkup(React.createElement(component, {
    showVectorization: true, vectorizationDetails: { current: 2, total: 3, dimension: 384, filename: 'synthetic.pdf' },
    vectorizationProgress: 150, vectorizationStatus: 'working', showQueryProcessing: true,
    queryProcessingStatus: 'querying', isLoading: true,
    queryAnalysis: { tokenization: { tokenCount: 7 }, embedding: { embeddingDimension: 384 } },
    retrievalDetails: { searchTime: 9, searchResults: [0.95, 0.75, 0.5, 0.1].map((similarity) => ({ similarity })) },
  }));
  assert.match(html, /width:100%/);
  assert.match(html, /synthetic.pdf/);
  assert.match(html, /95.0%/);
  assert.match(html, /75.0%/);
  assert.match(html, /50.0%/);
  assert.doesNotMatch(html, /10.0%/);
});

test('realtime monitor keeps its three empty states without domain runtime imports', () => {
  const component = loadSource('src/components/RealtimeMonitoring.tsx').default;
  const html = renderToStaticMarkup(React.createElement(component, {
    showVectorization: false, vectorizationDetails: null, vectorizationProgress: 0, vectorizationStatus: '',
    showQueryProcessing: false, queryProcessingStatus: '', isLoading: false, queryAnalysis: null, retrievalDetails: null,
  }));
  assert.match(html, /等待文档向量化/);
  assert.match(html, /等待查询处理/);
});

test('cognitive panel counts only present entity types and preserves empty analysis', () => {
  const hooks = createHooks({ 0: 'entities' });
  const component = loadSource('src/components/CognitiveParsingPanel.tsx', { react: hooks.react }).default;
  const props = { queryAnalysis: {
    originalQuery: 'synthetic', intent: 'factual', complexity: 'simple', confidence: 0.9, keywords: [],
    entities: ['PERSON', 'PERSON', 'LOCATION'].map((type, index) => ({ name: `entity-${index}`, type, value: 'value', confidence: 0.9 })),
  } };
  const html = renderToStaticMarkup(hooks.render(component, props));
  assert.match(html, /人物: 2/);
  assert.match(html, /地点: 1/);
  assert.doesNotMatch(html, /组织: 0/);
  assert.doesNotThrow(() => renderToStaticMarkup(hooks.render(component, { queryAnalysis: null })));
});

test('retrieval details preserve nested metadata formatting and numeric chart labels', () => {
  const options = [];
  const Chart = ({ option }) => { options.push(option); return null; };
  const component = loadSource('src/components/RetrievalDetailsPanel.tsx', {
    'next/dynamic': () => Chart,
    '@/components/RetrievalEffectSummary': () => null,
  }).default;
  const html = renderToStaticMarkup(React.createElement(component, { retrievalDetails: {
    searchResults: [{ document: { content: 'synthetic evidence', metadata: {
      source: 'fixture', range: { start: 2, end: 5 }, nested: ['one', { line: 8 }], missing: null,
    } }, similarity: 0.8, index: 0 }, {
      document: { content: 'second synthetic evidence', metadata: {} }, similarity: 0.4, index: 1,
    }], threshold: 0.3, topK: 3, totalDocuments: 2, searchTime: 4,
  } }));
  assert.match(html, /2-5/);
  assert.match(html, /one, Line 8/);
  assert.match(html, /N\/A/);
  const bar = options.flatMap((option) => option.series).find((series) => series.type === 'bar');
  assert.ok(bar);
  assert.equal(bar.label.formatter({ value: 0.8 }), '80%');
  assert.equal(bar.label.formatter({ value: 0 }), '0%');
});

function createObservability(fetch) {
  const hooks = createHooks();
  const icon = () => null;
  const component = loadSource('src/app/observability/page.tsx', {
    react: hooks.react,
    'lucide-react': Object.fromEntries(['ArrowLeft', 'BarChart3', 'Clock', 'CheckCircle', 'Coins', 'RefreshCw', 'Trash2', 'ThumbsUp', 'ThumbsDown'].map((name) => [name, icon])),
    '@/components/ui/button': { Button: 'button' },
    '@/components/ui/card': Object.fromEntries(['Card', 'CardContent', 'CardDescription', 'CardHeader', 'CardTitle'].map((name) => [name, 'section'])),
    '@/components/ui/badge': { Badge: 'span' },
    'next/link': 'a',
  }, { fetch, AbortController }).default;
  return { hooks, render: () => hooks.render(component) };
}

const settleRequests = () => new Promise((resolve) => setImmediate(resolve));
const emptyTraceData = () => ({ success: true, traces: [], stats: {
  totalTraces: 0, successRate: 0, avgDuration: 0, totalTokens: 0, avgTokensPerTrace: 0,
} });

test('observability mount starts loading without synchronous effect state writes', async () => {
  let release;
  const page = createObservability(() => new Promise((resolve) => { release = resolve; }));
  const tree = page.render();
  assert.equal(elements(tree, (element) => element.type === 'button' && element.props.disabled !== undefined)[0].props.disabled, true);
  const writes = page.hooks.stateWrites;
  page.hooks.flushEffects();
  assert.equal(page.hooks.stateWrites, writes);
  release({ json: async () => emptyTraceData() });
  await settleRequests();
  assert.equal(elements(page.render(), (element) => element.type === 'button' && element.props.disabled !== undefined)[0].props.disabled, false);
});

test('observability cleanup aborts fetch and ignores an uncancellable late response', async () => {
  let release;
  let signal;
  const page = createObservability((_url, options) => {
    signal = options?.signal;
    return new Promise((resolve) => { release = resolve; });
  });
  page.render();
  const [cleanup] = page.hooks.flushEffects();
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.equal(signal.aborted, true);
  const writes = page.hooks.stateWrites;
  release({ json: async () => emptyTraceData() });
  await settleRequests();
  assert.equal(page.hooks.stateWrites, writes);
});

test('observability does not mutate trace state order or render an opaque question object', async () => {
  const traces = Object.freeze([
    { id: 'older', name: 'older trace', startTime: '2026-01-01T00:00:00Z', status: 'SUCCESS', observations: [], scores: [], input: { question: { opaque: true } } },
    { id: 'newer', name: 'newer trace', startTime: '2026-01-02T00:00:00Z', status: 'SUCCESS', observations: [], scores: [], input: { question: 'valid question' } },
  ]);
  const page = createObservability(async () => ({ json: async () => ({ ...emptyTraceData(), traces }) }));
  page.render();
  page.hooks.flushEffects();
  await settleRequests();
  const html = renderToStaticMarkup(page.render());
  assert.deepEqual(traces.map((trace) => trace.id), ['older', 'newer']);
  assert.ok(html.indexOf('newer trace') < html.indexOf('older trace'));
  assert.match(html, /No question/);
  assert.match(html, /valid question/);
});

test('observability renders only string questions from unknown trace input', async () => {
  const traces = [null, 7, { question: { opaque: true } }, { question: 'valid question' }].map((input, index) => ({
    id: `trace-${index}`, name: 'synthetic trace', startTime: '2026-01-01T00:00:00Z', status: 'SUCCESS', observations: [], scores: [], input,
  }));
  const page = createObservability(async () => ({ json: async () => ({ ...emptyTraceData(), traces }) }));
  page.render();
  page.hooks.flushEffects();
  await settleRequests();
  const html = renderToStaticMarkup(page.render());
  assert.equal((html.match(/No question/g) ?? []).length, 3);
  assert.match(html, /valid question/);
});

test('observability manual refresh owns its loading state and never passes the click event as a signal', async () => {
  let calls = 0;
  let releaseRefresh;
  const signals = [];
  const page = createObservability((_url, options) => {
    calls++;
    signals.push(options?.signal);
    if (calls === 1) {
      return Promise.resolve({ json: async () => emptyTraceData() });
    }
    return new Promise((resolve) => { releaseRefresh = resolve; });
  });
  page.render();
  page.hooks.flushEffects();
  // Assertions belong outside the product's rejection handler.
  assert.ok(signals[0] instanceof AbortSignal);
  await settleRequests();
  const refresh = elements(page.render(), (element) => element.type === 'button' && element.props.disabled !== undefined)[0];
  assert.equal(refresh.props.disabled, false);
  refresh.props.onClick({ type: 'click' });
  assert.equal(calls, 2);
  assert.equal(signals[1], undefined);
  assert.equal(elements(page.render(), (element) => element.type === 'button' && element.props.disabled !== undefined)[0].props.disabled, true);
  releaseRefresh({ json: async () => emptyTraceData() });
  await settleRequests();
  assert.equal(elements(page.render(), (element) => element.type === 'button' && element.props.disabled !== undefined)[0].props.disabled, false);
});

test('observability rejected load clears loading without escaping the result callback', async () => {
  const page = createObservability(async () => { throw new Error('synthetic fetch failure'); });
  page.render();
  page.hooks.flushEffects();
  await settleRequests();
  const tree = page.render();
  assert.equal(elements(tree, (element) => element.type === 'button' && element.props.disabled !== undefined)[0].props.disabled, false);
  assert.match(renderToStaticMarkup(tree), /暂无 Traces 数据/);
});

const modelConfigData = () => ({
  success: true,
  config: {
    llm: { provider: 'ollama', model: 'synthetic-chat' },
    embedding: { provider: 'ollama', model: 'synthetic-embedding', dimension: 384 },
    registeredModels: [],
  },
  validation: { overall: { valid: true, errors: [] } },
});

function createModelConfig(fetch) {
  const hooks = createHooks();
  const component = loadSource('src/components/ModelConfigPanel.tsx', { react: hooks.react }, { fetch, AbortController }).ModelConfigPanel;
  return { hooks, render: () => hooks.render(component) };
}

test('model config mount owns initial loading without synchronous effect state writes', async () => {
  let release;
  const requests = [];
  const panel = createModelConfig((url, options) => {
    requests.push({ url, options });
    return new Promise((resolve) => { release = resolve; });
  });
  assert.match(renderToStaticMarkup(panel.render()), /加载配置中/);
  const writes = panel.hooks.stateWrites;
  panel.hooks.flushEffects();
  assert.equal(panel.hooks.stateWrites, writes);
  assert.equal(requests[0].url, '/rag-api/model-config');
  assert.ok(requests[0].options?.signal instanceof AbortSignal);
  release({ json: async () => modelConfigData() });
  await settleRequests();
  assert.match(renderToStaticMarkup(panel.render()), /模型配置/);
  assert.doesNotMatch(renderToStaticMarkup(panel.render()), /加载配置中/);
});

for (const outcome of ['resolve', 'reject']) {
  test(`model config cleanup ignores a late ${outcome} without state writes`, async () => {
    let finish;
    let signal;
    const panel = createModelConfig((_url, options) => {
      signal = options?.signal;
      return new Promise((resolve, reject) => { finish = outcome === 'resolve' ? resolve : reject; });
    });
    panel.render();
    const [cleanup] = panel.hooks.flushEffects();
    assert.equal(typeof cleanup, 'function');
    cleanup();
    assert.equal(signal.aborted, true);
    const writes = panel.hooks.stateWrites;
    finish(outcome === 'resolve' ? { json: async () => modelConfigData() } : new Error('synthetic late failure'));
    await settleRequests();
    assert.equal(panel.hooks.stateWrites, writes);
  });
}

test('model config retry and refresh keep click events out of request signals', async () => {
  const requests = [];
  let release;
  const panel = createModelConfig((url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return Promise.reject(new Error('synthetic config failure'));
    return new Promise((resolve) => { release = resolve; });
  });
  panel.render();
  panel.hooks.flushEffects();
  await settleRequests();
  assert.match(renderToStaticMarkup(panel.render()), /synthetic config failure/);
  const retry = elements(panel.render(), (element) => element.type === 'button')[0];
  retry.props.onClick({ type: 'click' });
  assert.match(renderToStaticMarkup(panel.render()), /加载配置中/);
  assert.equal(requests[1].options?.signal, undefined);
  release({ json: async () => modelConfigData() });
  await settleRequests();
  elements(panel.render(), (element) => element.type === 'button')[0].props.onClick();
  const refresh = elements(panel.render(), (element) => element.type === 'button' && element.props.children === '↻ 刷新')[0];
  refresh.props.onClick({ type: 'click' });
  assert.match(renderToStaticMarkup(panel.render()), /加载配置中/);
  assert.equal(requests[2].options?.signal, undefined);
  release({ json: async () => modelConfigData() });
  await settleRequests();
  assert.match(renderToStaticMarkup(panel.render()), /synthetic-chat/);
});

test('model config reload retains its POST action and awaits the subsequent GET', async () => {
  const requests = [];
  let release;
  const panel = createModelConfig((url, options) => {
    requests.push({ url, options });
    if (requests.length <= 2) return Promise.resolve({ json: async () => modelConfigData() });
    return new Promise((resolve) => { release = resolve; });
  });
  panel.render();
  panel.hooks.flushEffects();
  await settleRequests();
  elements(panel.render(), (element) => element.type === 'button')[0].props.onClick();
  const reload = elements(panel.render(), (element) => element.type === 'button' && element.props.children === '🔄 重新加载配置')[0];
  let completed = false;
  const pending = reload.props.onClick().then(() => { completed = true; });
  await settleRequests();
  assert.equal(requests.length, 3);
  assert.equal(requests[1].url, '/rag-api/model-config');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.body, JSON.stringify({ action: 'reload' }));
  assert.equal(requests[2].options?.method, undefined);
  assert.equal(completed, false);
  release({ json: async () => modelConfigData() });
  await pending;
  assert.equal(completed, true);
  assert.doesNotMatch(renderToStaticMarkup(panel.render()), /加载配置中/);
});

test('question selector treats analysis as opaque and retains selection, toggle, clear and truncation', () => {
  const component = loadSource('src/components/QuestionSelector.tsx').default;
  const opaque = new Proxy({}, { get() { throw new Error('must not inspect analysis'); } });
  const selected = [];
  const messages = [
    { id: 'assistant', type: 'assistant', content: 'ignored assistant', queryAnalysis: opaque },
    { id: 'missing', type: 'user', content: 'ignored missing' },
    { id: 'false', type: 'user', content: 'ignored false', queryAnalysis: false },
    { id: 'null', type: 'user', content: 'ignored null', queryAnalysis: null },
    { id: 'question', type: 'user', content: 'x'.repeat(31), queryAnalysis: opaque },
  ];
  const props = { messages, viewingAnalysisFor: null, onSelect: (id) => selected.push(id) };
  let tree = component(props);
  let buttons = elements(tree, (element) => element.type === 'button');
  assert.equal(buttons.length, 1);
  assert.match(renderToStaticMarkup(tree), new RegExp(`${'x'.repeat(30)}\\.\\.\\.`));
  assert.doesNotMatch(renderToStaticMarkup(tree), /ignored/);
  buttons[0].props.onClick();
  tree = component({ ...props, viewingAnalysisFor: 'question' });
  buttons = elements(tree, (element) => element.type === 'button');
  assert.equal(buttons.length, 2);
  buttons[1].props.onClick();
  buttons[0].props.onClick();
  assert.deepEqual(selected, ['question', null, null]);
  assert.equal(component({ ...props, messages: messages.slice(0, 4) }), null);
});

const reasoningData = () => ({
  success: true,
  files: [{ filename: 'synthetic.txt', originalName: 'synthetic.txt', sizeFormatted: '1 B' }],
  collection: 'synthetic', collectionStats: { rowCount: 7, name: 'synthetic', embeddingDimension: 384 },
  fileStats: { uploadedFiles: 1, textFiles: 1 }, isReady: true,
});

function createReasoningFiles(fetch, globals = {}) {
  const hooks = createHooks();
  const component = loadSource('src/components/ReasoningFileManager.tsx', { react: hooks.react }, { fetch, AbortController, ...globals }).default;
  return { hooks, render: (props = {}) => hooks.render(component, { embeddingModel: 'synthetic', ...props }) };
}

test('reasoning file mount keeps parallel reads, reports status and refreshes without an event signal', async () => {
  const requests = [];
  const statuses = [];
  const panel = createReasoningFiles((url, options) => {
    requests.push({ url, options });
    return Promise.resolve({ json: async () => reasoningData() });
  });
  const props = { onStatusChange: (...args) => statuses.push(args) };
  panel.render(props);
  const writes = panel.hooks.stateWrites;
  panel.hooks.flushEffects();
  assert.equal(panel.hooks.stateWrites, writes);
  assert.deepEqual(requests.map(({ url }) => url), ['/rag-api/reasoning-rag/files', '/rag-api/reasoning-rag/vectorize']);
  assert.ok(requests[0].options?.signal instanceof AbortSignal);
  assert.equal(requests[0].options.signal, requests[1].options.signal);
  await settleRequests();
  assert.deepEqual(statuses, [[true, 7]]);
  const tree = panel.render(props);
  assert.match(renderToStaticMarkup(tree), /synthetic.txt/);
  const refresh = elements(tree, (element) => element.type === 'button' && element.props.children === '🔄 刷新')[0];
  refresh.props.onClick({ type: 'click' });
  await settleRequests();
  assert.equal(requests.length, 4);
  assert.equal(requests[2].options?.signal, undefined);
  assert.equal(requests[3].options?.signal, undefined);
  assert.deepEqual(statuses, [[true, 7], [true, 7]]);
});

for (const outcome of ['resolve', 'reject']) {
  test(`reasoning file cleanup ignores late ${outcome}, including the old status callback`, async () => {
    const pending = [];
    const requests = [];
    const statuses = [];
    const errors = [];
    const panel = createReasoningFiles((_url, options) => {
      requests.push(options);
      return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
    }, { console: { error: (...args) => errors.push(args) } });
    panel.render({ onStatusChange: (...args) => statuses.push(args) });
    const [cleanup] = panel.hooks.flushEffects();
    assert.equal(typeof cleanup, 'function');
    cleanup();
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, true);
    const writes = panel.hooks.stateWrites;
    for (const request of pending) {
      if (outcome === 'resolve') request.resolve({ json: async () => reasoningData() });
      else request.reject(new Error('synthetic late failure'));
    }
    await settleRequests();
    assert.equal(panel.hooks.stateWrites, writes);
    assert.deepEqual(statuses, []);
    assert.deepEqual(errors, []);
  });
}

test('thinking chain retains compact, expanded and collapsed views with unknown metadata', () => {
  const hooks = createHooks();
  const component = loadSource('src/components/ThinkingChainDisplay.tsx', { react: hooks.react }).default;
  const props = { steps: [{
    id: 'synthetic-step', timestamp: 0, type: 'reasoning', content: 'synthetic reasoning', confidence: 0.8,
    metadata: { nested: { count: 2 }, empty: null, enabled: false },
  }] };
  let tree = hooks.render(component, props);
  assert.match(renderToStaticMarkup(tree), /synthetic reasoning/);
  assert.match(renderToStaticMarkup(tree), /nested:/);
  assert.match(renderToStaticMarkup(tree), /80%/);
  elements(tree, (element) => element.type === 'button')[0].props.onClick();
  tree = hooks.render(component, props);
  assert.doesNotMatch(renderToStaticMarkup(tree), /synthetic reasoning/);
  assert.match(renderToStaticMarkup(hooks.render(component, { ...props, compact: true })), /title="synthetic reasoning"/);
  assert.equal(hooks.render(component, { steps: [] }), null);
});

test('Milvus results only display string source labels from unknown metadata', () => {
  const hooks = createHooks({
    0: true,
    3: { phase: 'complete', query: 'synthetic', timing: {}, results: ['valid-source', { opaque: true }, 7, null].map((source, index) => ({
      id: `result-${index}`, content: 'synthetic evidence', score: 0.9, metadata: { source },
    })) },
  });
  const component = loadSource('src/components/MilvusQueryVisualizer.tsx', { react: hooks.react }).default;
  // Effects remain queued; no status/search network or timers execute in this rendering test.
  const html = renderToStaticMarkup(hooks.render(component));
  assert.match(html, /valid-source/);
  assert.match(html, /文档 2/);
  assert.match(html, /文档 3/);
  assert.match(html, /文档 4/);
});

function renderTraceChart(props) {
  const hooks = createHooks();
  const options = [];
  const Chart = ({ option }) => { options.push(option); return null; };
  const component = loadSource('src/components/TraceTrieVisualization.tsx', {
    react: hooks.react, 'next/dynamic': () => Chart,
  }).default;
  renderToStaticMarkup(hooks.render(component, { text: 'synthetic', ...props }));
  return options;
}

test('trace chart tooltip escapes token markup while retaining numeric formatting', () => {
  const token = '<img src=x onerror=synthetic>&"\'';
  const [option] = renderTraceChart({
    vectorWeights: [{ tokenId: 2, vectorMagnitude: 0.9, token }],
    densityInfos: [{ tokenId: 2, density: 0.5 }],
  });
  assert.ok(option);
  const html = option.tooltip.formatter({ data: option.series[0].data[0] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=synthetic&gt;&amp;&quot;&#39;/);
  assert.match(html, /0\.3333/);
  assert.match(html, /0\.900/);
  assert.match(html, /0\.50/);
});

test('trace chart joins density by token identity, preserves zero and bounds scatter size', () => {
  const [option] = renderTraceChart({
    vectorWeights: [
      { tokenId: 10, vectorMagnitude: 0.9, token: 'first' },
      { tokenId: 20, vectorMagnitude: 0.3, token: 'second' },
      { tokenId: 30, vectorMagnitude: 0.5, token: 'missing-density' },
    ],
    densityInfos: [{ tokenId: 20, density: 2 }, { tokenId: 10, density: 0 }],
  });
  const series = option.series[0];
  assert.deepEqual(Array.from(series.data, (point) => point[3]), [0, 2, 1]);
  assert.equal(series.symbolSize(series.data[0]), 8);
  assert.equal(series.symbolSize(series.data[1]), 25);
  assert.equal(series.symbolSize(series.data[2]), 15);
  assert.equal(series.label.formatter({ data: series.data[0] }), 'first');
  for (const [weight, expected] of [[0.9, '#6366f1'], [0.7, '#8b5cf6'], [0.5, '#a855f7'], [0.3, '#d946ef']]) {
    assert.equal(series.itemStyle.color({ data: [1, weight, 'synthetic', 1] }), expected);
  }
});

test('trace chart keeps empty vector or density inputs out of the chart', () => {
  assert.equal(renderTraceChart({ vectorWeights: [], densityInfos: [{ tokenId: 1, density: 1 }] }).length, 0);
  assert.equal(renderTraceChart({ vectorWeights: [{ tokenId: 1, token: 'synthetic', vectorMagnitude: 1 }], densityInfos: [] }).length, 0);
});

const syntheticDomains = {
  tech: { name: 'synthetic-tech', description: 'synthetic', color: '#123456', icon: 'T' },
  business: { name: 'synthetic-business', description: 'synthetic', color: '#654321', icon: 'B' },
};
const syntheticCentroid = (words) => ({
  ...syntheticDomains.business, seedWords: words, wordCount: words.length, centroid: [1, 0], dimension: 2,
  calculatedAt: '2026-01-01T00:00:00Z',
});
const domainReadData = (url) => url.endsWith('check-ollama')
  ? { success: true, status: 'online', models: ['synthetic'] }
  : url.endsWith('config') ? { success: true, domains: syntheticDomains } : { success: true, centroids: {} };

function createDomainVectors(fetch, initialState = {}) {
  const hooks = createHooks(initialState);
  const component = loadSource('src/app/domain-vectors/page.tsx', {
    react: hooks.react, 'next/link': 'a',
  }, { fetch, AbortController }).default;
  return { hooks, render: () => hooks.render(component) };
}

test('domain vectors mount starts three parallel cancellable reads without synchronous state writes', async () => {
  const requests = [];
  const releases = [];
  const page = createDomainVectors((url, options) => {
    requests.push({ url, options });
    return new Promise((resolve) => releases.push(() => resolve({ json: async () => domainReadData(url) })));
  });
  assert.match(renderToStaticMarkup(page.render()), /检查中/);
  const writes = page.hooks.stateWrites;
  page.hooks.flushEffects();
  assert.equal(page.hooks.stateWrites, writes);
  assert.deepEqual(requests.map(({ url }) => url), ['check-ollama', 'config', 'centroids'].map(action => `/rag-api/domain-vectors?action=${action}`));
  assert.ok(requests[0].options?.signal instanceof AbortSignal);
  assert.ok(requests.every(request => request.options.signal === requests[0].options.signal));
  for (const release of releases) release();
  await settleRequests();
  assert.match(renderToStaticMarkup(page.render()), /Ollama: 在线/);
  assert.match(renderToStaticMarkup(page.render()), /synthetic-tech/);
});

for (const outcome of ['resolve', 'reject']) {
  test(`domain vectors cleanup suppresses late ${outcome} from every initial read`, async () => {
    const requests = [];
    const pending = [];
    const page = createDomainVectors((url, options) => {
      requests.push({ url, options });
      return new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
    });
    page.render();
    const [cleanup] = page.hooks.flushEffects();
    assert.equal(typeof cleanup, 'function');
    cleanup();
    assert.ok(requests.every(request => request.options.signal.aborted));
    const writes = page.hooks.stateWrites;
    for (const request of pending) {
      if (outcome === 'resolve') request.resolve({ json: async () => domainReadData(request.url) });
      else request.reject(new Error('synthetic late domain failure'));
    }
    await settleRequests();
    assert.equal(page.hooks.stateWrites, writes);
  });
}

test('domain vectors late centroid sync preserves edits made in flight but hydrates untouched domains', async () => {
  let release;
  let calls = 0;
  const page = createDomainVectors((url) => {
    calls++;
    if (url.endsWith('centroids')) return new Promise(resolve => { release = resolve; });
    return Promise.resolve({ json: async () => domainReadData(url) });
  }, { 1: syntheticDomains, 5: 'tech' });
  page.render();
  page.hooks.flushEffects();
  await settleRequests();
  elements(page.render(), element => element.type === 'textarea')[0].props.onChange({ target: { value: 'user-edited, retained' } });
  page.render();
  assert.equal(page.hooks.flushEffects().length, 0);
  release({ json: async () => ({ success: true, centroids: {
    tech: syntheticCentroid(['stale-tech']), business: syntheticCentroid(['remote-business']), _meta: { savedAt: 'synthetic' },
  } }) });
  await settleRequests();
  let tree = page.render();
  assert.equal(elements(tree, element => element.type === 'textarea')[0].props.value, 'user-edited, retained');
  const headers = elements(tree, element => element.type === 'div' && element.props.className === 'p-4 cursor-pointer');
  headers[1].props.onClick();
  tree = page.render();
  assert.equal(elements(tree, element => element.type === 'textarea')[0].props.value, 'remote-business');
  assert.equal(calls, 3);
  assert.equal(page.hooks.flushEffects().length, 0);
});

test('domain vectors status refresh keeps loading feedback and never forwards the click event', async () => {
  const requests = [];
  let release;
  const page = createDomainVectors((url, options) => {
    requests.push({ url, options });
    if (requests.length > 3) return new Promise(resolve => { release = resolve; });
    return Promise.resolve({ json: async () => domainReadData(url) });
  });
  page.render();
  page.hooks.flushEffects();
  await settleRequests();
  const refresh = elements(page.render(), element => element.type === 'button' && element.props.children === '刷新')[0];
  refresh.props.onClick({ type: 'click' });
  assert.match(renderToStaticMarkup(page.render()), /检查中/);
  assert.equal(requests[3].url, '/rag-api/domain-vectors?action=check-ollama');
  assert.equal(requests[3].options?.signal, undefined);
  release({ json: async () => ({ success: false }) });
  await settleRequests();
  assert.match(renderToStaticMarkup(page.render()), /Ollama: 离线/);
});

test('domain vectors failed status read does not suppress independent configuration', async () => {
  const page = createDomainVectors(async (url) => {
    if (url.endsWith('check-ollama')) throw new Error('synthetic status failure');
    return { json: async () => domainReadData(url) };
  });
  page.render();
  page.hooks.flushEffects();
  await settleRequests();
  const html = renderToStaticMarkup(page.render());
  assert.match(html, /Ollama: 离线/);
  assert.match(html, /synthetic-tech/);
});

test('domain vectors retains its three tabs and typed similarity detail formatting', () => {
  let fetchCalls = 0;
  const item = {
    domain: 'tech', name: 'synthetic-ranked', icon: 'T', color: '#123456', similarity: 0.8,
    details: { dotProduct: 0.8, queryNorm: 1, centroidNorm: 1, wordCount: 2, seedSample: ['synthetic-seed'],
      topDimensions: [{ dim: 3, queryVal: 1, centroidVal: 0.8, contrib: 0.8 }] },
  };
  const page = createDomainVectors((url) => {
    fetchCalls++;
    return Promise.resolve({ json: async () => domainReadData(url) });
  }, { 9: {
    query: 'synthetic-query', stats: { mean: 0.5, std: 0.1, range: 0.6, queryDim: 2 },
    topDomain: item, similarities: [item], queryVector: { dimension: 2, norm: 1, sample: ['1.000000', '0.000000'] },
  } });
  let tree = page.render();
  const tabs = elements(tree, element => element.type === 'button' && Array.isArray(element.props.children) && ['领域管理', '向量测试', '自定义领域'].includes(element.props.children.at(-1)));
  assert.equal(tabs.length, 3);
  tabs[1].props.onClick();
  let html = renderToStaticMarkup(page.render());
  assert.match(html, /synthetic-ranked/);
  assert.match(html, /80\.0000%/);
  assert.match(html, /维度3/);
  assert.match(html, /synthetic-seed/);
  tabs[2].props.onClick();
  html = renderToStaticMarkup(page.render());
  assert.match(html, /领域ID/);
  tabs[0].props.onClick();
  html = renderToStaticMarkup(page.render());
  assert.match(html, /批量计算所有质心/);
  // Product catch handlers cannot swallow this no-network assertion.
  assert.equal(fetchCalls, 0);
});

function createAdaptivePage(fetch, initialState = {}) {
  const hooks = createHooks(initialState);
  const timers = new Map();
  let nextTimer = 0;
  const component = loadSource('src/app/adaptive-entity-rag/page.tsx', {
    react: hooks.react, 'next/link': 'a', '@/components/CognitiveParsingPanel': () => null,
    '@/lib/runtime-config-defaults': { DEFAULT_RUNTIME_MODELS: { llm: 'synthetic-default', embedding: 'synthetic-embed' } },
  }, { fetch, AbortController, window: {
    setTimeout(callback, delay) { assert.equal(delay, 2000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(timer) { timers.delete(timer); },
  } }).default;
  return { hooks, timers, render: () => hooks.render(component) };
}

const adaptiveReadData = (url) => url.endsWith('model-config')
  ? { config: { llm: { model: 'synthetic-llm' }, embedding: { model: 'synthetic-embed' } } }
  : url.endsWith('ollama/models') ? { success: true,
    llmModels: [{ name: 'synthetic-llm', size: 0, modified_at: 'synthetic' }],
    embeddingModels: [{ name: 'synthetic-embed', size: 0, modified_at: 'synthetic' }] }
    : url.endsWith('entities') ? { success: true, entities: [] }
      : url.endsWith('status') ? { success: true, knowledgeBase: { documentCount: 3, connected: true, embeddingDimension: 384 } }
        : { success: true, files: [{ name: 'synthetic.txt', size: 12, modified: 'synthetic' }] };
const adaptiveRefresh = (tree) => elements(tree, element => element.type === 'button'
  && Array.isArray(element.props.children) && element.props.children.some(value => typeof value === 'string' && value.includes('刷新')))[0];

test('adaptive page starts independent cancellable reads without synchronous effect state writes', async () => {
  const requests = [];
  const page = createAdaptivePage(async (url, options) => {
    requests.push({ url, options });
    return { json: async () => adaptiveReadData(url) };
  });
  page.render();
  const writes = page.hooks.stateWrites;
  page.hooks.flushEffects();
  assert.equal(page.hooks.stateWrites, writes);
  assert.deepEqual(requests.map(request => request.url), [
    '/rag-api/model-config', '/rag-api/adaptive-entity-rag?action=entities',
    '/rag-api/adaptive-entity-rag?action=status', '/rag-api/adaptive-entity-rag?action=files',
  ]);
  assert.ok(requests.every(request => request.options?.signal instanceof AbortSignal));
  await settleRequests();
  assert.equal(requests.length, 5);
  assert.equal(requests[4].options.signal, requests[0].options.signal);
  assert.equal(page.timers.size, 0);
  assert.equal(adaptiveRefresh(page.render()).props.disabled, false);
  assert.match(renderToStaticMarkup(page.render()), /synthetic.txt/);
});

for (const outcome of ['resolve', 'reject']) {
  test(`adaptive page cleanup suppresses late ${outcome} and never dispatches cancelled model follow-up`, async () => {
    const requests = [];
    const page = createAdaptivePage((url, options) => new Promise((resolve, reject) => {
      requests.push({ url, options, resolve, reject });
    }));
    page.render();
    const cleanups = page.hooks.flushEffects();
    assert.equal(cleanups.length, 2);
    assert.ok(cleanups.every(cleanup => typeof cleanup === 'function'));
    for (const cleanup of cleanups) cleanup();
    assert.ok(requests.every(request => request.options.signal.aborted));
    assert.equal(page.timers.size, 0);
    const writes = page.hooks.stateWrites;
    for (const request of requests) {
      if (outcome === 'resolve') request.resolve({ json: async () => adaptiveReadData(request.url) });
      else request.reject(new Error('synthetic late adaptive failure'));
    }
    await settleRequests();
    assert.equal(page.hooks.stateWrites, writes);
    assert.equal(requests.length, 4);
  });
}

test('adaptive page ignores model results that arrive after config completed and cleanup ran', async () => {
  let releaseModel;
  const page = createAdaptivePage((url) => url.endsWith('ollama/models')
    ? new Promise(resolve => { releaseModel = resolve; })
    : Promise.resolve({ json: async () => adaptiveReadData(url) }));
  page.render();
  const cleanups = page.hooks.flushEffects();
  await settleRequests();
  assert.equal(typeof releaseModel, 'function');
  for (const cleanup of cleanups) cleanup();
  const writes = page.hooks.stateWrites;
  releaseModel({ json: async () => adaptiveReadData('/rag-api/ollama/models') });
  await settleRequests();
  assert.equal(page.hooks.stateWrites, writes);
  assert.equal(page.timers.size, 0);
});

test('adaptive page manual refresh owns loading feedback and does not forward a click as signal', async () => {
  const requests = [];
  let rejectRefresh;
  const page = createAdaptivePage((url, options) => {
    requests.push({ url, options });
    return requests.length > 5 ? new Promise((resolve, reject) => { rejectRefresh = reject; })
      : Promise.resolve({ json: async () => adaptiveReadData(url) });
  });
  page.render();
  page.hooks.flushEffects();
  await settleRequests();
  const refresh = adaptiveRefresh(page.render());
  assert.equal(refresh.props.disabled, false);
  refresh.props.onClick({ type: 'click' });
  assert.equal(adaptiveRefresh(page.render()).props.disabled, true);
  assert.equal(requests[5].options?.signal, undefined);
  rejectRefresh(new Error('synthetic refresh failure'));
  await settleRequests();
  assert.equal(adaptiveRefresh(page.render()).props.disabled, false);
  assert.equal(page.timers.size, 0);
});

test('adaptive page retains workflow detail expansion and its three response tabs without network', () => {
  let fetchCalls = 0;
  const page = createAdaptivePage(async () => { fetchCalls++; return { json: async () => ({}) }; }, { 2: {
    success: true, answer: 'synthetic answer', duration: 1,
    queryAnalysis: { originalQuery: 'synthetic', intent: 'factual', complexity: 'simple', confidence: 1, entities: [], keywords: [] },
    entityValidation: [], routingDecision: { action: 'hybrid_search', reason: 'synthetic', constraints: [], relaxedConstraints: [], retryCount: 0 },
    retrievalDetails: { searchResultCount: 0, rankedResultCount: 0, topResults: [] },
    workflow: { totalDuration: 1, steps: [{ step: 'synthetic-step', status: 'completed', details: {
      entityCount: 2, operations: ['synthetic operation'],
      extractedEntities: [{ name: 'synthetic entity', type: 'PERSON', confidence: 0.8 }],
      validatedEntities: [{ original: 'synthetic original', normalized: 'synthetic normalized', type: 'PERSON', isValid: true }],
      topResults: [{ id: 'synthetic-result', score: 0.9, contentPreview: 'synthetic evidence', matchType: 'hybrid' }],
    } }] },
  } });
  let tree = page.render();
  const tabs = elements(tree, element => element.type === 'button' && Array.isArray(element.props.children)
    && ['认知解析', '工作流', '检索结果'].includes(element.props.children.at(-1)));
  assert.equal(tabs.length, 3);
  tabs[1].props.onClick();
  tree = page.render();
  assert.match(renderToStaticMarkup(tree), /实体: 2/);
  elements(tree, element => element.type === 'div' && /cursor-pointer hover:bg-black/.test(element.props.className))[0].props.onClick();
  const html = renderToStaticMarkup(page.render());
  for (const text of ['synthetic operation', 'synthetic entity', 'synthetic normalized', 'synthetic evidence']) assert.ok(html.includes(text));
  tabs[2].props.onClick();
  assert.match(renderToStaticMarkup(page.render()), /synthetic answer/);
  tabs[0].props.onClick();
  assert.equal(fetchCalls, 0);
});
