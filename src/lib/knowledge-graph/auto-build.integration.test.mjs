import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
        && !specifier.endsWith('.ts')
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const enabled = process.env.RAG_KG_AUTO_BUILD_INTEGRATION === '1';

test('real PostgreSQL auto-build enqueue is idempotent and safely retries failed work', {
  skip: !enabled && 'Set RAG_KG_AUTO_BUILD_INTEGRATION=1 with POSTGRES_URL to run.',
}, async () => {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  assert.ok(connectionString, 'POSTGRES_URL or DATABASE_URL is required.');
  const [{ default: pg }, { enqueueKnowledgeGraphBuildAfterVectorization }, {
    PostgresKnowledgeGraphBuildJobStore,
  }] = await Promise.all([
    import('pg'),
    import('./auto-build.ts'),
    import('./postgres-graph-build-store.ts'),
  ]);
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('begin');
  try {
    const suffix = randomUUID();
    const tenantId = `auto-build-it-${suffix}`;
    const corpusId = `corpus-${suffix}`;
    const documentId = `document-${suffix}`;
    const documentVersion = `sha256:${createHash('sha256').update(suffix).digest('hex')}`;
    await client.query(
      'insert into public.tenants (id, name) values ($1, $2)',
      [tenantId, 'Auto-build integration tenant']
    );
    await client.query(
      "insert into public.corpora (id, tenant_id, name, source_kind) values ($1, $2, $3, 'integration')",
      [corpusId, tenantId, 'Auto-build integration corpus']
    );
    const asset = await client.query(
      `insert into public.document_assets (
         tenant_id, corpus_id, external_document_id, original_name,
         content_type, source_hash, created_by
       ) values ($1, $2, $3, $4, $5, $6, $7)
       returning id::text`,
      [
        tenantId,
        corpusId,
        documentId,
        'integration.txt',
        'text/plain',
        documentVersion,
        'integration-test',
      ]
    );
    const transactionClient = {
      query: (text, values) => client.query(text, values),
      // This fixture already owns one explicit transaction so the store can
      // exercise its two-statement lock protocol without nesting BEGIN.
      async withTransaction(_operation, work) {
        return work(transactionClient);
      },
    };
    const store = new PostgresKnowledgeGraphBuildJobStore(transactionClient);
    const input = {
      tenantId,
      corpusId,
      actorId: 'integration-test',
      documentId,
      documentVersion,
      trustLevel: 'external',
      postgresAssetId: asset.rows[0].id,
      chunkCount: 2,
      sourceName: 'integration.txt',
    };
    const dependencies = {
      env: { RAG_GRAPH_BACKEND: 'neo4j' },
      store,
    };

    const first = await enqueueKnowledgeGraphBuildAfterVectorization(input, dependencies);
    const duplicate = await enqueueKnowledgeGraphBuildAfterVectorization(input, dependencies);
    assert.equal(first.enabled, true);
    assert.equal(duplicate.enabled, true);
    assert.equal(duplicate.job.id, first.job.id);
    assert.equal(duplicate.job.status, 'queued');

    await client.query(
      `update public.graph_build_jobs
       set status = 'failed', progress = 0.5, attempts = 5,
           error_code = 'TEST_FAILURE', error_message = 'retry fixture'
       where id = $1::uuid`,
      [first.job.id]
    );
    const retried = await enqueueKnowledgeGraphBuildAfterVectorization(input, dependencies);
    assert.equal(retried.enabled, true);
    assert.equal(retried.job.status, 'queued');
    const row = await client.query(
      'select count(*)::integer as count, max(attempts)::integer as attempts from public.graph_build_jobs where id = $1::uuid',
      [first.job.id]
    );
    assert.deepEqual(row.rows[0], { count: 1, attempts: 0 });

    await client.query(
      "update public.graph_build_jobs set status = 'cancelled' where id = $1::uuid",
      [first.job.id]
    );
    await assert.rejects(
      () => enqueueKnowledgeGraphBuildAfterVectorization(input, dependencies),
      error => error.code === 'KNOWLEDGE_GRAPH_BUILD_ENQUEUE_REQUIRED'
    );
  } finally {
    await client.query('rollback');
    await client.end();
  }
});

