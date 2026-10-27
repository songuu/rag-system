import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const require = createRequire(import.meta.url);
const code = buildSync({ entryPoints: [new URL('./RagDatasetBuilder.tsx', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent',
}).outputFiles[0].text;
const isolated = { exports: {} };
const context = { module: isolated, exports: isolated.exports, console, require,
  get fetch() { return globalThis.fetch; }, get document() { return globalThis.document; },
  get URL() { return globalThis.URL; }, get Blob() { return globalThis.Blob; }, AbortController,
};
vm.runInNewContext(code, context);
const Builder = isolated.exports.default;

function dataset() {
  return { schemaVersion: 'rag-eval-dataset/v1', datasetId: 'sample', datasetVersion: '1',
    corpus: [{ evidenceId: 'source-1', documentId: 'document-1', source: '说明.md', content: '系统支持全文检索和向量检索。' }],
    cases: [{ id: 'q1', query: '系统支持哪些检索方式？', expectedAbstain: false, tags: ['ai-generated', 'needs-review'],
      expectedAnswer: { referenceAnswer: '系统支持全文检索和向量检索。', requiredFacts: [['全文检索'], ['向量检索']] },
      goldEvidence: [{ evidenceId: 'source-1', relevance: 3, spans: [{ startOffset: 0, endOffset: 14 }] }] }],
  };
}

function datasetWithCases(count) {
  const value = dataset();
  value.cases = Array.from({ length: count }, (_, index) => ({ ...structuredClone(value.cases[0]),
    id: 'q' + (index + 1), query: '第 ' + (index + 1) + ' 个检索方式问题是什么？' }));
  return value;
}

function documentItem(id = 'asset-1', overrides = {}) {
  return { id, documentId: 'document-' + id, name: '说明.md', chunkCount: 12, documentVersion: 'version-1',
    trustLevel: 'reviewed', enabled: true, lifecycle: 'active', milvusStatus: 'ready', ...overrides };
}
const response = body => ({ ok: true, json: async () => body });

async function mount(run, fetcher = async () => response({ success: true, dataset: dataset() }), catalogFetcher = async () => response({ success: true, documents: [] })) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const saved = new Map();
  const routedFetch = (url, options) => url === '/rag-api/documents' ? catalogFetcher(url, options) : fetcher(url, options);
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, fetch: routedFetch, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Builder)));
    const ui = { container, dom,
      button(text) { return [...container.querySelectorAll('button')].find(button => button.textContent === text); },
      field(label) { return container.querySelector('[aria-label="' + label + '"]'); },
      async click(button) { assert.ok(button, 'button exists'); await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); },
      async edit(label, value) {
        const input = this.field(label);
        const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
        await act(async () => input.dispatchEvent(new dom.window.Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })));
      },
      async generate() {
        await this.click(this.button('粘贴 / 导入文本'));
        await this.edit('资料名称 1', '说明.md');
        await this.edit('资料正文 1', '系统支持全文检索和向量检索。');
        await this.edit('生成题数', '1');
        await this.click(this.button('生成测试集'));
      },
    };
    await run(ui);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test('generates editable grounded cases, reviews and downloads the edited dataset', async () => {
  let request;
  await mount(async ui => {
    await ui.generate();
    assert.equal(request.url, '/rag-api/rag-evaluation/datasets/generate');
    assert.equal(JSON.parse(request.options.body).sources[0].source, '说明.md');
    assert.match(ui.container.textContent, /系统支持全文检索和向量检索/);
    assert.equal(ui.field('问题 1').value, '系统支持哪些检索方式？');
    await ui.click(ui.button('标记已审核'));
    assert.match(ui.container.textContent, /已审核 1 \/ 1/);
    await ui.edit('参考答案 1', '支持全文与向量两种检索。');
    assert.match(ui.container.textContent, /已审核 0 \/ 1/);
    await ui.edit('答案要点 1', '全文检索 | 词法检索\n向量检索');
    await ui.edit('相关度 1-1', '2');
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = ui.dom.window.HTMLAnchorElement.prototype.click;
    let download;
    let revoked;
    URL.createObjectURL = blob => { download = blob; return 'blob:test'; };
    URL.revokeObjectURL = value => { revoked = value; };
    ui.dom.window.HTMLAnchorElement.prototype.click = function () { assert.equal(this.download, 'rag-eval-dataset.json'); };
    try {
      await ui.click(ui.button('下载 JSON 草稿'));
      const exported = JSON.parse(await download.text());
      assert.equal(exported.cases[0].expectedAnswer.referenceAnswer, '支持全文与向量两种检索。');
      assert.deepEqual(exported.cases[0].expectedAnswer.requiredFacts, [['全文检索', '词法检索'], ['向量检索']]);
      assert.equal(exported.cases[0].goldEvidence[0].relevance, 2);
      assert.ok(exported.cases[0].tags.includes('needs-review'));
      assert.equal(revoked, 'blob:test');
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; ui.dom.window.HTMLAnchorElement.prototype.click = originalClick; }
  }, async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ success: true, dataset: dataset() }) }; });
});

