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

const { rerankDocuments } = await import('./rerank.ts');

test('rerankDocuments maps provider scores back to original documents', async () => {
  const provider = {
    name: 'unit',
    model: 'unit-reranker',
    async rerank(_query, docs) {
      return [
        { ...docs[1], relevanceScore: 0.91, originalIndex: 1 },
        { ...docs[0], relevanceScore: 0.71, originalIndex: 0 },
      ];
    },
  };

  const result = await rerankDocuments('alpha', [
    { id: 'a', content: 'first', source: 'one' },
    { id: 'b', content: 'second', source: 'two' },
  ], { provider, topK: 2 });

  assert.deepEqual(result.map((doc) => doc.id), ['b', 'a']);
  assert.equal(result[0].rerankScore, 0.91);
  assert.equal(result[0].source, 'two');
});

test('rerankDocuments falls back to original order when provider fails', async () => {
  const errors = [];
  const provider = {
    name: 'unit',
    model: 'unit-reranker',
    async rerank() {
      throw new Error('provider down');
    },
  };

  const result = await rerankDocuments('alpha', [
    { id: 'a', content: 'first' },
    { id: 'b', content: 'second' },
  ], {
    provider,
    topK: 1,
    onError: (error) => errors.push(error.message),
  });

  assert.deepEqual(result.map((doc) => doc.id), ['a']);
  assert.deepEqual(errors, ['provider down']);
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

test('rerankDocuments forwards cancellation and never falls back after abort', async () => {
  const controller = new AbortController(); const errors = [];
  const provider = { name: 'unit', model: 'unit', async rerank(_query, docs, _topK, options) { assert.equal(options.signal, controller.signal); controller.abort(new Error('private disconnect reason')); return [{ ...docs[0], originalIndex: 0, relevanceScore: 1 }]; } };
  await assert.rejects(rerankDocuments('query', [{ id: 'a', content: 'content' }], { provider, signal: controller.signal, onError: error => errors.push(error) }), error => error.code === 'RAG_REQUEST_ABORTED');
  assert.deepEqual(errors, []);
});
test('rerankDocuments propagates explicit abort errors from a provider', async () => {
  await assert.rejects(rerankDocuments('query', [{ id: 'a', content: 'content' }], { provider: { name: 'unit', model: 'unit', rerank: async () => { throw new DOMException('Aborted', 'AbortError'); } } }), error => error.name === 'AbortError');
});
