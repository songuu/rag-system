import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const require = createRequire(import.meta.url);
const source = (await build({ stdin: { contents: `export { MiroFishLocaleProvider, MiroFishLanguageSwitcher, useMiroFishLocale } from './src/components/mirofish/MiroFishLocaleProvider';
  export {default as Home} from './src/app/mirofish/page';
  export {default as StepNav} from './src/components/mirofish/StepNav';
  export {default as History} from './src/components/mirofish/MiroFishHistory';
  export {default as Viewer} from './src/components/KnowledgeGraphViewer';
  export {default as Workbench} from './src/components/mirofish/MiroFishGraphWorkbench';
  export {toMiroFishViewerGraph} from './src/lib/mirofish/graph-view';`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' })).outputFiles[0].text;
const fixtureModule = { exports: {} };
const scope = { module: fixtureModule, exports: fixtureModule.exports,
  require: name => name === 'next/navigation' ? { useRouter: () => ({ push() {} }) } : name === 'next/link' ? ({children, ...props}) => React.createElement('a', props, children) : require(name),
  fetch: (...args) => globalThis.fetch(...args), queueMicrotask, AbortController, URLSearchParams, setInterval, clearInterval, setTimeout, clearTimeout,
  requestAnimationFrame: () => 1, cancelAnimationFrame() {}, ResizeObserver: class { observe() {} disconnect() {} },
};
for (const key of ['window', 'document', 'localStorage']) Object.defineProperty(scope, key, { get: () => globalThis[key] });
vm.runInNewContext(source, scope);
const { Home, StepNav, MiroFishLocaleProvider: Provider, MiroFishLanguageSwitcher: Switcher, useMiroFishLocale: useLocale, History, Viewer, Workbench, toMiroFishViewerGraph } = fixtureModule.exports;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function mount(element, run, { locale = 'zh', fetch: fetchMock = async () => json({ success: true, simulations: [] }) } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/mirofish' });
  dom.window.localStorage.setItem('mirofish.locale', locale);
  const canvasCalls = [];
  dom.window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get(_object, key) {
    if (key === 'measureText') return text => ({ width: text.length * 6 });
    if (key === 'createRadialGradient') return () => ({ addColorStop() {} });
    return (...args) => canvasCalls.push([key, ...args]);
  } });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchMock })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  const container = dom.window.document.getElementById('root');
  const ui = { container, window: dom.window, canvasCalls, async click(label) {
    const button = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === label);
    assert.ok(button, `Missing button ${label}`);
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  } };
  try { await act(async () => root.render(React.createElement(Provider, null, element))); await run(ui); }
  finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

test('language switching restores persisted English, translates real content, and saves Chinese', async () => {
  function Probe() { const { t } = useLocale(); return React.createElement('p', null, t('图谱构建')); }
  await mount(React.createElement(React.Fragment, null, React.createElement(Switcher), React.createElement(Probe)), async ui => {
    assert.match(ui.container.textContent, /Graph building/);
    assert.equal(ui.window.document.documentElement.lang, 'en');
    const select = ui.container.querySelector('select');
    await act(async () => { select.value = 'zh'; select.dispatchEvent(new ui.window.Event('change', { bubbles: true })); });
    assert.match(ui.container.textContent, /图谱构建/);
    assert.equal(ui.window.localStorage.getItem('mirofish.locale'), 'zh');
  }, { locale: 'en' });
});

test('history keeps multiple persisted simulations for one project with distinct deep links', async () => {
  await mount(React.createElement(History, { projects: [{ id: 'project-a', name: 'Scenario', simulation_requirement: 'Requirement', seed_files: [{ filename: 'seed.md', size: 20 }] }] }), async ui => {
    assert.equal(ui.container.querySelectorAll('[data-run-id]').length, 2);
    const links = [...ui.container.querySelectorAll('a')].map(link => link.getAttribute('href'));
    assert(links.some(link => link.includes('simulationId=run-old') && link.includes('reportId=report-old')));
    assert(links.some(link => link.includes('simulationId=run-new')));
    const saved = ui.container.querySelector('[data-run-id="run-old"]');
    assert.match(saved.textContent, /old-seed.md/);
    assert.match(saved.textContent, /Frozen old requirement/);
    assert(![...saved.querySelectorAll('li')].some(item => item.textContent.trim() === '📄 seed.md'));
    const select = ui.container.querySelector('select');
    await act(async () => { select.value = 'running'; select.dispatchEvent(new ui.window.Event('change', { bubbles: true })); });
    assert.equal(ui.container.querySelectorAll('[data-run-id]').length, 1);
    assert.equal(ui.container.querySelector('[data-run-id]').dataset.runId, 'run-new');
  }, { fetch: async () => json({ success: true, simulations: [
    { simulation_id: 'run-old', project_id: 'project-a', status: 'completed', current_round: 10, config: { round_count: 10 }, created_at: '2026-11-01', report_id: 'report-old', simulation_requirement: 'Frozen old requirement', seed_files: [{ filename: 'old-seed.md', size: 20 }] },
    { simulation_id: 'run-new', project_id: 'project-a', status: 'running', current_round: 2, config: { round_count: 10 }, created_at: '2026-11-02' },
  ] }) });
});

const rawGraph = { graph_id: 'graph', nodes: [
  { uuid: 'a', name: 'Alice', labels: ['Person'], summary: 'A', attributes: {} },
  { uuid: 'b', name: 'Bob', labels: ['Person'], summary: 'B', attributes: {} },
], edges: [
  { uuid: 'r', source_node_uuid: 'a', target_node_uuid: 'b', name: 'KNOWS', fact: 'A knows B' },
  { uuid: 'self', source_node_uuid: 'a', target_node_uuid: 'a', name: 'THINKS', fact: 'A thinks' },
], node_count: 2, edge_count: 2 };

