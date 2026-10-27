import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import * as d3 from 'd3';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const pagePath = fileURLToPath(new URL('./page.tsx', import.meta.url));
const source = await readFile(pagePath, 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: pagePath,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;

function graphWithTypes(types) {
  const entities = types.map((type, index) => ({
    id: `entity-${index}`,
    name: `Name ${index}`,
    type,
    description: `Description ${index}`,
    aliases: [],
    mentions: 1,
    sourceChunks: ['synthetic-chunk'],
  }));
  return {
    entities,
    relations: entities.length < 2 ? [] : [{
      id: 'relation-1', source: entities[0].id, target: entities[1].id,
      type: 'associated', description: '', weight: 1, sourceChunks: [],
    }],
    communities: [],
    chunks: [],
    metadata: {
      documentId: 'synthetic-document', createdAt: '2026-01-01T00:00:00Z',
      entityCount: entities.length, relationCount: entities.length < 2 ? 0 : 1,
      communityCount: 0,
    },
  };
}

async function mountPage(t, initialGraph = null, initialDeferred = null) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/',
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [
    key, Object.getOwnPropertyDescriptor(globalThis, key),
  ]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const requests = [];
  const timers = [];
  const simulations = [];
  const pushes = [];
  const commitSnapshots = [];
  const errors = [];
  const graphWrites = [];
  const observedSetters = new WeakMap();
  let nextGraph = initialGraph;
  let deferredRead = initialDeferred;
  let setGraph;
  let stateIndex = 0;
  const react = {
    ...React,
    useState(initial) {
      // This observes the real React state dispatcher, without replacing its scheduling.
      if (initial === '') stateIndex = 0;
      const state = React.useState(initial);
      if (stateIndex++ === 4) {
        let observedSetter = observedSetters.get(state[1]);
        if (!observedSetter) {
          observedSetter = value => { graphWrites.push(value); state[1](value); };
          observedSetters.set(state[1], observedSetter);
        }
        setGraph = observedSetter;
        return [state[0], observedSetter];
      }
      return state;
    },
  };
  const pageModule = { exports: {} };
  const context = vm.createContext({
    module: pageModule, exports: pageModule.exports,
    require(id) {
      if (id === 'react') return react;
      if (id === 'next/navigation') return { useRouter: () => ({ push: path => pushes.push(path) }) };
      if (id === 'd3') return {
        ...d3,
        forceSimulation(nodes) {
          const simulation = d3.forceSimulation(nodes).stop();
          // Keep the real force/link and drag implementation deterministic and timer-free.
          const restart = simulation.restart;
          simulation.restart = function () { restart.call(this); this.stop(); return this; };
          simulations.push(simulation);
          return simulation;
        },
      };
      if (id === 'react/jsx-runtime') return require(id);
      throw new Error(`Unexpected page dependency: ${id}`);
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(url, '/rag-api/entity-extraction?action=graph');
      if (deferredRead) {
        const pending = deferredRead;
        deferredRead = null;
        return pending.promise;
      }
      return { json: async () => ({ success: true, hasGraph: nextGraph !== null, graph: nextGraph }) };
    },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    console: { ...console, error: (...args) => errors.push(args) },
  });
  vm.runInContext(compiled, context, { filename: pagePath, timeout: 1000 });
  const rootElement = dom.window.document.getElementById('root');
  const root = createRoot(rootElement);
  const legend = () => Array.from(rootElement.querySelectorAll('div')).find(
    element => element.style.height === '40px',
  )?.textContent ?? '';
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    await act(async () => root.unmount());
    unmounted = true;
  };
  t.after(async () => {
    await unmount();
    for (const simulation of simulations) simulation.stop();
    dom.window.close();
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  });
  await act(async () => {
    root.render(React.createElement(React.Profiler, {
      id: 'entity-extraction',
      onRender() {
        commitSnapshots.push({
          hasGraph: Boolean(rootElement.querySelector('svg:not([viewBox])')),
          legend: legend(),
        });
      },
    }, React.createElement(pageModule.exports.default)));
  });

  return {
    dom, rootElement, requests, timers, simulations, pushes, commitSnapshots, legend,
    errors, graphWrites, unmount,
    deferNextRead() {
      deferredRead = Promise.withResolvers();
      return deferredRead;
    },
    async replaceGraph(graph) {
      await act(async () => setGraph(graph));
    },
    async refresh(graph) {
      nextGraph = graph;
      const button = Array.from(rootElement.querySelectorAll('button')).find(
        element => element.textContent === '刷新',
      );
      await act(async () => button.click());
    },
    async draw() {
      const pending = timers.splice(0);
      await act(async () => {
        for (const timer of pending) {
          assert.equal(timer.delay, 100);
          timer.callback();
        }
      });
    },
  };
}

