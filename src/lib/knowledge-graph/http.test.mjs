import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const {
  acquireKnowledgeGraphBuildPermit,
  acquireKnowledgeGraphQueryPermit,
  boundedInteger,
  knowledgeGraphHttpError,
  knowledgeGraphJsonResponse,
  isKnowledgeGraphConsoleAvailable,
  projectKnowledgeGraphCommunityResultsForHttp,
  projectKnowledgeGraphBuildJobForHttp,
  projectKnowledgeGraphEntityResultsForHttp,
  projectKnowledgeGraphPathResultsForHttp,
  projectClaimSourcesForHttp,
  resetKnowledgeGraphQueryAdmissionForTests,
  resolveActiveGraphVersion,
  withCurrentGraphSource,
  requiredString,
  requiredTrustLevel,
} = await import('./http.ts');
const { KnowledgeGraphError } = await import('./contracts.ts');
const { MiroFishGraphStoreError } = await import('../mirofish/graph-artifact-store.ts');
const { createMiroFishGraphVersion } = await import('./mirofish-adapter.ts');

test('validates bounded graph inputs with client-safe errors', () => {
  assert.equal(requiredString(' entity-a ', 'entityId'), 'entity-a');
  assert.equal(boundedInteger('2', 'maxHops', 1, 1, 2), 2);
  assert.equal(requiredTrustLevel('reviewed'), 'reviewed');
  assert.throws(() => requiredTrustLevel('root'), error => error.code === 'INVALID_TRUSTLEVEL');
  assert.throws(() => boundedInteger(3, 'maxHops', 1, 1, 2), error => error.status === 400);
});

test('maps graph failures without leaking their cause', async () => {
  const response = knowledgeGraphHttpError(new KnowledgeGraphError(
    'KNOWLEDGE_GRAPH_UNAVAILABLE',
    'Neo4j is unavailable.',
    new Error('neo4j://root:secret@internal:7687')
  ), 'request-1');

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'KNOWLEDGE_GRAPH_UNAVAILABLE',
    error: 'Neo4j is unavailable.',
    requestId: 'request-1',
  });
});

test('maps graph store conflicts and shared-control failures to actionable safe responses', async () => {
  const conflict = knowledgeGraphHttpError(new MiroFishGraphStoreError(
    'MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT',
    'internal revision detail'
  ));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    success: false,
    code: 'MIROFISH_GRAPH_ACTIVE_REVISION_CONFLICT',
    error: 'Graph snapshot revision changed. Refresh and retry.',
  });

  const unavailable = knowledgeGraphHttpError(new MiroFishGraphStoreError(
    'MIROFISH_GRAPH_SHARED_STORE_REQUIRED',
    'internal topology detail'
  ));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, 'Shared knowledge graph control is unavailable.');
});

test('bounds graph queries per tenant, corpus, and actor by concurrency and rate', async () => {
  resetKnowledgeGraphQueryAdmissionForTests();
  const security = {
    actorId: 'actor-a', tenantId: 'tenant-a', corpusId: 'corpus-a',
    role: 'viewer', accessMode: 'single-tenant-token', requestId: 'request-a',
    enforceIsolation: true,
  };
  let now = 1_000;
  const options = {
    now: () => now,
    env: {
      RAG_KG_QUERY_MAX_CONCURRENCY: '1',
      RAG_KG_QUERY_RATE_PER_MINUTE: '2',
    },
  };

  const releaseFirst = acquireKnowledgeGraphQueryPermit(security, options);
  assert.throws(
    () => acquireKnowledgeGraphQueryPermit(security, options),
    error => error.code === 'KNOWLEDGE_GRAPH_QUERY_BUSY' && error.status === 429
  );
  releaseFirst();
  const releaseSecond = acquireKnowledgeGraphQueryPermit(security, options);
  releaseSecond();
  assert.throws(
    () => acquireKnowledgeGraphQueryPermit(security, options),
    error => error.code === 'KNOWLEDGE_GRAPH_RATE_LIMITED' && error.retryAfterSeconds === 60
  );

  now += 60_001;
  const releaseAfterWindow = acquireKnowledgeGraphQueryPermit(security, options);
  releaseAfterWindow();
  resetKnowledgeGraphQueryAdmissionForTests();
});

