import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const {
  applyContextualRetrievalV2ToChunks,
  resolvePipelineDocumentId,
  splitDocument,
} = await import('./document-pipeline.ts');

test('contextual pipeline off mode keeps raw evidence and performs zero provider work', async () => {
  let calls = 0;
  const chunks = fixtureChunks();
  const result = await applyContextualRetrievalV2ToChunks({
    ...fixtureInput(chunks),
    mode: 'off',
    contextualizer: {
      async generateContext() {
        calls += 1;
        return 'unused';
      },
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.mode, 'off');
  assert.ok(chunks.every(chunk => chunk.embeddingContent === chunk.content));
  assert.ok(chunks.every(chunk => chunk.metadata.contextualStatus === 'disabled'));
  assert.ok(chunks.every(chunk => !('contextualPreamble' in chunk.metadata)));
});

test('shadow calls provider but cannot change embedding or prompt-visible source text', async () => {
  const chunks = fixtureChunks();
  const raw = chunks.map(chunk => chunk.content);
  let calls = 0;
  const result = await applyContextualRetrievalV2ToChunks({
    ...fixtureInput(chunks, 'shadow-model'),
    mode: 'shadow',
    contextualizer: {
      async generateContext() {
        calls += 1;
        return 'generated background';
      },
    },
  });

  assert.equal(calls, chunks.length);
  assert.equal(result.mode, 'shadow');
  assert.deepEqual(chunks.map(chunk => chunk.content), raw);
  assert.deepEqual(chunks.map(chunk => chunk.embeddingContent), raw);
  assert.ok(chunks.every(chunk => !JSON.stringify(chunk.metadata).includes('generated background')));
});

test('active changes only embedding text and uses stable scope-bound identities', async () => {
  const first = fixtureChunks();
  const second = fixtureChunks();
  const contextualizer = {
    async generateContext(input) {
      return 'context for ' + input.chunk.text;
    },
  };
  const firstResult = await applyContextualRetrievalV2ToChunks({
    ...fixtureInput(first, 'active-model'),
    mode: 'active',
    contextualizer,
  });
  const secondResult = await applyContextualRetrievalV2ToChunks({
    ...fixtureInput(second, 'active-model'),
    mode: 'active',
    contextualizer,
  });

  assert.deepEqual(
    firstResult.chunks.map(chunk => chunk.identity.key),
    secondResult.chunks.map(chunk => chunk.identity.key)
  );
  assert.ok(first.every(chunk => chunk.embeddingContent.startsWith('context for ')));
  assert.deepEqual(first.map(chunk => chunk.content), ['alpha', ' beta']);
  assert.ok(first.every(chunk => !JSON.stringify(chunk.metadata).includes('context for ')));

  const foreignScope = fixtureChunks('tenant-b');
  const foreign = await applyContextualRetrievalV2ToChunks({
    ...fixtureInput(foreignScope, 'active-model'),
    mode: 'active',
    contextualizer,
  });
  assert.notEqual(
    foreign.chunks[0].identity.key,
    firstResult.chunks[0].identity.key
  );
});

test('empty contextual output is a raw fallback', async () => {
  const chunks = fixtureChunks();
  const result = await applyContextualRetrievalV2ToChunks({
    ...fixtureInput(chunks, 'empty-model'),
    mode: 'active',
    contextualizer: { async generateContext() { return '   '; } },
  });
  assert.equal(result.fallbackCount, chunks.length);
  assert.ok(result.chunks.every(chunk => chunk.errorCode === 'CONTEXTUALIZER_EMPTY'));
  assert.deepEqual(chunks.map(chunk => chunk.embeddingContent), chunks.map(chunk => chunk.content));
});

test('repeated text chunks advance monotonically and remain source aligned', async () => {
  const document = {
    content: 'a'.repeat(400),
    metadata: { source: 'repeat.txt', type: 'raw' },
  };
  const chunks = await splitDocument(document, {
    chunkSize: 100,
    chunkOverlap: 50,
  });
  const starts = chunks.map(chunk => chunk.metadata.startOffset);
  assert.ok(starts.every((start, index) => index === 0 || start > starts[index - 1]));
  for (const chunk of chunks) {
    assert.equal(
      document.content.slice(chunk.metadata.startOffset, chunk.metadata.endOffset),
      chunk.content
    );
  }
});

test('pipeline document IDs are bounded and deterministic', () => {
  assert.equal(resolvePipelineDocumentId('doc-1', 'source'), 'doc-1');
  assert.throws(
    () => resolvePipelineDocumentId('x'.repeat(257), 'source'),
    /safe scalar bounds/
  );
  const longSource = '路径/'.repeat(200);
  const first = resolvePipelineDocumentId(undefined, longSource);
  assert.equal(first, resolvePipelineDocumentId(undefined, longSource));
  assert.match(first, /^source:sha256:[a-f0-9]{64}$/);
  assert.ok(first.length <= 256);
});

function fixtureChunks(tenantId = 'tenant-a') {
  const documentVersion = 'sha256:fixture';
  return [
    {
      id: 'runtime-random-1',
      content: 'alpha',
      metadata: {
        source: 'fixture.txt',
        type: 'raw',
        tenantId,
        corpusId: 'corpus-a',
        documentId: 'doc-a',
        documentVersion,
        startOffset: 0,
        endOffset: 5,
      },
    },
    {
      id: 'runtime-random-2',
      content: ' beta',
      metadata: {
        source: 'fixture.txt',
        type: 'raw',
        tenantId,
        corpusId: 'corpus-a',
        documentId: 'doc-a',
        documentVersion,
        startOffset: 5,
        endOffset: 10,
      },
    },
  ];
}

function fixtureInput(chunks, model = 'fixture-model') {
  return {
    documentText: 'alpha beta',
    sourceHash: 'sha256:fixture',
    documentVersion: 'sha256:fixture',
    model,
    promptVersion: 'prompt-v1',
    chunks,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
