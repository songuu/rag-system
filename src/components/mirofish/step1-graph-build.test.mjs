import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';

const require = createRequire(import.meta.url);
const source = (await build({ entryPoints: [fileURLToPath(new URL('./Step1GraphBuild.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
  plugins: [{ name: 'viewer-boundary', setup(build) {
    build.onResolve({ filter: /KnowledgeGraphViewer$/ }, () => ({ path: '@/components/KnowledgeGraphViewer', external: true }));
  } }],
})).outputFiles[0].text;
const isolatedModule = { exports: {} };
vm.runInNewContext(source, { module: isolatedModule, exports: isolatedModule.exports,
  require: specifier => specifier === '@/components/KnowledgeGraphViewer' ? () => null : require(specifier),
  fetch: (...args) => globalThis.fetch(...args), AbortController, URLSearchParams,
  setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args),
  setInterval, clearInterval, Error, FormData,
});
const Step1 = isolatedModule.exports.default;
const pageSource = (await build({
  entryPoints: [fileURLToPath(new URL('../../app/mirofish/console/[projectId]/page.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
  plugins: [{ name: 'unrelated-step-boundaries', setup(build) {
    build.onResolve({ filter: /KnowledgeGraphViewer$|\/mirofish\/(?:Step[2-5][^/]*|ModelSelector)$/ }, args => ({ path: args.path, external: true }));
  } }],
})).outputFiles[0].text;
const pageModule = { exports: {} };
const router = { push() { throw new Error('Unexpected redirect'); } };
vm.runInNewContext(pageSource, { module: pageModule, exports: pageModule.exports,
  require(specifier) {
    if (specifier === 'next/navigation') return { useParams: () => ({ projectId: 'project-a' }), useRouter: () => router, useSearchParams: () => new URLSearchParams() };
    if (specifier === 'next/link') return ({ children, ...props }) => React.createElement('a', props, children);
    if (specifier.endsWith('Step2EnvSetup')) return props => React.createElement('div', {
      'data-preparation-selected': JSON.stringify(props.initialSelectedEntityIds),
      'data-preparation-profiles': JSON.stringify(props.profiles.map(profile => profile.entity_id)),
    }, '环境设置验收已载入', React.createElement('button', {
      onClick: () => props.onSimulationCreated('sim-created', props.initialConfig),
    }, '创建模拟验收'));
    if (specifier.startsWith('@/components/')) return () => null;
    return require(specifier);
  },
  fetch: (...args) => globalThis.fetch(...args), AbortController, URLSearchParams, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
});
const ConsolePage = pageModule.exports.default;
const ontology = { entity_types: [], edge_types: [], analysis_summary: '' };
const graph = { graph_id: 'graph-ready', nodes: [], edges: [], node_count: 0, edge_count: 0 };
const completed = { success: true, status: 'completed', progress: 100, graphId: graph.graph_id,
  documentVersion: 'v1', trustLevel: 'external', graphGeneration: 'generation-1' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function mount(fetchMock, run, options = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: fetchMock })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  function Harness() {
    const [savedGraph, setSavedGraph] = useState(null);
    return React.createElement(Step1, { projectId: 'project-a', simulationRequirement: 'test', initialTexts: ['source'],
      ontology, graphData: savedGraph, initialTaskId: 'task-existing',
      onTextsPersist() {}, onOntologyGenerated() {}, onComplete() {},
      async onGraphBuilt(value, identity) { await options.save?.(value, identity); setSavedGraph(value); },
      ...options.props,
    });
  }
  try {
    const content = React.createElement(options.component ?? Harness);
    await act(async () => root.render(options.strict ? React.createElement(React.StrictMode, null, content) : content));
    await run({ container, async click(text) {
      const button = [...container.querySelectorAll('button')].find(item => item.textContent.includes(text));
      assert.ok(button, `missing button: ${text}`);
      await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    } });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test('resumes a saved completed task, reads its exact version, and unlocks the next step', async () => {
  const calls = [];
  await mount(async url => {
    calls.push(url);
    return json(String(url).includes('action=status') ? completed : { success: true, graph });
  }, async ({ container }) => {
    assert.match(container.textContent, /下一步: 环境设置/);
    const dataUrl = new URL(calls.find(url => url.includes('action=data')), 'http://localhost');
    assert.equal(dataUrl.searchParams.get('documentVersion'), 'v1');
    assert.equal(dataUrl.searchParams.get('trustLevel'), 'external');
    assert.equal(dataUrl.searchParams.get('graphGeneration'), 'generation-1');
  });
});

test('readback failure stays visible and retries the completed task without rebuilding', async () => {
  let reads = 0;
  const methods = [];
  await mount(async (url, init) => {
    methods.push(init?.method || 'GET');
    if (url.includes('action=status')) return json(completed);
    return ++reads === 1 ? json({ success: false, error: '图谱读取失败，请重试' }, 503) : json({ success: true, graph });
  }, async ui => {
    assert.match(ui.container.textContent, /图谱读取失败，请重试/);
    assert.doesNotMatch(ui.container.textContent, /下一步: 环境设置/);
    await ui.click('重新读取图谱');
    assert.match(ui.container.textContent, /下一步: 环境设置/);
    assert.equal(reads, 2);
    assert(!methods.includes('POST'));
  });
});

test('project save failure cannot silently unlock the next step and can be retried', async () => {
  let saves = 0;
  await mount(async url => json(url.includes('action=status') ? completed : { success: true, graph }), async ui => {
    assert.match(ui.container.textContent, /项目保存失败/);
    assert.doesNotMatch(ui.container.textContent, /下一步: 环境设置/);
    await ui.click('重新读取图谱');
    assert.match(ui.container.textContent, /下一步: 环境设置/);
    assert.equal(saves, 2);
  }, { async save() { if (++saves === 1) throw new Error('项目保存失败'); } });
});

test('a completed task cannot attach a different graph to the project', async () => {
  let saves = 0;
  await mount(async url => json(url.includes('action=status') ? completed : { success: true, graph: { ...graph, graph_id: 'other' } }), async ui => {
    assert.equal(saves, 0);
    assert.match(ui.container.textContent, /图谱结果与构建任务不一致/);
    assert.doesNotMatch(ui.container.textContent, /下一步: 环境设置/);
  }, { async save() { saves++; } });
});

test('older projects recover their latest authorized graph instead of rebuilding', async () => {
  const calls = [];
  await mount(async url => {
    calls.push(url);
    return json(url.includes('action=list') ? { success: true, graphs: [
      { ...completed, graphName: 'Project foreign-project Graph', createdAt: '2027-01-01' },
      { ...completed, graphName: 'Project project-a Graph', createdAt: '2026-11-05' },
    ] } : { success: true, graph });
  }, async ({ container }) => {
    assert.match(container.textContent, /下一步: 环境设置/);
    assert.equal(calls.length, 2);
    assert(calls[1].includes('graphId=graph-ready'));
  }, { props: { initialTaskId: null } });
});

test('console saves the completed graph before unlocking navigation and survives reload', async () => {
  const project = { id: 'project-a', name: 'Project', status: 'created', current_step: 0,
    simulation_requirement: 'test', texts: ['source'], ontology, graph_task_id: 'task-existing' };
  let releaseNavigation;
  let graphSaved = false;
  const fetchMock = async (url, init) => {
    if (url.includes('/project/')) {
      if (init?.method === 'PUT') {
        const patch = JSON.parse(init.body);
        if (patch.current_step === 1) return new Promise(resolve => {
          releaseNavigation = () => { Object.assign(project, patch); resolve(json({ success: true, project })); };
        });
        Object.assign(project, patch);
        graphSaved = Boolean(project.graph_data);
      }
      return json({ success: true, project });
    }
    return json(url.includes('action=status') ? completed : { success: true, graph });
  };
  await mount(fetchMock, async ui => {
    assert.equal(graphSaved, true);
    assert.equal(project.graph_id, graph.graph_id);
    assert.equal(project.graph_task_id, null);
    await ui.click('下一步: 环境设置');
    assert.equal(project.current_step, 0, 'navigation must await the PostgreSQL save');
    assert.doesNotMatch(ui.container.textContent, /环境设置验收已载入/);
    await act(async () => releaseNavigation());
    assert.equal(project.current_step, 1);
    assert.match(ui.container.textContent, /环境设置验收已载入/);
  }, { component: ConsolePage });
  await mount(fetchMock, async ui => {
    assert.match(ui.container.textContent, /环境设置验收已载入/);
  }, { component: ConsolePage });
});

test('console persists canonical legacy selections together with personas and restores preparation after creation', async () => {
  const legacyGraph = { ...graph, nodes: [{ uuid: 'node-student', name: 'Student', labels: ['Person'], summary: 'Student', attributes: {} }], node_count: 1 };
  const project = { id: 'project-a', name: 'Legacy preparation', status: 'graph_built', current_step: 1,
    simulation_requirement: 'test', texts: ['source'], graph_id: graph.graph_id, graph_data: legacyGraph,
    agent_profiles: [{ entity_id: 'Student', entity_name: 'Student', full_name: '学生' }], selected_entity_ids: ['Student'],
    simulation_config: { platforms: ['twitter'], round_count: 10, posts_per_round: 1, agents_per_round: 1, temperature: .8, seed_topics: [], time_interval: 2 } };
  await mount(async (url, init) => {
    if (init?.method === 'PUT') { Object.assign(project, JSON.parse(init.body)); return json({ success: true, project }); }
    if (url.includes('/project/')) return json({ success: true, project });
    return json({ success: true, graph: legacyGraph });
  }, async ui => {
    await ui.click('创建模拟验收');
    assert.equal(project.agent_profiles[0].entity_id, 'node-student');
    assert.deepEqual(project.selected_entity_ids, ['node-student']);
    const back = [...ui.container.querySelectorAll('button')].find(button => button.textContent.includes('环境设置'));
    await act(async () => back.dispatchEvent(new ui.container.ownerDocument.defaultView.MouseEvent('click', { bubbles: true })));
    const preparation = ui.container.querySelector('[data-preparation-selected]');
    assert.equal(preparation.getAttribute('data-preparation-selected'), '["node-student"]');
    assert.equal(preparation.getAttribute('data-preparation-profiles'), '["node-student"]');
  }, { component: ConsolePage });
});

test('StrictMode cleanup does not suppress recovery of an older completed graph', async () => {
  await mount(async url => json(url.includes('action=list') ? { success: true, graphs: [
    { ...completed, graphName: 'Project project-a Graph', createdAt: '2026-11-05' },
  ] } : { success: true, graph }), async ({ container }) => {
    assert.match(container.textContent, /下一步: 环境设置/);
  }, { strict: true, props: { initialTaskId: null } });
});

test('an expired process-local task recovers its durable graph instead of trapping retries', async () => {
  const clearedTasks = [];
  await mount(async url => {
    if (url.includes('action=status')) return json({ success: false, code: 'MIROFISH_GRAPH_NOT_FOUND', error: '任务不存在' }, 404);
    if (url.includes('action=list')) return json({ success: true, graphs: [
      { ...completed, graphName: 'Project project-a Graph', createdAt: '2026-11-05' },
    ] });
    return json({ success: true, graph });
  }, async ({ container }) => {
    assert.match(container.textContent, /下一步: 环境设置/);
    assert.deepEqual(clearedTasks, [null]);
  }, { props: { async onTaskStarted(taskId) { clearedTasks.push(taskId); } } });
});

test('an interrupted task with no durable graph explains recovery and allows a fresh build', async () => {
  const clearedTasks = [];
  let builds = 0;
  let statusReads = 0;
  await mount(async (url, init) => {
    if (init?.method === 'POST') { builds++; return json({ success: true, taskId: 'task-new' }); }
    if (url.includes('taskId=task-existing')) {
      statusReads++;
      return json({ success: false, code: 'MIROFISH_GRAPH_NOT_FOUND', error: '任务不存在' }, 404);
    }
    if (url.includes('action=list')) return json({ success: true, graphs: [] });
    if (url.includes('action=status')) return json(completed);
    return json({ success: true, graph });
  }, async ui => {
    assert.deepEqual(clearedTasks, [null]);
    assert.doesNotMatch(ui.container.textContent, /任务不存在|正在检查已有图谱/);
    assert.match(ui.container.textContent, /上次图谱构建任务已中断/);
    const button = [...ui.container.querySelectorAll('button')].find(item => item.textContent.includes('构建图谱'));
    assert.equal(button.disabled, false);
    await ui.click('构建图谱');
    assert.equal(builds, 1);
    assert.equal(statusReads, 1, 'the missing task must not be polled again');
    assert.match(ui.container.textContent, /下一步: 环境设置/);
  }, { props: { async onTaskStarted(id) { clearedTasks.push(id); } } });
});

test('console clears an interrupted task once and never leaves the graph button checking forever', async () => {
  const project = { id: 'project-a', name: 'Interrupted build', status: 'created', current_step: 0,
    simulation_requirement: 'test', texts: ['source'], ontology, graph_task_id: 'task-existing' };
  let clears = 0;
  let catalogReads = 0;
  await mount(async (url, init) => {
    if (url.includes('/project/')) {
      if (init?.method === 'PUT') { clears++; Object.assign(project, JSON.parse(init.body)); }
      return json({ success: true, project });
    }
    if (url.includes('action=status')) return json({ success: false, code: 'MIROFISH_GRAPH_NOT_FOUND', error: '任务不存在' }, 404);
    if (url.includes('action=list')) { catalogReads++; return json({ success: true, graphs: [] }); }
    throw new Error(`Unexpected request: ${url}`);
  }, async ui => {
    assert.equal(project.graph_task_id, null);
    assert.equal(clears, 1);
    assert.equal(catalogReads, 1);
    assert.doesNotMatch(ui.container.textContent, /任务不存在|正在检查已有图谱/);
    assert.match(ui.container.textContent, /上次图谱构建任务已中断/);
    const button = [...ui.container.querySelectorAll('button')].find(item => item.textContent.includes('构建图谱'));
    assert.equal(button.disabled, false);
  }, { component: ConsolePage, strict: true });
});

test('a stalled saved-graph check times out visibly and releases the build button', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await mount(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  }), async ui => {
    assert.match(ui.container.textContent, /正在检查已有图谱/);
    await act(async () => t.mock.timers.tick(30_000));
    assert.match(ui.container.textContent, /检查已有图谱超时/);
    const button = [...ui.container.querySelectorAll('button')].find(item => item.textContent.includes('构建图谱'));
    assert.equal(button.disabled, false);
  }, { props: { initialTaskId: null } });
});

test('a stalled task status read times out and can be retried without starting another build', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  await mount(async (url, init) => {
    requests++;
    if (requests === 1) return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    });
    return json(url.includes('action=status') ? completed : { success: true, graph });
  }, async ui => {
    await act(async () => t.mock.timers.tick(30_000));
    assert.match(ui.container.textContent, /读取图谱任务或结果超时/);
    await ui.click('重新读取图谱');
    assert.match(ui.container.textContent, /下一步: 环境设置/);
    assert.equal(requests, 3);
  });
});

