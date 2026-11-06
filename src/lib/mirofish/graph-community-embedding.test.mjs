import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });

const { EntityExtractor, EntityExtractionOutputBudgetError } = await import('../entity-extraction.ts');
const { createMiroFishGraphExtractionConfig } = await import('./graph-builder.ts');
let fixtureId = 0;
function fixture({ count = 3, config = {}, embedDocuments, ordinary = false } = {}) {
  const events = [];
  const entities = new Map(Array.from({ length: count }, (_, index) => [`Actor${index}`, {
    id: `Actor${index}`, name: `Actor${index}`, type: 'PERSON', description: 'A developer',
  }]));
  const id = ++fixtureId;
  const extractor = new EntityExtractor({
    ...(ordinary ? {} : createMiroFishGraphExtractionConfig({ chunkSize: 600, chunkOverlap: 50 })),
    embeddingBatchSize: 2, ...config,
  }, {
    llmInstance: { async invoke(prompt) {
      const actor = [...entities.keys()].sort((a, b) => b.length - a.length).find(name => prompt.includes(name));
      assert.ok(actor);
      events.push(`summary:${actor}`);
      return { content: JSON.stringify({ name: actor, summary: `Summary ${actor}`, keywords: ['development'] }) };
    } },
    embeddingInstance: {
      async embedQuery(text) { events.push(`query:${text}`); return [1, 0]; },
      async embedDocuments(texts) {
        events.push(`batch:${texts.join('|')}`);
        return embedDocuments ? embedDocuments(texts) : texts.map(text => [Number(text.at(-1)) + 1, 0]);
      },
    }, providerKey: `community-batch-llm-${id}`, embeddingProviderKey: `community-batch-embedding-${id}`,
  });
  extractor.startTime = Date.now(); extractor.estimatedTimeout = 5 * 60_000;
  return { extractor, entities, events, build: () => extractor.buildCommunities(entities, new Map()) };
}

test('graph communities finish all LLM summaries before bounded embedding batches and retain vector order', async () => {
  const run = fixture();
  const communities = await run.build();
  assert.deepEqual(run.events, [
    'summary:Actor0', 'summary:Actor1', 'summary:Actor2',
    'batch:Summary Actor0|Summary Actor1', 'batch:Summary Actor2',
  ]);
  assert.deepEqual([...communities.values()].map(community => [community.name, community.embedding]), [
    ['Actor0', [1, 0]], ['Actor1', [2, 0]], ['Actor2', [3, 0]],
  ]);
});

test('ordinary RAG keeps the existing per-community summary/query sequence', async () => {
  const run = fixture({ count: 2, ordinary: true });
  await run.build();
  assert.deepEqual(run.events, ['summary:Actor0', 'query:Summary Actor0', 'summary:Actor1', 'query:Summary Actor1']);
});

test('graph community batching uses bounded groups when no batch size is configured', async () => {
  const sizes = [];
  const run = fixture({ count: 33, config: { embeddingBatchSize: undefined }, embedDocuments: async texts => {
    sizes.push(texts.length); return texts.map(() => [1, 0]);
  } });
  await run.build();
  assert.deepEqual(sizes, [32, 1]);
});

test('a nonfatal failed batch retains the existing fallback only for its affected communities', async t => {
  t.mock.method(console, 'error', () => {});
  let batches = 0;
  const run = fixture({ embedDocuments: async texts => {
    if (++batches === 2) throw new Error('temporary embedding failure');
    return texts.map(() => [1, 0]);
  } });
  const communities = [...(await run.build()).values()];
  assert.equal(communities[0].name, 'Actor0');
  assert.deepEqual(communities[0].embedding, [1, 0]);
  assert.equal(communities[2].name, '社区 3');
  assert.equal(communities[2].summary, '包含 1 个实体的社区');
  assert.deepEqual(communities[2].keywords, []);
  assert.equal(communities[2].embedding, undefined);
});

test('an empty graph does not call either model provider', async () => {
  const run = fixture({ count: 0 });
  assert.equal((await run.build()).size, 0);
  assert.deepEqual(run.events, []);
});

test('graph embedding cold-start budgets permit 300 seconds while rejecting unbounded overrides', () => {
  assert.doesNotThrow(() => fixture({ count: 0, config: { embeddingTimeoutMs: 300_000 } }));
  for (const embeddingTimeoutMs of [0, 999, 300_001, Infinity, NaN]) {
    assert.throws(() => fixture({ count: 0, config: { embeddingTimeoutMs } }), /embedding timeout/);
  }
});

for (const [name, vectors] of [
  ['missing vector', [[1, 0]]],
  ['extra vector', [[1, 0], [1, 0], [1, 0]]],
  ['empty vector', [[1, 0], []]],
  ['nonfinite vector', [[1, 0], [Infinity, 0]]],
  ['dimension mismatch', [[1, 0], [1, 0, 0]]],
]) {
  test(`graph community batches reject ${name}`, async () => {
    const run = fixture({ count: 2, embedDocuments: async () => vectors });
    await assert.rejects(run.build(), EntityExtractionOutputBudgetError);
  });
}

test('graph community batches enforce dimensions across batch boundaries and maximum vector size', async () => {
  let batch = 0;
  const mismatch = fixture({ count: 2, config: { embeddingBatchSize: 1 }, embedDocuments: async () => ++batch === 1 ? [[1, 0]] : [[1, 0, 0]] });
  await assert.rejects(mismatch.build(), EntityExtractionOutputBudgetError);
  const oversized = fixture({ count: 1, config: { maxEmbeddingDimensions: 2 }, embedDocuments: async () => [[1, 0, 0]] });
  await assert.rejects(oversized.build(), EntityExtractionOutputBudgetError);
});

test('community batching retains provider call and cumulative input budgets', async () => {
  const calls = fixture({ count: 3, config: { embeddingBatchSize: 1, maxProviderCalls: 4 } });
  await assert.rejects(calls.build(), error => error.name === 'EntityExtractionProviderBudgetError');
  assert.equal(calls.events.filter(event => event.startsWith('batch:')).length, 1);
  const input = fixture({ count: 1 });
  input.extractor.generateCommunitySummary = async () => ({ name: 'Actor', summary: 'too many characters', keywords: [] });
  input.extractor.config.maxProviderInputCharacters = 1;
  await assert.rejects(input.build(), error => error.name === 'EntityExtractionProviderBudgetError');
  assert.deepEqual(input.events, []);
});

for (const [name, remainingMs, expectedSeconds] of [['configured deadline', 10 * 60_000, 300], ['remaining task budget', 30_000, 30]]) {
  test(`community batching honors the ${name}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const run = fixture({ count: 1, embedDocuments: () => new Promise(resolve => setTimeout(() => resolve([[1, 0]]), 450_000)) });
    run.extractor.estimatedTimeout = remainingMs;
    const pending = run.build();
    const failed = assert.rejects(pending, error => error.code === 'ENTITY_EXTRACTION_PROVIDER_TIMEOUT' && error.message.includes(`${expectedSeconds}秒`));
    void failed.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(450_000);
    await failed;
  });
}