test('real graph viewer draws UUID relationships and self loops through the geometry adapter', async () => {
  await mount(React.createElement(Viewer, { graph: toMiroFishViewerGraph(rawGraph) }), async ui => {
    assert(ui.canvasCalls.some(([kind]) => kind === 'quadraticCurveTo'));
    assert(ui.canvasCalls.some(([kind]) => kind === 'bezierCurveTo'));
    await ui.click('列表');
    assert.match(ui.container.textContent, /Alice/); assert.match(ui.container.textContent, /Bob/);
  });
});

test('workbench refresh uses exact authorized identity and layout changes preserve child state', async () => {
  const requests = [];
  function Draft() { const [count, setCount] = React.useState(0); return React.createElement('button', { onClick: () => setCount(count + 1) }, `draft ${count}`); }
  await mount(React.createElement(Workbench, { graph: rawGraph, identity: { documentId: 'graph', documentVersion: 'version', trustLevel: 'external', graphGeneration: 'generation' } }, React.createElement(Draft)), async ui => {
    await ui.click('draft 0'); await ui.click('图谱'); await ui.click('工作区');
    assert.match(ui.container.textContent, /draft 1/);
    await ui.click('刷新图谱');
    const url = new URL(requests[0], 'http://localhost');
    assert.equal(url.searchParams.get('documentVersion'), 'version');
    assert.equal(url.searchParams.get('graphGeneration'), 'generation');
  }, { fetch: async url => { requests.push(url); return json({ success: true, graph: rawGraph }); } });
});

test('workbench reads run-scoped observations separately and clears them when authorization is revoked', async () => {
  let memoryReads = 0;
  const requests = [];
  await mount(React.createElement(Workbench, { graph: rawGraph, simulationId: 'run-isolated', identity: {
    documentId: 'graph', documentVersion: 'version', trustLevel: 'external',
  } }, React.createElement('p', null, 'Editor')), async ui => {
    assert(requests.some(url => url.includes('/simulation/run-isolated?action=memory')));
    assert.match(ui.container.textContent, /run-only observation/);
    assert.match(ui.container.textContent, /不会修改原始知识图谱/);
    await ui.click('刷新图谱');
    assert.doesNotMatch(ui.container.textContent, /run-only observation/);
    assert.match(ui.container.textContent, /Source access revoked/);
    assert.equal(rawGraph.node_count, 2);
  }, { fetch: async url => {
    requests.push(String(url));
    if (!String(url).includes('action=memory')) return json({ success: true, graph: rawGraph });
    return ++memoryReads === 1 ? json({ success: true, evidenceScope: 'simulation', memory: { a: { observations: ['run-only observation'] } },
      projection: { enabled: true, status: 'complete', projectedEventSequence: 2, committedEventSequence: 2 } })
      : new Response(JSON.stringify({ success: false, error: 'Source access revoked' }), { status: 409 });
  } });
});

test('project reset is explicit, retains the project and reports running-run conflicts', async () => {
  let mutations = 0;
  const project = { id: 'project-reset', name: 'Reset scenario', status: 'graph_built', current_step: 1,
    simulation_requirement: 'Requirement', updated_at: '2026-11-05', description: '', seed_files: [{ filename: 'retained.md', size: 12 }] };
  await mount(React.createElement(Home), async ui => {
    ui.window.confirm = () => true;
    await ui.click('重置');
    assert.equal(mutations, 1);
    assert.match(ui.container.textContent, /运行中的模拟必须先停止/);
    assert.match(ui.container.textContent, /Reset scenario/);
    assert.match(ui.container.textContent, /图谱已建/);
  }, { fetch: async (url, init) => {
    if (init?.method === 'POST') { mutations++; assert.equal(JSON.parse(init.body).action, 'reset'); return new Response(JSON.stringify({ success: false, error: '运行中的模拟必须先停止' }), { status: 409 }); }
    return json(String(url).endsWith('/simulation') ? { success: true, simulations: [] } : { success: true, projects: [project] });
  } });
});

test('historical navigation cannot change source or prepare but permits later stages', async () => {
  const changes = [];
  await mount(React.createElement(StepNav, { currentStep: 2, maxStep: 4, minStep: 2, onStepChange: step => changes.push(step) }), async ui => {
    const buttons = [...ui.container.querySelectorAll('button')];
    assert.equal(buttons[0].disabled, true);
    assert.equal(buttons[1].disabled, true);
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    await act(async () => buttons[3].click());
    assert.deepEqual(changes, [3]);
  });
});

test('project reset cancellation is inert and success uses the persisted project projection', async () => {
  let mutations = 0;
  const project = { id: 'project-reset', name: 'Kept project', status: 'graph_built', current_step: 1,
    simulation_requirement: 'Requirement', updated_at: '2026-11-05', description: '' };
  await mount(React.createElement(Home), async ui => {
    ui.window.confirm = () => false;
    await ui.click('重置'); assert.equal(mutations, 0);
    ui.window.confirm = () => true;
    await ui.click('重置'); assert.equal(mutations, 1);
    assert.match(ui.container.textContent, /Kept project/);
    assert.match(ui.container.textContent, /已创建/);
    assert.doesNotMatch(ui.container.textContent, /图谱已建/);
  }, { fetch: async (url, init) => {
    if (init?.method === 'POST') { mutations++; return json({ success: true, project: { ...project, status: 'created', current_step: 0 } }); }
    return json(String(url).endsWith('/simulation') ? { success: true, simulations: [] } : { success: true, projects: [project] });
  } });
});
