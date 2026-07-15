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

const { createRagCacheIdentity, createRagContextDigest } = await import('./cache-identity.ts');

test('RAG cache identity is stable across document-version order', () => {
  const first = createRagCacheIdentity(createInput({
    documentVersions: ['doc-b:v2', 'doc-a:v1', 'doc-b:v2'],
  }));
  const second = createRagCacheIdentity(createInput({
    documentVersions: ['doc-a:v1', 'doc-b:v2'],
  }));
  assert.equal(first.key, second.key);
  assert.deepEqual(first.components.documentVersions, ['doc-a:v1', 'doc-b:v2']);
  assert.match(first.key, /^rag:answer:[a-f0-9]{64}$/);
});

test('every security, retrieval, model, prompt, policy, and fusion dimension changes the key', () => {
  const base = createInput();
  const baseKey = createRagCacheIdentity(base).key;
  const variants = [
    { kind: 'context' },
    { tenantId: 'tenant-b' },
    { corpusId: 'corpus-b' },
    { corpusVersion: 'corpus-v2' },
    { contextDigest: createRagContextDigest('different context') },
    { documentVersions: ['doc:v2'] },
    { schemaVersion: 'schema-v2' },
    { indexVersion: 'index-v2' },
    { llmModel: 'llm-v2' },
    { embeddingModel: 'embed-v2' },
    { promptVersion: 'prompt-v2' },
    { policyId: 'agentic' },
    { fusionVersion: 'rrf-v2' },
  ];
  for (const variant of variants) {
    assert.notEqual(
      createRagCacheIdentity(createInput(variant)).key,
      baseKey,
      JSON.stringify(variant)
    );
  }
});

test('RAG cache identity rejects missing version dimensions', () => {
  assert.throws(
    () => createRagCacheIdentity(createInput({ indexVersion: '' })),
    /indexVersion is required/
  );
});

test('RAG context digest changes for prompt-visible source, score, or content changes', () => {
  const contexts = [
    '[1] (score: 0.9000) (source: a.md)\nalpha',
    '[1] (score: 0.8000) (source: a.md)\nalpha',
    '[1] (score: 0.9000) (source: b.md)\nalpha',
    '[1] (score: 0.9000) (source: a.md)\nbeta',
  ];
  assert.equal(new Set(contexts.map(createRagContextDigest)).size, contexts.length);
});

test('RAG cache identity separates ordered evidence, chunk identity, and spans', () => {
  const fingerprints = [
    {
      evidenceId: 'chunk-a',
      documentId: 'doc-a',
      documentVersion: 'v1',
      startOffset: 0,
      endOffset: 10,
    },
    {
      evidenceId: 'chunk-b',
      documentId: 'doc-b',
      documentVersion: 'v2',
      startOffset: 20,
      endOffset: 30,
    },
  ];
  const baseKey = createRagCacheIdentity(
    createInput({ evidenceFingerprints: fingerprints })
  ).key;
  for (const evidenceFingerprints of [
    [...fingerprints].reverse(),
    [{ ...fingerprints[0], evidenceId: 'chunk-c' }, fingerprints[1]],
    [{ ...fingerprints[0], endOffset: 9 }, fingerprints[1]],
  ]) {
    assert.notEqual(
      createRagCacheIdentity(createInput({ evidenceFingerprints })).key,
      baseKey
    );
  }
});

function createInput(overrides = {}) {
  return {
    kind: 'answer',
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    corpusVersion: 'corpus-v1',
    contextDigest: createRagContextDigest('fixture context'),
    documentVersions: ['doc:v1'],
    schemaVersion: 'schema-v1',
    indexVersion: 'index-v1',
    llmModel: 'llm-v1',
    embeddingModel: 'embed-v1',
    promptVersion: 'prompt-v1',
    policyId: 'milvus-2step',
    fusionVersion: 'dense-v1',
    ...overrides,
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