test('real PostgreSQL serializes competing graph versions before enforcing capacity', {
  skip: !enabled && 'Set RAG_KG_AUTO_BUILD_INTEGRATION=1 with POSTGRES_URL to run.',
}, async () => {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  assert.ok(connectionString, 'POSTGRES_URL or DATABASE_URL is required.');
  const [{ default: pg }, { createPostgresQueryClient }, {
    PostgresKnowledgeGraphBuildJobStore,
  }, { createRetrievalScope }] = await Promise.all([
    import('pg'),
    import('../postgres/client.ts'),
    import('./postgres-graph-build-store.ts'),
    import('../security/retrieval-scope.ts'),
  ]);
  const suffix = randomUUID();
  const tenantId = `auto-build-cap-${suffix}`;
  const corpusId = `corpus-${suffix}`;
  const control = new pg.Client({ connectionString });
  const pool = new pg.Pool({ connectionString, max: 2 });
  let lockHeld = false;
  await control.connect();
  try {
    await control.query(
      'insert into public.tenants (id, name) values ($1, $2)',
      [tenantId, 'Auto-build capacity integration tenant']
    );
    await control.query(
      "insert into public.corpora (id, tenant_id, name, source_kind) values ($1, $2, $3, 'integration')",
      [corpusId, tenantId, 'Auto-build capacity integration corpus']
    );
    await control.query('begin');
    lockHeld = true;
    await control.query(
      "select pg_advisory_xact_lock(hashtextextended($1 || chr(31) || $2, 0))",
      [tenantId, corpusId]
    );

    const baseClient = createPostgresQueryClient({
      databaseUrl: connectionString,
      defaultTenantId: tenantId,
      defaultCorpusId: corpusId,
      sslMode: 'disable',
      maxConnections: 2,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
      persistenceBackend: 'postgres',
      vectorBackend: 'milvus',
    }, () => pool);
    assert.equal(typeof baseClient.withTransaction, 'function');

    let lockWaiters = 0;
    let releaseWaiterBarrier;
    const bothWaiting = new Promise(resolve => { releaseWaiterBarrier = resolve; });
    const observedClient = {
      query: (text, values) => baseClient.query(text, values),
      withTransaction(operation, work) {
        return baseClient.withTransaction(operation, transaction => work({
          query(text, values) {
            if (/pg_advisory_xact_lock/i.test(text)) {
              lockWaiters += 1;
              if (lockWaiters === 2) releaseWaiterBarrier();
            }
            return transaction.query(text, values);
          },
        }));
      },
    };
    const store = new PostgresKnowledgeGraphBuildJobStore(observedClient);
    const scope = createRetrievalScope({
      tenantId,
      corpusId,
      allowedTrustLevels: ['external'],
      enforceIsolation: true,
    });
    const pending = [
      store.enqueue(scope, 'graph-v1', {}, { maxPendingJobs: 1 }),
      store.enqueue(scope, 'graph-v2', {}, { maxPendingJobs: 1 }),
    ];

    await bothWaiting;
    await control.query('commit');
    lockHeld = false;
    const outcomes = await Promise.allSettled(pending);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    assert.equal(rejected?.reason?.code, 'KNOWLEDGE_GRAPH_CAPACITY');
    const count = await control.query(
      'select count(*)::integer as count from public.graph_build_jobs where tenant_id = $1 and corpus_id = $2',
      [tenantId, corpusId]
    );
    assert.equal(count.rows[0].count, 1);
  } finally {
    if (lockHeld) await control.query('rollback');
    await pool.end();
    await control.query(
      'delete from public.graph_build_jobs where tenant_id = $1 and corpus_id = $2',
      [tenantId, corpusId]
    );
    await control.query(
      'delete from public.corpora where tenant_id = $1 and id = $2',
      [tenantId, corpusId]
    );
    await control.query('delete from public.tenants where id = $1', [tenantId]);
    await control.end();
  }
});
