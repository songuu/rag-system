import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const srcRoot = path.resolve(appRoot, '..');

test('RAG workspace exposes dedicated document management and search pages', () => {
  const managementPage = fs.readFileSync(path.join(here, 'page.tsx'), 'utf8');
  const searchPage = fs.readFileSync(path.join(appRoot, 'document-search', 'page.tsx'), 'utf8');
  const navigation = fs.readFileSync(path.join(srcRoot, 'components', 'KnowledgeWorkspaceNav.tsx'), 'utf8');

  assert.match(managementPage, /DocumentManagementWorkspace/);
  assert.match(searchPage, /DocumentSearchWorkspace/);
  assert.match(navigation, /href:\s*['"]\/documents['"]/);
  assert.match(navigation, /href:\s*['"]\/document-search['"]/);
  assert.match(navigation, /href:\s*['"]\/knowledge-graph['"]/);
});

test('management owns every canonical RAG ingestion surface', () => {
  const workspace = fs.readFileSync(
    path.join(srcRoot, 'components', 'documents', 'DocumentManagementWorkspace.tsx'),
    'utf8'
  );
  assert.match(workspace, /API_ROOT = ['"]\/rag-api['"]/);
  assert.match(workspace, /\$\{API_ROOT\}\/pipeline/);
  assert.match(workspace, /文件上传/);
  assert.match(workspace, /网页地址/);
  assert.match(workspace, /粘贴文本/);
  assert.match(workspace, /\$\{API_ROOT\}\/documents/);
});

test('document search defaults to the dedicated hybrid search API', () => {
  const workspace = fs.readFileSync(
    path.join(srcRoot, 'components', 'documents', 'DocumentSearchWorkspace.tsx'),
    'utf8'
  );
  const home = fs.readFileSync(path.join(appRoot, 'page.tsx'), 'utf8');
  assert.match(workspace, /API_ROOT = ['"]\/rag-api['"]/);
  assert.match(workspace, /\$\{API_ROOT\}\/document-search/);
  assert.match(workspace, /Milvus \+ Elasticsearch/);
  assert.match(home, /href="\/documents"/);
  assert.match(home, /href="\/document-search"/);
});

test('document catalog preserves retrieval trust scope and counts only dual-ready indexes', () => {
  const catalog = fs.readFileSync(
    path.join(srcRoot, 'lib', 'documents', 'document-catalog.ts'),
    'utf8'
  );
  const route = fs.readFileSync(
    path.join(appRoot, 'api', 'documents', 'route.ts'),
    'utf8'
  );

  assert.match(catalog, /input\.scope\.allowedTrustLevels/);
  assert.match(catalog, /= any\(\$3::text\[\]\)/);
  assert.match(route, /document\.elasticsearchStatus === 'ready'/);
  assert.doesNotMatch(route, /document\.elasticsearchStatus === 'disabled'/);
});

test('home navigation keeps labels on one line when document links are present', () => {
  const home = fs.readFileSync(path.join(appRoot, 'page.tsx'), 'utf8');

  assert.match(home, /max-w-\[1440px\]/);
  assert.match(home, /flex shrink-0 items-center gap-6/);
  assert.match(home, /flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap/);
  assert.match(home, /flex shrink-0 items-center gap-2/);
});
