import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const require = createRequire(import.meta.url);
const source = buildSync({
  entryPoints: [new URL('./HomeHeader.tsx', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
}).outputFiles[0].text;
const isolated = { exports: {} };
vm.runInNewContext(source, {
  module: isolated, exports: isolated.exports,
  get window() { return globalThis.window; }, get document() { return globalThis.document; },
  require(name) {
    if (name === 'next/link') return { __esModule: true, default: ({ children, onClick, ...props }) => {
      const anchorProps = { ...props };
      delete anchorProps.prefetch;
      return React.createElement('a', {
        ...anchorProps, onClick(event) { event.preventDefault(); onClick?.(event); },
      }, children);
    } };
    return require(name);
  },
});
const Header = isolated.exports.default;
async function mount(run, overrides = {}) {
  const dom = new JSDOM('<div id="root"></div><button id="outside">外部按钮</button>', { url: 'http://localhost/' });
  const saved = new Map();
  const listeners = new Set();
  const media = { matches: false, addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); } };
  dom.window.matchMedia = query => { assert.equal(query, '(min-width: 1536px)'); return media; };
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  const calls = { agent: 0, entity: 0, clear: 0, refresh: 0 };
  try {
    await act(async () => root.render(React.createElement(Header, {
      vectorBackendDisabled: false, milvusConnected: true, showRagModes: true,
      useAgenticRAG: false, useAdaptiveEntityRAG: false, systemStatus: '运行中',
      onToggleAgentic: () => calls.agent++, onToggleEntity: () => calls.entity++,
      onClearConversations: () => calls.clear++, onRefreshStatus: () => calls.refresh++, ...overrides,
    })));
    const trigger = container.querySelector('button[aria-controls]');
    await run({ container, dom, trigger, calls,
      get menu() { return dom.window.document.getElementById(trigger.getAttribute('aria-controls')); },
      async click(element) { assert.ok(element); await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))); },
      async resize(wide, blurBeforeEvent = false) {
        media.matches = wide;
        if (blurBeforeEvent) await act(async () => dom.window.document.activeElement.blur());
        await act(async () => listeners.forEach(listener => listener({ matches: wide })));
      },
    });
  } finally {
    await act(async () => root.unmount());
    assert.equal(listeners.size, 0);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('disclosure opens, Escape closes and restores focus, outside pointer closes', async () => {
  await mount(async ui => {
    assert.equal(ui.trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(ui.menu, null);
    await ui.click(ui.trigger);
    assert.equal(ui.trigger.getAttribute('aria-expanded'), 'true');
    assert.ok(ui.menu);
    await act(async () => ui.menu.querySelector('a').focus());
    await act(async () => ui.dom.window.document.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(ui.menu, null);
    assert.equal(ui.dom.window.document.activeElement, ui.trigger);
    await ui.click(ui.trigger);
    await act(async () => ui.dom.window.document.getElementById('outside').dispatchEvent(new ui.dom.window.Event('pointerdown', { bubbles: true })));
    assert.equal(ui.menu, null);
  });
});

test('all desktop destinations remain available with full names in the dropdown and links dismiss it', async () => {
  await mount(async ui => {
    const desktop = ui.container.querySelector('[aria-label="桌面功能导航"]');
    const destinations = [...desktop.querySelectorAll('a')].map(link => link.getAttribute('href')).sort();
    assert.equal(destinations.length, 18);
    await ui.click(ui.trigger);
    assert.deepEqual([...ui.menu.querySelectorAll('a')].map(link => link.getAttribute('href')).sort(), destinations);
    assert.ok([...ui.menu.querySelectorAll('a')].every(link => link.textContent.trim().length > 0));
    await ui.click(ui.menu.querySelector('a[href="/rag-evaluation"]'));
    assert.equal(ui.menu, null);
  });
});

test('mode and clear actions call their original callbacks once and dismiss the dropdown', async () => {
  await mount(async ui => {
    for (const [label, name] of [['Agent', 'agent'], ['Entity', 'entity'], ['清空历史对话', 'clear']]) {
      await ui.click(ui.trigger);
      await ui.click([...ui.menu.querySelectorAll('button')].find(button => button.textContent.trim() === label));
      assert.equal(ui.calls[name], 1);
      assert.equal(ui.menu, null);
      assert.equal(ui.dom.window.document.activeElement, ui.trigger);
    }
    await ui.click(ui.container.querySelector('button[aria-label="刷新运行状态"]'));
    assert.equal(ui.calls.refresh, 1);
  });
});

test('desktop breakpoint clears mobile open state and Tab can leave the navigation', async () => {
  await mount(async ui => {
    await ui.click(ui.trigger);
    await ui.resize(true);
    assert.equal(ui.menu, null);
    await ui.resize(false);
    assert.equal(ui.trigger.getAttribute('aria-expanded'), 'false');
    await ui.resize(true);
    await act(async () => ui.container.querySelector('[aria-label="桌面功能导航"] a').focus());
    await ui.resize(false, true);
    assert.equal(ui.dom.window.document.activeElement, ui.trigger);
    await ui.click(ui.trigger);
    await act(async () => ui.menu.querySelector('a').focus());
    await act(async () => ui.dom.window.document.getElementById('outside').focus());
    assert.equal(ui.menu, null);
  });
});

test('maintenance state does not expose disabled RAG modes', async () => {
  await mount(async ui => {
    await ui.click(ui.trigger);
    assert.match(ui.menu.textContent, /知识库维护/);
    assert.equal(ui.menu.querySelector('button[aria-pressed]'), null);
  }, { vectorBackendDisabled: true, showRagModes: false });
});
