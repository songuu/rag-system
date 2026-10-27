import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';
import neo4j from 'neo4j-driver';
import { DataType, MilvusClient } from '@zilliz/milvus2-sdk-node';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
const { canonicalJson, canonicalJsonSha256: hash } = await import('../rag/eval/canonical-json.ts');
const { createReferenceAuthorityClock } = await import('../rag/eval/production-authority-ports.ts');
const { createBuildPublicationManifest } = await import('./build-publication-manifest.ts');
const { PostgresKnowledgeGraphBuildJobStore } = await import('./postgres-graph-build-store.ts');
const { PostgresKnowledgeGraphPublicationStore } = await import('./postgres-publication-store.ts');
const { MilvusKnowledgeGraphPublicationReadback } = await import('./milvus-publication-readback.ts');
const { createNativePublicationSources } = await import('./native-publication-sources.ts');
const { createReferencePublicationReadback, publicationChunkManifestHash, PublicationIdentityError } = await import('./publication-identity.ts');

// The parent supplies credentials only through child environment variables,
// from the already-verified project containers. No .env, argv or discovery.
const databaseUrl = process.env.TEST_DATABASE_URL;
let postgresTarget; let postgresDatabase;
try { postgresTarget = new URL(databaseUrl); postgresDatabase = decodeURIComponent(postgresTarget.pathname.slice(1)); }
catch { throw new Error('Explicit isolated local PostgreSQL URL is required.'); }
if (process.env.RAG_NATIVE_PUBLICATION_LOCAL_TEST !== '1' || process.env.RAG_PUBLICATION_LOCAL_TEST !== '1'
  || !process.env.TEST_PUBLICATION_EXPECTED_DATABASE || postgresTarget.protocol !== 'postgresql:'
  || postgresTarget.hostname !== '127.0.0.1' || postgresTarget.port !== '5432'
  || postgresDatabase !== process.env.TEST_PUBLICATION_EXPECTED_DATABASE
  || postgresTarget.search || postgresTarget.hash) throw new Error('Native composition only targets the verified project-local PostgreSQL database.');
if (process.env.RAG_NEO4J_PUBLICATION_LOCAL_TEST !== '1' || process.env.TEST_NEO4J_URI !== 'bolt://127.0.0.1:7687'
  || process.env.TEST_NEO4J_USERNAME !== 'neo4j' || !process.env.TEST_NEO4J_PASSWORD) throw new Error('Explicit verified local Neo4j configuration is required.');
