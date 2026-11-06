import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });

const url = process.env.PUBLICATION_TEST_DATABASE_URL?.trim();
const esUrl = process.env.TEST_ELASTICSEARCH_URL?.trim();
const enabled = Boolean(url && esUrl && process.env.PUBLICATION_TEST_ALLOW_MUTATIONS === '1' && process.env.RAG_ES_GENERATION_TEST === '1');

test('durable ES identity is recorded before create and bound only to observed UUID', {
  skip: enabled ? false : 'Opt in with a dedicated publication test database and loopback Elasticsearch.', timeout: 120_000,
}, async () => {
  const parsed = new URL(esUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password) throw new Error('TEST_ELASTICSEARCH_URL must be credential-free and loopback only.');
  const { Client } = await import('@elastic/elasticsearch');
  const { PostgresDocumentPublicationStore } = await import('../documents/publication-control.ts');
  const { PostgresElasticsearchPublicationOperations, createPersistedElasticsearchIndex } = await import('./publication-operation.ts');
  const { inspectGenerationIndexOperation } = await import('./generation-seal.ts');
  const pgPool = new pg.Pool({ connectionString: url, max: 4 });
  const admin = await pgPool.connect();
  const es = new Client({ node: parsed.toString(), requestTimeout: 30_000,
    ...(process.env.TEST_ELASTICSEARCH_API_KEY ? { auth: { apiKey: process.env.TEST_ELASTICSEARCH_API_KEY } } : {}) });
  const suffix = randomUUID().replaceAll('-', '');
  const role = `es_operation_test_${suffix}`;
  const scope = { tenantId: `tenant-${suffix}`, corpusId: `corpus-${suffix}`, documentId: `document-${suffix}` };
  const ids = [];
  let createdTenant = false;
  let createdRole = false;
  let handle;
  let bound;
  try {
    const result = await admin.query('select current_database() as name, to_regclass($1) as operations', ['public.elasticsearch_publication_operations']);
    assert.match(result.rows[0].name, /^rag_publication_test_[a-z0-9_]+$/);
    assert.ok(result.rows[0].operations, 'Apply the control prototype and ES operation migration in the dedicated test database.');
    await admin.query('insert into public.tenants (id,name) values ($1,$2)', [scope.tenantId, 'ES operation integration']);
    createdTenant = true;
    await admin.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'integration')", [scope.tenantId, scope.corpusId, 'ES operation integration']);
    await admin.query(`create role "${role}" nologin`);
    createdRole = true;
    await admin.query(`grant usage on schema public to "${role}"`);
    await admin.query(`grant execute on function public.rag_publication_control(text,text,text,text,jsonb) to "${role}"`);
    await admin.query(`grant execute on function public.rag_elasticsearch_publication_operation(text,text,text,text,jsonb) to "${role}"`);
    const client = { async query(sql, values) {
      const connection = await pgPool.connect();
      try { await connection.query('begin'); await connection.query(`set local role "${role}"`);
        const response = await connection.query(sql, values); await connection.query('commit'); return response;
      } catch (error) { await connection.query('rollback'); throw error; } finally { connection.release(); }
    } };
    const control = new PostgresDocumentPublicationStore(client);
    const store = new PostgresElasticsearchPublicationOperations(client);
    const input = { ...scope, idempotencyKey: 'first', contentVersion: 'source-v1', manifestDigest: `sha256:${'a'.repeat(64)}`,
      physicalCollection: `publication_${suffix}_first`, requiredProviders: ['milvus', 'elasticsearch'] };
    const attempt = await control.claim(await control.begin(input));
    const [a, b] = await Promise.all([store.prepare(attempt, input.contentVersion), store.prepare(attempt, input.contentVersion)]);
    assert.deepEqual(a, b);
    ids.push(a.operationId);
    const created = await createPersistedElasticsearchIndex({ store, client: es, attempt, contentVersion: input.contentVersion });
    handle = created.handle;
    bound = created.operation;
    assert.equal(bound.operationId, a.operationId);
    assert.equal(bound.status, 'bound');
    assert.equal(bound.indexUuid, handle.indexUuid);
    assert.deepEqual(await store.read(scope, bound.operationId), bound);
    await assert.rejects(store.read({ ...scope, tenantId: 'another-tenant' }, bound.operationId), error => error.code === 'ELASTICSEARCH_PUBLICATION_CONFLICT');
    await assert.rejects(store.startCreate(attempt, bound), error => error.code === 'ELASTICSEARCH_PUBLICATION_CONFLICT');
    const bindFields = { generation: attempt.generation, revision: attempt.revision, manifestDigest: attempt.manifestDigest,
      physicalCollection: attempt.physicalCollection, leaseToken: attempt.leaseToken, operationId: bound.operationId,
      indexName: bound.indexName, marker: bound.marker, contentVersion: bound.identity.documentVersion, indexUuid: bound.indexUuid };
    for (const change of [
      { indexName: `codex-generation-seal-${'f'.repeat(32)}` },
      { marker: 'e'.repeat(64) }, { contentVersion: 'other-version' }, { indexUuid: 'other-uuid' },
    ]) {
      await assert.rejects(client.query('select public.rag_elasticsearch_publication_operation($1,$2,$3,$4,$5::jsonb) as result',
        ['bind', scope.tenantId, scope.corpusId, scope.documentId, JSON.stringify({ ...bindFields, ...change })]),
      error => error.code === 'P0001');
    }
    await assert.rejects(admin.query('update public.elasticsearch_publication_operations set index_uuid=null where operation_id=$1',
      [bound.operationId]), error => error.code === '23514');
    await admin.query('begin');
    try { await admin.query(`set local role "${role}"`);
      await assert.rejects(admin.query('update public.elasticsearch_publication_operations set index_uuid=$1 where operation_id=$2', ['forged', bound.operationId]),
        error => error.code === '42501');
    } finally { await admin.query('rollback'); }

    const next = await control.claim(await control.begin({ ...input, idempotencyKey: 'unknown', physicalCollection: `publication_${suffix}_unknown` }));
    let unknownId;
    await assert.rejects(createPersistedElasticsearchIndex({ store, client: es, attempt: next, contentVersion: input.contentVersion,
      create: async () => { throw new Error('simulated remote completion unknown'); } }), error => {
      unknownId = error.operationId; return error.code === 'ELASTICSEARCH_CREATE_OUTCOME_UNKNOWN';
    });
    ids.push(unknownId);
    const unknown = await store.read(scope, unknownId);
    assert.equal(unknown.status, 'creating');
    await assert.rejects(store.startCreate(next, unknown), error => error.code === 'ELASTICSEARCH_PUBLICATION_CONFLICT');
    assert.equal((await inspectGenerationIndexOperation({ client: es, operation: unknown })).kind, 'not-visible');
    const competing = await control.claim(await control.begin({ ...input, idempotencyKey: 'competing', physicalCollection: `publication_${suffix}_competing` }));
    const prepared = await store.prepare(competing, input.contentVersion);
    ids.push(prepared.operationId);
    const starts = await Promise.allSettled([store.startCreate(competing, prepared), store.startCreate(competing, prepared)]);
    assert.equal(starts.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(starts.filter(item => item.status === 'rejected' && item.reason.code === 'ELASTICSEARCH_PUBLICATION_CONFLICT').length, 1);
    await control.revoke({ ...scope, expectedRevision: competing.revision });
    await assert.rejects(store.startCreate(competing, prepared), error => error.code === 'ELASTICSEARCH_PUBLICATION_CONFLICT');
  } finally {
    try {
      if (handle && bound && /^codex-generation-seal-[0-9a-f]{32}$/.test(handle.indexName)) {
        const observed = await inspectGenerationIndexOperation({ client: es, operation: bound });
        if (observed.kind !== 'matching-marker' || observed.indexUuid !== handle.indexUuid) throw new Error('Temporary index identity changed; refusing cleanup.');
        await es.indices.delete({ index: handle.indexName });
      }
    } finally {
      if (ids.length) await admin.query('delete from public.elasticsearch_publication_operations where operation_id = any($1::uuid[])', [ids]);
      if (createdTenant) await admin.query('delete from public.tenants where id=$1', [scope.tenantId]);
      await admin.query('delete from public.document_publication_collection_reservations where physical_collection = any($1::text[])',
        [[`publication_${suffix}_first`, `publication_${suffix}_unknown`, `publication_${suffix}_competing`]]);
      if (createdRole) { await admin.query(`drop owned by "${role}"`); await admin.query(`drop role "${role}"`); }
      admin.release(); await pgPool.end(); await es.close();
    }
  }
});
