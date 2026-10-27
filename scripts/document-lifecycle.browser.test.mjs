import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('document workspace toggles visibility, confirms deletion and supports failed-cleanup retry', {
  skip: !process.env.DOCUMENT_LIFECYCLE_BROWSER_URL, timeout: 90_000,
}, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const screenshotDir = process.env.DOCUMENT_LIFECYCLE_SCREENSHOT_DIR || path.join(tmpdir(), 'document-lifecycle-browser');
  const row = { id: 'synthetic-ui-asset', documentId: 'synthetic-ui-doc', name: 'synthetic-ui.txt', contentType: 'text/plain', sourceKind: 'text',
    byteSize: 128, chunkCount: 2, documentVersion: 'v1', trustLevel: 'external', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    milvusStatus: 'ready', elasticsearchStatus: 'ready', enabled: true, lifecycle: 'active' };
  let documents = [row];
  let deletions = 0;
  const changes = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Every application API is intercepted: this UI test never mutates real data.
  await page.route('**/rag-api/**', async route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname;
    let body = { success: true };
    let status = 200;
    if (endpoint === '/rag-api/documents') {
      if (request.method() === 'GET') {
        const enabledCount = documents.filter(item => item.enabled && item.lifecycle === 'active').length;
        body = { success: true, documents,
          summary: { documentCount: documents.length, enabledDocumentCount: enabledCount, disabledDocumentCount: documents.length - enabledCount,
            chunkCount: documents.length * 2, searchableChunkCount: enabledCount * 2, disabledChunkCount: (documents.length - enabledCount) * 2,
            byteSize: documents.length * 128, syncedCount: documents.length, elasticsearchMode: 'active' } };
      }
      else if (request.method() === 'PATCH') {
        const mutation = request.postDataJSON(); changes.push(mutation);
        documents = documents.map(item => ({ ...item, enabled: mutation.enabled }));
      } else if (request.method() === 'DELETE') {
        deletions++;
        if (deletions === 1) {
          documents = documents.map(item => ({ ...item, enabled: false, lifecycle: 'deleting' }));
          status = 503;
          body = { success: false, error: { code: 'DOCUMENT_DELETE_INCOMPLETE', message: '文档已停止检索，但清理尚未完成，请重试删除。' } };
        } else documents = [];
      }
    } else if (endpoint === '/rag-api/health') body = { elasticsearch: { mode: 'active', connected: true } };
    else if (endpoint === '/rag-api/milvus') body = { connected: true };
    else if (endpoint === '/rag-api/pipeline') body = { pipeline: { config: { embeddingModel: 'synthetic-embedding' } } };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    const response = await page.goto(process.env.DOCUMENT_LIFECYCLE_BROWSER_URL + '/documents', { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    const searchableMetric = page.getByText('可检索文档块', { exact: true }).locator('..');
    await page.getByRole('button', { name: '禁用 synthetic-ui.txt', exact: true }).waitFor();
    assert.equal(await searchableMetric.locator('strong').innerText(), '2');
    await page.getByRole('button', { name: '禁用 synthetic-ui.txt', exact: true }).click();
    await page.getByText('已禁用 · 不参与检索', { exact: true }).waitFor();
    assert.equal(await searchableMetric.locator('strong').innerText(), '0');
    await page.getByText('已存储 2 · 已停用 2', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '在 synthetic-ui.txt 中搜索' }).count(), 0);
    await page.getByRole('button', { name: '启用 synthetic-ui.txt', exact: true }).click();
    await page.getByRole('link', { name: '在 synthetic-ui.txt 中搜索' }).waitFor();
    assert.equal(await searchableMetric.locator('strong').innerText(), '2');
    assert.deepEqual(changes.map(item => item.enabled), [false, true]);
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'desktop.png'), fullPage: true });
    await page.getByRole('button', { name: '删除 synthetic-ui.txt', exact: true }).click();
    await page.getByRole('dialog', { name: '删除文档', exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(deletions, 0);
    await page.getByRole('button', { name: '删除 synthetic-ui.txt', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除文档', exact: true });
    await dialog.getByText('文档已停止检索，但清理尚未完成，请重试删除。', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(screenshotDir, 'retry.png'), fullPage: true });
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.getByText('还没有进入知识库的文档', { exact: true }).waitFor();
    assert.equal(deletions, 2);
    assert.equal(await dialog.count(), 0);
    documents = [{ ...row }];
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '禁用 synthetic-ui.txt', exact: true }).waitFor();
    await page.getByRole('button', { name: '禁用 synthetic-ui.txt', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({ path: path.join(screenshotDir, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
