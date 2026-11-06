import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const require = createRequire(import.meta.url);
const source = buildSync({
  entryPoints: [new URL('./ResizableChatArea.tsx', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
}).outputFiles[0].text;
const isolated = { exports: {} };
vm.runInNewContext(source, {
  module: isolated, exports: isolated.exports, require,
  get window() { return globalThis.window; }, get document() { return globalThis.document; },
});
const ChatArea = isolated.exports.default;

async function mount(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  dom.window.innerHeight = 1000;
  const resizeListeners = new Set();
  const addEventListener = dom.window.addEventListener.bind(dom.window);
  const removeEventListener = dom.window.removeEventListener.bind(dom.window);
  dom.window.addEventListener = (type, listener, options) => {
    if (type === 'resize') resizeListeners.add(listener);
    addEventListener(type, listener, options);
  };
  dom.window.removeEventListener = (type, listener, options) => {
    if (type === 'resize') resizeListeners.delete(listener);
    removeEventListener(type, listener, options);
  };
  const captured = new Set();
  dom.window.HTMLElement.prototype.setPointerCapture = pointerId => captured.add(pointerId);
  dom.window.HTMLElement.prototype.hasPointerCapture = pointerId => captured.has(pointerId);
  dom.window.HTMLElement.prototype.releasePointerCapture = pointerId => captured.delete(pointerId);
  const saved = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(ChatArea, null, React.createElement('p', null, '已有对话消息'))));
    const handle = container.querySelector('[role="separator"]');
    const area = container.querySelector('[aria-label="对话消息"]');
    const ui = {
      dom, container, handle, area, captured,
      get height() { return Number(handle.getAttribute('aria-valuenow')); },
      get min() { return Number(handle.getAttribute('aria-valuemin')); },
      get max() { return Number(handle.getAttribute('aria-valuemax')); },
      async pointer(type, y = 500, overrides = {}) {
        const event = new dom.window.MouseEvent(type, { button: 0, clientY: y, bubbles: true, cancelable: true, ...overrides });
        Object.defineProperties(event, {
          pointerId: { value: overrides.pointerId ?? 1 },
          isPrimary: { value: overrides.isPrimary ?? true },
        });
        await act(async () => handle.dispatchEvent(event));
      },
      async key(key) {
        await act(async () => handle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
      },
      async resize(height) {
        dom.window.innerHeight = height;
        await act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')));
      },
      async doubleClick() {
        await act(async () => handle.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true })));
      },
    };
    // JSDOM has no layout; report the visible height that the separator exposes.
    area.getBoundingClientRect = () => ({ height: ui.height });
    await run(ui);
  } finally {
    await act(async () => root.unmount());
    assert.equal(resizeListeners.size, 0, 'viewport subscription must be removed on unmount');
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('message area is larger by default and its resize handle is accessible', async () => {
  await mount(async ui => {
    assert.ok(ui.area.textContent.includes('已有对话消息'));
    assert.ok(ui.height > 384);
    assert.equal(ui.height, 560);
    assert.equal(ui.handle.getAttribute('aria-label'), '调整对话区域高度');
    assert.equal(ui.handle.getAttribute('aria-orientation'), 'horizontal');
    assert.equal(ui.handle.tabIndex, 0);
    assert.equal(ui.handle.getAttribute('aria-controls'), ui.area.id);
    assert.ok(ui.dom.window.document.getElementById(ui.handle.getAttribute('aria-describedby')));
    await ui.resize(600);
    assert.equal(ui.height, 360);
    await ui.resize(1600);
    assert.equal(ui.height, 760);
  });
});

test('dragging changes height in both directions and respects the visible bounds', async () => {
  await mount(async ui => {
    await ui.pointer('pointerdown', 500);
    assert.equal(ui.dom.window.document.activeElement, ui.handle);
    assert.ok(ui.captured.has(1));
    await ui.pointer('pointermove', 620);
    assert.equal(ui.height, 680);
    assert.equal(ui.area.style.height, '680px');
    await ui.pointer('pointermove', 440);
    assert.equal(ui.height, 500);
    await ui.pointer('pointermove', 5000);
    assert.equal(ui.height, ui.max);
    await ui.pointer('pointermove', -5000);
    assert.equal(ui.height, ui.min);
    await ui.pointer('pointerup');
    assert.equal(ui.captured.size, 0);
  });
});

test('right clicks, secondary touches and unrelated pointer IDs cannot resize the chat', async () => {
  await mount(async ui => {
    for (const overrides of [{ button: 2 }, { isPrimary: false }]) {
      await ui.pointer('pointerdown', 500, overrides);
      await ui.pointer('pointermove', 700, overrides);
      assert.equal(ui.height, 560);
      assert.equal(ui.captured.size, 0);
    }
    await ui.pointer('pointerdown', 500);
    await ui.pointer('pointermove', 800, { pointerId: 2 });
    await ui.pointer('pointerup', 800, { pointerId: 2 });
    assert.equal(ui.height, 560);
    await ui.pointer('pointermove', 600);
    assert.equal(ui.height, 660);
  });
});

for (const endEvent of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  test(`${endEvent} ends dragging so later moves do not change the height`, async () => {
    await mount(async ui => {
      await ui.pointer('pointerdown', 500);
      await ui.pointer('pointermove', 600);
      assert.equal(ui.height, 660);
      await ui.pointer(endEvent, 600);
      await ui.pointer('pointermove', 800);
      assert.equal(ui.height, 660);
      assert.equal(ui.captured.size, 0);
      await ui.pointer('pointerdown', 800);
      await ui.pointer('pointermove', 760);
      assert.equal(ui.height, 620, 'a new drag starts from the latest visible height');
    });
  });
}

test('keyboard resizing supports fine adjustment, bounds and reset', async () => {
  await mount(async ui => {
    await ui.key('ArrowDown');
    assert.equal(ui.height, 592);
    await ui.key('ArrowUp');
    assert.equal(ui.height, 560);
    await ui.key('Home');
    assert.equal(ui.height, ui.min);
    await ui.key('ArrowUp');
    assert.equal(ui.height, ui.min);
    await ui.key('End');
    assert.equal(ui.height, ui.max);
    await ui.key('ArrowDown');
    assert.equal(ui.height, ui.max);
    await ui.key('Tab');
    assert.equal(ui.height, ui.max);
    await ui.key('Enter');
    assert.equal(ui.height, 560);
  });
});

test('manual height stays within a smaller viewport and double click restores responsive sizing', async () => {
  await mount(async ui => {
    await ui.key('End');
    assert.equal(ui.height, 850);
    await ui.resize(600);
    assert.equal(ui.height, ui.max);
    assert.equal(ui.area.style.height, '510px');
    await ui.doubleClick();
    assert.equal(ui.height, 360);
    await ui.resize(1200);
    assert.equal(ui.height, 672);
  });
});
