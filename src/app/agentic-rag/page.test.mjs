import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const pagePath = fileURLToPath(new URL('./page.tsx', import.meta.url));
const rootPath = fileURLToPath(new URL('../../..', import.meta.url));
const source = await readFile(pagePath, 'utf8');
const tracePath = path.join(rootPath, 'src/components/LangSmithTraceViewer.tsx');
const traceSource = await readFile(tracePath, 'utf8');
const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
};

function compile(text, fileName) {
  const result = ts.transpileModule(text, { fileName, compilerOptions, reportDiagnostics: true });
  assert.deepEqual(result.diagnostics, []);
  return result.outputText;
}

const emitted = compile(source, pagePath);
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}
function loadModule(text, fileName, imports, globals = {}) {
  const isolatedModule = { exports: {} };
  vm.runInNewContext(compile(text, fileName), {
    module: isolatedModule, exports: isolatedModule.exports,
    require(id) {
      if (id === 'react' || id === 'react/jsx-runtime') return require(id);
      if (Object.hasOwn(imports, id)) return imports[id];
      throw new Error(`Unexpected isolated runtime dependency: ${id}`);
    },
    ...globals,
  }, { filename: `${fileName}.compiled.cjs` });
  return isolatedModule.exports;
}

const runtimeDefaults = loadModule(
  await readFile(new URL('../../lib/runtime-config-defaults.ts', import.meta.url), 'utf8'),
  'runtime-config-defaults.ts', {},
);
const modelNames = loadModule(
  await readFile(new URL('../../lib/ollama-model-name.ts', import.meta.url), 'utf8'),
  'ollama-model-name.ts', {},
);

