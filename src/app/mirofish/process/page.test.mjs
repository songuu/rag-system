import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as d3 from 'd3';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';

const useObservedEffect = React.useEffect;
const filename = new URL('./page.tsx', import.meta.url);
const source = await readFile(filename, 'utf8');
const ast = ts.createSourceFile(filename.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const stateNames = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)
    && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === 'useState') {
    const first = node.name.elements[0];
    stateNames.push(ts.isBindingElement(first) ? first.name.getText(ast) : null);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const compiled = ts.transpileModule(source, {
  fileName: filename.pathname,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React,
    esModuleInterop: true,
  },
}).outputText;

const graph = (name = 'Alpha') => ({
  graph_id: 'synthetic-local-graph',
  nodes: [
    { uuid: 'a', name, labels: ['Entity', 'Person'], summary: 'Synthetic person', attributes: {} },
    { uuid: 'b', name: 'Beta', labels: ['Entity', 'Company'], summary: 'Synthetic company', attributes: {} },
  ],
  edges: [
    { uuid: 'ab', name: 'works-at', fact: 'Synthetic relation', source_node_name: name, target_node_name: 'Beta' },
    { uuid: 'missing', name: 'missing-target', fact: '', source_node_name: name, target_node_name: 'Absent' },
  ],
  node_count: 2,
  edge_count: 2,
});

