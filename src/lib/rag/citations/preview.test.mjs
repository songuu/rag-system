import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });
const { createMiroFishGraphVersion } = await import('../../knowledge-graph/mirofish-adapter.ts');
const { issueAnswerCitations } = await import('./issuance.ts');
const instant = 1_800_000_000_000;
const env = { RAG_CITATION_KEYS: JSON.stringify({ test: Buffer.alloc(32, 7).toString('base64') }), RAG_CITATION_ACTIVE_KEY_ID: 'test', RAG_CITATION_ISSUER: 'test', RAG_CITATION_ENVIRONMENT: 'test', RAG_CITATION_TTL_SECONDS: '60' };
const security = { actorId: 'actor-a', tenantId: 'tenant-a', corpusId: 'corpus-a', role: 'viewer', accessMode: 'single-tenant-token', requestId: 'request-a', enforceIsolation: true };
const identity = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a', documentVersion: 'version-a', trustLevel: 'external' };
const version = createMiroFishGraphVersion(identity);
const relationEvidence = () => ({ claimId: 'claim-a', sourceEntityId: 'alice', sourceEntityName: 'Alice', predicate: 'manages', targetEntityId: 'project-a', targetEntityName: 'Project A', passageIds: ['passage-a'] });

function fixture(content = 'Alice manages Project A.') {
  const served = content.slice(0, 13);
  const passage = { id: 'passage-a', document_id: identity.documentId, document_version: identity.documentVersion, tenant_id: identity.tenantId, corpus_id: identity.corpusId, trust_level: identity.trustLevel, content, index: 0, start_offset: 0, end_offset: content.length, source: '资料.txt', page: 3 };
  const artifact = { ...identity, schemaVersion: 'mirofish-graph-artifact-v2', graph: { graph_id: 'graph-a', artifact_version: 'mirofish-graph-v2', nodes: [], edges: [{ uuid: 'claim-a', name: 'manages', fact: 'Alice manages Project A.', source_node_name: 'Alice', target_node_name: 'Project A', source_node_uuid: 'alice', target_node_uuid: 'project-a', fact_type: 'relation', episodes: ['passage-a'], attributes: { sourceChunks: ['passage-a'] } }], node_count: 0, edge_count: 1, passages: [passage] } };
  const evidence = { id: 'graph:' + version + ':passage-a', ...identity, laneId: 'graph', content: served, startOffset: 0, endOffset: served.length, metadata: { graphVersion: version, graphPassageId: 'passage-a', graphPaths: [[relationEvidence()]] } };
  const locator = issueAnswerCitations({ answer: 'Answer[1]', graphLaneIds: ['graph'], servedEvidence: [evidence], security, env, now: instant }).items[0].locator;
  const calls = [];
  const dependencies = {
    async readAuthority(source) { calls.push(['authority', source]); return { revision: 'asset-a:staged', chunkCount: 1 }; },
    async readArtifact(source, scope) { calls.push(['artifact', source, scope]); return artifact; },
    async readIndexedSource(source, state, scope) { calls.push(['index', source, state, scope]); return content; },
  };
  return { locator, artifact, passage, calls, dependencies, served };
}

test('re-authorizes exact original graph and source versions, serving only the prompt-visible interval', async () => {
  const { previewCitation } = await import('./preview.ts');
  const f = fixture();
  const result = await previewCitation({ locator: f.locator, security, env, clock: () => instant + 1, dependencies: f.dependencies });
  assert.equal(result.content, f.served); assert.equal(result.page, 3); assert.equal(result.source, '资料.txt');
  assert.deepEqual(result.relations, []);
  assert.deepEqual(f.calls.map(call => call[0]), ['authority', 'artifact', 'index', 'authority', 'artifact']);
  assert.equal(f.calls[1][1].graphVersion, version); assert.equal(f.calls[1][2].enforceIsolation, true);
});

test('denies cross-account, cross-tenant and cross-corpus replay before reading sources', async () => {
  const { previewCitation } = await import('./preview.ts');
  for (const changes of [{ actorId: 'actor-b' }, { tenantId: 'tenant-b' }, { corpusId: 'corpus-b' }]) {
    const f = fixture();
    await assert.rejects(previewCitation({ locator: f.locator, security: { ...security, ...changes }, env, clock: () => instant, dependencies: f.dependencies }), { code: 'RAG_CITATION_INVALID' });
    assert.equal(f.calls.length, 0);
  }
});

