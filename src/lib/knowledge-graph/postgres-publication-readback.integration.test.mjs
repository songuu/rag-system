import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
const { createBuildPublicationManifest } = await import('./build-publication-manifest.ts');
const { PostgresKnowledgeGraphBuildJobStore } = await import('./postgres-graph-build-store.ts');
const { PostgresKnowledgeGraphPublicationStore } = await import('./postgres-publication-store.ts');
const { PostgresKnowledgeGraphPublicationReadback } = await import('./postgres-publication-readback.ts');

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || process.env.RAG_PUBLICATION_LOCAL_TEST !== '1') throw new Error('Explicit isolated local PostgreSQL test configuration is required.');
const target = new URL(databaseUrl);
if (target.hostname !== '127.0.0.1' || target.port !== '5432') throw new Error('Publication integration tests only target the verified local RAG PostgreSQL port.');

async function isolated(work) {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const suffix = randomUUID().replaceAll('-', ''); const scope = { tenantId: `pubtest-${suffix}`, corpusId: `pubcorpus-${suffix}` };
  let began = false;
  try {
    await client.connect(); const version = await client.query('select current_setting(\'server_version_num\')::integer as version');
    assert.ok(version.rows[0].version >= 170000 && version.rows[0].version < 180000);
    await client.query('begin'); began = true; await client.query("set local statement_timeout = '5s'");
    await client.query('insert into public.tenants (id, name) values ($1, $2)', [scope.tenantId, 'publication test fixture']);
    await client.query('insert into public.corpora (id, tenant_id, name, source_kind) values ($1, $2, $3, $4)',
      [scope.corpusId, scope.tenantId, 'publication test fixture', 'isolated-test']);
    const query = { async query(text, values) { const r = await client.query(text, values); return { rows: r.rows, rowCount: r.rowCount }; } };
    await work({ client, query, scope, suffix });
  } finally {
    try {
      if (began) { await client.query('rollback'); const r = await client.query('select count(*)::integer as count from public.tenants where id = $1', [scope.tenantId]); assert.equal(r.rows[0].count, 0); }
    } finally { await client.end(); }
  }
}
async function seedRunning({ client, scope, suffix }, expiration = '3 minutes') {
  const id = randomUUID(), lease = randomUUID(), graphVersion = `pubgraph-${suffix}`;
  await client.query(`insert into public.graph_build_jobs (id, tenant_id, corpus_id, graph_version, status, progress, lease_token, lease_expires_at)
    values ($1::uuid, $2, $3, $4, 'running', 0, $5::uuid, now() + $6::interval)`,
  [id, scope.tenantId, scope.corpusId, graphVersion, lease, expiration]);
  const manifest = createBuildPublicationManifest({ ...scope, graphVersion, artifactDigest: `sha256:${'a'.repeat(64)}`,
    documents: [{ documentId: '课程甲', documentVersion: '版本/一', trustLevel: 'trusted' }, { documentId: 'doc/a', documentVersion: 'v1', trustLevel: 'reviewed' }] });
  return { id, lease, graphVersion, manifest };
}

