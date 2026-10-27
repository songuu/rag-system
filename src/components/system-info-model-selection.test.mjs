import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('./SystemInfo.tsx', import.meta.url))],
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  write: false,
});
const componentModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), componentModule, componentModule.exports
);
const SystemInfo = componentModule.exports.default;

test('model selector waits for application, keeps failures open, and displays the successful choice', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = async () => Response.json({
    success: true,
    llmModels: [
      { name: 'llama3.1:latest', displayName: 'llama3.1', category: 'llm' },
      { name: 'glm-4.7-flash:latest', displayName: 'glm-4.7-flash', category: 'llm' },
    ],
    embeddingModels: [
      { name: 'nomic-embed-text:latest', displayName: 'nomic-embed-text', category: 'embedding' },
      { name: 'other-embedding', displayName: 'other-embedding', category: 'embedding' },
    ],
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  let complete;
  let fail;
  const requests = [];
  function Harness() {
    const [llmModel, setLlmModel] = React.useState('llama3.1');
    const [embeddingModel, setEmbeddingModel] = React.useState('nomic-embed-text');
    return React.createElement(SystemInfo, {
      docCount: 42, embeddingDim: 768, systemStatus: '运行中',
      llmModel, embeddingModel, onRefresh() {},
      async onModelChange(llm, embedding, onProgress) {
        requests.push({ llm, embedding });
        if (embedding !== embeddingModel) onProgress?.('正在重新构建向量索引：已处理 8 个文档块，旧索引保留中。');
        await new Promise((resolve, reject) => { complete = resolve; fail = reject; });
        setLlmModel(llm);
        setEmbeddingModel(embedding);
      },
    });
  }
  const button = label => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === label);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => button('切换模型').click());
    assert.equal(button('llama3.1').querySelector('svg') !== null, true);
    assert.equal(button('nomic-embed-text').disabled, false);
    assert.equal(button('other-embedding').disabled, false);
    assert.equal(button('应用更改').disabled, true);
    await act(async () => button('glm-4.7-flash').click());
    await act(async () => button('应用更改').click());
    assert.deepEqual(requests, [{ llm: 'glm-4.7-flash:latest', embedding: 'nomic-embed-text' }]);
    assert.equal(button('正在应用...').disabled, true);
    assert.equal(button('取消').disabled, true);
    assert(document.querySelector('h3').textContent.includes('系统信息'));
    await act(async () => fail(new Error('所选模型未获服务器授权')));
    assert.equal(document.querySelector('[role="alert"]').textContent, '所选模型未获服务器授权');
    assert(button('应用更改'));
    assert(document.querySelector('[title="llama3.1"]'));
    await act(async () => button('应用更改').click());
    await act(async () => complete());
    assert.equal(button('应用更改'), undefined);
    assert(document.querySelector('[title="glm-4.7-flash:latest"]'));
    await act(async () => button('切换模型').click());
    await act(async () => button('other-embedding').click());
    assert.equal(button('应用更改').disabled, false);
    await act(async () => button('应用更改').click());
    assert.equal(requests.at(-1).embedding, 'other-embedding');
    assert.match(document.querySelector('[role="status"]').textContent, /8 个文档块/);
    assert.equal(button('other-embedding').disabled, true);
    await act(async () => complete());
    assert(document.querySelector('[title="other-embedding"]'));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
