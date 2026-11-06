import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const workflowUrl = new URL('./self-corrective-rag.ts', import.meta.url).href;
const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === workflowUrl && specifier === './milvus-client') {
      return { shortCircuit: true, url: stub(`
        export function getMilvusInstance() { return globalThis.__scragTestFixture.milvus; }
      `) };
    }
    if (context.parentURL === workflowUrl && specifier === './model-config') {
      return { shortCircuit: true, url: stub(`
        export function selectModelByDimension() { return 'nomic-embed-text'; }
        export function createEmbedding(model) {
          const fixture = globalThis.__scragTestFixture;
          fixture.models.push(model);
          return { async embedQuery() { return fixture.vectors[model] || fixture.vectors.default; } };
        }
        export function createLLM() {
          globalThis.__scragTestFixture.llmCalls++;
          throw new Error('Unexpected LLM call');
        }
      `) };
    }
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { buildSCRAGGraph, executeSCRAG } = await import('./self-corrective-rag.ts');

function setup(t, search) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const fixture = {
    models: [],
    llmCalls: 0,
    searches: [],
    vectors: {
      'qwen3-embedding:latest': Array(4096).fill(0.1),
      'nomic-embed-text': Array(768).fill(0.1),
      default: Array(768).fill(0.1),
    },
  };
  fixture.milvus = {
    async getCollectionStats() { return { embeddingDimension: 4096, name: 'active-index' }; },
    async search(vector, topK) {
      fixture.searches.push({ dimension: vector.length, topK });
      return search(vector);
    },
  };
  globalThis.__scragTestFixture = fixture;
  t.after(() => { delete globalThis.__scragTestFixture; });
  return fixture;
}

test('retrieval uses the model bound to the active index instead of guessing from its dimension', async t => {
  const fixture = setup(t, async () => []);
  const state = await buildSCRAGGraph().invoke({
    originalQuery: '问题', embeddingModel: 'qwen3-embedding:latest', maxRewriteAttempts: 0,
  });

  assert.deepEqual(fixture.models, ['qwen3-embedding:latest']);
  assert.deepEqual(fixture.searches, [{ dimension: 4096, topK: 5 }]);
  assert.equal(state.error, undefined);
  assert.deepEqual(state.nodeExecutions.map(node => node.node), ['retrieve', 'grade', 'generate']);
});

test('a dimension mismatch stops after retrieval and explains how to restore the index binding', async t => {
  const fixture = setup(t, async () => {
    throw new Error('vector dimension mismatch, expected vector size(byte) 16384, actual 3072');
  });
  const state = await buildSCRAGGraph().invoke({ originalQuery: '问题', maxRewriteAttempts: 3 });

  assert.equal(fixture.searches.length, 1);
  assert.equal(fixture.llmCalls, 0);
  assert.deepEqual(state.nodeExecutions.map(node => node.node), ['retrieve']);
  assert.equal(state.currentRewriteCount, 0);
  assert.match(state.error, /维度不匹配/);
  assert.match(state.error, /嵌入模型/);
  assert.match(state.finalAnswer, /检索失败/);
});

test('other retrieval failures also stop without rewriting or reporting no documents', async t => {
  const fixture = setup(t, async () => { throw new Error('Milvus unavailable'); });
  const state = await buildSCRAGGraph().invoke({ originalQuery: '问题', maxRewriteAttempts: 3 });

  assert.equal(fixture.searches.length, 1);
  assert.equal(fixture.llmCalls, 0);
  assert.deepEqual(state.nodeExecutions.map(node => node.node), ['retrieve']);
  assert.match(state.finalAnswer, /Milvus unavailable/);
});

test('zero rewrite attempts prevents LLM retries when no documents match', async t => {
  const fixture = setup(t, async () => []);
  const result = await executeSCRAG({ query: '问题', maxRewriteAttempts: 0 });

  assert.equal(fixture.searches.length, 1);
  assert.equal(fixture.llmCalls, 0);
  assert.equal(result.rewriteCount, 0);
  assert.deepEqual(result.nodeExecutions.map(node => node.node), ['retrieve', 'grade', 'generate']);
});
