import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import ts from 'typescript';

const source = await readFile(new URL('./QueryAnalysis.tsx', import.meta.url), 'utf8');
const sourceFile = ts.createSourceFile('QueryAnalysis.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
  const chartProps = [];
  const dynamicCalls = [];
  let memoCalls = 0;
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
    fileName: 'QueryAnalysis.tsx',
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, []);
  const componentModule = { exports: {} };
  const react = {
    ...require('react'),
    useMemo(...args) {
      memoCalls += 1;
      return Reflect.apply(React.useMemo, React, args);
    },
  };
  vm.runInNewContext(compiled.outputText, {
    module: componentModule,
    exports: componentModule.exports,
    require(specifier) {
      if (specifier === 'react') return react;
      if (specifier === 'next/dynamic') {
        return (loader, options) => {
          dynamicCalls.push({ loader, options });
          return function Chart(props) {
            chartProps.push(props);
            return React.createElement('div', { 'data-chart': 'mock' });
          };
        };
      }
      throw new Error(`Unexpected runtime import: ${specifier}`);
    },
  }, { filename: 'QueryAnalysis.compiled.cjs' });
  return {
    Component: componentModule.exports.default,
    chartProps,
    dynamicCalls,
    get memoCalls() { return memoCalls; },
  };
}

async function withRenderer(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const failures = [];
  const { createRoot } = await import('react-dom/client');
  const container = document.getElementById('root');
  const root = createRoot(container, { onUncaughtError: error => failures.push(error) });
  const loaded = loadComponent();
  const baseProps = { topK: 7, threshold: 0.35, getRadarChartOption: () => null };
  try {
    await run({
      loaded,
      container,
      async render(props) {
        loaded.chartProps.length = 0;
        await act(async () => root.render(React.createElement(loaded.Component, { ...baseProps, ...props })));
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

function vectorAnalysis(vectorFeatures = {}, categoryDistribution) {
  return { embedding: { semanticAnalysis: { vectorFeatures, categoryDistribution } } };
}

function options(loaded) {
  return loaded.chartProps.map(props => props.option);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('nullable public boundary owns no chart hooks and delegates non-null analysis', () => {
  const boundary = sourceFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'QueryAnalysis');
  assert.ok(boundary, 'public QueryAnalysis function is required');
  const memoCalls = descendants(boundary, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useMemo');
  assert.equal(memoCalls.length, 0, 'nullable early returns and chart hooks must have separate component lifetimes');
  const childElements = descendants(boundary, node => ts.isJsxSelfClosingElement(node) && /^[A-Z]/.test(node.tagName.getText(sourceFile)));
  assert.equal(childElements.length, 1, 'the valid branch must render its own chart-hook component');
});

test('consumed analysis and chart fields have explicit types without any escapes', () => {
  assert.equal(descendants(sourceFile, node => node.kind === ts.SyntaxKind.AnyKeyword).length, 0);
});

test('real React preserves null → valid → null → partial → valid updates without eager chart work', async () => {
  await withRenderer(async ({ loaded, container, render }) => {
    await render({ analysis: null });
    assert.equal(container.innerHTML, '');
    assert.equal(loaded.memoCalls, 0);
    assert.equal(loaded.chartProps.length, 0);
    assert.equal(loaded.dynamicCalls.length, 1);
    assert.equal(loaded.dynamicCalls[0].options.ssr, false);

    const analysis = vectorAnalysis({ techScore: 0.7, vectorMagnitude: 1.2 });
    await render({ analysis });
    assert.equal(loaded.memoCalls, 3);
    assert.equal(loaded.chartProps.length, 2);
    assert.match(container.textContent, /768 维/);
    const firstOptions = options(loaded);

    await render({ analysis, topK: 10 });
    assert.equal(loaded.memoCalls, 6);
    options(loaded).forEach((option, index) => assert.equal(option, firstOptions[index]));

    await render({ analysis: null });
    assert.equal(container.innerHTML, '');
    assert.equal(loaded.memoCalls, 6);
    await render({ analysis: {} });
    assert.equal(loaded.memoCalls, 9);
    assert.equal(loaded.chartProps.length, 0);
    assert.match(container.textContent, /通用语境/);

    await render({ analysis });
    assert.equal(loaded.memoCalls, 12);
    assert.equal(loaded.chartProps.length, 2);
    assert.notEqual(options(loaded)[0], firstOptions[0]);
    await render({ analysis: undefined });
    assert.equal(container.innerHTML, '');
    assert.equal(loaded.memoCalls, 12);
  });
});

test('radar and vector bar options preserve dimensions, zero defaults, entropy cap, and formatter', async () => {
  await withRenderer(async ({ loaded, render }) => {
    await render({ analysis: vectorAnalysis({ techScore: 0.7, businessScore: 0, dailyScore: 0.25, emotionScore: -0.2, academicScore: 0.9, informationDensity: 0.32, semanticClarity: 0.74, vectorEntropy: 20, vectorSparsity: 0.04 }) });
    const [radar, bars] = options(loaded);
    assert.deepEqual(plain(radar.radar.indicator), ['技术', '商业', '日常', '情感', '学术'].map(name => ({ name, max: 1 })));
    assert.deepEqual(plain(radar.series[0].data[0].value), [0.7, 0, 0.25, -0.2, 0.9]);
    assert.deepEqual(plain(bars.yAxis.data), ['信息密度', '语义清晰度', '向量熵', '稀疏度']);
    assert.deepEqual(plain(bars.series[0].data.map(item => item.value)), [0.32, 0.74, 1, 0.04]);
    assert.equal(bars.series[0].label.formatter({ value: 0.345 }), '35%');
    assert.equal(bars.series[0].label.formatter({ value: 0 }), '0%');
    assert.equal(bars.series[0].label.formatter({ value: -0.2 }), '-20%');
    await render({ analysis: vectorAnalysis({}) });
    assert.deepEqual(plain(options(loaded)[0].series[0].data[0].value), [0, 0, 0, 0, 0]);
    assert.deepEqual(plain(options(loaded)[1].series[0].data.map(item => item.value)), [0, 0, 0, 0]);
  });
});

test('category chart preserves one-decimal rounding, strict one-percent filter, descending stable order, and colors', async () => {
  await withRenderer(async ({ loaded, render }) => {
    await render({ analysis: vectorAnalysis({}, { low: 0.009, boundary: 0.01, belowRoundedBoundary: 0.0104, roundedUp: 0.0106, first: 0.55123, tiedA: 0.2, tiedB: 0.2 }) });
    const pie = options(loaded)[2];
    assert.deepEqual(plain(pie.series[0].data), [
      { name: 'first', value: 55.1, itemStyle: { color: '#3B82F6' } },
      { name: 'tiedA', value: 20, itemStyle: { color: '#10B981' } },
      { name: 'tiedB', value: 20, itemStyle: { color: '#8B5CF6' } },
      { name: 'roundedUp', value: 1.1, itemStyle: { color: '#F59E0B' } },
    ]);
    assert.equal(pie.tooltip.formatter, '{b}: {c}%');
    assert.deepEqual(plain(pie.series[0].radius), ['40%', '70%']);
    await render({ analysis: { embedding: { semanticAnalysis: { categoryDistribution: {} } } } });
    assert.deepEqual(plain(options(loaded)[0].series[0].data), []);
  });
});

test('memoized charts reuse their precise inputs and update independently', async () => {
  await withRenderer(async ({ loaded, render }) => {
    const vectors = { techScore: 0.4 };
    const distribution = { technical: 0.8 };
    await render({ analysis: vectorAnalysis(vectors, distribution) });
    const first = options(loaded);
    await render({ analysis: vectorAnalysis(vectors, distribution) });
    options(loaded).forEach((option, index) => assert.equal(option, first[index]));
    await render({ analysis: vectorAnalysis(vectors, { business: 0.9 }) });
    const second = options(loaded);
    assert.equal(second[0], first[0]);
    assert.equal(second[1], first[1]);
    assert.notEqual(second[2], first[2]);
    await render({ analysis: vectorAnalysis({ techScore: 0.6 }, distribution) });
    assert.notEqual(options(loaded)[0], first[0]);
    assert.notEqual(options(loaded)[1], first[1]);
    assert.deepEqual(plain(options(loaded)[0].series[0].data[0].value), [0.6, 0, 0, 0, 0]);
  });
});

test('retrieval callback remains demand-gated and preserves existing two-call successful path', async () => {
  await withRenderer(async ({ loaded, container, render }) => {
    const callbackOptions = { series: [{ type: 'radar', data: [{ value: [1, 2] }] }] };
    let calls = 0;
    const getRadarChartOption = () => { calls += 1; return callbackOptions; };
    await render({ analysis: {}, getRadarChartOption });
    assert.equal(calls, 0);
    await render({ analysis: null, radarChartData: {}, getRadarChartOption });
    assert.equal(calls, 0);
    await render({ analysis: {}, radarChartData: { vectorMagnitude: 1.23456 }, getRadarChartOption });
    assert.equal(calls, 2);
    assert.equal(options(loaded)[0], callbackOptions);
    assert.match(container.textContent, /模长: 1\.235/);
    assert.match(container.textContent, /阈值: ≥ 0\.35/);
    assert.match(container.textContent, /返回: Top-7/);
    await render({ analysis: {}, radarChartData: {}, getRadarChartOption: () => { calls += 1; return null; } });
    assert.equal(calls, 3);
    assert.equal(loaded.chartProps.length, 0);
  });
});

test('partial adaptive analysis preserves tokens, entities, semantic labels, and quality formatting', async () => {
  await withRenderer(async ({ container, render }) => {
    await render({ analysis: {
      tokenization: { originalText: '测试原文', processingTime: 12, tokenCount: 2, tokens: [
        { token: '架构', tokenId: 4, type: 'entity', entityType: 'CONCEPT', confidence: 0.9 },
        { token: '查询', tokenId: 5, type: 'keyword' },
      ] },
      embedding: { semanticAnalysis: { context: '事实查询语境', semanticCategory: '技术', confidence: 0.8123, nearestConcepts: ['知识图谱'], vectorFeatures: { techScore: 0.7, vectorMagnitude: 1.2 }, categoryDistribution: { technical: 0.8 }, semanticClusters: [{ name: '关联概念', similarity: 0.8 }], intentAnalysis: { primaryIntent: '查询信息', intentConfidence: 0.9, possibleIntents: ['查询信息', '原因分析', '推荐建议', '操作指导'] } } },
      quality: { queryQualityScore: 0.8, specificity: 0.6, ambiguity: 0.2, retrievability: 0.9 },
      adaptiveEntityAnalysis: { entities: [{ name: '知识图谱', normalizedName: 'Knowledge Graph', type: 'CONCEPT', confidence: 0.9 }], intent: 'factual', complexity: 'moderate', confidence: 0.9, keywords: ['实体关系'] },
    } });
    for (const text of ['测试原文', '12ms', '事实查询语境', '81.2%', '关联概念', '知识图谱', 'Knowledge Graph', '事实查询', '中等', '实体关系', '60.0%', '80.0%', '90.0%', '1.20', '原因分析', '推荐建议']) assert.ok(container.textContent.includes(text), text);
    assert.equal(container.textContent.includes('操作指导'), false, 'only the existing two secondary intent badges are shown');
    assert.equal(container.querySelector('[title="实体: CONCEPT (90%)"]').textContent.includes('架构'), true);
    assert.equal(container.querySelector('[title="关键词"]').textContent.includes('查询'), true);
  });
});