if (process.env.RAG_MILVUS_PUBLICATION_LOCAL_TEST !== '1' || process.env.TEST_MILVUS_ADDRESS !== '127.0.0.1:19530') {
  throw new Error('Explicit verified local Milvus configuration is required.');
}
const OBSERVED_AT = '2026-10-10T06:01:00.000Z';
const WINDOW = { startsAt: '2026-10-10T06:00:00.000Z', endsAt: '2026-10-10T06:05:00.000Z' };
const ROW_FIELDS = ['id', 'content', 'tenant_id', 'corpus_id', 'document_id', 'document_version', 'trust_level', 'chunk_index', 'total_chunks'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const reference = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const success = result => assert.equal((result.status ?? result).error_code, 'Success');
const pgQuery = client => ({ async query(text, values) { const result = await client.query(text, values); return { rows: result.rows, rowCount: result.rowCount }; } });
function scalarRow(row) { return Object.fromEntries(ROW_FIELDS.map(field => [field, row[field]])); }
function storedRow(id, document, index, scope, extra = {}) {
  return { id, content: `合成片段 ${id} / UTF-8 😀`, embedding: [1, 0, 0, 0], source: 'isolated-native-composition', metadata_json: '{}', created_at: 1,
    tenant_id: scope.tenantId, corpus_id: scope.corpusId, document_id: document.documentId, document_version: document.documentVersion,
    trust_level: document.trustLevel, chunk_index: index, total_chunks: 2, ...extra };
}

async function seedPostgres(client, scope, graphVersion, suffix) {
  const query = pgQuery(client); const jobId = randomUUID(); const leaseToken = randomUUID();
  const manifest = createBuildPublicationManifest({ tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion,
    artifactDigest: `sha256:${hash('isolated-native-composition-artifact')}`,
    documents: [{ documentId: '课程甲/文档', documentVersion: '版本/一', trustLevel: 'trusted' },
      { documentId: 'doc/a', documentVersion: 'v1', trustLevel: 'reviewed' }] });
  await client.query('insert into public.tenants (id, name) values ($1, $2)', [scope.tenantId, 'isolated native publication fixture']);
  await client.query('insert into public.corpora (id, tenant_id, name, source_kind) values ($1, $2, $3, $4)',
    [scope.corpusId, scope.tenantId, 'isolated native publication fixture', 'isolated-test']);
  await client.query(`insert into public.graph_build_jobs (id, tenant_id, corpus_id, graph_version, status, progress, lease_token, lease_expires_at)
    values ($1::uuid, $2, $3, $4, 'running', 0, $5::uuid, now() + interval '3 minutes')`, [jobId, scope.tenantId, scope.corpusId, graphVersion, leaseToken]);
  const build = new PostgresKnowledgeGraphBuildJobStore(query);
  const validated = await build.completeValidated({ jobId, progress: 1, artifactDigest: manifest.artifactDigest, leaseToken, publicationManifest: manifest });
  assert.deepEqual(validated.metadata.publicationManifest, manifest);
  const publication = new PostgresKnowledgeGraphPublicationStore(query);
  await publication.registerStagedSnapshot({ tenantId: scope.tenantId, corpusId: scope.corpusId, allowedTrustLevels: ['reviewed', 'trusted'], enforceIsolation: true }, graphVersion);
  const lease = await publication.acquireSnapshotLease(scope, graphVersion, 'activate');
  const pointer = await publication.compareAndSetActiveWithLease(scope, graphVersion, 0, lease);
  assert.equal(pointer.revision, 1);
  const events = await publication.listPendingEvents(scope); assert.equal(events.length, 1);
  // Only this uncommitted event receives a synthetic acknowledgement. The
  // fixed reference clock proves ordering in this fixture, not wall-clock time.
  const acknowledgement = await client.query(`update public.graph_publication_outbox
    set created_at = '2026-10-10T05:00:00Z', published_at = '2026-10-10T06:00:00.000Z'
    where id = $1::uuid and tenant_id = $2 and corpus_id = $3`, [events[0].id, scope.tenantId, scope.corpusId]);
  assert.equal(acknowledgement.rowCount, 1); assert.match(suffix, /^[a-f0-9]{32}$/);
  return { manifest, pointer };
}
async function seedNeo4j(tx, scope, graphVersion, manifest, revision) {
  const before = await tx.run('MATCH (node {tenantId: $tenantId}) RETURN count(node) AS remaining', { tenantId: scope.tenantId });
  assert.equal(before.records[0].get('remaining').toNumber(), 0);
  await tx.run(`CREATE (pointer:GraphPointer {tenantId: $tenantId, corpusId: $corpusId, activeGraphVersion: $graphVersion, revision: $revision})
    CREATE (snapshot:GraphSnapshot {tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      status: 'active', artifactDigest: $digest, documentCount: $documentCount})
    WITH snapshot UNWIND $documents AS identity
    CREATE (document:DocumentVersion {tenantId: $tenantId, corpusId: $corpusId, graphVersion: $graphVersion,
      documentId: identity.documentId, documentVersion: identity.documentVersion, trustLevel: identity.trustLevel, status: 'staging'})
    CREATE (snapshot)-[:CONTAINS]->(document)`, { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion,
    revision: neo4j.int(revision), digest: manifest.artifactDigest, documentCount: neo4j.int(manifest.documents.length), documents: manifest.documents });
}
async function seedMilvus(client, collection, rows, scope) {
  success(await client.createCollection({ collection_name: collection, enable_dynamic_field: false, fields: [
    { name: 'id', data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 256 },
    { name: 'content', data_type: DataType.VarChar, max_length: 65535 }, { name: 'embedding', data_type: DataType.FloatVector, dim: 4 },
    { name: 'source', data_type: DataType.VarChar, max_length: 1024 }, { name: 'metadata_json', data_type: DataType.VarChar, max_length: 65535 },
    { name: 'created_at', data_type: DataType.Int64 }, ...['tenant_id', 'corpus_id'].map(name => ({ name, data_type: DataType.VarChar, max_length: 128 })),
    ...['document_id', 'document_version'].map(name => ({ name, data_type: DataType.VarChar, max_length: 256 })),
    { name: 'trust_level', data_type: DataType.VarChar, max_length: 32 }, ...['chunk_index', 'total_chunks'].map(name => ({ name, data_type: DataType.Int64 })),
  ] }));
  success(await client.insert({ collection_name: collection, data: [...rows,
    { ...rows[0], id: 'foreign-tenant', tenant_id: `${scope.tenantId}-other` }, { ...rows[0], id: 'foreign-corpus', corpus_id: `${scope.corpusId}-other` }] }));
  success(await client.createIndex({ collection_name: collection, field_name: 'embedding', index_name: 'native_publication_vector_index', index_type: 'FLAT', metric_type: 'COSINE' }));
  success(await client.loadCollectionSync({ collection_name: collection }));
}
async function postgresRemaining(client, scope) {
  const result = await client.query(`select
    (select count(*)::integer from public.tenants where id = $1) as tenants,
    (select count(*)::integer from public.corpora where tenant_id = $1 and id = $2) as corpora,
    (select count(*)::integer from public.graph_build_jobs where tenant_id = $1 and corpus_id = $2) as jobs,
    (select count(*)::integer from public.graph_active_snapshots where tenant_id = $1 and corpus_id = $2) as pointers,
    (select count(*)::integer from public.graph_snapshot_lifecycle where tenant_id = $1 and corpus_id = $2) as lifecycle,
    (select count(*)::integer from public.graph_publication_outbox where tenant_id = $1 and corpus_id = $2) as outbox`, [scope.tenantId, scope.corpusId]);
  assert.deepEqual(result.rows, [{ tenants: 0, corpora: 0, jobs: 0, pointers: 0, lifecycle: 0, outbox: 0 }]); return result.rows[0];
}

// PG and Neo use their real public SDKs inside independently uncommitted
// transactions. Neo executeRead below shares the actual awaited transaction:
// a test seam, not managed-driver authenticity, independent IAM or atomicity.
async function isolated(work) {
  const suffix = randomUUID().replaceAll('-', ''); const scope = { environment: 'isolated-local', tenantId: `nativepub-${suffix}`, corpusId: `nativecorpus-${suffix}` };
  const graphVersion = `nativegraph-${suffix}`; const collection = `rag_native_publication_test_${suffix}`;
  const postgres = new pg.Client({ connectionString: databaseUrl, ssl: false, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const driver = neo4j.driver(process.env.TEST_NEO4J_URI, neo4j.auth.basic(process.env.TEST_NEO4J_USERNAME, process.env.TEST_NEO4J_PASSWORD),
    { connectionTimeout: 5000, maxTransactionRetryTime: 0 });
  const session = driver.session({ database: 'neo4j' }); const milvus = new MilvusClient({ address: '127.0.0.1:19530', timeout: 10000 });
  let began = false; let tx; let ownedCollection = false; const cleanup = {};
  try {
    await postgres.connect(); const version = await postgres.query("select current_setting('server_version_num')::integer as version");
    assert.ok(version.rows[0].version >= 170000 && version.rows[0].version < 180000); await postgresRemaining(postgres, scope);
    await postgres.query('begin'); began = true; await postgres.query("set local statement_timeout = '5s'");
    const { manifest, pointer } = await seedPostgres(postgres, scope, graphVersion, suffix);
    const existing = await milvus.hasCollection({ collection_name: collection }); success(existing); assert.equal(existing.value, false);
    ownedCollection = true;
    const rows = manifest.documents.flatMap((document, position) => [storedRow(position ? '中/片段' : "片段'一", document, 0, scope),
      storedRow(position ? '零号😀' : '😀片段', document, 1, scope)]);
    await seedMilvus(milvus, collection, rows, scope);
    // Start only after Milvus setup so collection creation cannot spend the
    // existing five-second Neo transaction budget. Await the public API;
    // never fabricate a run shim or import private driver prototypes.
    tx = await session.beginTransaction({ timeout: 5000 }); await seedNeo4j(tx, scope, graphVersion, manifest, pointer.revision);
    let phase = 'warm'; const io = [];
    const milvusClient = {
      async describeCollection(request) { io.push({ phase, store: 'milvus', kind: 'schema' }); return milvus.describeCollection(request); },
      async describeIndex(request) { io.push({ phase, store: 'milvus', kind: 'index' }); return milvus.describeIndex(request); },
      async query(request) {
        const entry = { phase, store: 'milvus', kind: request.output_fields[0] === 'count(*)' ? 'count' : 'scalar', filter: request.filter,
          fields: [...request.output_fields], seen: [...(request.exprValues.seenIds ?? [])] };
        assert.equal(request.exprValues.tenantId, scope.tenantId); assert.equal(request.exprValues.corpusId, scope.corpusId);
        const result = await milvus.query(request); entry.rows = result.data.length; io.push(entry); return result;
      },
    };
    const clients = { postgres: { async query(text, values) { io.push({ phase, store: 'postgres', kind: 'barrier' });
      assert.deepEqual(values, [scope.tenantId, scope.corpusId]); return pgQuery(postgres).query(text, values); } },
      neo4j: { async executeRead(_operation, callback) { io.push({ phase, store: 'neo4j', kind: 'barrier' }); return callback(tx); } }, milvus: milvusClient };
    const native = { operationTimeoutMs: 10000, maxReads: 32, milvus: { pageSize: 2, maxRows: 65536,
      maxTotalRowBytes: 64 * 1024 * 1024, maxQueryParameterBytes: 64 * 1024 * 1024 } };
    const binding = { ...scope, runNonce: suffix, manifestHash: hash({ purpose: 'isolated-native-composition', suffix }) };
    const sourceOptions = { executionProfile: 'local-reference', binding, readerId: 'native-publication-reader', readerAuthorizationDigest: hash('local-fixture-role'),
      selector: { scope, graphVersion, collection }, sourceIdentityRefs: { postgres: reference(`pg-${suffix}`), neo4j: reference(`neo-${suffix}`), milvus: reference(`mil-${suffix}`) },
      validFrom: WINDOW.startsAt, validUntil: WINDOW.endsAt, maxReads: 64, pageSize: 2, native };
    const fixture = { scope, graphVersion, collection, manifest, pointer, rows, milvus, milvusClient, clients, native, binding, sourceOptions, io,
      setPhase(value) { phase = value; } };
    return { result: await work(fixture), cleanup };
  } finally {
    try {
      try {
        if (ownedCollection) {
          assert.match(collection, /^rag_native_publication_test_[a-f0-9]{32}$/);
          const existing = await milvus.hasCollection({ collection_name: collection }); success(existing);
          if (existing.value) success(await milvus.dropCollection({ collection_name: collection }));
          const removed = await milvus.hasCollection({ collection_name: collection }); success(removed); assert.equal(removed.value, false); cleanup.milvusOwnedCollectionAbsent = true;
        }
      } finally { await milvus.closeConnection(); }
    } finally {
      try {
        try {
          if (tx) { await tx.rollback(); const result = await session.run('MATCH (node {tenantId: $tenantId}) RETURN count(node) AS remaining', { tenantId: scope.tenantId });
            cleanup.neo4jRemaining = result.records[0].get('remaining').toNumber(); assert.equal(cleanup.neo4jRemaining, 0); }
        } finally { try { await session.close(); } finally { await driver.close(); } }
      } finally { try { if (began) { await postgres.query('rollback'); cleanup.postgresRemaining = await postgresRemaining(postgres, scope); } } finally { await postgres.end(); } }
    }
  }
}

async function warmIdentity(fixture) {
  fixture.setPhase('warm');
  const warm = await new MilvusKnowledgeGraphPublicationReadback(fixture.milvusClient, { executionProfile: 'local-reference', scope: fixture.scope,
    collection: fixture.collection, operationTimeoutMs: fixture.native.operationTimeoutMs, maxReads: 1, ...fixture.native.milvus }).readPublication({});
  assert.deepEqual(warm.rows.map(row => [...Object.keys(row)].sort()), Array.from({ length: 4 }, () => [...ROW_FIELDS].sort()));
  assert.deepEqual([...warm.rows].sort((a, b) => compare(a.id, b.id)), fixture.rows.map(scalarRow).sort((a, b) => compare(a.id, b.id)));
  assert.equal(warm.schemaManifest.schema.fields.length, 13); assert.equal(warm.indexManifest.indexes.length, 1);
  assert.equal(warm.indexManifest.indexes[0].field_name, 'embedding'); assert.equal(warm.indexManifest.indexes[0].state, 'Finished');
  assert.deepEqual(fixture.io.filter(entry => entry.phase === 'warm' && entry.kind === 'scalar').map(entry => entry.rows), [2, 2, 0]);
  return { schemaVersion: 'kg-publication-identity/v1', scope: fixture.scope,
    graph: { graphVersion: fixture.graphVersion, artifactDigest: fixture.manifest.artifactDigest, pointerRevision: fixture.pointer.revision },
    documents: fixture.manifest.documents.map(document => { const rows = warm.rows.filter(row => row.document_id === document.documentId && row.document_version === document.documentVersion);
      return { ...document, expectedChunkCount: rows.length, contentManifestHash: publicationChunkManifestHash(rows) }; }),
    milvus: { collection: fixture.collection, schemaManifestHash: hash(warm.schemaManifest), indexManifestHash: hash(warm.indexManifest) } };
}
function composedReader(fixture, identity, phase) {
  fixture.setPhase(phase); const nativeSources = createNativePublicationSources(fixture.sourceOptions, fixture.clients);
  const readbacks = []; const clockReadings = []; const clockRequests = [];
  const sources = { executionProfile: nativeSources.executionProfile, productionCapable: nativeSources.productionCapable };
  for (const [method, source] of [['readPostgres', 'postgres'], ['readNeo4j', 'neo4j'], ['readMilvusPage', 'milvus']]) {
    sources[method] = async request => { const reply = await nativeSources[method](request); readbacks.push({ source, request, reply }); return reply; };
  }
  const clockRef = reference(`clock-${fixture.binding.runNonce}`);
  const authorityClock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope: fixture.scope, allowedActorIds: [fixture.sourceOptions.readerId],
    sourceIdentityRef: clockRef, initialObservedAt: OBSERVED_AT, uncertaintyMs: 0, maxReadings: 64, maxAdvanceMs: 86400000 });
  const clock = { executionProfile: authorityClock.executionProfile, productionCapable: authorityClock.productionCapable,
    async readTime(request) { const reading = await authorityClock.readTime(request); clockRequests.push(request); clockReadings.push(reading); return reading; } };
  const reader = createReferencePublicationReadback({ executionProfile: 'local-reference', binding: fixture.binding, expectedIdentity: identity,
    expectedIdentityRef: { ...reference(`identity-${fixture.binding.runNonce}`), sha256: hash(identity) },
    readerId: fixture.sourceOptions.readerId, readerAuthorizationDigest: fixture.sourceOptions.readerAuthorizationDigest,
    sourceIdentityRefs: fixture.sourceOptions.sourceIdentityRefs, clockIdentityRef: clockRef, maxClockUncertaintyMs: 0,
    observationWindow: WINDOW, operationTimeoutMs: 30000, maxVerifications: 1, maxPages: 1024, maxRows: 65536 }, { sources, clock });
  return { reader, nativeSources, readbacks, clockReadings, clockRequests };
}

test('three actual native stores compose through the factory and whole reader with two full scans and four fresh barriers', { timeout: 30000 }, async () => {
  const { result, cleanup } = await isolated(async fixture => {
    // An independent full warm scan obtains actual SDK schema/index identity.
    // It is explicitly not either of the reader's two required full scans.
    const identity = await warmIdentity(fixture); const observed = composedReader(fixture, identity, 'required');
    const decision = await observed.reader.readPublication({}); const io = fixture.io.filter(entry => entry.phase === 'required');
    assert.deepEqual(io.filter(entry => entry.kind === 'barrier').map(entry => entry.store), ['postgres', 'neo4j', 'neo4j', 'postgres']);
    assert.deepEqual(io.filter(entry => entry.kind === 'scalar').map(entry => entry.rows), [2, 2, 0, 2, 2, 0]);
    assert.equal(io.filter(entry => entry.kind === 'scalar' && entry.seen.length === 0).length, 2);
    for (const entry of io.filter(entry => entry.store === 'milvus')) {
      if (entry.kind === 'scalar') { assert.deepEqual(entry.fields, ROW_FIELDS); assert.match(entry.filter, /^tenant_id == \{tenantId\} && corpus_id == \{corpusId\}/);
        assert.doesNotMatch(entry.filter, /document_version|document_id|trust_level|版本|课程/); }
    }
    for (const kind of ['schema', 'index', 'count']) assert.equal(io.filter(entry => entry.kind === kind).length, 4);
    assert.deepEqual(observed.readbacks.map(entry => entry.source), ['postgres', 'neo4j', 'milvus', 'milvus', 'milvus', 'milvus', 'neo4j', 'postgres']);
    for (const { source, request, reply } of observed.readbacks) {
      assert.equal(reply.proof.source, source); assert.equal(reply.proof.assurance, 'local-reference'); assert.equal(reply.proof.productionSourceAuthenticated, false);
      // Protocol identity is exact canonical data, not its storage prototype:
      // validated references can legitimately be null-prototype records.
      assert.equal(canonicalJson(reply.proof.sourceIdentityRef), canonicalJson(fixture.sourceOptions.sourceIdentityRefs[source]));
      assert.equal(canonicalJson(reply.proof.context), canonicalJson(request.context));
      assert.equal(canonicalJson(reply.proof.selector), canonicalJson(request.selector)); assert.equal(reply.proof.requestNonce, request.requestNonce); assert.equal(reply.proof.cursor, request.cursor);
      assert.equal(reply.proof.dataHash, hash(reply.data)); assert.ok(Object.isFrozen(reply.proof));
    }
    const pages = observed.readbacks.filter(entry => entry.source === 'milvus');
    assert.deepEqual(pages.map(entry => entry.reply.data.completion), ['more', 'complete', 'more', 'complete']);
    for (const start of [0, 2]) { assert.equal(pages[start].request.cursor, null); assert.equal(pages[start + 1].request.cursor, pages[start].reply.data.nextCursor);
      assert.equal(pages[start + 1].reply.data.nextCursor, null); }
    assert.notEqual(pages[0].reply.data.nextCursor, pages[2].reply.data.nextCursor);
    assert.equal(decision.rowCount, 4); assert.equal(decision.identityHash, hash(identity));
    assert.equal(decision.rowsManifestHash, hash(identity.documents.map(document => ({ documentId: document.documentId, documentVersion: document.documentVersion,
      trustLevel: document.trustLevel, chunkCount: document.expectedChunkCount, contentManifestHash: document.contentManifestHash }))));
    assert.deepEqual(decision.readbacks, observed.readbacks.map(({ source, reply }) => ({ source, proofHash: hash(reply.proof) })));
    assert.equal(observed.clockReadings.length, decision.readbacks.length + 1); assert.deepEqual(observed.clockReadings.map(reading => reading.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(observed.clockReadings.every(reading => reading.assurance === 'local-reference' && reading.productionTimeAuthenticated === false));
    assert.equal(new Set([...observed.clockRequests.map(request => request.requestNonce), ...observed.readbacks.map(entry => entry.request.requestNonce)]).size, 17);
    assert.equal(decision.completionClockHash, hash(observed.clockReadings.at(-1))); assert.equal(decision.observedAt, OBSERVED_AT); assert.equal(decision.uncertaintyMs, 0);
    const { observationHash, ...body } = decision; assert.equal(observationHash, hash(body)); assert.ok(Object.isFrozen(decision.readbacks));
    assert.equal(decision.validationLevel, 'local-reference-three-store-readback'); assert.equal(decision.consistencyVerified, true);
    assert.equal(decision.productionAuthorized, false); assert.equal(decision.sourceAuthenticated, false); assert.equal(decision.linearizableSnapshotProven, false);
    assert.equal(decision.stageAcceptanceComplete, false); assert.equal(observed.nativeSources.productionCapable, false); assert.equal(observed.reader.productionCapable, false);
    return { rowCount: decision.rowCount, requiredScans: 2, warmScans: 1, freshBarriers: 4, readbacks: decision.readbacks.length, completionClockHash: decision.completionClockHash };
  });
  console.log(JSON.stringify({ capability: 'local-three-native-composition', ...result, cleanup, productionAuthorized: false, linearizableSnapshotProven: false }));
});

test('actual same-scope Milvus version superset rejects the unified identity instead of being filtered or authorized', { timeout: 30000 }, async () => {
  const { cleanup } = await isolated(async fixture => {
    const identity = await warmIdentity(fixture);
    success(await fixture.milvus.insert({ collection_name: fixture.collection,
      data: [storedRow('unexpected/版本', fixture.manifest.documents[0], 0, fixture.scope, { document_version: '版本/二', trust_level: 'external', total_chunks: 1 })] }));
    const observed = composedReader(fixture, identity, 'negative');
    await assert.rejects(observed.reader.readPublication({}), error => error instanceof PublicationIdentityError && error.code === 'identity-mismatch'
      && error.phase === 'milvus' && error.productionAuthorized === false && error.automaticRetryAllowed === false);
    const io = fixture.io.filter(entry => entry.phase === 'negative');
    assert.deepEqual(io.filter(entry => entry.kind === 'scalar').map(entry => entry.rows), [2, 2, 1, 0]);
    assert.equal(io.filter(entry => entry.kind === 'scalar' && entry.seen.length === 0).length, 1);
    assert.ok(observed.readbacks.some(entry => entry.source === 'milvus' && entry.reply.data.rows.some(row => row.document_version === '版本/二' && row.trust_level === 'external')));
    assert.deepEqual(io.filter(entry => entry.kind === 'barrier').map(entry => entry.store), ['postgres', 'neo4j']);
  });
  console.log(JSON.stringify({ capability: 'local-three-native-version-superset-refusal', cleanup, productionAuthorized: false }));
});
