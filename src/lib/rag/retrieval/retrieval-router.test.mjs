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
  classifyRetrievalQuery,
  resolveRetrievalRouterCapabilities,
  routeRetrievalQuery,
} = await import('./retrieval-router.ts');

test('router capabilities allow only usable active features to affect generation', () => {
  assert.deepEqual(
    resolveRetrievalRouterCapabilities({
      hybrid: { mode: 'shadow', usable: true },
      orderedContext: { mode: 'active', usable: false },
    }),
    { hybridActive: false, orderedContextActive: false }
  );
  assert.deepEqual(
    resolveRetrievalRouterCapabilities({
      hybrid: { mode: 'active', usable: true },
      orderedContext: { mode: 'active', usable: true },
    }),
    { hybridActive: true, orderedContextActive: true }
  );
});

test('identifier requests use hybrid only when it is active', () => {
  const active = routeRetrievalQuery(input('请查找错误码 ERR-42', true, false));
  assert.equal(active.route, 'hybrid');
  assert.equal(active.queryKind, 'identifier');
  assert.equal(active.reason, 'identifier_prefers_lexical');

  const fallback = routeRetrievalQuery(input('请查找错误码 ERR-42', false, false));
  assert.equal(fallback.route, 'dense');
  assert.equal(fallback.reason, 'identifier_hybrid_unavailable');
});

test('bounded global request uses ordered context with explicit capability', () => {
  const decision = routeRetrievalQuery({
    ...input('请按顺序总结整篇文档', false, true),
    corpus: { documentCount: 2, characterCount: 20_000, complete: true },
  });
  assert.equal(decision.route, 'ordered-context');
  assert.equal(decision.reason, 'bounded_global_prefers_ordered_context');
});

test('ordered context falls back when capability or bounded corpus proof is absent', () => {
  assert.equal(
    routeRetrievalQuery(input('总结整篇文档', false, false)).reason,
    'ordered_context_unavailable'
  );
  assert.equal(
    routeRetrievalQuery(input('总结整篇文档', false, true)).reason,
    'ordered_context_corpus_unbounded'
  );
  const tooLarge = routeRetrievalQuery({
    ...input('总结整篇文档', false, true),
    corpus: { documentCount: 2, characterCount: 200_000, complete: true },
  });
  assert.equal(tooLarge.route, 'dense');
  assert.equal(tooLarge.reason, 'ordered_context_corpus_unbounded');
});

test('multi-hop and ordinary semantic questions keep dense control', () => {
  const multiHop = routeRetrievalQuery(input('比较方案 A 与方案 B 的影响', true, true));
  assert.equal(multiHop.queryKind, 'multi-hop');
  assert.equal(multiHop.route, 'dense');
  assert.equal(routeRetrievalQuery(input('向量数据库有什么用途', true, true)).reason, 'semantic_dense_default');
});

test('classification is pure and identifier signal has priority', () => {
  const first = classifyRetrievalQuery('全文中错误码 ERR-42 在哪里？');
  const second = classifyRetrievalQuery('全文中错误码 ERR-42 在哪里？');
  assert.deepEqual(first, second);
  assert.equal(first.queryKind, 'identifier');
});

function input(query, hybridActive, orderedContextActive) {
  return {
    query,
    capabilities: { hybridActive, orderedContextActive },
  };
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