test('rate limits graph build submissions per tenant, corpus, and actor', () => {
  resetKnowledgeGraphQueryAdmissionForTests();
  const security = { actorId: 'builder-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const options = {
    now: () => 10_000,
    env: { RAG_KG_BUILD_RATE_PER_MINUTE: '1' },
  };
  acquireKnowledgeGraphBuildPermit(security, options);
  assert.throws(
    () => acquireKnowledgeGraphBuildPermit(security, options),
    error => error.code === 'KNOWLEDGE_GRAPH_RATE_LIMITED' && error.status === 429
  );
  resetKnowledgeGraphQueryAdmissionForTests();
});

test('maps graph admission failures to a bounded retry response', async () => {
  resetKnowledgeGraphQueryAdmissionForTests();
  const security = {
    actorId: 'actor-b', tenantId: 'tenant-a', corpusId: 'corpus-a',
    role: 'viewer', accessMode: 'single-tenant-token', requestId: 'request-b',
    enforceIsolation: true,
  };
  const options = {
    now: () => 5_000,
    env: { RAG_KG_QUERY_MAX_CONCURRENCY: '1', RAG_KG_QUERY_RATE_PER_MINUTE: '10' },
  };
  const release = acquireKnowledgeGraphQueryPermit(security, options);
  let error;
  try {
    acquireKnowledgeGraphQueryPermit(security, options);
  } catch (cause) {
    error = cause;
  }
  const response = knowledgeGraphHttpError(error, security.requestId);
  release();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.deepEqual(await response.json(), {
    success: false,
    code: 'KNOWLEDGE_GRAPH_QUERY_BUSY',
    error: 'Knowledge graph query concurrency limit reached.',
    requestId: 'request-b',
  });
  resetKnowledgeGraphQueryAdmissionForTests();
});

test('resolves the active graph version from the complete immutable identity', async () => {
  const identity = {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'document-a',
    documentVersion: 'document-v1',
    trustLevel: 'reviewed',
  };
  const context = {
    scope: {
      tenantId: identity.tenantId,
      corpusId: identity.corpusId,
      allowedTrustLevels: ['reviewed'],
      enforceIsolation: true,
    },
    runtime: {
      store: { async getActive() { return { identity, revision: 1 }; } },
    },
  };

  assert.equal(
    await resolveActiveGraphVersion(context),
    createMiroFishGraphVersion(identity)
  );
  assert.notEqual(await resolveActiveGraphVersion(context), identity.documentVersion);
});

test('local file backend keeps its existing snapshot contract without PostgreSQL graph lifecycle', async () => {
  const identity = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc', documentVersion: 'v1', trustLevel: 'reviewed' };
  const context = {
    scope: { tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['reviewed'], enforceIsolation: true },
    runtime: { backend: 'file', store: { async getActive() { return { identity, revision: 1 }; } } },
  };
  assert.equal(await withCurrentGraphSource(context, async version => version), createMiroFishGraphVersion(identity));
});

test('projects claim sources into a bounded response without metadata', () => {
  const content = '图'.repeat(20_000);
  const result = projectClaimSourcesForHttp({
    claim: {
      id: 'claim-a', predicate: 'supports', fact: 'A supports B', factType: 'relation',
      sourceEntityId: 'entity-a', targetEntityId: 'entity-b',
      sourceEntityName: 'A', targetEntityName: 'B', episodes: ['episode-a'],
      passageIds: ['passage-a'], confidence: 0.9, status: 'active',
      attributes: { unsafe: 'x'.repeat(100_000) },
    },
    passages: Array.from({ length: 12 }, (_, index) => ({
      id: `passage-${index}`,
      content,
      index,
      startOffset: 0,
      endOffset: content.length,
      source: 'source.md',
      sectionPath: ['section'],
      documentId: 'document-a',
      documentVersion: 'document-v1',
      trustLevel: 'reviewed',
      metadata: { unsafe: 'x'.repeat(100_000) },
    })),
  });

  assert.equal(result.passages.length, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.contentTruncated, true);
  assert.equal(result.passages.every(passage => passage.contentTruncated), true);
  assert.equal(Buffer.byteLength(result.passages[0].content, 'utf8') <= 16 * 1024, true);
  assert.equal('metadata' in result.passages[0], false);
  assert.equal('attributes' in result.claim, false);
  assert.equal(JSON.stringify(result).includes('unsafe'), false);
});