test('checking for a completed graph disables duplicate builds until recovery settles', async () => {
  let releaseCatalog;
  let builds = 0;
  await mount(async (url, init) => {
    if (init?.method === 'POST') { builds++; return json({ success: true, taskId: 'new-task' }); }
    if (url.includes('action=list')) return new Promise(resolve => { releaseCatalog = () => resolve(json({ success: true, graphs: [] })); });
    return json({ success: true });
  }, async ui => {
    try {
      const buildButton = [...ui.container.querySelectorAll('button')].find(button => button.textContent.includes('已有图谱') || button.textContent.includes('构建图谱'));
      assert.equal(buildButton.disabled, true);
      assert.equal(builds, 0);
    } finally { await act(async () => releaseCatalog()); }
    assert.equal([...ui.container.querySelectorAll('button')].find(button => button.textContent.includes('构建图谱')).disabled, false);
  }, { props: { initialTaskId: null } });
});

test('a newly created graph task is persisted before the workflow completes', async () => {
  const started = [];
  const taskId = 'task_00000000-0000-4000-8000-000000000001';
  await mount(async (url, init) => {
    if (init?.method === 'POST') {
      assert.equal(JSON.parse(init.body).projectId, 'project-a', 'the real UI must claim its project before graph worker startup');
      return json({ success: true, taskId });
    }
    if (url.includes('action=list')) return json({ success: true, graphs: [] });
    if (url.includes('action=status')) return json(completed);
    return json({ success: true, graph });
  }, async ui => {
    await ui.click('构建图谱');
    assert.deepEqual(started, [taskId]);
    assert.match(ui.container.textContent, /下一步: 环境设置/);
  }, { props: { initialTaskId: null, async onTaskStarted(value) { started.push(value); } } });
});