test('native PG publication joins persisted complete documents and conservatively preserves acknowledgement precision', async () => isolated(async fixture => {
  const { client, query, scope } = fixture; const { id, lease, graphVersion, manifest } = await seedRunning(fixture);
  const build = new PostgresKnowledgeGraphBuildJobStore(query);
  await assert.rejects(build.completeValidated({ jobId: id, progress: 1, artifactDigest: manifest.artifactDigest, leaseToken: lease,
    publicationManifest: { ...manifest, tenantId: 'wrong-tenant' } }), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
  const validated = await build.completeValidated({ jobId: id, progress: 1, artifactDigest: manifest.artifactDigest, leaseToken: lease, publicationManifest: manifest });
  assert.deepEqual(validated.metadata.publicationManifest, manifest);
  const publication = new PostgresKnowledgeGraphPublicationStore(query);
  await publication.registerStagedSnapshot({ ...scope, allowedTrustLevels: ['reviewed', 'trusted'], enforceIsolation: true }, graphVersion);
  const activation = await publication.acquireSnapshotLease(scope, graphVersion, 'activate');
  await publication.compareAndSetActiveWithLease(scope, graphVersion, 0, activation);
  const event = (await publication.listPendingEvents(scope))[0]; assert.ok(event);
  const reader = new PostgresKnowledgeGraphPublicationReadback(query, { executionProfile: 'local-reference', scope: { environment: 'isolated-local', ...scope }, operationTimeoutMs: 1000, maxReads: 16 });
  await assert.rejects(reader.readPublication({}), e => e.code === 'invalid-readback');
  await client.query(`update public.graph_publication_outbox set created_at = '2026-10-10T05:00:00Z', published_at = '2026-10-10T06:00:00.000Z'
    where id = $1::uuid and tenant_id = $2 and corpus_id = $3`, [event.id, scope.tenantId, scope.corpusId]);
  const result = await reader.readPublication({}); assert.deepEqual(result.buildJob.documents, manifest.documents); assert.equal(result.pointer.revision, 1);
  assert.equal(result.outbox.publishedAt, '2026-10-10T06:00:00.000Z'); assert.equal(result.buildJob.status, 'published');
  await client.query(`update public.graph_publication_outbox set published_at = '2026-10-10T06:00:00.000001Z' where id = $1::uuid`, [event.id]);
  assert.equal((await reader.readPublication({})).outbox.publishedAt, '2026-10-10T06:00:00.001Z');
  for (const [stored, expected] of [
    ['2026-10-10T06:00:00.999999Z', '2026-10-10T06:00:01.000Z'],
    ['2026-10-10T06:00:00.123000Z', '2026-10-10T06:00:00.123Z'],
    ['2026-10-10T06:00:00.123456Z', '2026-10-10T06:00:00.124Z'],
  ]) {
    await client.query('update public.graph_publication_outbox set published_at = $2::timestamptz where id = $1::uuid', [event.id, stored]);
    assert.equal((await reader.readPublication({})).outbox.publishedAt, expected);
  }
  await client.query("update public.graph_build_jobs set metadata = metadata - 'publicationManifest' where id = $1::uuid", [id]);
  await assert.rejects(reader.readPublication({}), e => e.code === 'invalid-readback');
}));
test('an expired running lease cannot persist a validated publication manifest', async () => isolated(async fixture => {
  const { query, client } = fixture; const { id, lease, manifest } = await seedRunning(fixture, '-1 second');
  await assert.rejects(new PostgresKnowledgeGraphBuildJobStore(query).completeValidated({ jobId: id, progress: 1,
    artifactDigest: manifest.artifactDigest, leaseToken: lease, publicationManifest: manifest }), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
  const r = await client.query("select status, metadata ? 'publicationManifest' as manifest from public.graph_build_jobs where id = $1::uuid", [id]);
  assert.deepEqual(r.rows, [{ status: 'running', manifest: false }]);
}));
test('lease expiry during a transaction is checked against wall time, not the transaction start', async () => isolated(async fixture => {
  const { query, client } = fixture; const { id, lease, manifest } = await seedRunning(fixture, '0.01 seconds');
  await client.query('select pg_sleep(0.03)');
  const r = await client.query('select lease_expires_at > now() as transaction_valid, lease_expires_at <= clock_timestamp() as expired from public.graph_build_jobs where id = $1::uuid', [id]);
  assert.deepEqual(r.rows, [{ transaction_valid: true, expired: true }]);
  await assert.rejects(new PostgresKnowledgeGraphBuildJobStore(query).completeValidated({ jobId: id, progress: 1,
    artifactDigest: manifest.artifactDigest, leaseToken: lease, publicationManifest: manifest }), e => e.code === 'KNOWLEDGE_GRAPH_CONFLICT');
}));