test('generation failures preserve input and the previous draft', async () => {
  let calls = 0;
  await mount(async ui => {
    await ui.generate();
    await ui.click(ui.button('重新生成测试集'));
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /模型暂不可用/);
    assert.equal(ui.field('资料正文 1').value, '系统支持全文检索和向量检索。');
    assert.equal(ui.field('问题 1').value, '系统支持哪些检索方式？');
  }, async () => ++calls === 1 ? { ok: true, json: async () => ({ success: true, dataset: dataset() }) }
    : { ok: false, json: async () => ({ error: { message: '模型暂不可用' } }) });
});

test('invalid case review reports an error and keeps the draft editable', async () => {
  await mount(async ui => {
    await ui.generate();
    await ui.edit('问题 1', '');
    await ui.click(ui.button('标记已审核'));
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /query|问题/);
    assert.equal(ui.field('参考答案 1').value, '系统支持全文检索和向量检索。');
    assert.equal(ui.button('下载 JSON 草稿').disabled, true);
    await ui.edit('问题 1', '支持哪些检索方式？');
    assert.equal(ui.container.querySelector('[role="alert"]'), null);
    await ui.click(ui.button('标记已审核'));
    assert.match(ui.container.textContent, /已审核 1 \/ 1/);
  });
});

test('cancel ignores a late generation response and keeps the page usable', async () => {
  let finish;
  let signal;
  await mount(async ui => {
    await ui.generate();
    assert.equal(ui.button('生成中…').disabled, true);
    await ui.click(ui.button('取消生成'));
    assert.equal(signal.aborted, true);
    await act(async () => finish({ ok: true, json: async () => ({ success: true, dataset: dataset() }) }));
    assert.equal(ui.field('问题 1'), null);
    assert.ok(ui.button('生成测试集'));
  }, async (_url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
});

test('imports supported text sources and rejects oversized source text before calling the API', async () => {
  let calls = 0;
  await mount(async ui => {
    await ui.click(ui.button('粘贴 / 导入文本'));
    const input = ui.field('导入 TXT 或 Markdown 资料');
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'import.md', size: 12, text: async () => '# 资料\n真实内容。' }] });
    await act(async () => input.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true })));
    assert.equal(ui.field('资料名称 1').value, 'import.md');
    await ui.edit('资料正文 1', 'a'.repeat(24001));
    await ui.click(ui.button('生成测试集'));
    assert.equal(calls, 0);
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /24,000|24000/);
  }, async () => { calls++; throw new Error('must not call'); });
});

