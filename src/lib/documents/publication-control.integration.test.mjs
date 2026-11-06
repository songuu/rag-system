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

// Explicit opt-in and a dedicated database name prevent accidentally writing to
// an existing developer/production database. The migrations must be applied
// by the test environment before this test runs.
const url = process.env.PUBLICATION_TEST_DATABASE_URL?.trim();
const enabled = Boolean(url && process.env.PUBLICATION_TEST_ALLOW_MUTATIONS === '1');

test('two real PostgreSQL connections fence competing attempts, late actors, and revocation', {
  skip: enabled ? false : 'Set PUBLICATION_TEST_DATABASE_URL and PUBLICATION_TEST_ALLOW_MUTATIONS=1 for an isolated database.',
}, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const admin = await pool.connect();
  const suffix = randomUUID();
  const role = `publication_test_${suffix.replaceAll('-', '')}`;
  const scope = { tenantId: `publication-test-${suffix}`, corpusId: `publication-corpus-${suffix}`, documentId: `document-${suffix}` };
  const collection = label => `publication_${suffix.replaceAll('-', '')}_${label}`;
  const manifestDigest = `sha256:${'a'.repeat(64)}`;
  const evidenceDigest = `sha256:${'b'.repeat(64)}`;
  let created = false;
  let roleCreated = false;
  try {
    const database = await admin.query('select current_database() as name, to_regclass($1) as table_name', ['public.document_publication_heads']);
    assert.match(database.rows[0].name, /^rag_publication_test_[a-z0-9_]+$/, 'A dedicated publication test database is required.');
    assert.ok(database.rows[0].table_name, 'Apply migration 0008 to the dedicated test database first.');
    await admin.query('insert into public.tenants (id,name) values ($1,$2)', [scope.tenantId, 'Publication integration test']);
    created = true;
    await admin.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'integration')", [scope.tenantId, scope.corpusId, 'Publication test']);
    await admin.query(`create role "${role}" nologin`);
    roleCreated = true;
    await admin.query(`grant usage on schema public to "${role}"`);
    await admin.query(`grant execute on function public.rag_publication_control(text,text,text,text,jsonb) to "${role}"`);
    const { PostgresDocumentPublicationStore } = await import('./publication-control.ts');
    const wrap = () => ({
      async query(text, values) {
        const connection = await pool.connect();
        try {
          await connection.query('begin');
          await connection.query(`set local role "${role}"`);
          const result = await connection.query(text, values);
          await connection.query('commit');
          return result;
        } catch (error) {
          await connection.query('rollback');
          throw error;
        } finally { connection.release(); }
      },
      async withTransaction(_operation, work) {
        const connection = await pool.connect();
        const tx = { query: (text, values) => connection.query(text, values) };
        try {
          await connection.query('begin');
          const value = await work(tx);
          await connection.query('commit');
          return value;
        } catch (error) {
          await connection.query('rollback');
          throw error;
        } finally { connection.release(); }
      },
    });
    const a = new PostgresDocumentPublicationStore(wrap());
    const b = new PostgresDocumentPublicationStore(wrap());
    const input = { ...scope, idempotencyKey: 'same-request', contentVersion: 'source-v1', manifestDigest,
      physicalCollection: collection('first'), requiredProviders: ['milvus', 'elasticsearch'] };
    const [candidate, duplicate] = await Promise.all([a.begin(input), b.begin(input)]);
    assert.deepEqual(candidate, duplicate);
    assert.equal('leaseToken' in candidate, false);
    const claims = await Promise.allSettled([a.claim(candidate), b.claim(duplicate)]);
    assert.equal(claims.filter(claim => claim.status === 'fulfilled').length, 1);
    assert.equal(claims.filter(claim => claim.status === 'rejected' && claim.reason.code === 'PUBLICATION_CONFLICT').length, 1);
    const first = claims.find(claim => claim.status === 'fulfilled').value;
    await assert.rejects(b.begin({ ...input, contentVersion: 'different' }), error => error.code === 'PUBLICATION_CONFLICT');
    // A second attempt cannot claim the physical collection of a worker that
    // might still finish a remote request. The failed transaction must not
    // supersede the original valid lease.
    await assert.rejects(b.begin({ ...input, idempotencyKey: 'same-collection' }), error => error.code === '23505');
    await a.renew(first);
    await a.observeAndRecord(first, 'milvus', async () => ({ ...scope, generation: first.generation, provider: 'milvus', manifestDigest, evidenceDigest, physicalCollection: first.physicalCollection }));
    await assert.rejects(a.publish(first), error => error.code === 'PUBLICATION_NOT_IMPLEMENTED');
    let signalEntered;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    let releaseOld;
    const held = new Promise(resolve => { releaseOld = resolve; });
    const lateOldRead = a.observeAndRecord(first, 'elasticsearch', async () => {
      signalEntered(); await held;
      return { ...scope, generation: first.generation, provider: 'elasticsearch', manifestDigest, evidenceDigest, physicalCollection: first.physicalCollection };
    });
    await entered;
    const nextCandidate = await b.begin({ ...input, idempotencyKey: 'next-request', physicalCollection: collection('next') });
    const next = await b.claim(nextCandidate);
    releaseOld();
    await assert.rejects(lateOldRead, error => error.code === 'PUBLICATION_CONFLICT');
    assert.notEqual(first.generation, next.generation);
    assert.notEqual(first.physicalCollection, next.physicalCollection);
    await assert.rejects(a.renew(first), error => error.code === 'PUBLICATION_CONFLICT');
    await assert.rejects(a.observeAndRecord(first, 'milvus', async () => { throw new Error('must not read a stale lease'); }),
      error => error.code === 'PUBLICATION_CONFLICT');

    await b.observeAndRecord(next, 'milvus', async () => ({ ...scope, generation: next.generation, provider: 'milvus', manifestDigest, evidenceDigest, physicalCollection: next.physicalCollection }));
    await admin.query(`update public.document_publication_attempts set lease_expires_at=clock_timestamp()-interval '1 second'
      where tenant_id=$1 and corpus_id=$2 and document_id=$3 and generation=$4::bigint`,
    [scope.tenantId, scope.corpusId, scope.documentId, next.generation]);
    await assert.rejects(a.renew(next), error => error.code === 'PUBLICATION_CONFLICT');
    await assert.rejects(a.claim(nextCandidate), error => error.code === 'PUBLICATION_CONFLICT');
    await assert.rejects(b.begin({ ...input, idempotencyKey: 'next-request', physicalCollection: collection('next') }),
      error => error.code === 'PUBLICATION_CONFLICT');
    await b.abandon(next);
    await assert.rejects(b.begin({ ...input, idempotencyKey: 'next-request', physicalCollection: collection('next') }),
      error => error.code === 'PUBLICATION_CONFLICT');
    await assert.rejects(a.claim(nextCandidate), error => error.code === 'PUBLICATION_CONFLICT');
    await assert.rejects(b.renew(next), error => error.code === 'PUBLICATION_CONFLICT');
    const recoveryCandidate = await a.begin({ ...input, idempotencyKey: 'recovery', physicalCollection: collection('recovery') });
    const recovery = await a.claim(recoveryCandidate);
    assert.notEqual(recovery.generation, next.generation);
    assert.notEqual(recovery.physicalCollection, next.physicalCollection);
    await b.revoke({ ...scope, expectedRevision: recovery.revision });
    await assert.rejects(a.renew(recovery), error => error.code === 'PUBLICATION_CONFLICT');
    const head = await admin.query(`select active_generation,revoked,revision::text from public.document_publication_heads
      where tenant_id=$1 and corpus_id=$2 and document_id=$3`, [scope.tenantId, scope.corpusId, scope.documentId]);
    assert.equal(head.rows[0].active_generation, null);
    assert.equal(head.rows[0].revoked, true);
    await assert.rejects(b.begin({ ...input, idempotencyKey: 'after-revocation', physicalCollection: collection('after_revocation') }), error => error.code === 'PUBLICATION_CONFLICT');
    await assert.rejects(b.restore({ ...scope, expectedRevision: head.rows[0].revision }), error => error.code === 'PUBLICATION_CONFLICT');
    await admin.query(`insert into public.document_assets (tenant_id,corpus_id,external_document_id,original_name,content_type,source_hash,metadata)
      values ($1,$2,$3,'source.txt','text/plain','source-v1', '{"source_kind":"text","persistence_status":"ready","retrieval_enabled":false,"lifecycle":"active"}'::jsonb)`,
    [scope.tenantId,scope.corpusId,scope.documentId]);
    await assert.rejects(b.restore({ ...scope, expectedRevision: head.rows[0].revision }), error => error.code === 'PUBLICATION_CONFLICT');
    await admin.query(`update public.document_assets set metadata = jsonb_set(metadata, '{retrieval_enabled}', 'true'::jsonb)
      where tenant_id=$1 and corpus_id=$2 and external_document_id=$3`, [scope.tenantId,scope.corpusId,scope.documentId]);
    const restores = await Promise.allSettled([
      a.restore({ ...scope, expectedRevision: head.rows[0].revision }),
      b.restore({ ...scope, expectedRevision: head.rows[0].revision }),
    ]);
    assert.equal(restores.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(restores.filter(item => item.status === 'rejected' && item.reason.code === 'PUBLICATION_CONFLICT').length, 1);
    const restored = await admin.query(`select active_generation,revoked,revision::text from public.document_publication_heads
      where tenant_id=$1 and corpus_id=$2 and document_id=$3`, [scope.tenantId,scope.corpusId,scope.documentId]);
    assert.equal(restored.rows[0].active_generation, null);
    assert.equal(restored.rows[0].revoked, false);
    const afterRevocation = await b.begin({ ...input, idempotencyKey: 'after-revocation', physicalCollection: collection('after_revocation') });
    const latest = await b.claim(afterRevocation);
    await assert.rejects(a.revoke({ ...scope, expectedRevision: recovery.revision }), error => error.code === 'PUBLICATION_CONFLICT');
    await b.renew(latest);
    const directAttempt = (generation, name) => admin.query(`insert into public.document_publication_attempts
      (tenant_id,corpus_id,document_id,generation,idempotency_key,content_version,manifest_digest,physical_collection,
       required_providers,status,expected_revision)
      values ($1,$2,$3,$4::bigint,$5,'source-v1',$6,$7,array['milvus']::text[],'queued',1)`,
    [scope.tenantId, scope.corpusId, scope.documentId, generation, `direct-${generation}`, manifestDigest, name]);
    await assert.rejects(directAttempt('999', collection('unreserved')), error => error.code === '23503');
    // A tenant/corpus may be deleted while an expired remote request is still
    // in flight. Recreating the corpus must never free its physical names.
    await admin.query('delete from public.corpora where tenant_id=$1 and id=$2', [scope.tenantId, scope.corpusId]);
    await admin.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'integration')", [scope.tenantId, scope.corpusId, 'Recreated publication test']);
    await assert.rejects(a.begin({ ...input, idempotencyKey: 'recreated', physicalCollection: collection('first') }),
      error => error.code === '23505');
    const fresh = await a.begin({ ...input, idempotencyKey: 'recreated', physicalCollection: collection('recreated') });
    assert.equal(fresh.physicalCollection, collection('recreated'));
    // Direct INSERT must not bind the prior tombstone, even when its original
    // attempt disappeared with its former corpus.
    await assert.rejects(directAttempt('999', collection('first')), error => error.code === '23503');
    // App has UPDATE for lease and status maintenance, but must not be able
    // to redirect an existing attempt onto a previously bound tombstone.
    await admin.query('begin');
    try {
      await admin.query(`set local role "${role}"`);
      await assert.rejects(admin.query(`update public.document_publication_attempts set status='queued', lease_token=null,
        lease_expires_at=null where tenant_id=$1 and corpus_id=$2 and document_id=$3`,
      [scope.tenantId, scope.corpusId, scope.documentId]), error => error.code === '42501');
    } finally { await admin.query('rollback'); }
    // Test the immutable-identity trigger separately as the owner. The
    // application role above cannot issue any table UPDATE at all.
    await admin.query('begin');
    try {
      const mutations = [
        ['physical_collection=$4', collection('first')],
        ['tenant_id=$4', 'other-tenant'], ['corpus_id=$4', 'other-corpus'], ['document_id=$4', 'other-document'],
        ['generation=$4::bigint', '999'], ['idempotency_key=$4', 'other-request'], ['content_version=$4', 'different-content'],
        ['manifest_digest=$4', `sha256:${'c'.repeat(64)}`], ['required_providers=$4::text[]', ['neo4j']],
        ['expected_revision=$4::bigint', '999'], ["created_at=created_at+($4::integer * interval '1 second')", 1],
      ];
      for (const [mutation, value] of mutations) {
        await admin.query('savepoint immutable_identity_test');
        // mutation values are fixed test literals, never externally supplied SQL.
        const query = `update public.document_publication_attempts set ${mutation}
          where tenant_id=$1 and corpus_id=$2 and document_id=$3 and generation=$5::bigint`;
        await assert.rejects(admin.query(query, [scope.tenantId, scope.corpusId, scope.documentId, value, fresh.generation]),
          error => error.code === '23514');
        await admin.query('rollback to savepoint immutable_identity_test');
      }
    } finally {
      await admin.query('rollback');
    }
  } finally {
    if (created) await admin.query('delete from public.tenants where id=$1', [scope.tenantId]);
    // This is a dedicated disposable test database; remove only the exact
    // names generated by this test after all clients have stopped writing.
    if (created) await admin.query('delete from public.document_publication_collection_reservations where physical_collection = any($1::text[])',
      [['first', 'next', 'recovery', 'after_revocation', 'recreated'].map(collection)]);
    if (roleCreated) {
      await admin.query(`drop owned by "${role}"`);
      await admin.query(`drop role "${role}"`);
    }
    admin.release();
    await pool.end();
  }
});
