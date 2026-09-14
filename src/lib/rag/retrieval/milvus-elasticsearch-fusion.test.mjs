import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { retrieveMilvusElasticsearch } = await import('./milvus-elasticsearch-fusion.ts');

test('active mode starts Milvus and Elasticsearch together and RRF promotes overlap', async () => {
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = retrieveMilvusElasticsearch({
    mode: 'active', topK: 3, laneId: 'dense-primary',
    async retrieveDense() { started.push('dense'); await gate; return [evidence('a', 0.9), evidence('b', 0.8)]; },
    async retrieveLexical() { started.push('lexical'); await gate; return [evidence('b', 12, true), evidence('c', 8, true)]; },
  });
  await Promise.resolve();
  assert.deepEqual(started.sort(), ['dense', 'lexical']);
  release();
  const result = await pending;
  assert.equal(result.evidence[0].id, 'b');
  assert.deepEqual(result.evidence[0].metadata.matchedLanes, ['dense', 'lexical']);
  assert.equal(result.diagnostics.status, 'fused');
});

test('shadow mode observes ES without changing dense evidence', async () => {
  const result = await retrieveMilvusElasticsearch({
    mode: 'shadow', topK: 3, laneId: 'dense-primary',
    async retrieveDense() { return [evidence('dense', 0.8)]; },
    async retrieveLexical() { return [evidence('lexical', 10, true)]; },
  });
  assert.deepEqual(result.evidence.map(item => item.id), ['dense']);
  assert.equal(result.diagnostics.lexicalCandidateCount, 1);
  assert.equal(result.diagnostics.status, 'shadow');
});

test('active mode degrades to Milvus on ES availability errors but not integrity errors', async () => {
  const degraded = await retrieveMilvusElasticsearch({
    mode: 'active', topK: 3, laneId: 'dense-primary',
    async retrieveDense() { return [evidence('dense', 0.8)]; },
    async retrieveLexical() { throw new Error('connection refused'); },
  });
  assert.deepEqual(degraded.evidence.map(item => item.id), ['dense']);
  assert.equal(degraded.diagnostics.status, 'degraded');

  const integrity = Object.assign(new Error('scope mismatch'), {
    code: 'ELASTICSEARCH_INTEGRITY_VIOLATION',
  });
  await assert.rejects(
    retrieveMilvusElasticsearch({
      mode: 'active', topK: 3, laneId: 'dense-primary',
      async retrieveDense() { return [evidence('dense', 0.8)]; },
      async retrieveLexical() { throw integrity; },
    }),
    error => error === integrity
  );
});

function evidence(id, score, lexical = false) {
  return {
    id, tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: `doc-${id}`,
    documentVersion: 'v1', content: id.toUpperCase(), source: `${id}.pdf`,
    retrievalScore: score, trustLevel: 'reviewed', laneId: 'dense-primary',
    metadata: lexical ? { lexicalMatch: true } : {},
  };
}