test('knowledge mode selects existing document identities without uploading text and retains result coverage', async () => {
  let request;
  await mount(async ui => {
    assert.equal(ui.button('知识库文档').getAttribute('aria-pressed'), 'true');
    assert.equal(ui.field('资料正文 1'), null);
    assert.match(ui.container.textContent, /长文档将选取部分分块出题/);
    assert.equal(ui.field('选择文档 不可用.md').disabled, true);
    assert.equal(ui.field('选择文档 未定版本.md').disabled, true);
    assert.equal(ui.field('选择文档 超大文档.md').disabled, true);
    await ui.click(ui.field('选择文档 说明.md'));
    await ui.edit('生成题数', '1');
    await ui.click(ui.button('生成测试集'));
    assert.deepEqual(JSON.parse(request.options.body), { datasetId: 'rag-evaluation', datasetVersion: '1', count: 1, documentAssetIds: ['asset-1'] });
    assert.match(ui.container.textContent, /2 \/ 12 分块/);
    assert.match(ui.container.textContent, /部分内容.*不代表全文/);
    await ui.click(ui.field('选择文档 说明.md'));
    await ui.click(ui.button('粘贴 / 导入文本'));
    assert.match(ui.container.querySelector('[aria-label="出题资料范围"]').textContent, /2 \/ 12 分块/);
    assert.equal(ui.field('问题 1').value, '系统支持哪些检索方式？');
  }, async (url, options) => {
    request = { url, options };
    return response({ success: true, dataset: dataset(), sourceCoverage: [{ documentAssetId: 'asset-1', source: '说明.md',
      documentVersion: 'version-1', totalChunks: 12, selectedChunks: 2, characterCount: 14, sampled: true }] });
  }, async () => response({ success: true, documents: [documentItem(), documentItem('asset-2', { name: '不可用.md', enabled: false }),
    documentItem('asset-3', { name: '未定版本.md', documentVersion: 'unversioned' }),
    documentItem('asset-4', { name: '超大文档.md', chunkCount: 100001 })] }));
});

test('knowledge catalog failure can retry and an empty catalog links to document management', async () => {
  let reads = 0;
  await mount(async ui => {
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /目录暂不可用/);
    assert.equal(ui.button('生成测试集').disabled, true);
    await ui.click(ui.button('刷新文档'));
    assert.match(ui.container.textContent, /暂无已上传文档/);
    assert.equal(ui.container.querySelector('a[href="/documents"]').textContent, '前往文档管理');
  }, undefined, async () => ++reads === 1 ? { ok: false, json: async () => ({ error: { message: '目录暂不可用' } }) }
    : response({ success: true, documents: [] }));
});

test('catalog refresh removes selections that are no longer eligible and blocks stale requests', async () => {
  let reads = 0;
  let calls = 0;
  await mount(async ui => {
    await ui.click(ui.field('选择文档 说明.md'));
    assert.match(ui.container.textContent, /已选 1 \/ 8/);
    await ui.click(ui.button('刷新文档'));
    assert.match(ui.container.textContent, /已移除.*失效/);
    assert.match(ui.container.textContent, /已选 0 \/ 8/);
    assert.equal(ui.field('选择文档 说明.md').disabled, true);
    await ui.click(ui.button('生成测试集'));
    assert.equal(calls, 0);
    assert.match(ui.container.querySelector('[role="alert"]').textContent, /选择.*文档/);
  }, async () => { calls++; return response({ success: true, dataset: dataset() }); }, async () => response({ success: true,
    documents: [documentItem('asset-1', ++reads === 1 ? {} : { enabled: false })] }));
});

test('a slow catalog does not block switching to manual generation', async () => {
  let finish;
  await mount(async ui => {
    assert.equal(ui.button('知识库文档').getAttribute('aria-pressed'), 'true');
    await ui.generate();
    assert.equal(ui.field('问题 1').value, '系统支持哪些检索方式？');
    await act(async () => finish(response({ success: true, documents: [] })));
  }, undefined, () => new Promise(resolve => { finish = resolve; }));
});