test('multiple seed files append to existing source text and preserve upload metadata', async () => {
  const savedTexts = [], savedFiles = [];
  await mount(async (url, init) => {
    assert.equal(url, '/rag-api/mirofish/upload');
    assert.equal(init.body.getAll('files').length, 2);
    return json({ success: true, texts: ['first source', 'second source'], files: [
      { filename: 'first.md', size: 12 }, { filename: 'second.txt', size: 13 },
    ] });
  }, async ({ container }) => {
    const input = container.querySelector('input[type=file]');
    assert.equal(input.multiple, true);
    Object.defineProperty(input, 'files', { value: [new File(['first'], 'first.md'), new File(['second'], 'second.txt')] });
    await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
    assert.equal(container.querySelector('textarea').value, 'source\n\nfirst source\n\nsecond source');
    assert.match(container.textContent, /first.md/); assert.match(container.textContent, /second.txt/);
    assert.equal(savedTexts[0][0], 'source\n\nfirst source\n\nsecond source');
    assert.equal(savedFiles[0].length, 2);
  }, { props: { initialTaskId: null, ontology: null, onTextsPersist(value) { savedTexts.push(value); }, onSeedFilesPersist(value) { savedFiles.push(value); } } });
});

test('completed graph callback retains the exact public artifact identity', async () => {
  let savedIdentity;
  await mount(async url => json(url.includes('action=status') ? completed : { success: true, graph,
    documentVersion: 'v1', trustLevel: 'external', graphGeneration: 'generation-1' }), async () => {
    assert.equal(savedIdentity.documentId, 'graph-ready'); assert.equal(savedIdentity.documentVersion, 'v1');
    assert.equal(savedIdentity.graphGeneration, 'generation-1');
  }, { save(_graph, identity) { savedIdentity = identity; } });
});

