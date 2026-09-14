import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveConfiguredOllamaModel } from '../../lib/ollama-model-name.ts';

const pageSource = await readFile(new URL('./page.tsx', import.meta.url), 'utf8');
const routeSource = await readFile(new URL('../api/agentic-rag/route.ts', import.meta.url), 'utf8');

test('resolves an untagged configured model to its installed latest tag', () => {
  const availableModels = [
    { name: 'glm-4.7-flash:latest' },
    { name: 'llama3.1:latest' },
  ];

  assert.equal(
    resolveConfiguredOllamaModel('llama3.1', availableModels),
    'llama3.1:latest'
  );
});

test('does not confuse an embedding model with a similarly prefixed model', () => {
  const availableModels = [
    { name: 'nomic-embed-text-v2-moe:latest' },
    { name: 'bge-m3:latest' },
    { name: 'nomic-embed-text:latest' },
  ];

  assert.equal(
    resolveConfiguredOllamaModel('nomic-embed-text', availableModels),
    'nomic-embed-text:latest'
  );
});

test('preserves explicit tags and falls back predictably when needed', () => {
  const availableModels = [
    { name: 'llama3.1:8b' },
    { name: 'llama3.1:latest' },
  ];

  assert.equal(
    resolveConfiguredOllamaModel('llama3.1:8b', availableModels),
    'llama3.1:8b'
  );
  assert.equal(
    resolveConfiguredOllamaModel('missing-model', availableModels),
    'llama3.1:8b'
  );
  assert.equal(resolveConfiguredOllamaModel('configured-only', []), 'configured-only');
});

test('model loading callback is stable and aborts obsolete requests', () => {
  assert.match(
    pageSource,
    /const loadAvailableModels = useCallback\(async \(\) => \{[\s\S]*?\n  \}, \[\]\);/
  );
  assert.doesNotMatch(
    pageSource,
    /\}, \[llmModel, embeddingModel, embeddingProvider\]\);/
  );
  assert.match(
    pageSource,
    /queueMicrotask\([\s\S]*?if \(!cancelled\)[\s\S]*?cancelled = true;[\s\S]*?modelLoadControllerRef\.current\?\.abort\(\);/
  );
});

test('retrieved document similarity has an API alias and a finite UI fallback', () => {
  assert.match(routeSource, /similarity: doc\.score/);
  assert.match(
    pageSource,
    /formatSimilarityPercent\(doc\.similarity \?\? doc\.score\)/
  );
  assert.doesNotMatch(pageSource, /doc\.similarity \* 100/);
});

test('a failed generation step propagates failure and detail to the page', () => {
  assert.match(
    routeSource,
    /const generationFailure = result\.workflowSteps\.find/
  );
  assert.match(routeSource, /success: !responseError/);
  assert.match(pageSource, /errorDetail: data\.errorDetail/);
});