test('partial generation preserves fixed target and coverage, stays editable and downloads retained cases', async () => {
  let calls = 0;
  const partial = datasetWithCases(7);
  await mount(async ui => {
    await ui.click(ui.field('选择文档 说明.md'));
    await ui.edit('生成题数', '10');
    await ui.click(ui.button('生成测试集'));
    assert.match(ui.container.querySelector('[aria-label="生成进度"]').textContent, /已保留 7 \/ 10 题.*尚未补齐.*可下载草稿/);
    assert.match(ui.container.textContent, /达到补齐次数上限/);
    await ui.edit('生成题数', '3');
    await ui.click(ui.button('粘贴 / 导入文本'));
    assert.match(ui.container.querySelector('[aria-label="生成进度"]').textContent, /7 \/ 10/);
    assert.match(ui.container.querySelector('[aria-label="出题资料范围"]').textContent, /2 \/ 12/);
    await ui.edit('参考答案 1', '系统支持全文与向量检索。');
    for (const button of [...ui.container.querySelectorAll('button')].filter(button => button.textContent === '标记已审核')) await ui.click(button);
    assert.ok(ui.button('下载部分 JSON 草稿'));
    assert.equal(ui.button('下载审核后 JSON'), undefined);
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = ui.dom.window.HTMLAnchorElement.prototype.click;
    let download;
    URL.createObjectURL = blob => { download = blob; return 'blob:partial'; };
    URL.revokeObjectURL = () => {};
    ui.dom.window.HTMLAnchorElement.prototype.click = function () { assert.equal(this.download, 'rag-eval-dataset.json'); };
    try {
      await ui.click(ui.button('下载部分 JSON 草稿'));
      const exported = JSON.parse(await download.text());
      assert.equal(exported.cases.length, 7);
      assert.equal(exported.cases[0].expectedAnswer.referenceAnswer, '系统支持全文与向量检索。');
      assert.deepEqual(exported.corpus, partial.corpus);
      assert.deepEqual(exported.cases[0].goldEvidence, partial.cases[0].goldEvidence);
      assert.match(ui.container.textContent, /已下载 7 \/ 10 题的部分草稿/);
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; ui.dom.window.HTMLAnchorElement.prototype.click = originalClick; }
    await ui.click(ui.field('删除问题 7'));
    assert.match(ui.container.querySelector('[aria-label="生成进度"]').textContent, /6 \/ 10/);
    assert.doesNotMatch(ui.container.querySelector('[aria-label="生成进度"]').textContent, /已保留 7 题，还差 3 题/);
    assert.match(ui.container.querySelector('[aria-label="生成进度"]').textContent, /已达到本次自动补齐次数上限/);
    await ui.edit('资料正文 1', '系统支持全文检索和向量检索。');
    await ui.click(ui.button('重新生成测试集'));
    assert.match(ui.container.textContent, /模型暂不可用/);
    assert.match(ui.container.querySelector('[aria-label="生成进度"]').textContent, /6 \/ 10/);
    assert.match(ui.container.querySelector('[aria-label="出题资料范围"]').textContent, /2 \/ 12/);
  }, async () => ++calls === 1 ? response({ success: true, dataset: partial, sourceCoverage: [{ documentAssetId: 'asset-1', source: '说明.md',
    documentVersion: 'version-1', totalChunks: 12, selectedChunks: 2, characterCount: 14, sampled: true }],
    generation: { requestedCount: 10, generatedCount: 7, attempts: 5, complete: false, reason: 'attempt_limit', message: '要求 10 题，已保留 7 题，还差 3 题；达到补齐次数上限。' } })
    : { ok: false, json: async () => ({ error: { message: '模型暂不可用' } }) }, async () => response({ success: true, documents: [documentItem()] }));
});

test('complete ten-case result reports fulfilled target and a later deletion cannot masquerade as complete', async () => {
  await mount(async ui => {
    await ui.click(ui.field('选择文档 说明.md'));
    await ui.edit('生成题数', '10');
    await ui.click(ui.button('生成测试集'));
    assert.equal(ui.container.querySelectorAll('textarea[aria-label^="问题 "]').length, 10);
    assert.match(ui.container.querySelector('[aria-label="生成进度"]').textContent, /已生成 10 \/ 10 题/);
    assert.ok(ui.button('下载 JSON 草稿'));
    await ui.edit('生成题数', '2');
    assert.match(ui.container.querySelector('[aria-label="生成进度"]').textContent, /10 \/ 10/);
    await ui.click(ui.field('删除问题 10'));
    assert.match(ui.container.querySelector('[aria-label="生成进度"]').textContent, /9 \/ 10/);
    assert.ok(ui.button('下载部分 JSON 草稿'));
  }, async () => response({ success: true, dataset: datasetWithCases(10),
    generation: { requestedCount: 10, generatedCount: 10, attempts: 5, complete: true } }), async () => response({ success: true, documents: [documentItem()] }));
});
