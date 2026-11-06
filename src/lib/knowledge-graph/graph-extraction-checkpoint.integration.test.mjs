import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { PostgresKnowledgeGraphBuildJobStore } = await import('./postgres-graph-build-store.ts');
const { createRetrievalScope } = await import('../security/retrieval-scope.ts');

const url = process.env.TEST_DATABASE_URL || process.env.POSTGRES_URL;
if (process.env.RAG_GRAPH_CHECKPOINT_LOCAL_TEST !== '1' || !url) {
  throw new Error('Explicit isolated graph checkpoint PostgreSQL test configuration is required.');
}
const target = new URL(url);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.port !== '5432') {
  throw new Error('Graph checkpoint integration tests require the local PostgreSQL port.');
}

test('checkpoint writes are transactional, idempotent, scoped and fenced by an unexpired lease', async () => {
  const client = new pg.Client({ connectionString: url, ssl: false, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
  const suffix = randomUUID().replaceAll('-', '');
  const tenantId = `graph-checkpoint-${suffix}`, corpusId = `corpus-${suffix}`;
  const jobId = randomUUID(), leaseToken = randomUUID(), graphVersion = `test-${suffix}`;
  const identity = { documentId: 'document', documentVersion: 'v1', trustLevel: 'external' };
  let began = false;
  try {
    await client.connect();
    await client.query('begin'); began = true;
    await client.query("set local statement_timeout = '10s'");
    await client.query('insert into public.tenants (id, name) values ($1, $2)', [tenantId, 'isolated graph checkpoint']);
    await client.query('insert into public.corpora (id, tenant_id, name, source_kind) values ($1,$2,$3,$4)',
      [corpusId, tenantId, 'isolated graph checkpoint', 'isolated-test']);
    await client.query(`insert into public.graph_build_jobs (id,tenant_id,corpus_id,graph_version,status,lease_token,lease_expires_at,metadata)
      values ($1,$2,$3,$4,'running',$5,clock_timestamp() + interval '2 minutes',$6::jsonb)`,
    [jobId, tenantId, corpusId, graphVersion, leaseToken, JSON.stringify({ retained: 'yes', documentIdentity: { tenantId, corpusId, ...identity } })]);
    const query = { async query(text, values) { const result = await client.query(text, values); return { rows: result.rows, rowCount: result.rowCount }; },
      async withTransaction(_operation, work) { return work(query); } };
    const store = new PostgresKnowledgeGraphBuildJobStore(query);
    const scope = createRetrievalScope({ tenantId, corpusId, allowedTrustLevels: ['external'], enforceIsolation: true });
    const base = { jobId, tenantId, corpusId, graphVersion, leaseToken, profile: 'profile-v1', leaseMs: 60_000 };
    const first = { ...base, segmentKey: '0:0:10', record: { sourceDigest: `sha256:${'a'.repeat(64)}`, value: { kind: 'split' } }, progress: 0.2 };
    await store.saveExtractionCheckpoint(first);
    await store.saveExtractionCheckpoint(first);
    const second = { ...base, segmentKey: '0:0:5', record: { sourceDigest: `sha256:${'b'.repeat(64)}`,
      value: { kind: 'complete', result: { entities: [], relations: [] } } }, progress: 0.1 };
    await store.saveExtractionCheckpoint(second);
    const saved = await client.query('select progress,metadata from public.graph_build_jobs where id=$1', [jobId]);
    assert.equal(saved.rows[0].progress, 0.2);
    assert.equal(saved.rows[0].metadata.retained, 'yes');
    assert.deepEqual(saved.rows[0].metadata.graphExtractionCheckpoint.segments[second.segmentKey], second.record);
    await assert.rejects(store.saveExtractionCheckpoint({ ...first, record: { ...first.record, sourceDigest: `sha256:${'c'.repeat(64)}` } }), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await assert.rejects(store.saveExtractionCheckpoint({ ...second, segmentKey: '0:5:10', tenantId: 'wrong' }), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await assert.rejects(store.saveExtractionCheckpoint({ ...second, segmentKey: '0:5:10', leaseToken: randomUUID() }), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await client.query("update public.graph_build_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id=$1", [jobId]);
    await assert.rejects(store.renewExtractionLease(base), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await assert.rejects(store.saveExtractionCheckpoint({ ...second, segmentKey: '0:5:10' }), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await assert.rejects(store.transition({ jobId, leaseToken, expectedStatus: 'running', status: 'queued', progress: 0 }), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await client.query("update public.graph_build_jobs set lease_expires_at = clock_timestamp() + interval '1 minute' where id=$1", [jobId]);
    const failed = await store.transition({ jobId, leaseToken, expectedStatus: 'running', status: 'failed', progress: 0,
      errorCode: 'TEST', errorMessage: 'isolated test failure' });
    assert.equal(failed.progress, 0.2);
    assert.equal((await store.findLatestDocumentBuild(scope, identity)).id, jobId);
    await assert.rejects(store.resumeFailedDocumentBuild(scope, { ...identity, documentVersion: 'other' }, jobId), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    const queued = await store.resumeFailedDocumentBuild(scope, identity, jobId);
    assert.equal(queued.progress, 0.2);
    assert.deepEqual(queued.metadata.graphExtractionCheckpoint.segments[second.segmentKey], second.record);
    await client.query("update public.graph_build_jobs set status='running', lease_token=$2, lease_expires_at=clock_timestamp() + interval '1 minute' where id=$1", [jobId, leaseToken]);
    const artifactDigest = `sha256:${'d'.repeat(64)}`;
    const completed = await store.completeValidated({ jobId, leaseToken, progress: 1, artifactDigest,
      publicationManifest: { schemaVersion: 'kg-build-publication-manifest/v1', tenantId, corpusId, graphVersion, artifactDigest,
        documents: [{ documentId: 'document', documentVersion: 'v1', trustLevel: 'external' }] } });
    assert.equal(completed.metadata.graphExtractionCheckpoint, undefined);
    assert.equal(completed.metadata.publicationManifest.artifactDigest, artifactDigest);
  } finally {
    if (began) await client.query('rollback');
    await client.end();
  }
});