test('projects one look-ahead claim source into an exact caller limit', () => {
  const result = projectClaimSourcesForHttp({
    claim: {
      id: 'claim-a', predicate: 'supports', fact: 'A supports B', factType: 'relation',
      sourceEntityId: 'entity-a', targetEntityId: 'entity-b',
      sourceEntityName: 'A', targetEntityName: 'B', episodes: [],
      passageIds: [], confidence: 0.9, status: 'active', attributes: {},
    },
    passages: Array.from({ length: 4 }, (_, index) => ({
      id: `passage-${index}`, content: `content-${index}`, index,
      startOffset: 0, endOffset: 9, documentId: 'document-a',
      documentVersion: 'document-v1', trustLevel: 'reviewed', metadata: {},
    })),
  }, { limit: 3 });

  assert.equal(result.passages.length, 3);
  assert.equal(result.truncated, true);
});

test('projects graph query results through bounded allowlists and rejects oversized envelopes', async () => {
  const repeatedIds = Array.from({ length: 200 }, (_, index) => `id-${index}-${'x'.repeat(600)}`);
  const entities = projectKnowledgeGraphEntityResultsForHttp([{
    entity: {
      id: 'entity-a',
      name: 'Acme',
      normalizedName: 'acme',
      labels: repeatedIds,
      summary: '图'.repeat(10_000),
      aliases: repeatedIds,
      passageIds: repeatedIds,
      attributes: { unsafe: 'must-not-cross-http-boundary' },
      createdAt: '2026-09-07T00:00:00.000Z',
    },
    score: 1,
  }]);
  assert.equal(entities.truncated, true);
  assert.equal(entities.data[0].entity.labels.length <= 16, true);
  assert.equal(entities.data[0].entity.aliases.length <= 32, true);
  assert.equal(entities.data[0].entity.passageIds.length <= 64, true);
  assert.equal(Buffer.byteLength(entities.data[0].entity.summary, 'utf8') <= 8 * 1024, true);
  assert.equal('attributes' in entities.data[0].entity, false);

  const communities = projectKnowledgeGraphCommunityResultsForHttp([{
    community: {
      id: 'community-a', name: 'Network', entityIds: repeatedIds,
      claimIds: repeatedIds, summary: 's'.repeat(20_000), keywords: repeatedIds,
      level: 1, parentId: 'parent-a',
    },
    score: 0.5,
  }]);
  assert.equal(communities.truncated, true);
  assert.equal(communities.data[0].community.entityIds.length <= 64, true);
  assert.equal(communities.data[0].community.claimIds.length <= 64, true);
  assert.equal(communities.data[0].community.keywords.length <= 32, true);

  const paths = projectKnowledgeGraphPathResultsForHttp([{
    entityIds: repeatedIds, claimIds: repeatedIds, passageIds: repeatedIds, score: 0.5,
  }]);
  assert.equal(paths.truncated, true);
  assert.equal(paths.data[0].entityIds.length <= 8, true);
  assert.equal(paths.data[0].claimIds.length <= 8, true);
  assert.equal(paths.data[0].passageIds.length <= 64, true);

  const oversized = knowledgeGraphJsonResponse({
    success: true,
    data: 'x'.repeat(2 * 1024 * 1024),
  }, 'request-large');
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {
    success: false,
    code: 'KNOWLEDGE_GRAPH_RESPONSE_TOO_LARGE',
    error: 'Knowledge graph response exceeds the safe response budget.',
    requestId: 'request-large',
  });
});

test('knowledge graph browser console is local-development only', () => {
  assert.equal(isKnowledgeGraphConsoleAvailable({ NODE_ENV: 'development' }), true);
  assert.equal(isKnowledgeGraphConsoleAvailable({ NODE_ENV: 'test' }), true);
  assert.equal(isKnowledgeGraphConsoleAvailable({ NODE_ENV: 'production' }), false);
});