// The complete TSX module renders through React DOM; only router, fetch and the
// simulation clock are local substitutes. Real D3 selections and drag run in DOM.
async function withPage(run) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1/' });
  const globals = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 320 },
    clientHeight: { configurable: true, get: () => 400 },
  });

  let cursor = 0;
  let effectDepth = 0;
  const setters = new Map();
  const synchronousEffectWrites = [];
  const simulations = [];
  const requests = [];
  const responses = [];
  const navigations = [];
  const hookReact = {
    ...React,
    createElement(type, props, ...children) {
      if (type === 'style' && props) {
        const { jsx, global, ...domProps } = props;
        void jsx;
        void global;
        return React.createElement(type, domProps, ...children);
      }
      return React.createElement(type, props, ...children);
    },
    useState(initial) {
      const name = stateNames[cursor++];
      const [value, setValue] = React.useState(initial);
      const set = next => {
        if (effectDepth > 0) synchronousEffectWrites.push(name);
        setValue(next);
      };
      if (name) setters.set(name, set);
      return [value, set];
    },
    useEffect(effect, dependencies) {
      useObservedEffect(() => {
        effectDepth++;
        try {
          return effect();
        } finally {
          effectDepth--;
        }
      }, dependencies);
    },
  };
  const exports = {};
  const d3Module = {
    ...d3,
    forceSimulation(nodes) {
      const simulation = d3.forceSimulation(nodes).stop();
      const record = { simulation, stopped: false };
      const stop = simulation.stop.bind(simulation);
      simulation.stop = () => {
        record.stopped = true;
        return stop();
      };
      simulations.push(record);
      return simulation;
    },
  };
  vm.runInNewContext(compiled, {
    exports,
    Error,
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.ok(responses.length, 'Unexpected network request; all responses must be synthetic');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { json: async () => response };
    },
    require(id) {
      if (id === 'react') return { __esModule: true, default: hookReact, ...hookReact };
      if (id === 'd3') return d3Module;
      if (id === 'next/navigation') return { useRouter: () => ({ push: url => navigations.push(url) }) };
      if (id === 'next/link') return { __esModule: true, default: 'a' };
      throw new Error(`Unexpected module: ${id}`);
    },
  }, { filename: filename.pathname });
  const root = createRoot(dom.window.document.getElementById('root'));
  let unmounted = false;
  function ObservedPage() {
    cursor = 0;
    return exports.default();
  }
  const state = {
    document: dom.window.document, window: dom.window, simulations, requests,
    responses, navigations, synchronousEffectWrites,
    async set(values) {
      await act(async () => {
        for (const [name, value] of Object.entries(values)) {
          assert.ok(setters.has(name), `Missing actual module state: ${name}`);
          setters.get(name)(value);
        }
      });
    },
    async click(element) {
      assert.ok(element, 'Expected an actual rendered control');
      await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    },
    button(text) {
      return [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === text);
    },
    tick() {
      const simulation = simulations.at(-1).simulation;
      simulation.tick();
      simulation.on('tick')();
    },
    async unmount() {
      await act(async () => root.unmount());
      unmounted = true;
    },
  };
  try {
    await act(async () => root.render(React.createElement(ObservedPage)));
    await run(state);
  } finally {
    if (!unmounted) await state.unmount();
    for (const { simulation } of simulations) simulation.stop();
    dom.window.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function stepTexts(document) {
  return [...document.querySelectorAll('.left-panel > div > div')].map(section => section.firstElementChild.lastElementChild.textContent);
}

test('initial render derives visible state without synchronous effect state writes', () => withPage(page => {
  assert.deepEqual(stepTexts(page.document), ['进行中', '待开始', '待开始', '待开始']);
  assert.deepEqual(page.synchronousEffectWrites, []);
  assert.equal(page.requests.length, 0);
}));

for (const [step, expected] of [
  [1, ['完成', '进行中', '待开始', '待开始']],
  [2, ['完成', '完成', '进行中', '待开始']],
  [3, ['完成', '完成', '完成', '进行中']],
  [4, ['完成', '完成', '完成', '完成']],
]) {
  test(`step ${step} preserves completed/current/waiting precedence`, () => withPage(async page => {
    await page.set({ currentStep: step });
    assert.deepEqual(stepTexts(page.document), expected);
  }));
}

for (const step of [0, 1, 2, 3]) {
  test(`error overrides loading and completion at step ${step}`, () => withPage(async page => {
    await page.set({ currentStep: step, error: 'Synthetic failure', ontologyLoading: true, graphBuilding: true });
    assert.deepEqual(stepTexts(page.document), ['失败', '失败', '失败', '失败']);
    assert.ok(page.document.body.textContent.includes('Synthetic failure'));
  }));
}

test('only the active ontology/building step uses its loading text', () => withPage(async page => {
  await page.set({ ontologyLoading: true });
  assert.equal(stepTexts(page.document)[0], '生成中');
  await page.set({ currentStep: 1, graphBuilding: true });
  assert.deepEqual(stepTexts(page.document), ['完成', '构建中', '待开始', '待开始']);
}));

test('clearing an error restores the current step status', () => withPage(async page => {
  await page.set({ currentStep: 2, error: 'Synthetic failure' });
  await page.set({ error: null });
  assert.deepEqual(stepTexts(page.document), ['完成', '完成', '进行中', '待开始']);
}));

test('graph nodes, valid links, text and palette render using real D3', () => withPage(async page => {
  await page.set({ graphData: graph() });
  const svg = page.document.querySelector('.graph-container svg');
  assert.equal(svg.querySelectorAll('circle').length, 2);
  assert.equal(svg.querySelectorAll('line').length, 1);
  assert.deepEqual([...svg.querySelectorAll('text')].map(node => node.textContent), ['Alpha', 'Beta']);
  assert.deepEqual([...svg.querySelectorAll('circle')].map(node => node.getAttribute('fill')), ['#FF6B35', '#004E89']);
  assert.equal(page.synchronousEffectWrites.length, 0);
}));

test('empty replacement removes previous graph elements and stops its simulation', () => withPage(async page => {
  await page.set({ graphData: graph() });
  const prior = page.simulations[0];
  await page.set({ graphData: { ...graph(), nodes: [], edges: [], node_count: 0, edge_count: 0 } });
  assert.equal(page.document.querySelectorAll('.graph-container svg > *').length, 0);
  assert.equal(prior.stopped, true);
  assert.equal(page.simulations.length, 1);
}));

test('replacement renders new graph and fresh legend without stale old labels', () => withPage(async page => {
  await page.set({ graphData: graph() });
  const replacement = graph('Gamma');
  replacement.nodes[0].labels = ['Entity', 'Place'];
  replacement.nodes[1].labels = ['Entity'];
  await page.set({ graphData: replacement });
  assert.equal(page.simulations[0].stopped, true);
  assert.equal(page.document.querySelector('.graph-container svg text').textContent, 'Gamma');
  const panel = page.document.querySelector('.right-panel');
  assert.ok(panel.textContent.includes('Place'));
  assert.ok(panel.textContent.includes('Entity'));
  assert.ok(!panel.textContent.includes('Person'));
  assert.equal(page.synchronousEffectWrites.length, 0);
}));

test('null graph removes SVG and legend and stops simulation', () => withPage(async page => {
  await page.set({ graphData: graph() });
  await page.set({ graphData: null });
  assert.equal(page.document.querySelectorAll('.graph-container svg circle').length, 4);
  assert.ok(page.document.querySelector('.right-panel').textContent.includes('暂无图谱数据'));
  assert.ok(!page.document.querySelector('.right-panel').textContent.includes('Person'));
  assert.equal(page.simulations[0].stopped, true);
}));

test('node and edge selection show original details and close correctly', () => withPage(async page => {
  await page.set({ graphData: graph() });
  const svg = page.document.querySelector('.graph-container svg');
  await page.click(svg.querySelector('g > g'));
  assert.ok(page.document.querySelector('.graph-container').textContent.includes('Node Details'));
  assert.ok(page.document.querySelector('.graph-container').textContent.includes('Synthetic person'));
  await page.click(page.button('×'));
  assert.ok(!page.document.querySelector('.graph-container').textContent.includes('Node Details'));
  await page.click(svg.querySelector('line'));
  assert.ok(page.document.querySelector('.graph-container').textContent.includes('Relationship'));
  assert.ok(page.document.querySelector('.graph-container').textContent.includes('Synthetic relation'));
}));

test('tick writes node positions and resolved endpoint coordinates', () => withPage(async page => {
  await page.set({ graphData: graph() });
  page.tick();
  const svg = page.document.querySelector('.graph-container svg');
  const link = svg.querySelector('line');
  const endpoints = d3.select(link).datum();
  for (const [attribute, expected] of [
    ['x1', endpoints.source.x], ['y1', endpoints.source.y],
    ['x2', endpoints.target.x], ['y2', endpoints.target.y],
  ]) {
    const actual = link.getAttribute(attribute);
    assert.notEqual(actual, null, `Missing endpoint attribute: ${attribute}`);
    assert.ok(Number.isFinite(expected), `Unresolved endpoint: ${attribute}`);
    assert.equal(Number(actual), expected, `Wrong endpoint coordinate: ${attribute}`);
  }
  assert.match(svg.querySelector('g > g').getAttribute('transform'), /^translate\(-?[\d.]+,-?[\d.]+\)$/);
}));

test('real drag start/move/end pins and releases a simulation node', () => withPage(async page => {
  await page.set({ graphData: graph() });
  const group = page.document.querySelector('.graph-container svg g > g');
  const datum = d3.select(group).datum();
  await act(async () => {
    group.dispatchEvent(new page.window.MouseEvent('mousedown', { bubbles: true, view: page.window, clientX: 20, clientY: 20, buttons: 1 }));
    assert.equal(page.simulations[0].simulation.alphaTarget(), 0.3);
    assert.equal(datum.fx, datum.x);
    page.window.dispatchEvent(new page.window.MouseEvent('mousemove', { bubbles: true, view: page.window, clientX: 50, clientY: 60, buttons: 1 }));
    assert.ok(Number.isFinite(datum.fx));
    assert.ok(Number.isFinite(datum.fy));
    page.window.dispatchEvent(new page.window.MouseEvent('mouseup', { bubbles: true, view: page.window, clientX: 50, clientY: 60 }));
  });
  assert.equal(datum.fx, null);
  assert.equal(datum.fy, null);
  assert.equal(page.simulations[0].simulation.alphaTarget(), 0);
}));

test('unmount stops the active simulation before fallback cleanup', () => withPage(async page => {
  await page.set({ graphData: graph() });
  const simulation = page.simulations[0];
  assert.equal(simulation.stopped, false);
  await page.unmount();
  assert.equal(simulation.stopped, true);
}));

test('home navigation remains a local router action', () => withPage(async page => {
  await page.click(page.document.querySelector('.nav-brand'));
  assert.deepEqual(page.navigations, ['/mirofish']);
  assert.equal(page.requests.length, 0);
}));

test('ontology validates required input before making a request', () => withPage(async page => {
  await page.click(page.button('开始生成'));
  assert.ok(page.document.body.textContent.includes('请输入模拟需求'));
  await page.set({ simulationRequirement: 'Synthetic requirement' });
  await page.click(page.button('开始生成'));
  assert.ok(page.document.body.textContent.includes('请输入分析文本'));
  assert.equal(page.requests.length, 0);
}));

test('ontology request and graph response preserve payloads and phase progression', () => withPage(async page => {
  await page.set({ simulationRequirement: 'Synthetic requirement', inputText: 'Synthetic text' });
  const ontology = { entity_types: [{ name: 'Person' }], relation_types: [], analysis_summary: '' };
  page.responses.push({ success: true, ontology });
  await page.click(page.button('开始生成'));
  assert.equal(page.requests[0].url, '/rag-api/mirofish/ontology');
  assert.equal(page.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(page.requests[0].options.body), { texts: ['Synthetic text'], simulationRequirement: 'Synthetic requirement' });
  assert.deepEqual(stepTexts(page.document), ['完成', '进行中', '待开始', '待开始']);
  page.responses.push({ success: true, graph: graph() });
  await page.click(page.button('开始构建'));
  assert.equal(page.requests[1].url, '/rag-api/mirofish/graph');
  assert.deepEqual(JSON.parse(page.requests[1].options.body), { text: 'Synthetic text', ontology });
  assert.deepEqual(stepTexts(page.document), ['完成', '完成', '进行中', '待开始']);
  assert.equal(page.document.querySelectorAll('.graph-container svg text').length, 2);
}));

test('ontology and graph server errors remain visible and clear loading state', () => withPage(async page => {
  await page.set({ simulationRequirement: 'Synthetic requirement', inputText: 'Synthetic text' });
  page.responses.push({ success: false, error: 'Synthetic ontology failure' });
  await page.click(page.button('开始生成'));
  assert.ok(page.document.body.textContent.includes('Synthetic ontology failure'));
  assert.equal(page.button('开始生成').disabled, false);
  await page.set({ currentStep: 1 });
  page.responses.push(new Error('Synthetic graph failure'));
  await page.click(page.button('开始构建'));
  assert.ok(page.document.body.textContent.includes('Synthetic graph failure'));
  assert.equal(page.button('开始构建').disabled, false);
}));

test('task-id response retains existing waiting behavior without inventing polling', () => withPage(async page => {
  await page.set({ currentStep: 1, inputText: 'Synthetic text' });
  page.responses.push({ success: true, taskId: 'synthetic-pending-task', graph: graph() });
  await page.click(page.button('开始构建'));
  assert.deepEqual(stepTexts(page.document), ['完成', '进行中', '待开始', '待开始']);
  assert.equal(page.requests.length, 1);
  assert.equal(page.simulations.length, 0);
}));

test('file upload preserves ordered text concatenation and removal behavior', () => withPage(async page => {
  await page.set({ inputText: 'Prefix' });
  const input = page.document.getElementById('file-upload');
  Object.defineProperty(input, 'files', { configurable: true, value: [
    { name: 'first.txt', text: async () => 'First' },
    { name: 'second.md', text: async () => 'Second' },
  ] });
  await act(async () => input.dispatchEvent(new page.window.Event('change', { bubbles: true })));
  assert.equal(page.document.querySelectorAll('textarea')[1].value, 'Prefix\n\nFirst\n\nSecond');
  assert.ok(page.document.body.textContent.includes('first.txt'));
  assert.ok(page.document.body.textContent.includes('second.md'));
  await page.click(page.button('×'));
  assert.ok(!page.document.body.textContent.includes('first.txt'));
  assert.equal(page.document.querySelectorAll('textarea')[1].value, 'Prefix\n\nFirst\n\nSecond');
  assert.equal(page.requests.length, 0);
}));

test('file read errors remain visible and uploading flag is reset', () => withPage(async page => {
  const input = page.document.getElementById('file-upload');
  Object.defineProperty(input, 'files', { configurable: true, value: [
    { name: 'failed.txt', text: async () => { throw new Error('Synthetic read failure'); } },
  ] });
  await act(async () => input.dispatchEvent(new page.window.Event('change', { bubbles: true })));
  assert.ok(page.document.body.textContent.includes('文件读取失败'));
  assert.ok(!page.document.body.textContent.includes('上传中...'));
  assert.equal(page.requests.length, 0);
}));
