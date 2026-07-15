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

const { SemanticCache } = await import('./semantic-cache.ts');
const { createRagCacheIdentity } = await import('./rag/core/cache-identity.ts');

// Mock embeddings: returns deterministic small vectors per query token count
class StubEmbeddings {
  constructor() {
    this.callCount = 0;
  }
  async embedQuery(text) {
    this.callCount++;
    // 简单确定性 embedding：基于字符 code 做散列
    const v = new Array(8).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[i % 8] += text.charCodeAt(i);
    }
    return v;
  }
  async embedDocuments(texts) {
    return Promise.all(texts.map(t => this.embedQuery(t)));
  }
}

test('SemanticCache hits when query embedding above threshold', async () => {
  const emb = new StubEmbeddings();
  const cache = new SemanticCache(emb, { similarityThreshold: 0.99, maxSize: 10 });

  await cache.set('hello world', 'answer A');

  const result = await cache.get('hello world');
  assert.equal(result.hit, true, 'should hit identical query');
  if (result.hit) {
    assert.equal(result.entry.answer, 'answer A');
  }

  const stats = cache.getStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 0);
  assert.ok(stats.lastScanEntries >= 1);
});

test('SemanticCache misses when below threshold', async () => {
  const emb = new StubEmbeddings();
  const cache = new SemanticCache(emb, { similarityThreshold: 0.99, maxSize: 10 });

  await cache.set('foo bar baz', 'answer F');
  const result = await cache.get('completely different query content');
  assert.equal(result.hit, false);

  const stats = cache.getStats();
  assert.equal(stats.misses, 1);
});

test('SemanticCache stores normalizedEmbedding for O(N·D) dot-product hot path', async () => {
  const emb = new StubEmbeddings();
  const cache = new SemanticCache(emb, { maxSize: 5 });
  await cache.set('test query', 'ans');

  const internalCache = cache['cache'];
  const entries = Array.from(internalCache.values());
  assert.equal(entries.length, 1);
  assert.ok(entries[0].normalizedEmbedding, 'normalizedEmbedding should be set');
  assert.equal(entries[0].normalizedEmbedding.length, entries[0].queryEmbedding.length);

  // L2 norm of normalizedEmbedding should be ~1.0
  let sumSq = 0;
  for (const v of entries[0].normalizedEmbedding) sumSq += v * v;
  assert.ok(Math.abs(Math.sqrt(sumSq) - 1) < 1e-9, `||normalized|| should be 1, got ${Math.sqrt(sumSq)}`);
});

test('SemanticCache.clear resets stats', async () => {
  const emb = new StubEmbeddings();
  const cache = new SemanticCache(emb, { maxSize: 5 });
  await cache.set('q', 'a');
  await cache.get('q');
  cache.clear();
  const stats = cache.getStats();
  assert.equal(stats.size, 0);
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 0);
});

test('SemanticCache LRU eviction respects maxSize', async () => {
  const emb = new StubEmbeddings();
  const cache = new SemanticCache(emb, { maxSize: 2 });
  await cache.set('a', '1');
  await cache.set('b', '2');
  await cache.set('c', '3'); // 应 evict 'a'
  const stats = cache.getStats();
  assert.equal(stats.size, 2);
});

test('SemanticCache never reuses an answer across cache identities', async () => {
  const emb = new StubEmbeddings();
  const cache = new SemanticCache(emb, { similarityThreshold: 0.99, maxSize: 10 });
  const tenantA = createIdentity({ tenantId: 'tenant-a' });
  const tenantB = createIdentity({ tenantId: 'tenant-b' });

  await cache.set('same query', 'tenant A answer', '', undefined, tenantA);
  assert.equal((await cache.get('same query', undefined, tenantB)).hit, false);
  const hit = await cache.get('same query', undefined, tenantA);
  assert.equal(hit.hit, true);
  if (hit.hit) assert.equal(hit.entry.answer, 'tenant A answer');
});

test('SemanticCache requires a versioned identity in authenticated modes', async () => {
  const previousMode = process.env.RAG_ACCESS_MODE;
  process.env.RAG_ACCESS_MODE = 'supabase';
  try {
    const cache = new SemanticCache(new StubEmbeddings());
    await assert.rejects(
      () => cache.set('query', 'answer'),
      /versioned cache identity/
    );
    await assert.rejects(
      () => cache.get('query'),
      /versioned cache identity/
    );
  } finally {
    if (previousMode === undefined) delete process.env.RAG_ACCESS_MODE;
    else process.env.RAG_ACCESS_MODE = previousMode;
  }
});

test('SemanticCache rejects a forged key paired with different identity components', async () => {
  const cache = new SemanticCache(new StubEmbeddings());
  const tenantA = createIdentity({ tenantId: 'tenant-a' });
  const tenantB = createIdentity({ tenantId: 'tenant-b' });
  const forged = {
    ...tenantB,
    key: tenantA.key,
  };
  await cache.set('same query', 'tenant A answer', '', undefined, tenantA);
  await assert.rejects(
    () => cache.get('same query', undefined, forged),
    /key does not match its components/
  );
});

function createIdentity(overrides = {}) {
  return createRagCacheIdentity({
    kind: 'answer',
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    corpusVersion: 'v1',
    contextDigest: 'sha256:' + 'a'.repeat(64),
    documentVersions: ['doc:v1'],
    schemaVersion: 'schema-v1',
    indexVersion: 'index-v1',
    llmModel: 'llm-v1',
    embeddingModel: 'embed-v1',
    promptVersion: 'prompt-v1',
    policyId: 'agentic',
    fusionVersion: 'dense-v1',
    ...overrides,
  });
}

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