test('projects graph build status without worker leases, metadata, or raw errors', () => {
  const projected = projectKnowledgeGraphBuildJobForHttp({
    id: '5bc631c8-4c86-4b87-af1f-055321563402',
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    status: 'running', progress: 0.5, artifactDigest: null,
    errorCode: 'GRAPH_BUILD_DELIVERY_FAILED',
    errorMessage: 'https://secret-user:secret-pass@internal.example/private',
    metadata: { lastDeliveryError: 'private', secret: 'do-not-leak' },
    attempts: 2,
    leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87',
    leaseExpiresAt: '2026-09-07T00:01:00.000Z',
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:30.000Z',
  });

  assert.deepEqual(projected, {
    id: '5bc631c8-4c86-4b87-af1f-055321563402',
    graphVersion: 'graph-v1', status: 'running', progress: 0.5,
    artifactDigest: null, errorCode: 'GRAPH_BUILD_DELIVERY_FAILED', errorMessage: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:30.000Z',
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes('leaseToken'), false);
  assert.equal(serialized.includes('secret-pass'), false);
  assert.equal(serialized.includes('metadata'), false);
});

test('reports missing source chunks without exposing arbitrary worker errors', () => {
  const job = { id: 'job', graphVersion: 'version', status: 'failed', progress: 0,
    artifactDigest: null, errorCode: 'GRAPH_BUILD_DELIVERY_FAILED',
    errorMessage: 'Local graph build expected 645 chunks, received 0.', createdAt: '', updatedAt: '' };
  assert.match(projectKnowledgeGraphBuildJobForHttp(job).errorMessage, /重新向量化/);
  job.errorMessage = 'https://secret-user:secret-pass@internal.example/private';
  const message = projectKnowledgeGraphBuildJobForHttp(job).errorMessage;
  assert.match(message, /联系管理员/);
  assert.doesNotMatch(message, /secret|internal/);
});

test('reports incompatible graph worker versions without exposing internal error details', () => {
  const job = { id: 'job', graphVersion: 'version', status: 'failed', progress: 0,
    artifactDigest: null, errorCode: 'GRAPH_BUILD_DELIVERY_FAILED',
    errorMessage: 'Local graph build version does not match its document identity.', createdAt: '', updatedAt: '' };
  const message = projectKnowledgeGraphBuildJobForHttp(job).errorMessage;
  assert.match(message, /版本不一致/);
  assert.match(message, /更新并重启/);
  assert.doesNotMatch(message, /Local graph build/);
});

test('reports mismatched embedding index identity safely', () => {
  const job = { id: 'job', graphVersion: 'version', status: 'failed', progress: 0,
    artifactDigest: null, errorCode: 'GRAPH_BUILD_DELIVERY_FAILED',
    errorMessage: '活动嵌入索引身份不匹配，请检查图谱服务的索引身份配置。', createdAt: '', updatedAt: '' };
  assert.match(projectKnowledgeGraphBuildJobForHttp(job).errorMessage, /索引身份配置/);
});

test('reports a model extraction timeout without exposing raw provider errors', () => {
  const job = { id: 'job', graphVersion: 'version', status: 'failed', progress: 0,
    artifactDigest: null, errorCode: 'GRAPH_BUILD_DELIVERY_FAILED',
    errorMessage: '单块提取超时 (45秒)', createdAt: '', updatedAt: '' };
  assert.match(projectKnowledgeGraphBuildJobForHttp(job).errorMessage, /模型.*超时/);
});

test('explains resource and structured-output failures without exposing provider details', () => {
  const job = { id: 'job', graphVersion: 'version', status: 'failed', progress: 0.4,
    artifactDigest: null, errorCode: 'GRAPH_BUILD_DELIVERY_FAILED',
    errorMessage: 'Entity extraction output budget exceeded.', createdAt: '', updatedAt: '' };
  assert.match(projectKnowledgeGraphBuildJobForHttp(job).errorMessage, /资源.*上限/);
  job.errorMessage = 'Entity extraction provider budget exceeded.';
  assert.match(projectKnowledgeGraphBuildJobForHttp(job).errorMessage, /资源.*上限/);
  job.errorMessage = '模型输出已截断，无法完整提取当前文本块。';
  assert.match(projectKnowledgeGraphBuildJobForHttp(job).errorMessage, /截断/);
  job.errorMessage = '模型输出无法解析为完整的实体和关系。';
  assert.match(projectKnowledgeGraphBuildJobForHttp(job).errorMessage, /实体和关系/);
});

test('reports a graph with no extracted entities as a failure', () => {
  const job = { id: 'job', graphVersion: 'version', status: 'failed', progress: 0,
    artifactDigest: null, errorCode: 'GRAPH_BUILD_DELIVERY_FAILED',
    errorMessage: '图谱未提取到实体，请检查模型输出后重试。', createdAt: '', updatedAt: '' };
  assert.match(projectKnowledgeGraphBuildJobForHttp(job).errorMessage, /未提取到实体/);
});