test('the complete page initially has no graph or type legend', async t => {
  const page = await mountPage(t);
  assert.equal(page.legend(), '');
  assert.match(page.rootElement.textContent, /输入文本并点击开始抽取/);
  assert.equal(page.requests.length, 1);
  assert.equal(page.timers.length, 0);
});

test('every committed graph uses its own type legend immediately, including refresh and null', async t => {
  const page = await mountPage(t, graphWithTypes(['Person', 'Person', 'Organization']));
  const initial = page.commitSnapshots.filter(snapshot => snapshot.hasGraph);
  assert.ok(initial.length > 0);
  for (const snapshot of initial) assert.equal(snapshot.legend, 'Person(2)Organization(1)');
  page.commitSnapshots.length = 0;
  await page.refresh(graphWithTypes(['Topic']));
  assert.ok(page.commitSnapshots.length > 0);
  for (const snapshot of page.commitSnapshots) assert.equal(snapshot.legend, 'Topic(1)');
  await page.replaceGraph(null);
  assert.equal(page.legend(), '');
  assert.match(page.rootElement.textContent, /输入文本并点击开始抽取/);
  page.commitSnapshots.length = 0;
  await page.replaceGraph(graphWithTypes(['Location', 'Location']));
  for (const snapshot of page.commitSnapshots) assert.equal(snapshot.legend, 'Location(2)');
  await page.replaceGraph(graphWithTypes([]));
  assert.equal(page.legend(), '');
  await page.draw();
  assert.equal(page.rootElement.querySelectorAll('svg:not([viewBox]) circle').length, 0);
  assert.equal(page.requests.length, 2);
});

test('initial and refresh read failures retain the original logged-only error strategy', async t => {
  const initialRead = Promise.withResolvers();
  const page = await mountPage(t, null, initialRead);
  const initialError = new Error('synthetic initial failure');
  await act(async () => initialRead.reject(initialError));
  assert.equal(page.requests.length, 1);
  assert.equal(page.graphWrites.length, 0);
  assert.equal(page.errors.length, 1);
  assert.equal(page.errors[0][0], '加载图谱失败:');
  assert.equal(page.errors[0][1], initialError);
  assert.doesNotMatch(page.rootElement.textContent, /synthetic initial failure/);
  await page.refresh(graphWithTypes(['Topic']));
  const before = page.legend();
  const refreshRead = page.deferNextRead();
  await page.refresh(null);
  const refreshError = new Error('synthetic refresh failure');
  await act(async () => refreshRead.reject(refreshError));
  assert.equal(page.requests.length, 3);
  assert.equal(page.legend(), before);
  assert.equal(page.errors.length, 2);
  assert.equal(page.errors[1][1], refreshError);
  assert.doesNotMatch(page.rootElement.textContent, /synthetic refresh failure/);
});

test('a missing stored graph on refresh leaves the displayed graph unchanged', async t => {
  const page = await mountPage(t, graphWithTypes(['Person']));
  await page.refresh(null);
  assert.equal(page.requests.length, 2);
  assert.equal(page.graphWrites.length, 1);
  assert.equal(page.legend(), 'Person(1)');
  assert.equal(page.errors.length, 0);
});

test('late initial reads cannot dispatch graph state after the complete page unmounts', async t => {
  const pending = Promise.withResolvers();
  const page = await mountPage(t, null, pending);
  await page.unmount();
  await act(async () => pending.resolve({
    json: async () => ({ success: true, hasGraph: true, graph: graphWithTypes(['Late']) }),
  }));
  assert.equal(page.requests.length, 1);
  assert.equal(page.graphWrites.length, 0);
  assert.equal(page.rootElement.childElementCount, 0);
});

