import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import ts from 'typescript';

const componentPath = fileURLToPath(new URL('./AdaptiveEntityWorkflowPanel.tsx', import.meta.url));
const source = await readFile(componentPath, 'utf8');
const sourceFile = ts.createSourceFile(componentPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const require = createRequire(import.meta.url);

function descendants(node, predicate) {
  const matches = [];
  function visit(current) {
    if (predicate(current)) matches.push(current);
    ts.forEachChild(current, visit);
  }
  visit(node);
  return matches;
}

function loadComponent() {
  const memoEvaluations = [0, 0];
  let memoIndex = 0;
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
    fileName: componentPath,
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, []);
  const componentModule = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module: componentModule,
    exports: componentModule.exports,
    require(specifier) {
      assert.equal(specifier, 'react', 'the panel has no external runtime dependency');
      return {
        ...require('react'),
        useMemo(callback, dependencies) {
          const index = memoIndex++ % 2;
          return Reflect.apply(React.useMemo, React, [() => {
            memoEvaluations[index] += 1;
            return callback();
          }, dependencies]);
        },
      };
    },
  }, { filename: 'AdaptiveEntityWorkflowPanel.compiled.cjs' });
  return { Component: componentModule.exports.default, memoEvaluations };
}

async function withRenderer(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1' });
  const previous = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const failures = [];
  const { createRoot } = await import('react-dom/client');
  const container = document.getElementById('root');
  const root = createRoot(container, { onUncaughtError: error => failures.push(error) });
  const loaded = loadComponent();
  try {
    await run({
      ...loaded,
      container,
      async render(props = {}) {
        await act(async () => root.render(React.createElement(loaded.Component, props)));
        assert.deepEqual(failures, []);
      },
      async click(element) {
        assert.ok(element, 'an actual rendered click target is required');
        await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
        assert.deepEqual(failures, []);
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

function section(container, name) {
  return Array.from(container.querySelectorAll('button')).find(button => button.textContent.startsWith(name));
}

function header(container) {
  return container.querySelector('h3').closest('[class*="cursor-pointer"]');
}

function fullProps() {
  return {
    defaultExpanded: true,
    workflow: {
      steps: [
        { step: '认知解析 (模型)', status: 'completed', duration: 12, details: {
          operations: ['--- 提取阶段', '✓ 已提取', '✗ 未匹配', '⚠️ 需核实', '[模型] 本地', '普通记录'],
          entityCount: 2, intent: 'factual',
          extractedEntities: [{ name: '样例机构', type: 'ORGANIZATION', confidence: 0.875 }],
          validatedEntities: [{ original: '别名', normalized: '标准名', type: 'ORGANIZATION', isValid: true }],
        } },
        { step: '实体校验与归一化', status: 'completed', duration: 0, details: { validatedCount: 0, totalCount: 2 } },
        { step: '路由决策 (重试 1)', status: 'running', details: { action: 'structured_search', actionName: '结构化检索' } },
        { step: '执行语义检索', status: 'pending', details: { resultCount: 0 } },
        { step: '混合重排', status: 'skipped', details: { inputCount: 3, outputCount: 0 } },
        { step: '答案生成', status: 'error', error: '合成失败信息', details: { responseLength: 0 } },
      ],
      totalDuration: 1234,
    },
    queryAnalysis: {
      originalQuery: '比较样例机构与样例产品', intent: 'comparison', complexity: 'moderate', confidence: 0.834,
      entities: [
        { name: '样例机构', type: 'ORGANIZATION', confidence: 0.875 },
        { name: '样例产品', type: 'PRODUCT', confidence: 0 },
        { name: '备用机构', type: 'ORGANIZATION', confidence: 1 },
      ],
      keywords: ['比较', '样例'],
      logicalRelations: [{ operator: 'AND', entities: ['样例机构', '样例产品'], description: '并列' }],
    },
    entityValidation: [{ name: '样例机构', type: 'ORGANIZATION', normalizedName: '标准机构', isValid: true }],
    routingDecision: {
      action: 'structured_search', reason: '保留实际后端下划线动作',
      constraints: [{ field: 'entity', operator: 'eq', value: '样例机构', priority: 1 }],
      relaxedConstraints: ['LOCATION'], retryCount: 2,
    },
    retrievalDetails: {
      searchResultCount: 5, rankedResultCount: 3,
      topResults: [
        { score: 0.8, rerankedScore: 0, contentPreview: '第一个证据', matchType: 'structured', relevanceExplanation: '保留旧零值回退' },
        { score: 0.6, rerankedScore: 0.45, contentPreview: '第二个证据' },
        { score: 0.2, contentPreview: '第三个证据' },
      ],
    },
  };
}

test('consumed workflow payload fields have no any type escapes', () => {
  assert.equal(descendants(sourceFile, node => node.kind === ts.SyntaxKind.AnyKeyword).length, 0);
});

test('memo callbacks and declared dependencies use the same captured input', () => {
  const memos = descendants(sourceFile, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useMemo');
  assert.equal(memos.length, 2);
  for (const memo of memos) {
    const [callback, dependencies] = memo.arguments;
    assert.ok(ts.isArrayLiteralExpression(dependencies));
    assert.equal(dependencies.elements.length, 1);
    assert.ok(ts.isIdentifier(dependencies.elements[0]), 'capture the consumed array before entering the callback');
    const outerObjects = descendants(callback, node => ts.isIdentifier(node) && ['queryAnalysis', 'workflow'].includes(node.text));
    assert.equal(outerObjects.length, 0, 'memo must not capture broader objects than its dependency');
  }
});

test('strict narrow TypeScript program uses only explicit component root, without directory discovery', () => {
  const repository = path.resolve(path.dirname(componentPath), '../..');
  const configPath = path.join(repository, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  let directoryReads = 0;
  const denyDirectoryRead = () => { directoryReads += 1; throw new Error('Directory discovery is not permitted for this narrow check'); };
  const parsed = ts.parseJsonConfigFileContent({ ...config.config, include: [], exclude: [], files: [componentPath] }, { ...ts.sys, readDirectory: denyDirectoryRead }, repository);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fileNames.map(file => path.resolve(file)), [componentPath]);
  const options = { ...parsed.options, incremental: false, noEmit: true, types: ['react', 'react-dom'] };
  const host = ts.createCompilerHost(options);
  host.readDirectory = denyDirectoryRead;
  const program = ts.createProgram({ rootNames: parsed.fileNames, options, host });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
  assert.equal(directoryReads, 0);
});

test('real React default collapse, expansion, loading, close propagation and className remain intact', async () => {
  await withRenderer(async ({ container, render, click }) => {
    let closed = 0;
    await render({ className: 'local-test-panel', isLoading: true, onClose: () => { closed += 1; } });
    assert.match(container.textContent, /实体路由 RAG 工作流/);
    assert.match(container.textContent, /处理中/);
    assert.equal(section(container, '工作流步骤'), undefined);
    assert.ok(container.firstElementChild.classList.contains('local-test-panel'));
    await click(header(container));
    assert.match(container.textContent, /等待工作流执行/);
    const closeButton = container.querySelector('.fa-times').closest('button');
    await click(closeButton);
    assert.equal(closed, 1);
    assert.ok(section(container, '工作流步骤'), 'close handler must not also collapse the panel');
    await click(container.querySelector('.fa-chevron-up').closest('button'));
    assert.equal(section(container, '工作流步骤'), undefined);
  });
});

test('real workflow preserves step order, five existing UI statuses, zero counters, durations and progress', async () => {
  await withRenderer(async ({ container, render }) => {
    await render(fullProps());
    const text = container.textContent;
    for (const value of ['🧠 认知解析', '✅ 实体校验', '🛤️ 路由决策', '🎯 语义检索', '📊 混合重排序', '✍️ 生成响应', '12ms', '0ms', '校验: 0/2', '结果: 0', '3 → 0', '响应: 0字', '合成失败信息', '1.23s']) assert.ok(text.includes(value), value);
    const labels = ['🧠 认知解析', '✅ 实体校验', '🛤️ 路由决策', '🎯 语义检索', '📊 混合重排序', '✍️ 生成响应'];
    assert.deepEqual([...labels].sort((a, b) => text.indexOf(a) - text.indexOf(b)), labels);
    for (const icon of ['fa-check-circle', 'fa-spinner', 'fa-circle', 'fa-forward', 'fa-exclamation-circle']) assert.ok(container.querySelector(`.${icon}`), icon);
    assert.equal(container.querySelector('[class*="duration-500"]').style.width, `${2 / 6 * 100}%`);
  });
});

test('actual backend failed status retains legacy pending-color fallback and supplied error detail', async () => {
  await withRenderer(async ({ container, render }) => {
    await render({ defaultExpanded: true, workflow: { steps: [{ step: '本地合成失败步骤', status: 'failed', error: '保留后端失败信息' }] } });
    assert.match(container.textContent, /保留后端失败信息/);
    const name = Array.from(container.querySelectorAll('span')).find(span => span.textContent === '本地合成失败步骤');
    assert.ok(name.classList.contains('text-slate-400'));
    assert.equal(container.querySelector('.fa-exclamation-circle'), null);
  });
});

test('real step expansion preserves operation styles, entity rounding and normalized validation details', async () => {
  await withRenderer(async ({ container, render, click }) => {
    await render(fullProps());
    const firstStep = Array.from(container.querySelectorAll('span')).find(span => span.textContent === '🧠 认知解析').closest('.p-3');
    await click(firstStep);
    for (const value of ['执行详情', '--- 提取阶段', '✓ 已提取', '✗ 未匹配', '⚠️ 需核实', '[模型] 本地', '普通记录', '提取的实体', '88%', '别名', '标准名', '校验结果']) assert.ok(container.textContent.includes(value), value);
    for (const [operation, style] of [['--- 提取阶段', 'bg-slate-800'], ['✓ 已提取', 'text-green-400'], ['✗ 未匹配', 'text-red-400'], ['⚠️ 需核实', 'text-amber-400'], ['[模型] 本地', 'text-blue-400']]) {
      const element = Array.from(container.querySelectorAll('div')).find(node => node.textContent === operation);
      assert.ok(element.classList.contains(style), operation);
    }
    await click(firstStep);
    assert.equal(container.textContent.includes('执行详情'), false);
  });
});

test('real entities and query details retain counts, original order, zero confidence and supplied validation', async () => {
  await withRenderer(async ({ container, render, click }) => {
    await render(fullProps());
    for (const value of ['组织: 2', '产品: 1', '标准机构', '✓ 已验证', '0%', '100%', '88%']) assert.ok(container.textContent.includes(value), value);
    await click(section(container, '查询分析'));
    for (const value of ['比较样例机构与样例产品', '比较分析', 'moderate', '83%', '提取的关键词']) assert.ok(container.textContent.includes(value), value);
    const entityNames = Array.from(container.querySelectorAll('.font-medium.text-white')).map(node => node.textContent).filter(value => ['样例机构', '样例产品', '备用机构'].includes(value));
    assert.deepEqual(entityNames, ['样例机构', '样例产品', '备用机构']);
  });
});

test('real routing and retrieval retain actual underscore action fallback, JSON constraints and score zero fallback', async () => {
  await withRenderer(async ({ container, render, click }) => {
    await render(fullProps());
    await click(section(container, '路由决策'));
    for (const value of ['structured_search', '保留实际后端下划线动作', '应用的约束', '已放宽的约束', '重试次数']) assert.ok(container.textContent.includes(value), value);
    const json = Array.from(container.querySelectorAll('pre')).map(node => JSON.parse(node.textContent));
    assert.deepEqual(json, [fullProps().routingDecision.constraints, ['LOCATION']]);
    await click(section(container, '检索结果'));
    for (const value of ['初始检索', '重排序后', '第一个证据', '第二个证据', '第三个证据', '80%', '45%', '20%', '保留旧零值回退']) assert.ok(container.textContent.includes(value), value);
    const text = container.textContent;
    assert.ok(text.indexOf('第一个证据') < text.indexOf('第二个证据'));
    assert.ok(text.indexOf('第二个证据') < text.indexOf('第三个证据'));
  });
});

test('real empty and partial API updates stay renderable and remove stale sections and progress', async () => {
  await withRenderer(async ({ container, render, click }) => {
    await render(fullProps());
    await render({ defaultExpanded: true, workflow: { steps: [], totalDuration: 0 }, queryAnalysis: { entities: [], keywords: [] }, routingDecision: { action: 'future_action', reason: '' }, retrievalDetails: { searchResultCount: 0, rankedResultCount: 0, topResults: [] } });
    assert.match(container.textContent, /等待工作流执行/);
    assert.equal(section(container, '实体分析'), undefined);
    assert.equal(container.querySelector('[class*="duration-500"]'), null);
    await click(section(container, '查询分析'));
    assert.match(container.textContent, /探索性/);
    assert.match(container.textContent, /NaN%/);
    await click(section(container, '路由决策'));
    assert.match(container.textContent, /future_action/);
    await click(section(container, '检索结果'));
    assert.equal(container.textContent.includes('Top 检索结果'), false);
    await render({ defaultExpanded: true });
    assert.equal(section(container, '查询分析'), undefined);
    assert.equal(section(container, '路由决策'), undefined);
    assert.equal(section(container, '检索结果'), undefined);
  });
});

test('real memoized inputs reuse independently and refresh stats and progress on array replacement', async () => {
  await withRenderer(async ({ container, memoEvaluations, render }) => {
    const entities = [{ name: '旧实体', type: 'PERSON', confidence: 1 }];
    const steps = [{ step: '执行检索', status: 'completed' }];
    const queryAnalysis = { entities, keywords: [] };
    await render({ defaultExpanded: true, queryAnalysis, workflow: { steps } });
    assert.deepEqual(memoEvaluations, [1, 1]);
    await render({ defaultExpanded: true, queryAnalysis: { ...queryAnalysis }, workflow: { steps, totalDuration: 1 } });
    assert.deepEqual(memoEvaluations, [1, 1]);
    await render({ defaultExpanded: true, queryAnalysis: { entities: [{ name: '新实体', type: 'PRODUCT', confidence: 0.5 }], keywords: [] }, workflow: { steps } });
    assert.deepEqual(memoEvaluations, [2, 1]);
    assert.match(container.textContent, /产品: 1/);
    assert.equal(container.textContent.includes('人物: 1'), false);
    await render({ defaultExpanded: true, queryAnalysis: { entities, keywords: [] }, workflow: { steps: [{ step: '执行检索', status: 'running' }] } });
    assert.deepEqual(memoEvaluations, [3, 2]);
    assert.equal(container.querySelector('[class*="duration-500"]'), null);
  });
});
