import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('every home counter shares visibility-aware counts and refreshes on return without a storage fallback', {
  skip: !process.env.DOCUMENT_LIFECYCLE_BROWSER_URL, timeout: 90_000,
}, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  let searchable = 760;
  let unavailable = false;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // API fixtures keep the test independent of model readiness and real documents.
  await page.route('**/rag-api/**', async route => {
    const endpoint = new URL(route.request().url()).pathname;
    let body = { success: true };
    let status = 200;
    const config = { llm: { provider: 'ollama', model: 'fixture-llm' }, embedding: { provider: 'ollama', model: 'fixture-embedding', dimension: 4096 } };
    if (endpoint === '/rag-api/documents') {
      status = unavailable ? 503 : 200;
      body = unavailable ? { success: false } : { success: true, documents: [], summary: {
        documentCount: 7, chunkCount: 1405, searchableChunkCount: searchable, disabledChunkCount: 1405 - searchable,
      } };
    } else if (endpoint === '/rag-api/health') body = { success: true, modelConfig: config, ragSystem: { documentCount: 1405 }, vectorBackend: { disabled: false } };
    else if (endpoint === '/rag-api/milvus') body = { success: true, connected: true, stats: { rowCount: 1405, embeddingDimension: 4096 } };
    else if (endpoint === '/rag-api/model-config') body = { success: true, config };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const label = count => `可检索 ${count.toLocaleString('zh-CN')} 块 · 已存储 1,405 块 · 已停用 ${(1405 - count).toLocaleString('zh-CN')} 块`;
  const returnToHome = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const assertCounters = async count => {
    await page.getByText(label(count), { exact: true }).nth(1).waitFor();
    assert.equal(await page.getByText(label(count), { exact: true }).count(), 2, 'query panel and corpus card must agree');
    const system = page.getByRole('heading', { name: '系统信息', exact: true }).locator('../..');
    assert.equal(await system.getByText(count.toLocaleString('zh-CN'), { exact: true }).count(), 1, 'system info must use the same searchable count');
  };
  try {
    assert.equal((await page.goto(process.env.DOCUMENT_LIFECYCLE_BROWSER_URL, { waitUntil: 'domcontentloaded' })).status(), 200);
    await assertCounters(760);
    await page.getByRole('button', { name: /Milvus 查询可视化/ }).click();
    await page.getByText('Milvus 实时查询', { exact: true }).waitFor();
    await assertCounters(760);
    const screenshots = process.env.DOCUMENT_LIFECYCLE_SCREENSHOT_DIR || path.join(tmpdir(), 'document-lifecycle-browser');
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: path.join(screenshots, 'home-counts.png'), fullPage: true });
    searchable = 0;
    await returnToHome();
    await assertCounters(0);
    await page.getByText('当前没有启用的文档块。可在文档管理中启用已有文档，或上传新文档。', { exact: true }).waitFor();
    unavailable = true;
    await returnToHome();
    await page.getByText('文档块统计暂不可用', { exact: true }).nth(1).waitFor();
    assert.equal(await page.getByText('可检索 1,405 块', { exact: false }).count(), 0);
    await page.getByText('统计暂不可用', { exact: true }).waitFor();
    unavailable = false;
    searchable = 760;
    await returnToHome();
    await assertCounters(760);
    searchable = 42;
    await page.getByRole('button', { name: '刷新知识库状态', exact: true }).click();
    await assertCounters(42);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
