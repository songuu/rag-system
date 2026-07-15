import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { cosineSimilarity, createDenseBaselineTarget } = await import('./dense-baseline.ts');

const corpus = [
  { evidenceId: 'alpha', documentId: 'doc-a', source: 'a.md', content: 'alpha text' },
  { evidenceId: 'beta', documentId: 'doc-b', source: 'b.md', content: 'beta text' },
  { evidenceId: 'gamma', documentId: 'doc-c', source: 'c.md', content: 'gamma text' },
];

test('dense baseline ranks exact cosine similarity and forwards evidence to the generator', async () => {
  const generatedFrom = [];
  const target = createDenseBaselineTarget({
    embeddings: createStubEmbeddings(),
    generator: createGenerator(generatedFrom),
    now: incrementingClock(),
  });

  const result = await target.run({ evalCase: createCase('alpha query'), corpus, topK: 2 });

  assert.deepEqual(
    result.evidence.map(evidence => evidence.evidenceId),
    ['alpha', 'gamma']
  );
  assert.deepEqual(generatedFrom, [['alpha', 'gamma']]);
  assert.equal(result.answer, 'alpha,gamma');
  assert.equal(result.usage.embeddingCalls, 2);
  assert.equal(result.usage.totalLatencyMs, 2);
});

test('dense baseline embeds one corpus only once across cases', async () => {
  const embeddings = createStubEmbeddings();
  const target = createDenseBaselineTarget({
    embeddings,
    generator: createGenerator([]),
    now: incrementingClock(),
  });

  const first = await target.run({ evalCase: createCase('alpha query'), corpus, topK: 1 });
  const second = await target.run({ evalCase: createCase('beta query'), corpus, topK: 1 });

  assert.equal(embeddings.documentCalls, 1);
  assert.equal(embeddings.queryCalls, 2);
  assert.equal(first.usage.embeddingCalls, 2);
  assert.equal(second.usage.embeddingCalls, 1);
  assert.equal(second.evidence[0].evidenceId, 'beta');
});

test('dense baseline preserves corpus order for equal scores', async () => {
  const embeddings = {
    async embedDocuments(texts) {
      return texts.map(() => [1, 0]);
    },
    async embedQuery() {
      return [1, 0];
    },
  };
  const target = createDenseBaselineTarget({
    embeddings,
    generator: createGenerator([]),
  });

  const result = await target.run({ evalCase: createCase('tie'), corpus, topK: 3 });
  assert.deepEqual(
    result.evidence.map(evidence => evidence.evidenceId),
    ['alpha', 'beta', 'gamma']
  );
});

test('cosineSimilarity handles zero vectors and rejects dimensional drift', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.throws(() => cosineSimilarity([1], [1, 0]), /embedding dimensions differ/);
});

test('dense baseline rejects a malformed embedding batch with context', async () => {
  const target = createDenseBaselineTarget({
    embeddings: {
      async embedDocuments() {
        return [[1, 0]];
      },
      async embedQuery() {
        return [1, 0];
      },
    },
    generator: createGenerator([]),
  });

  await assert.rejects(
    target.run({ evalCase: createCase('alpha query'), corpus, topK: 1 }),
    /document embeddings count 1 does not match corpus count 3/
  );
});

test('E1b dense baseline filters cross-scope and quarantined corpus before embedding', async () => {
  const embeddedDocuments = [];
  const canonicalCorpus = [
    {
      evidenceId: 'safe',
      documentId: 'doc-safe',
      documentVersion: 'v1',
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      trustLevel: 'reviewed',
      source: 'safe.md',
      content: 'safe fact',
    },
    {
      evidenceId: 'secret',
      documentId: 'doc-secret',
      documentVersion: 'v1',
      tenantId: 'tenant-b',
      corpusId: 'corpus-b',
      trustLevel: 'trusted',
      source: 'secret.md',
      content: 'tenant secret',
    },
    {
      evidenceId: 'poison',
      documentId: 'doc-poison',
      documentVersion: 'v1',
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      trustLevel: 'quarantined',
      source: 'poison.md',
      content: 'poison',
    },
  ];
  const target = createDenseBaselineTarget({
    id: 'fixture-hash-dense-v2',
    policyId: 'fixture-hash-dense-v2',
    laneId: 'dense-vector-required',
    embeddings: {
      async embedDocuments(texts) {
        embeddedDocuments.push(...texts);
        return texts.map(() => [1, 0]);
      },
      async embedQuery() {
        return [1, 0];
      },
    },
    generator: {
      async generate({ evidence }) {
        return {
          answer: evidence.map(item => item.content).join('\n'),
          abstained: evidence.length === 0,
          citations: evidence.map(item => ({
            evidenceId: item.evidenceId,
            startOffset: 0,
            endOffset: item.content.length,
          })),
          tokenMeasurement: 'unavailable',
          costMeasurement: 'unavailable',
        };
      },
    },
  });

  const result = await target.run({
    evalCase: {
      query: 'safe?',
      scope: {
        tenantId: 'tenant-a',
        corpusId: 'corpus-a',
        allowedTrustLevels: ['reviewed'],
      },
    },
    corpus: canonicalCorpus,
    topK: 5,
  });

  assert.deepEqual(embeddedDocuments, ['safe fact']);
  assert.deepEqual(result.evidence.map(item => item.evidenceId), ['safe']);
  assert.equal(result.evidence[0].tenantId, 'tenant-a');
  assert.equal(result.evidence[0].laneId, 'dense-vector-required');
  assert.equal(result.policyId, 'fixture-hash-dense-v2');
  assert.deepEqual(result.citations, [
    { evidenceId: 'safe', startOffset: 0, endOffset: 9 },
  ]);
});

function createStubEmbeddings() {
  const vectors = new Map([
    ['alpha text', [1, 0]],
    ['beta text', [0, 1]],
    ['gamma text', [0.7, 0.7]],
    ['alpha query', [1, 0]],
    ['beta query', [0, 1]],
  ]);
  return {
    documentCalls: 0,
    queryCalls: 0,
    async embedDocuments(texts) {
      this.documentCalls += 1;
      return texts.map(text => vectors.get(text));
    },
    async embedQuery(text) {
      this.queryCalls += 1;
      return vectors.get(text) ?? [0, 0];
    },
  };
}

function createGenerator(capturedEvidence) {
  return {
    async generate({ evidence }) {
      const ids = evidence.map(item => item.evidenceId);
      capturedEvidence.push(ids);
      return {
        answer: ids.join(','),
        abstained: false,
        inputTokens: 8,
        outputTokens: 2,
        tokenMeasurement: 'estimated',
        costMeasurement: 'unavailable',
      };
    },
  };
}

function createCase(query) {
  return {
    id: query,
    query,
    tags: [],
    goldEvidence: [],
    expectedAbstain: false,
  };
}

function incrementingClock() {
  let value = 0;
  return () => value++;
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
