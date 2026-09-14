import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('durable build route wires actor rate and database queue capacity before enqueue', async () => {
  const source = await readFile(new URL('./route.ts', import.meta.url), 'utf8');
  const permit = source.indexOf('acquireKnowledgeGraphBuildPermit(security)');
  const capacity = source.indexOf('RAG_KG_BUILD_MAX_PENDING_PER_SCOPE');
  const enqueue = source.indexOf('.enqueueDocumentBuild(');

  assert.ok(permit >= 0);
  assert.ok(capacity > permit);
  assert.ok(enqueue > capacity);
  assert.match(source, /\{ maxPendingJobs \}/);
  assert.match(source, /findDocumentSource/);
  assert.match(source, /manual-console/);
});

test('durable build route lists PostgreSQL document sources for the console', async () => {
  const source = await readFile(new URL('./route.ts', import.meta.url), 'utf8');
  assert.match(source, /listDocumentSources/);
  assert.match(source, /projectKnowledgeGraphBuildSourceForHttp/);
});