test('denies source tombstone, graph disappearance, missing index row, changed trust/version or source content', async () => {
  const { previewCitation } = await import('./preview.ts');
  const scenarios = [
    { async readAuthority() { return null; } },
    { async readArtifact() { return null; } },
    { async readIndexedSource() { throw new Error('deleted source'); } },
    { async readIndexedSource() { return 'changed source'; } },
  ];
  for (const scenario of scenarios) {
    const f = fixture();
    await assert.rejects(previewCitation({ locator: f.locator, security, env, clock: () => instant, dependencies: { ...f.dependencies, ...scenario } }));
  }
  for (const mutate of [f => { f.artifact.documentVersion = 'other'; }, f => { f.artifact.trustLevel = 'quarantined'; }, f => { f.passage.content = 'tampered'; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(previewCitation({ locator: f.locator, security, env, clock: () => instant, dependencies: f.dependencies }), { code: 'RAG_CITATION_SOURCE_UNAVAILABLE' });
  }
});

test('denies authority drift and expiry while source IO is in flight', async () => {
  const { previewCitation } = await import('./preview.ts');
  const f = fixture(); let reads = 0;
  await assert.rejects(previewCitation({ locator: f.locator, security, env, clock: () => instant, dependencies: { ...f.dependencies, async readAuthority() { return { revision: String(reads++), chunkCount: 1 }; } } }), { code: 'RAG_CITATION_SOURCE_UNAVAILABLE' });
  let now = instant;
  await assert.rejects(previewCitation({ locator: f.locator, security, env, clock: () => now, dependencies: { ...f.dependencies, async readIndexedSource() { now += 60_000; return f.passage.content; } } }), { code: 'RAG_CITATION_INVALID' });
});

test('bounds multibyte previews and never exposes unsupported or inactive relations', async () => {
  const { previewCitation } = await import('./preview.ts');
  const content = '汉'.repeat(6000); const f = fixture(content);
  f.artifact.graph.edges[0].invalid_at = '2026-01-01';
  const result = await previewCitation({ locator: f.locator, security, env, clock: () => instant, dependencies: f.dependencies });
  assert.equal(result.content, f.served); assert.deepEqual(result.relations, []);
  const evidence = { id: 'graph:' + version + ':passage-a', ...identity, laneId: 'graph', content, startOffset: 0, endOffset: content.length, metadata: { graphVersion: version, graphPassageId: 'passage-a', graphClaimIds: [] } };
  const locator = issueAnswerCitations({ answer: '[1]', graphLaneIds: ['graph'], servedEvidence: [evidence], security, env, now: instant }).items[0].locator;
  const bounded = await previewCitation({ locator, security, env, clock: () => instant, dependencies: f.dependencies });
  assert.equal(bounded.contentTruncated, true); assert.ok(Buffer.byteLength(bounded.content) <= 16 * 1024); assert.ok(!bounded.content.includes('\ufffd'));
});

test('reuses exact Milvus reconstruction and checks PG current asset and deletion lifecycle', async () => {
  const { createCitationSourceDependencies } = await import('./source-authority.ts');
  const f = fixture(); const calls = [];
  const content = f.passage.content;
  const client = { async query(sql, values) { calls.push({ sql, values }); return { rows: [{ asset_id: 'asset-a', document_version: identity.documentVersion, trust_level: 'external', chunk_count: 1, state: 'staged' }], rowCount: 1 }; } };
  const deps = createCitationSourceDependencies({ client, store: { async get() { return f.artifact; } }, milvus: { async queryDocumentRows(scope, id, count) { assert.equal(scope.enforceIsolation, true); assert.equal(count, 1); return [{ id: 'chunk-a', content, tenant_id: id.tenantId, corpus_id: id.corpusId, document_id: id.documentId, document_version: id.documentVersion, trust_level: id.trustLevel, chunk_index: 0, total_chunks: 1, metadata_json: JSON.stringify({ startOffset: 0, endOffset: content.length, sourceTextLength: content.length, sourceTextHash: 'sha256:' + createHash('sha256').update(content).digest('hex') }) }]; } } });
  const { previewCitation } = await import('./preview.ts');
  assert.equal((await previewCitation({ locator: f.locator, security, env, clock: () => instant, dependencies: deps })).content, f.served);
  assert.ok(calls[0].sql.includes('graph_snapshot_lifecycle')); assert.ok(calls[0].sql.includes('document_assets')); assert.ok(calls[0].sql.includes('source_hash = $4'));
  assert.match(calls[0].sql, /retrieval_enabled.*distinct from 'false'/s);
  assert.match(calls[0].sql, /coalesce\(asset.metadata->>'lifecycle', 'active'\) = 'active'/);
  assert.deepEqual(calls[0].values.slice(0, 4), ['tenant-a', 'corpus-a', 'doc-a', 'version-a']);
  const missing = createCitationSourceDependencies({ client, store: { async get() { return f.artifact; } }, milvus: { async queryDocumentRows() { return []; } } });
  await assert.rejects(previewCitation({ locator: f.locator, security, env, clock: () => instant, dependencies: missing }));
});

test('returns authoritative relations only when the entire supporting passage was actually served', async () => {
  const { previewCitation } = await import('./preview.ts');
  const f = fixture(); const content = f.passage.content;
  const evidence = { id: 'graph:' + version + ':passage-a', ...identity, laneId: 'graph', content, startOffset: 0, endOffset: content.length, metadata: { graphVersion: version, graphPassageId: 'passage-a', graphPaths: [[relationEvidence()]] } };
  const locator = issueAnswerCitations({ answer: '[1]', graphLaneIds: ['graph'], servedEvidence: [evidence], security, env, now: instant }).items[0].locator;
  assert.deepEqual((await previewCitation({ locator, security, env, clock: () => instant, dependencies: f.dependencies })).relations, [{ source: 'Alice', predicate: 'manages', target: 'Project A', fact: 'Alice manages Project A.' }]);
});

test('rechecks the exact file artifact after IO and rejects a concurrent durable tombstone', async () => {
  const { previewCitation } = await import('./preview.ts');
  const f = fixture(); let reads = 0;
  await assert.rejects(previewCitation({ locator: f.locator, security, env, clock: () => instant, dependencies: { ...f.dependencies, async readArtifact() { return ++reads === 1 ? f.artifact : null; } } }), { code: 'RAG_CITATION_SOURCE_UNAVAILABLE' });
  assert.equal(reads, 2);
});

test('local file authority may omit PG graph lifecycle but never current PG asset or document trust/version', async () => {
  const { createCitationSourceDependencies } = await import('./source-authority.ts');
  const f = fixture();
  let row = { asset_id: 'asset-a', document_version: identity.documentVersion, trust_level: 'external', chunk_count: 1, state: 'file-authority' };
  const client = { async query() { return { rows: row ? [row] : [] }; } };
  const args = { client, store: { async get() { return f.artifact; } }, milvus: { async queryDocumentRows() { throw new Error(); } } };
  const source = (await import('./locator-codec.ts')).createCitationLocatorCodec(env).decode(f.locator, instant);
  assert.equal(await createCitationSourceDependencies(args).readAuthority(source), null);
  const deps = createCitationSourceDependencies({ ...args, localFileAuthority: true });
  assert.ok(await deps.readAuthority(source));
  for (const mutation of [{ ...row, state: 'deleted' }, { ...row, trust_level: 'quarantined' }, { ...row, document_version: 'old' }, null]) {
    row = mutation; assert.equal(await deps.readAuthority(source), null);
  }
});

test('actual local build identity, File GraphLane, locator and live source reconstruction form one version-bound chain', async () => {
  const { createLocalGraphBuildHandler } = await import('../../knowledge-graph/local-graph-build-executor.ts');
  const { InMemoryMiroFishGraphArtifactStore } = await import('../../mirofish/graph-artifact-store.ts');
  const { createGraphEntityLaneHandler } = await import('../retrieval/graph-entity-lane.ts');
  const { createCitationSourceDependencies } = await import('./source-authority.ts');
  const { previewCitation } = await import('./preview.ts');
  const first = 'Alice manages Project A.';
  const second = 'Project A depends on Vendor B.';
  const content = first + ' ' + second;
  const documentVersion = 'sha256:' + createHash('sha256').update(content).digest('hex');
  const actualIdentity = { ...identity, documentVersion };
  const graphVersion = createMiroFishGraphVersion(actualIdentity);
  const store = new InMemoryMiroFishGraphArtifactStore();
  const rows = [{ id: 'vector-a', content, tenant_id: identity.tenantId, corpus_id: identity.corpusId, document_id: identity.documentId, document_version: documentVersion, trust_level: identity.trustLevel, chunk_index: 0, total_chunks: 1, metadata_json: JSON.stringify({ startOffset: 0, endOffset: content.length, sourceTextLength: content.length, sourceTextHash: documentVersion }) }];
  const milvus = { async queryDocumentRows() { return rows; } };
  const build = createLocalGraphBuildHandler({ milvus, commandStore: { async getCompatibilityDescriptor() { return null; } }, artifactStore: store, async extractGraph() { return {
    graph_id: identity.documentId, artifact_version: 'mirofish-graph-v2', node_count: 3, edge_count: 2,
    nodes: [
      { uuid: 'alice', name: 'Alice', labels: ['Person'], summary: 'Alice', attributes: { sourceChunks: ['passage-a'] } },
      { uuid: 'project', name: 'Project A', labels: ['Project'], summary: 'Project A', attributes: { sourceChunks: ['passage-a', 'passage-b'] } },
      { uuid: 'vendor', name: 'Vendor B', labels: ['Company'], summary: 'Vendor B', attributes: { sourceChunks: ['passage-b'] } },
    ],
    edges: [
      { uuid: 'claim-a', name: 'manages', fact: first, source_node_uuid: 'alice', source_node_name: 'Alice', target_node_uuid: 'project', target_node_name: 'Project A', fact_type: 'relation', episodes: [], attributes: { sourceChunks: ['passage-a'] } },
      { uuid: 'claim-b', name: 'depends_on', fact: second, source_node_uuid: 'project', source_node_name: 'Project A', target_node_uuid: 'vendor', target_node_name: 'Vendor B', fact_type: 'relation', episodes: [], attributes: { sourceChunks: ['passage-b'] } },
    ],
    passages: [
      { id: 'passage-a', document_id: identity.documentId, content: first, index: 0, start_offset: 0, end_offset: first.length },
      { id: 'passage-b', document_id: identity.documentId, content: second, index: 1, start_offset: first.length + 1, end_offset: content.length },
    ],
  }; } });
  await build({ id: 'job-a', tenantId: identity.tenantId, corpusId: identity.corpusId, graphVersion, metadata: { documentIdentity: actualIdentity, chunkCount: 1 } });
  const scope = { tenantId: identity.tenantId, corpusId: identity.corpusId, allowedTrustLevels: ['external'], enforceIsolation: true };
  const client = { async query(_sql, values) { assert.equal(values[3], documentVersion); return { rows: [{ asset_id: 'asset-a', document_version: documentVersion, trust_level: 'external', chunk_count: 1, state: 'file-authority' }] }; } };
  const dependencies = createCitationSourceDependencies({ client, store, milvus, localFileAuthority: true });
  for (const maxHops of [1, 2]) {
    const lane = { id: 'graph', type: 'graph-entity', required: false, parameters: { documentId: identity.documentId, documentVersion, trustLevel: identity.trustLevel, maxHops } };
    const result = await createGraphEntityLaneHandler({ store }).execute({ request: { retrievalScope: scope }, plan: { query: 'Alice', top_k: 3 }, lane, priorEvidence: [], signal: new AbortController().signal });
    assert.ok(result.evidence.length >= 1); assert.ok(result.evidence.every(item => !('graphClaimIds' in item.metadata)));
    const issued = issueAnswerCitations({ answer: result.evidence.map((_, index) => '[' + (index + 1) + ']').join(''), servedEvidence: result.evidence, graphLaneIds: ['graph'], security, env, now: instant });
    assert.equal(issued.status, 'available'); assert.equal(issued.items.length, result.evidence.length);
    const previews = await Promise.all(issued.items.map(item => previewCitation({ locator: item.locator, security, env, clock: () => instant, dependencies })));
    assert.ok(previews.every(item => item.content === first || item.content === second));
    const predicates = new Set(previews.flatMap(item => item.relations.map(relation => relation.predicate)));
    assert.ok(predicates.has('manages'));
    assert.equal(predicates.has('depends_on'), maxHops === 2);
  }
});

test('cold citation Neo4j adapter never initializes schema or invokes a write', async () => {
  const { createReadOnlyCitationNeo4jStore } = await import('./source-authority.ts');
  let reads = 0; let writes = 0;
  const store = createReadOnlyCitationNeo4jStore({ async executeRead(_operation, work) { reads++; return work({ async run() { return { records: [] }; } }); }, async executeWrite() { writes++; throw new Error('forbidden'); } });
  assert.equal(await store.get(identity, { tenantId: identity.tenantId, corpusId: identity.corpusId, allowedTrustLevels: ['external'], enforceIsolation: true }), null);
  assert.equal(reads, 1); assert.equal(writes, 0);
  const failed = createReadOnlyCitationNeo4jStore({ async executeRead() { throw new Error('schema unavailable'); }, async executeWrite() { writes++; } });
  await assert.rejects(failed.get(identity, { tenantId: identity.tenantId, corpusId: identity.corpusId, allowedTrustLevels: ['external'], enforceIsolation: true }));
  assert.equal(writes, 0);
});
