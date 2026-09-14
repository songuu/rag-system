import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('legacy MiroFish graph-rag entry redirects to the unified knowledge graph console', async () => {
  const route = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
  const sourceFiles = await Promise.all([
    '../ontology/page.tsx',
    '../profile/page.tsx',
    '../simulation/page.tsx',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')));

  assert.match(route, /redirect\('\/knowledge-graph'\)/);
  for (const source of sourceFiles) {
    assert.doesNotMatch(source, /href="\/mirofish\/graph-rag"/);
  }
});