test('seed text persistence failure keeps local text and cannot be hidden by a later file metadata save', async () => {
  let savedFiles = 0;
  let failed = true;
  await mount(async () => json({ success: true, texts: ['new source'], files: [{ filename: 'new.md', size: 10 }] }), async ({ container, click }) => {
    const input = container.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { value: [new File(['new source'], 'new.md')] });
    await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
    assert.equal(container.querySelector('textarea').value, 'source\n\nnew source');
    assert.match(container.textContent, /Seed text save failed/);
    assert.equal(savedFiles, 0);
    failed = false;
    await click('重试保存种子文件');
    assert.equal(savedFiles, 1);
    assert.doesNotMatch(container.textContent, /Seed text save failed/);
    assert.equal(container.querySelector('textarea').value, 'source\n\nnew source');
  }, { props: { initialTaskId: null, ontology: null, async onTextsPersist() { if (failed) throw new Error('Seed text save failed'); }, onSeedFilesPersist() { savedFiles++; } } });
});

test('ontology persistence errors remain visible instead of producing unobserved rejection', async () => {
  let calls = 0;
  await mount(async () => { calls++; return json({ success: true, ontology }); }, async ({ click, container }) => {
    await click('生成本体');
    assert.equal(calls, 1);
    assert.match(container.textContent, /Ontology save failed/);
    assert.doesNotMatch(container.textContent, /下一步: 环境设置/);
  }, { props: { initialTaskId: null, ontology: null, async onOntologyGenerated() { throw new Error('Ontology save failed'); } } });
});
