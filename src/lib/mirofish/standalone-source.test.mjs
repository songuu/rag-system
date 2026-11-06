import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const { registerStandaloneMiroFishGraphSource, repairStandaloneMiroFishGraphSource } = await import('./standalone-source.ts');
const { createMiroFishGraphArtifact } = await import('./graph-artifact-store.ts');
const { mapMiroFishArtifactToKnowledgeGraphSnapshot } = await import('../knowledge-graph/mirofish-adapter.ts');
const projectId = 'proj_1d2976ce-1899-4579-a583-d5200c5b97c0';
const graphName = `Project ${projectId} Graph`;
const documentId = 'mirofish_b66c35ac-0a7a-4ff5-b203-0372643bedaf';
const identity = { tenantId: 'tenant', corpusId: 'corpus', documentId, documentVersion: `sha256:${'a'.repeat(64)}`, trustLevel: 'external' };
const scope = { tenantId: 'tenant', corpusId: 'corpus', allowedTrustLevels: ['external'], enforceIsolation: true };
const artifact = createMiroFishGraphArtifact({ identity, graph: {
  artifact_version: 'mirofish-graph-v2', graph_id: documentId,
  nodes: [{ uuid: 'entity', name: 'Alice', labels: ['Person'], summary: '', attributes: { sourceChunks: ['passage'] } }],
  edges: [], node_count: 1, edge_count: 0,
  passages: [{ id: 'passage', document_id: documentId, content: 'Alice', index: 0, start_offset: 0, end_offset: 5 }],
} });
const descriptor = { identity, graphName, artifactDigest: mapMiroFishArtifactToKnowledgeGraphSnapshot(artifact).artifactDigest, createdAt: '2026-11-05T10:00:00.000Z', nodeCount: 1, edgeCount: 0 };
const snapshot = mapMiroFishArtifactToKnowledgeGraphSnapshot(artifact, { graphName });
const buildLease = { jobId: '5bc631c8-4c86-4b87-af1f-055321563402', leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87' };

test('standalone registration binds canonical source to immutable artifact and exact scope', async () => {
  let query;
  const client = { async query(sql, values) { query = { sql, values }; return { rows: [{ id: 'asset' }] }; } };
  await registerStandaloneMiroFishGraphSource(client, artifact, { graphName });
  assert.deepEqual(query.values.slice(0, 4), ['tenant', 'corpus', documentId, identity.documentVersion]);
  const metadata = JSON.parse(query.values[5]);
  assert.equal(metadata.source_kind, 'mirofish-graph');
  assert.equal(metadata.document.trustLevel, 'external');
  assert.equal(metadata.standalone_graph.artifact_digest, descriptor.artifactDigest);
  assert.equal(metadata.standalone_graph.passages[0].content_digest.startsWith('sha256:'), true);
  assert.match(query.sql, /on conflict do nothing/);
  assert.doesNotMatch(query.sql, /do update/i);
  assert.match(query.sql, /retrieval_enabled/);
  assert.match(query.sql, /lifecycle/);
  assert.doesNotMatch(query.sql, /graph_build_jobs/);
  assert.equal(query.values.length, 9);
});

test('durable source registration locks and verifies the exact live build lease on its write and reuse path', async () => {
  let query;
  await registerStandaloneMiroFishGraphSource({ async query(sql, values) {
    query = { sql, values };
    return { rows: [{ id: 'asset' }] };
  } }, artifact, { graphName, buildLease });
  assert.deepEqual(query.values.slice(9), [buildLease.jobId, buildLease.leaseToken]);
  assert.equal(query.values[6], snapshot.graphVersion);
  assert.match(query.sql, /job_owner as materialized/i);
  assert.match(query.sql, /from public\.graph_build_jobs[\s\S]*id = \$10::uuid[\s\S]*lease_token = \$11::uuid/i);
  assert.match(query.sql, /tenant_id = \$1 and corpus_id = \$2 and graph_version = \$7/i);
  assert.match(query.sql, /status = 'running' and lease_expires_at > clock_timestamp\(\)[\s\S]*for update/i);
  assert.match(query.sql, /from job_owner where lease_expires_at > clock_timestamp\(\)/i);
  assert.match(query.sql, /from eligible[\s\S]*asset cross join eligible/i);
});

test('a denied durable lease cannot insert a source or silently reuse an existing authority', async () => {
  for (const reason of ['stale', 'expired', 'foreign']) {
    let calls = 0;
    await assert.rejects(registerStandaloneMiroFishGraphSource({ async query(sql) {
      calls++;
      assert.match(sql, /exists \(select 1 from job_owner where lease_expires_at > clock_timestamp\(\)\)/i);
      return { rows: [] };
    } }, artifact, { graphName, buildLease }), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT', reason);
    assert.equal(calls, 1, 'a failed lease must not fall back to an unfenced write');
  }
});

test('malformed durable lease identifiers fail with a source conflict before issuing SQL', async () => {
  let calls = 0;
  const client = { async query() { calls++; return { rows: [{ id: 'asset' }] }; } };
  for (const lease of [null, {}, { ...buildLease, jobId: 'bad' }, { ...buildLease, leaseToken: 'bad' },
    { ...buildLease, jobId: '' }, { ...buildLease, leaseToken: undefined }]) {
    await assert.rejects(registerStandaloneMiroFishGraphSource(client, artifact, { graphName, buildLease: lease }),
      error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
  }
  assert.equal(calls, 0);
});

test('registration fails closed on a revoked, conflicting or deleted source', async () => {
  await assert.rejects(registerStandaloneMiroFishGraphSource({ query: async () => ({ rows: [] }) }, artifact, { graphName }),
    error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
});

test('document-backed and generated snapshots never create a standalone authority', async () => {
  let calls = 0;
  const client = { query: async () => { calls++; return { rows: [] }; } };
  await registerStandaloneMiroFishGraphSource(client, { ...artifact, documentId: 'document.pdf' });
  await registerStandaloneMiroFishGraphSource(client, { ...artifact, graphGeneration: '19b0d243-b625-4eba-85aa-f42fda97355a' });
  assert.equal(calls, 0);
});

test('repair requires exact project binding, immutable digest and matching identity before writing', async () => {
  let calls = 0;
  const client = { async query(sql, values) {
    calls++;
    assert.match(sql, /mirofish_projects/);
    assert.equal(values[7], projectId);
    return { rows: [{ id: 'asset' }] };
  } };
  const repair = (nextSnapshot = snapshot, nextDescriptor = descriptor, nextScope = scope) =>
    repairStandaloneMiroFishGraphSource(client, nextScope, projectId, nextSnapshot, nextDescriptor);
  await assert.rejects(repair(snapshot, { ...descriptor, graphName: 'another graph' }));
  await assert.rejects(repair(snapshot, { ...descriptor, artifactDigest: `sha256:${'f'.repeat(64)}` }));
  await assert.rejects(repair(snapshot, descriptor, { ...scope, tenantId: 'foreign' }));
  await assert.rejects(repair(snapshot, { ...descriptor, identity: { ...identity, documentVersion: 'forged' } }));
  await assert.rejects(repair({ ...snapshot, graphName: 'foreign project' }));
  assert.equal(calls, 0);
  await repair();
  assert.equal(calls, 1);
});

test('real PG source registration permits staged readback and cannot revive removed sources', {
  skip: process.env.RAG_STANDALONE_SOURCE_INTEGRATION !== '1',
}, async () => {
  const { default: pg } = await import('pg');
  const { getPostgresRuntimeConfig } = await import('../postgres/env.ts');
  const { readGraphQueryAuthority } = await import('../knowledge-graph/query-authority.ts');
  const { createMiroFishGraphVersion } = await import('../knowledge-graph/mirofish-adapter.ts');
  const configured = getPostgresRuntimeConfig();
  const target = new URL(configured.databaseUrl);
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.port, '5432');
  const client = new pg.Client({ connectionString: configured.databaseUrl, ssl: false, query_timeout: 5000, connectionTimeoutMillis: 5000 });
  const suffix = randomUUID().replaceAll('-', '');
  const config = { defaultTenantId: `standalone-${suffix}`, defaultCorpusId: `graph-${suffix}` };
  await client.connect();
  try {
    await client.query('begin');
    await client.query('insert into public.tenants (id, name) values ($1, $2)', [config.defaultTenantId, 'standalone graph regression']);
    await client.query('insert into public.corpora (id, tenant_id, name, source_kind) values ($1, $2, $3, $4)',
      [config.defaultCorpusId, config.defaultTenantId, 'standalone graph regression', 'isolated-test']);
    const tx = client;
    const documentId = `mirofish_${randomUUID()}`;
    const nextIdentity = { ...identity, tenantId: config.defaultTenantId, corpusId: config.defaultCorpusId,
      documentId, documentVersion: `sha256:${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}` };
    const nextArtifact = createMiroFishGraphArtifact({ identity: nextIdentity, graph: {
      ...artifact.graph, graph_id: documentId,
      passages: [{ id: 'passage', document_id: documentId, content: 'Alice', index: 0, start_offset: 0, end_offset: 5 }],
    } });
    const activeScope = { ...scope, tenantId: config.defaultTenantId, corpusId: config.defaultCorpusId };
    const version = createMiroFishGraphVersion(nextIdentity);
    const ownLease = { jobId: randomUUID(), leaseToken: randomUUID() };
    await tx.query(`insert into public.graph_build_jobs
      (id, tenant_id, corpus_id, graph_version, status, lease_token, lease_expires_at)
      values ($1, $2, $3, $4, 'running', $5, clock_timestamp() - interval '1 second')`,
    [ownLease.jobId, nextIdentity.tenantId, nextIdentity.corpusId, version, ownLease.leaseToken]);
    const leasedRegistration = (lease = ownLease) => registerStandaloneMiroFishGraphSource(tx, nextArtifact, { graphName, buildLease: lease });
    await assert.rejects(leasedRegistration(), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    const beforeInsert = await tx.query('select count(*)::integer as count from public.document_assets where tenant_id=$1 and corpus_id=$2',
      [nextIdentity.tenantId, nextIdentity.corpusId]);
    assert.equal(beforeInsert.rows[0].count, 0, 'an expired lease must not create source authority');
    await tx.query("update public.graph_build_jobs set lease_expires_at=clock_timestamp() + interval '1 minute' where id=$1", [ownLease.jobId]);
    await leasedRegistration();
    await leasedRegistration();
    await assert.rejects(leasedRegistration({ ...ownLease, jobId: randomUUID() }), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await tx.query("update public.graph_build_jobs set lease_expires_at=clock_timestamp() - interval '1 second' where id=$1", [ownLease.jobId]);
    await assert.rejects(leasedRegistration(), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await tx.query("update public.graph_build_jobs set lease_expires_at=clock_timestamp() + interval '1 minute', lease_token=$2 where id=$1",
      [ownLease.jobId, randomUUID()]);
    await assert.rejects(leasedRegistration(), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await registerStandaloneMiroFishGraphSource(tx, nextArtifact, { graphName });
    assert.equal(await readGraphQueryAuthority(tx, activeScope, nextIdentity, version), null);
    await tx.query('insert into public.graph_snapshot_lifecycle (tenant_id, corpus_id, graph_version) values ($1, $2, $3)',
      [nextIdentity.tenantId, nextIdentity.corpusId, version]);
    assert.ok(await readGraphQueryAuthority(tx, activeScope, nextIdentity, version));
    await registerStandaloneMiroFishGraphSource(tx, nextArtifact, { graphName });
    assert.equal(await readGraphQueryAuthority(tx, { ...activeScope, tenantId: 'foreign' }, nextIdentity, version), null);
    assert.equal(await readGraphQueryAuthority(tx, { ...activeScope, allowedTrustLevels: ['reviewed'] }, nextIdentity, version), null);
    await tx.query("update public.document_assets set metadata = jsonb_set(metadata, '{retrieval_enabled}', 'false'::jsonb) where tenant_id=$1 and corpus_id=$2 and external_document_id=$3",
      [nextIdentity.tenantId, nextIdentity.corpusId, documentId]);
    assert.equal(await readGraphQueryAuthority(tx, activeScope, nextIdentity, version), null);
    await assert.rejects(registerStandaloneMiroFishGraphSource(tx, nextArtifact), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    await tx.query('delete from public.document_assets where tenant_id=$1 and corpus_id=$2 and external_document_id=$3',
      [nextIdentity.tenantId, nextIdentity.corpusId, documentId]);
    await assert.rejects(registerStandaloneMiroFishGraphSource(tx, nextArtifact), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
    assert.equal(await readGraphQueryAuthority(tx, activeScope, nextIdentity, version), null);
  } finally {
    await client.query('rollback');
    const remaining = await client.query('select count(*)::integer as count from public.tenants where id=$1', [config.defaultTenantId]);
    assert.equal(remaining.rows[0].count, 0);
    await client.end();
  }
});
