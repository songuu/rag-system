import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const generator = fileURLToPath(new URL('./generate-articles.mjs', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

async function fixture(t, { configured = true, environmentDirectory = false } = {}) {
  const temporaryRoot = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(path.join(temporaryRoot, 'rag-local-articles-')));
  t.after(async () => {
    // Delete only this test's resolved fixture, never a user workspace or link.
    assert.equal(path.dirname(root), temporaryRoot);
    assert.equal(path.basename(root).startsWith('rag-local-articles-'), true);
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'scripts'));
  await copyFile(generator, path.join(root, 'scripts', 'generate-articles.mjs'));
  await writeFile(path.join(root, 'ADAPTIVE_ENTITY_RAG_GUIDE.md'), '# Fixture article\n\nSynthetic local content.\n');
  // A local marker replaces the external connector; no test can contact Notion.
  await writeFile(path.join(root, 'scripts', 'sync-to-notion.mjs'),
    "import fs from 'node:fs'; fs.writeFileSync(new URL('../sync-marker.txt', import.meta.url), 'fixture-only');\n");
  if (environmentDirectory) await mkdir(path.join(root, '.env.local'));
  else if (configured) await writeFile(path.join(root, '.env.local'), 'NOTION_TOKEN=fixture-no-network\nNOTION_PARENT_PAGE_ID=fixture-parent\n');
  const env = { ...process.env };
  delete env.NOTION_TOKEN; delete env.NOTION_PARENT_PAGE_ID;
  return { root, env };
}

function run(f, args = [], env = f.env) {
  return spawnSync(process.execPath, ['scripts/generate-articles.mjs', ...args], {
    cwd: f.root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}

async function verifyArticles(f) {
  const articles = JSON.parse(await readFile(path.join(f.root, 'public', 'articles-data.json'), 'utf8'));
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, 'Fixture article');
  assert.equal(articles[0].content, '# Fixture article\n\nSynthetic local content.\n');
}

test('normal prebuild and build both explicitly select local-only article generation', () => {
  assert.equal(manifest.scripts.prebuild, 'node scripts/generate-articles.mjs --local-only');
  assert.equal(manifest.scripts.build.startsWith('node scripts/generate-articles.mjs --local-only && '), true);
  assert.equal(manifest.scripts['sync:notion'], 'node scripts/sync-to-notion.mjs');
});

test('local-only generates complete articles without syncing configured environment or dotenv credentials', async t => {
  const f = await fixture(t);
  const result = run(f, ['--local-only'], { ...f.env, NOTION_TOKEN: 'fixture-process-token', NOTION_PARENT_PAGE_ID: 'fixture-process-parent' });
  assert.equal(result.status, 0); assert.equal(result.error, undefined);
  await verifyArticles(f);
  await assert.rejects(stat(path.join(f.root, 'sync-marker.txt')), { code: 'ENOENT' });
});

test('local-only does not read dotenv configuration merely to generate articles', async t => {
  const f = await fixture(t, { environmentDirectory: true });
  const result = run(f, ['--local-only']);
  assert.equal(result.status, 0); assert.equal(result.error, undefined);
  await verifyArticles(f);
  await assert.rejects(stat(path.join(f.root, 'sync-marker.txt')), { code: 'ENOENT' });
});

test('direct generation preserves explicitly configured legacy sync using only the isolated local connector', async t => {
  const f = await fixture(t), result = run(f);
  assert.equal(result.status, 0); assert.equal(result.error, undefined);
  await verifyArticles(f);
  assert.equal(await readFile(path.join(f.root, 'sync-marker.txt'), 'utf8'), 'fixture-only');
});

test('unconfigured generation remains local and produces the same complete article data', async t => {
  const f = await fixture(t, { configured: false }), result = run(f);
  assert.equal(result.status, 0); assert.equal(result.error, undefined);
  await verifyArticles(f);
  await assert.rejects(stat(path.join(f.root, 'sync-marker.txt')), { code: 'ENOENT' });
});
