import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveEmbeddingModelSelection } from './embedding-model-selection.ts';

const milvusPageUrl = new URL('./page.tsx', import.meta.url);

test('model loading cannot feed selected-model changes back into the initialization effect', async () => {
  const pageSource = await readFile(milvusPageUrl, 'utf8');

  assert.match(pageSource, /setSelectedEmbeddingModel\(\(currentModel\) =>/);
  assert.doesNotMatch(pageSource, /\}, \[selectedEmbeddingModel\]\);/);
});

test('resolves an untagged configured Ollama model to its installed latest tag', () => {
  const availableModels = [
    { name: 'nomic-embed-text-v2-moe:latest' },
    { name: 'bge-m3:latest' },
    { name: 'nomic-embed-text:latest' },
  ];

  const firstSelection = resolveEmbeddingModelSelection({
    currentModel: 'nomic-embed-text',
    configuredModel: 'nomic-embed-text',
    availableModels,
  });
  const stableSelection = resolveEmbeddingModelSelection({
    currentModel: firstSelection,
    configuredModel: 'nomic-embed-text',
    availableModels,
  });

  assert.equal(firstSelection, 'nomic-embed-text:latest');
  assert.equal(stableSelection, firstSelection);
});

test('preserves an installed current model when the configured model is unavailable', () => {
  const selectedModel = resolveEmbeddingModelSelection({
    currentModel: 'bge-m3:latest',
    configuredModel: 'missing-model',
    availableModels: [
      { name: 'nomic-embed-text-v2-moe:latest' },
      { name: 'bge-m3:latest' },
    ],
  });

  assert.equal(selectedModel, 'bge-m3:latest');
});

test('keeps the configured model visible while Ollama has no installed models', () => {
  const selectedModel = resolveEmbeddingModelSelection({
    currentModel: 'nomic-embed-text',
    configuredModel: 'bge-m3',
    availableModels: [],
  });

  assert.equal(selectedModel, 'bge-m3');
});