async function mountPage(t, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: () => { throw new Error('Unexpected global network access'); },
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const requests = [];
  const errors = [];
  const panelProps = [];
  const traceProps = [];
  const failures = [];
  const queue = [...(options.results ?? [])];
  const modelConfig = options.config ?? { config: {} };
  const models = options.models ?? {
    success: true,
    llmModels: [{ name: 'llama3.1:latest', size: 2048, modified_at: '2026-01-01' }],
    embeddingModels: [{ name: 'nomic-embed-text:latest', size: 1024, modified_at: '2026-01-01' }],
  };
  const page = loadModule(source, pagePath, {
    'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children), __esModule: true },
    '@/components/AgenticWorkflowPanel': { default: props => {
      panelProps.push(props);
      return React.createElement('section', { 'data-workflow-boundary': '', 'data-loading': String(props.isLoading) });
    }, __esModule: true },
    '@/components/LangSmithTraceViewer': { default: props => {
      traceProps.push(props);
      return React.createElement('section', { 'data-trace-boundary': '' });
    }, __esModule: true },
    '@/lib/ollama-model-name': modelNames,
    '@/lib/runtime-config-defaults': runtimeDefaults,
  }, {
    AbortController, DOMException, Error, queueMicrotask,
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, requestOptions) => {
      requests.push({ url, options: requestOptions });
      if (url === '/rag-api/model-config') {
        if (options.configError) throw options.configError;
        return options.configDeferred ? options.configDeferred.promise : jsonResponse(modelConfig);
      }
      if (url === '/rag-api/ollama/models') {
        if (options.modelsError) throw options.modelsError;
        return options.modelsDeferred ? options.modelsDeferred.promise : jsonResponse(models);
      }
      assert.equal(url, '/rag-api/agentic-rag');
      assert.equal(requestOptions.method, 'POST');
      assert.ok(queue.length, 'query requires an explicitly supplied synthetic response');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : jsonResponse(next);
    },
  });
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container, { onUncaughtError: error => failures.push(error) });
  let unmounted = false;
  async function unmount() {
    if (unmounted) return;
    unmounted = true;
    await act(async () => root.unmount());
  }
  t.after(async () => {
    await unmount();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(failures, []);
  });
  await act(async () => root.render(React.createElement(page.default)));
  async function input(value) {
    const textarea = container.querySelector('textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(textarea.value, value);
  }
  async function submit(value) {
    await input(value);
    await act(async () => container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  }
  return { container, dom, requests, errors, panelProps, traceProps, input, submit, unmount };
}

test('consumed Agentic response boundaries contain no explicit any', () => {
  const parsed = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  function visit(node) { if (node.kind === ts.SyntaxKind.AnyKeyword) count++; ts.forEachChild(node, visit); }
  visit(parsed);
  assert.equal(count, 0);
});

test('type-only page edits preserve the complete actual compiled JavaScript', () => {
  assert.equal(digest(emitted), '4c49ef36307c399b550617bdab01d32e953cbc7bd4d51613c8ea45b07f001826');
});

test('optional Trace workflow id preserves the complete actual compiled JavaScript', () => {
  assert.equal(digest(compile(traceSource, tracePath)), '839c2389d25790280b04e374a0a79f594d5990c12d7c2d039be26ed134c54e79');
});

test('strict target-only type checking includes the real workflow consumers without project discovery', () => {
  const configPath = path.join(rootPath, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  let directoryReads = 0;
  const parsed = ts.parseJsonConfigFileContent({ ...config.config, include: [], exclude: [], files: [pagePath] }, {
    ...ts.sys,
    readDirectory() { directoryReads++; throw new Error('Targeted checking must not enumerate directories'); },
  }, rootPath, { noEmit: true, incremental: false, types: ['node'] });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fileNames.map(file => path.resolve(file)), [pagePath]);
  const host = ts.createCompilerHost(parsed.options);
  host.readDirectory = () => { directoryReads++; throw new Error('Targeted checking must not enumerate directories'); };
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(item => ({ file: item.file?.fileName, code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') })), []);
  assert.equal(directoryReads, 0);
});

test('initial model requests preserve parallel dispatch and installed latest-tag reconciliation', async t => {
  const page = await mountPage(t);
  assert.deepEqual(page.requests.map(item => item.url), ['/rag-api/model-config', '/rag-api/ollama/models']);
  assert.equal(page.requests[0].options.signal, page.requests[1].options.signal);
  assert.equal(page.requests[0].options.signal.aborted, false);
  const selects = page.container.querySelectorAll('select');
  assert.equal(selects[0].value, 'llama3.1:latest');
  assert.equal(selects[1].value, 'nomic-embed-text:latest');
  assert.match(page.container.textContent, /1 个 LLM 模型可用/);
  assert.match(page.container.textContent, /准备就绪/);
  assert.equal(page.container.querySelector('button[type="submit"]').disabled, true);
  assert.deepEqual(page.errors, []);
});

test('successful whole-page submission preserves payload, document order, scores, child boundaries and fallback filtering', async t => {
  const result = {
    answer: '合成答案 [1]',
    workflow: { steps: [{ step: 'generate', status: 'completed', duration: 25 }], totalDuration: 1250, retryCount: 1 },
    queryAnalysis: { originalQuery: '合成问题', rewrittenQuery: '优化问题', intent: 'factual', complexity: 'simple', needsRetrieval: true, keywords: ['证据'], confidence: 0.8 },
    retrievalDetails: {
      documents: [
        { content: '第一段证据', relevanceScore: 0.8, similarity: 0, score: 0.92, metadata: { source: 'synthetic-A.pdf' } },
        { content: '第二段证据', score: 0.456, metadata: { source: 'synthetic-B.pdf' } },
        { content: '无分数证据', similarity: null },
      ],
      quality: { overallScore: 0.8, relevanceScore: 0.8, coverageScore: 1, diversityScore: 1, isAcceptable: true, suggestions: [] },
      selfReflection: { documentScores: [], queryAlignmentScore: 0.9, contextCompleteness: 1, recommendation: 'use' },
    },
    retrievalGrade: { isRelevant: true, score: 0.8, keywordMatchScore: 1, semanticScore: 0.8, hasAnswerSignals: true, reasoning: 'synthetic' },
    debugInfo: { embeddingModel: 'synthetic', collectionDimension: 768 },
    hallucinationCheck: { hasHallucination: false, confidence: 0.9, problematicClaims: [], supportedClaims: [], overallFactualScore: 0.9 },
    models: { fallbacks: ['合成回退', 7, null, {}, false] },
  };
  const page = await mountPage(t, { results: [result] });
  await page.submit('  合成问题  ');
  const request = page.requests.find(item => item.url === '/rag-api/agentic-rag');
  assert.deepEqual(plain(request.options.headers), { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(request.options.body), {
    question: '合成问题', topK: 5, similarityThreshold: 0.3, maxRetries: 2,
    llmModel: 'llama3.1:latest', embeddingModel: 'nomic-embed-text:latest',
  });
  const text = page.container.textContent;
  for (const expected of ['合成答案 [1]', '第一段证据', '第二段证据', '无分数证据', '来源: synthetic-A.pdf', '相关性: 80%', '相似度: 0.0%', '相似度: 45.6%', '相似度: —', '模型已自动回退', '合成回退']) assert.ok(text.includes(expected), expected);
  assert.ok(text.indexOf('第一段证据') < text.indexOf('第二段证据'));
  const panel = page.panelProps.at(-1);
  assert.equal(panel.workflow, result.workflow);
  assert.equal(panel.queryAnalysis, result.queryAnalysis);
  assert.equal(panel.retrievalQuality, result.retrievalDetails.quality);
  assert.equal(panel.selfReflection, result.retrievalDetails.selfReflection);
  assert.equal(panel.hallucinationCheck, result.hallucinationCheck);
  assert.equal(panel.isLoading, false);
  const trace = page.traceProps.at(-1);
  assert.equal(trace.workflowSteps, result.workflow.steps);
  assert.equal(trace.retrievalGrade, result.retrievalGrade);
  assert.equal(trace.debugInfo, result.debugInfo);
  assert.equal(trace.totalDuration, 1250);
  assert.equal(page.container.querySelector('textarea').disabled, false);
  assert.deepEqual(page.errors, []);
});

test('legacy 410 refusal is displayed without inventing answers, evidence or extra requests', async t => {
  const page = await mountPage(t, { results: [() => jsonResponse({ success: false, error: 'This legacy RAG route is disabled outside local development.', code: 'LEGACY_RAG_ROUTE_DISABLED' }, 410)] });
  await page.submit('合成受限问题');
  assert.match(page.container.textContent, /This legacy RAG route is disabled outside local development\./);
  assert.equal(page.container.textContent.includes('生成的回答'), false);
  assert.equal(page.container.textContent.includes('检索到的文档'), false);
  assert.equal(page.traceProps.length, 0);
  assert.equal(page.requests.length, 3);
  assert.equal(page.container.querySelector('button[type="submit"]').disabled, false);
});

test('partial error response preserves errorDetail and suppresses absent optional sections', async t => {
  const page = await mountPage(t, { results: [{ error: 'AGENTIC_GENERATION_FAILED', errorDetail: 'synthetic generation detail', models: { fallbacks: 'not-an-array' } }] });
  await page.submit('合成失败问题');
  assert.match(page.container.textContent, /AGENTIC_GENERATION_FAILED/);
  assert.match(page.container.textContent, /synthetic generation detail/);
  assert.equal(page.container.textContent.includes('生成的回答'), false);
  assert.equal(page.container.textContent.includes('模型已自动回退'), false);
  assert.equal(page.traceProps.length, 0);
  const panel = page.panelProps.at(-1);
  assert.equal(panel.workflow, undefined);
  assert.equal(panel.queryAnalysis, undefined);
  assert.equal(panel.isLoading, false);
});

test('network rejection and invalid JSON preserve caught-error behavior and release the loading state', async t => {
  const page = await mountPage(t, { results: [new Error('synthetic transport error'), () => ({ json: async () => { throw new Error('synthetic invalid JSON'); } })] });
  await page.submit('第一条合成问题');
  assert.match(page.container.textContent, /synthetic transport error/);
  assert.equal(page.container.querySelector('textarea').disabled, false);
  await page.submit('第二条合成问题');
  assert.match(page.container.textContent, /synthetic invalid JSON/);
  assert.equal(page.container.querySelector('button[type="submit"]').disabled, false);
  assert.equal(page.container.textContent.includes('查询历史'), false, 'caught network failures are not inserted into query history');
});

test('deferred request blocks duplicate submits, keeps pending workflow state and accepts the original completion', async t => {
  const pending = deferred();
  const page = await mountPage(t, { results: [() => pending.promise] });
  await page.input('合成等待问题');
  await act(async () => page.container.querySelector('form').dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(page.container.querySelector('textarea').disabled, true);
  assert.equal(page.container.querySelector('button[type="submit"]').disabled, true);
  assert.equal(page.panelProps.at(-1).isLoading, true);
  await act(async () => page.container.querySelector('form').dispatchEvent(new page.dom.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(page.requests.filter(item => item.url === '/rag-api/agentic-rag').length, 1);
  await act(async () => pending.resolve(jsonResponse({ answer: '合成延迟结果' })));
  assert.match(page.container.textContent, /合成延迟结果/);
  assert.equal(page.panelProps.at(-1).isLoading, false);
});

test('history remains capped at ten, preserves selected result and does not persist or refetch', async t => {
  const page = await mountPage(t, { results: Array.from({ length: 11 }, (_, index) => ({ answer: `合成答案${index}`, workflow: { steps: [], totalDuration: 1250 } })) });
  for (let index = 0; index < 11; index++) await page.submit(`合成问题${index}`);
  const historyTitle = [...page.container.querySelectorAll('h3')].find(node => node.textContent.includes('查询历史'));
  const buttons = [...historyTitle.parentElement.querySelectorAll('button')];
  assert.equal(buttons.length, 9);
  assert.match(buttons[0].textContent, /合成问题9/);
  assert.match(buttons.at(-1).textContent, /合成问题1/);
  assert.match(buttons[0].textContent, /耗时: 1\.25s/);
  const requestCount = page.requests.length;
  await act(async () => buttons[0].click());
  assert.equal(page.container.querySelector('textarea').value, '合成问题9');
  assert.match(page.container.textContent, /合成答案9/);
  assert.equal(page.requests.length, requestCount);
  assert.equal(page.dom.window.localStorage.length, 0);
});

test('offline model discovery preserves configured remote defaults without additional IO', async t => {
  const page = await mountPage(t, {
    config: { config: { llm: { provider: 'openai', model: 'synthetic-remote-llm' }, embedding: { provider: 'openai', model: 'synthetic-remote-embedding', dimension: 1536 } } },
    modelsError: new Error('synthetic discovery unavailable'),
    results: [{ answer: '合成离线配置结果' }],
  });
  assert.match(page.container.textContent, /synthetic-remote-embedding/);
  assert.match(page.container.textContent, /1536D/);
  assert.match(page.container.textContent, /使用远程 Embedding 服务/);
  assert.equal(page.container.querySelectorAll('select').length, 1);
  await page.submit('合成离线配置问题');
  const body = JSON.parse(page.requests.at(-1).options.body);
  assert.equal(body.llmModel, 'synthetic-remote-llm');
  assert.equal(body.embeddingModel, 'synthetic-remote-embedding');
  assert.equal(page.errors.length, 1);
  assert.match(String(page.errors[0][0]), /Failed to load available models/);
});

test('unmount aborts both model requests and ignores their eventual results', async t => {
  const configDeferred = deferred();
  const modelsDeferred = deferred();
  const page = await mountPage(t, { configDeferred, modelsDeferred });
  assert.equal(page.requests.length, 2);
  const signal = page.requests[0].options.signal;
  await page.unmount();
  assert.equal(signal.aborted, true);
  await act(async () => {
    configDeferred.resolve(jsonResponse({ config: { llm: { model: 'stale' } } }));
    modelsDeferred.resolve(jsonResponse({ success: true, llmModels: [], embeddingModels: [] }));
  });
  assert.equal(page.container.innerHTML, '');
  assert.equal(page.panelProps.length, 0);
  assert.deepEqual(page.errors, []);
});

test('real Trace viewer accepts absent workflow ids and preserves its explicit deterministic fallback', async t => {
  const dom = new JSDOM('<div id="trace"></div>', { url: 'http://localhost/' });
  const previous = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const flows = [];
  const trace = loadModule(traceSource, tracePath, {
    './LangSmithReactFlowGraph': { default: props => { flows.push(props); return React.createElement('div', { 'data-flow': '' }); }, __esModule: true },
  }, { process: { env: {} } });
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('trace');
  const failures = [];
  const root = createRoot(container, { onUncaughtError: error => failures.push(error) });
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(failures, []);
  });
  await act(async () => root.render(React.createElement(trace.default, {
    defaultExpanded: true,
    workflowSteps: [
      { step: 'generate', status: 'completed', duration: 5 },
      { id: 'explicit-step-id', step: 'retrieve_original', status: 'completed' },
    ],
  })));
  assert.match(container.textContent, /generate/);
  const button = [...container.querySelectorAll('button')].find(node => node.textContent.includes('ReactFlow'));
  await act(async () => button.click());
  assert.deepEqual(flows.at(-1).steps.map(step => step.id), ['workflow-0', 'explicit-step-id']);
});
