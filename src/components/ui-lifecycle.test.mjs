import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(relative, overrides = {}) {
  const record = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module: record, exports: record.exports, console, AbortController, DOMException,
    setTimeout, clearTimeout, setInterval, clearInterval,
    get window() { return globalThis.window; }, get document() { return globalThis.document; },
    require(name) {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
      if (name === '@/lib/maic/slide-animation') return { buildDefaultSlideAnimations: () => [], shouldHoldFocus: () => false };
      throw Error('Unexpected import: ' + name);
    }, ...overrides });
  return record.exports;
}
async function renderTest(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const saved = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  try { await run({ dom, container, render: element => act(async () => root.render(element)),
    click: element => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))),
    input: (element, value) => act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }) });
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

test('appending thinking steps keeps already displayed content visible', async () => renderTest(async ui => {
  const Component = load('./ThinkingProcessCollapsible.tsx').default;
  const first = { id: 'one', timestamp: 0, type: 'reasoning', content: '已经展示的步骤' };
  await ui.render(React.createElement(Component, { steps: [first], isThinking: true }));
  await act(async () => new Promise(resolve => setTimeout(resolve, 120)));
  assert.match(ui.container.textContent, /已经展示的步骤/);
  await ui.render(React.createElement(Component, { steps: [first, { ...first, id: 'two', content: '新步骤' }], isThinking: true }));
  assert.match(ui.container.textContent, /已经展示的步骤/);
}));

test('choosing an available default model does not reload the model list or sessions', async () => renderTest(async ui => {
  const requests = [];
  const Component = load('../app/context-management/page.tsx', { fetch: async url => {
    requests.push(url);
    return { ok: true, json: async () => url.includes('ollama/models')
      ? { success: true, llmModels: [{ name: 'available-llm', displayName: 'Available' }],
        embeddingModels: [{ name: 'available-embedding', displayName: 'Embedding' }] }
      : { success: true, sessions: [] } };
  } }).default;
  await ui.render(React.createElement(Component));
  assert.equal(requests.filter(url => url.includes('ollama/models')).length, 1);
  assert.equal(requests.filter(url => url.includes('action=sessions')).length, 1);
}));

test('changing courses hides the previous course while its replacement loads', async () => renderTest(async ui => {
  let closed = 0;
  class Events { close() { closed++; } }
  ui.dom.window.localStorage.setItem('maic:first:quiz-answers', '{"question":1}');
  ui.dom.window.localStorage.setItem('maic:second:quiz-answers', '{"question":2}');
  const { OpenMaicClassroom } = load('./maic/OpenMaicClassroom.tsx', {
    EventSource: Events, fetch: async url => url.endsWith('/first')
      ? { json: async () => ({ success: true, data: { course_id: 'first', title: '旧课程', status: 'ready', prepared: { pages: [], active_questions: [] } } }) }
      : new Promise(() => {}),
  });
  await ui.render(React.createElement(OpenMaicClassroom, { courseId: 'first' }));
  assert.match(ui.container.textContent, /旧课程/);
  await ui.render(React.createElement(OpenMaicClassroom, { courseId: 'second' }));
  assert.doesNotMatch(ui.container.textContent, /旧课程/);
  assert.match(ui.container.textContent, /正在加载/);
  assert.equal(closed, 1);
  assert.equal(ui.dom.window.localStorage.getItem('maic:first:quiz-answers'), '{"question":1}');
  assert.equal(ui.dom.window.localStorage.getItem('maic:second:quiz-answers'), '{"question":2}');
}));

test('simulation starts its first round and reset cancels pending continuation', async () => renderTest(async ui => {
  const timers = new Map(); let id = 0;
  const Component = load('../app/mirofish/simulation/page.tsx', {
    setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: key => timers.delete(key),
  }).default;
  await ui.render(React.createElement(Component));
  const topic = ui.container.querySelector('input[type="text"]');
  await ui.input(topic, '公开测试话题');
  const findButton = text => [...ui.container.querySelectorAll('button')].find(button => button.textContent.includes(text));
  await ui.click(findButton('+'));
  await ui.click(findButton('开始模拟'));
  assert.match(ui.container.textContent, /第1轮/);
  assert.ok(timers.size > 0);
  await ui.click(findButton('🔄'));
  assert.equal(timers.size, 0);
  assert.doesNotMatch(ui.container.textContent, /第1轮/);
  assert.doesNotMatch(ui.container.textContent, /模拟结果/);
}));