test('late manual refreshes cannot dispatch graph state after the complete page unmounts', async t => {
  const page = await mountPage(t, graphWithTypes(['Person']));
  const pending = page.deferNextRead();
  await page.refresh(null);
  await page.unmount();
  await act(async () => pending.resolve({
    json: async () => ({ success: true, hasGraph: true, graph: graphWithTypes(['Late']) }),
  }));
  assert.equal(page.requests.length, 2);
  assert.equal(page.graphWrites.length, 1);
  assert.equal(page.rootElement.childElementCount, 0);
});

test('actual D3 force links resolve only valid endpoint IDs and tick updates positions', async t => {
  const graph = graphWithTypes(['Person', 'Organization']);
  graph.relations.push({ ...graph.relations[0], id: 'missing', target: 'absent' });
  const page = await mountPage(t, graph);
  await page.draw();
  assert.equal(page.simulations.length, 1);
  const simulation = page.simulations[0];
  const [first, second] = simulation.nodes();
  const links = simulation.force('link').links();
  assert.equal(links.length, 1);
  assert.equal(links[0].source, first);
  assert.equal(links[0].target, second);
  first.x = 12; first.y = 34;
  second.x = 56; second.y = 78;
  simulation.on('tick')();
  const line = page.rootElement.querySelector('svg:not([viewBox]) line');
  assert.deepEqual(['x1', 'y1', 'x2', 'y2'].map(name => line.getAttribute(name)), ['12', '34', '56', '78']);
  const circles = page.rootElement.querySelectorAll('svg:not([viewBox]) circle');
  assert.equal(circles[0].getAttribute('cx'), '12');
  assert.equal(circles[1].getAttribute('cy'), '78');
  const labels = page.rootElement.querySelectorAll('svg:not([viewBox]) text');
  assert.equal(labels[0].textContent, 'Name 0');
  assert.equal(labels[1].getAttribute('x'), '56');
});

test('actual D3 mouse drag pins and releases typed simulation nodes, and click opens details', async t => {
  const page = await mountPage(t, graphWithTypes(['Person', 'Organization']));
  await page.draw();
  const simulation = page.simulations[0];
  const node = simulation.nodes()[0];
  const circle = page.rootElement.querySelector('svg:not([viewBox]) circle');
  const mouse = (type, target, x, y, buttons) => target.dispatchEvent(new page.dom.window.MouseEvent(type, {
    bubbles: true, cancelable: true, view: page.dom.window,
    clientX: x, clientY: y, button: 0, buttons,
  }));
  node.x = 10; node.y = 20;
  mouse('mousedown', circle, 10, 20, 1);
  assert.equal(node.fx, 10);
  assert.equal(node.fy, 20);
  assert.equal(simulation.alphaTarget(), 0.3);
  mouse('mousemove', page.dom.window, 30, 50, 1);
  assert.equal(node.fx, 30);
  assert.equal(node.fy, 50);
  mouse('mouseup', page.dom.window, 30, 50, 0);
  assert.equal(node.fx, null);
  assert.equal(node.fy, null);
  assert.equal(simulation.alphaTarget(), 0);
  // D3 suppresses the browser's immediate post-drag click; invoke its actual listener
  // to independently exercise the same datum-to-React selection transition.
  let stopped = false;
  await act(async () => d3.select(circle).on('click').call(circle, {
    stopPropagation() { stopped = true; },
  }, node));
  assert.equal(stopped, true);
  assert.match(page.rootElement.textContent, /实体详情/);
  assert.match(page.rootElement.textContent, /Description 0/);
  const close = Array.from(page.rootElement.querySelectorAll('button')).find(button => button.textContent === '×');
  await act(async () => close.click());
  assert.doesNotMatch(page.rootElement.textContent, /实体详情/);
});

test('all entity-extraction page types compile under the repository strict compiler settings', () => {
  const config = ts.readConfigFile(fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent({
    compilerOptions: config.config.compilerOptions,
    files: [pagePath],
  }, {
    ...ts.sys,
    readDirectory() { throw new Error('The narrow page type check must not enumerate workspace directories'); },
  }, fileURLToPath(new URL('../../../../', import.meta.url)));
  const program = ts.createProgram([pagePath], { ...parsed.options, noEmit: true, incremental: false });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getCanonicalFileName: name => name,
    getNewLine: () => '\n',
  }));
});

test('the full page does not erase D3 node, link or drag event types with explicit any', () => {
  const file = ts.createSourceFile(pagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const untyped = [];
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) untyped.push(file.getLineAndCharacterOfPosition(node.pos).line + 1);
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.deepEqual(untyped, []);
});
