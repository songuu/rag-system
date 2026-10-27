import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPresentationReport } from '../lib/rag/eval/report-presentation.test-support.mjs';

const require = createRequire(import.meta.url);
function loadComponent(filename) {
  const code = buildSync({ entryPoints: [new URL(filename, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
  }).outputFiles[0].text;
  const isolated = { exports: {} };
  vm.runInNewContext(code, {
    module: isolated, exports: isolated.exports, console,
    require(name) {
      if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
      return require(name);
    },
  });
  return isolated.exports.default;
}
const Panel = loadComponent('./RagEvaluationPanel.tsx');
const Summary = loadComponent('./RetrievalEffectSummary.tsx');
async function mount(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Panel)));
    await run({
      container, dom,
      async upload(value, name = 'report.json') {
        const input = container.querySelector('input[type="file"]');
        const content = typeof value === 'string' ? value : JSON.stringify(value);
        Object.defineProperty(input, 'files', { configurable: true, value: [{ name, size: content.length, text: async () => content }] });
        await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
      },
      async beginUpload(textPromise) {
        const input = container.querySelector('input[type="file"]');
        Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'pending.json', size: 10, text: () => textPromise }] });
        await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
      },
      async click(button) { await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('report upload renders paired metrics, supports case inspection and clears local data', async () => {
  await mount(async ui => {
    assert.match(ui.container.textContent, /尚未导入报告/);
    const baseline = createPresentationReport();
    const candidate = createPresentationReport({ runId: 'reranked', target: { id: 'rerank' } });
    candidate.cases[0].retrieval.ndcgAtK = 0.9;
    candidate.cases[0].answer = '<script>escaped</script>';
    await ui.upload({ schemaVersion: 'rag-eval-matrix/v1', baselineTargetId: 'dense', targets: [{ report: baseline }, { report: candidate }] });
    assert.match(ui.container.textContent, /已导入 2 次运行/);
    assert.match(ui.container.textContent, /模拟 \/ 夹具评测/);
    assert.match(ui.container.textContent, /\+50\.0 pp/);
    assert.match(ui.container.querySelector('[aria-label="指标对比"]').textContent, /未标注 \/ 未计量|计量覆盖不完整/);
    const row = ui.container.querySelector('[aria-label="逐题变化"] button');
    await ui.click(row);
    assert.match(ui.container.textContent, /输出证据排名/);
    assert.match(ui.container.textContent, /<script>escaped<\/script>/);
    assert.equal(ui.container.querySelectorAll('script').length, 0);
    await ui.click([...ui.container.querySelectorAll('button')].find(button => button.textContent === '清空'));
    assert.match(ui.container.textContent, /尚未导入报告/);
    assert.equal(ui.container.querySelector('[aria-label="指标对比"]'), null);
  });
});

test('invalid JSON is actionable and leaves imported data intact', async () => {
  await mount(async ui => {
    await ui.upload(createPresentationReport());
    await ui.upload('{invalid', 'broken.json');
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /broken.json.*JSON/);
    assert.match(ui.container.textContent, /已导入 1 次运行/);
  });
});

test('incompatible runs show a reason and suppress all numeric deltas', async () => {
  await mount(async ui => {
    const baseline = createPresentationReport();
    const candidate = createPresentationReport({ runId: 'different', configuration: { topK: 10 } });
    await ui.upload({ schemaVersion: 'scoped-agent-eval/v1', reports: [baseline, candidate] });
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /Top K 不同/);
    assert.doesNotMatch(ui.container.textContent, /\+\d+[.]\d+ pp/);
  });
});

test('reading disables run selectors and clear cancels an uncancellable late file read', async () => {
  await mount(async ui => {
    await ui.upload(createPresentationReport());
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    await ui.beginUpload(pending);
    assert.ok([...ui.container.querySelectorAll('select[aria-label$="运行"]')].every(select => select.disabled));
    await ui.click([...ui.container.querySelectorAll('button')].find(button => button.textContent === '清空'));
    await act(async () => finish(JSON.stringify(createPresentationReport({ runId: 'late' }))));
    assert.match(ui.container.textContent, /尚未导入报告/);
    assert.doesNotMatch(ui.container.textContent, /已导入 1 次运行/);
  });
});

test('single-query summary preserves zero scores and explicitly labels unmeasured quality', () => {
  const html = renderToStaticMarkup(React.createElement(Summary, { diagnostics: {
    candidateCount: 1, contextCount: 1, citedCount: null, rows: [{
      evidenceId: 'a', source: 'source.pdf', laneId: 'dense', beforeRerankRank: 8, afterRerankRank: 1,
      retrievalScore: 0, rerankScore: 0, inContext: true, cited: null,
    }],
  } }));
  assert.match(html, /#8 → #1/);
  assert.match(html, /0\.0000/);
  assert.match(html, /质量未评测/);
  assert.match(html, /未计量/);
  assert.match(html, /href="\/rag-evaluation"/);
  assert.match(renderToStaticMarkup(React.createElement(Summary)), /未记录候选与重排轨迹/);
});
