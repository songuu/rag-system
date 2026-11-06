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
const enabled = Boolean(url && process.env.PUBLICATION_TEST_ALLOW_MUTATIONS === '1');

test('verified publication CAS is atomic under missing seals, competing revoke and source conflicts', {
  skip: enabled ? false : 'Requires a dedicated publication test database and explicit opt-in.',
}, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const admin = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const appRole = `cas_app_${suffix}`;
  const publisherRole = `cas_publisher_${suffix}`;
  const tenantId = `publish-tenant-${suffix}`;
  const corpusId = `publish-corpus-${suffix}`;
  const collectionNames = [];
  let created = false;
  let rolesCreated = false;
  try {
    const database = await admin.query('select current_database() as name, to_regprocedure($1) as fn',
      ['public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text)']);
    assert.match(database.rows[0].name, /^rag_publication_test_[a-z0-9_]+$/);
    assert.ok(database.rows[0].fn, 'Apply migrations 0001 and 0008–0012 to the dedicated database.');
    await admin.query('insert into public.tenants (id,name) values ($1,$2)', [tenantId, 'CAS integration test']);
    created = true;
    await admin.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'test')", [tenantId, corpusId, 'CAS test']);
    const { preparePublicationAsset, PostgresPublicationAssetStore } = await import('./publication-asset-store.ts');
    const { PostgresDocumentPublicationStore } = await import('./publication-control.ts');
    const { publishVerifiedGeneration } = await import('./publication-live-publisher.ts');
    const db = { query: (sql, values) => pool.query(sql, values) };
    const control = new PostgresDocumentPublicationStore(db);
    const assets = new PostgresPublicationAssetStore(db);
    const prepare = async (id, source) => {
      const documentId = `${id}-${suffix}`;
      const collection = `rag_publication_${randomUUID().replaceAll('-', '')}`;
      collectionNames.push(collection);
      const bytes = Buffer.from(source);
      const asset = preparePublicationAsset({ tenantId, corpusId, documentId, sourceBytes: bytes, sourceIdentityBytes: bytes,
        originalName: `${id}.txt`, contentType: 'text/plain', sourceKind: 'text',
        embedding: { model: 'test', revision: '1', dimension: 2, indexSchema: 'v1' },
        splitter: { name: 'test', revision: '1', chunkSize: 20, chunkOverlap: 0 },
        chunks: [{ chunkIndex: 0, content: source, trustLevel: 'external', embedding: [0.25, 0.5] }] });
      const candidate = await control.begin({ tenantId, corpusId, documentId, idempotencyKey: randomUUID(),
        contentVersion: asset.contentVersion, manifestDigest: asset.manifestDigest, physicalCollection: collection,
        requiredProviders: ['milvus', 'elasticsearch'] });
      const attempt = await control.claim(candidate);
      await assets.stage(attempt, asset);
      const indexName = `codex-generation-seal-${randomUUID().replaceAll('-', '')}`;
      const indexUuid = `uuid_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`insert into public.elasticsearch_publication_operations (operation_id,tenant_id,corpus_id,document_id,generation,
        revision,manifest_digest,physical_collection,content_version,index_name,owner_marker,state,index_uuid)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'bound',$12)`,
      [randomUUID(), tenantId, corpusId, documentId, attempt.generation, attempt.revision, attempt.manifestDigest,
        collection, asset.contentVersion, indexName, 'a'.repeat(64), indexUuid]);
      return { documentId, collection, asset, attempt, indexName, indexUuid };
    };
    // Test-only synthetic seals exercise SQL state transitions; they are NOT
    // proof of real backend verification or permission to deploy a publisher.
    const addSeal = async (item, provider) => {
      const manifest = JSON.stringify([{ chunkId: `pub:${'a'.repeat(64)}` }]);
      await admin.query(`insert into public.document_publication_provider_seals
        (tenant_id,corpus_id,document_id,generation,provider,manifest_digest,resource_name,resource_id,
         verification_profile,configuration_digest,evidence_digest,provider_manifest_json,provider_manifest_digest)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tenantId, corpusId, item.documentId, item.attempt.generation, provider, item.asset.manifestDigest,
        provider === 'milvus' ? item.collection : item.indexName, provider === 'milvus' ? '123' : item.indexUuid,
        provider === 'milvus' ? 'milvus-exclusive-strong-v1' : 'elasticsearch-write-block-pit-v1',
        `sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, manifest, `sha256:${'d'.repeat(64)}`]);
    };
    const first = await prepare('first', 'new text');
    await assert.rejects(publishVerifiedGeneration(db, first.attempt), /publication|query/i);
    assert.equal((await admin.query('select count(*)::int as n from public.document_assets where tenant_id=$1 and corpus_id=$2', [tenantId, corpusId])).rows[0].n, 0);
    await addSeal(first, 'milvus');
    await assert.rejects(publishVerifiedGeneration(db, first.attempt), /publication|query/i);
    await addSeal(first, 'elasticsearch');
    await admin.query(`create role "${appRole}" nologin`);
    await admin.query(`create role "${publisherRole}" nologin`);
    rolesCreated = true;
    await admin.query(`grant usage on schema public to "${appRole}", "${publisherRole}"`);
    await admin.query(`grant execute on function public.rag_publish_document_generation(text,text,text,bigint,bigint,uuid,text,text) to "${publisherRole}"`);
    await admin.query(`set role "${appRole}"`);
    const restricted = { query: (sql, values) => admin.query(sql, values) };
    await assert.rejects(publishVerifiedGeneration(restricted, first.attempt), /query|permission/i);
    await admin.query('reset role');
    await admin.query(`set role "${publisherRole}"`);
    const published = await publishVerifiedGeneration(restricted, first.attempt);
    await admin.query('reset role');
    assert.equal(published.generation, first.attempt.generation);
    const state = await admin.query(`select d.source_hash,d.raw_blob_filename,d.parsed_blob_filename,h.active_generation::text,a.status
      from public.document_assets d join public.document_publication_heads h on h.tenant_id=d.tenant_id and h.corpus_id=d.corpus_id and h.document_id=d.external_document_id
      join public.document_publication_attempts a on a.tenant_id=h.tenant_id and a.corpus_id=h.corpus_id and a.document_id=h.document_id and a.generation=h.active_generation
      where d.tenant_id=$1 and d.corpus_id=$2 and d.external_document_id=$3`, [tenantId, corpusId, first.documentId]);
    assert.equal(state.rows[0].source_hash, first.asset.contentVersion);
    assert.equal(state.rows[0].status, 'published');
    assert.equal(state.rows[0].raw_blob_filename, null);
    assert.equal(state.rows[0].parsed_blob_filename, null);
    assert.deepEqual(await publishVerifiedGeneration(db, first.attempt), published, 'a lost response is recoverable for the identical active attempt');
    await assert.rejects(publishVerifiedGeneration(db, { ...first.attempt, leaseToken: randomUUID() }), /publication|query/i,
      'a replay with a different lease must not recover a receipt');
    await assert.rejects(publishVerifiedGeneration(db, { ...first.attempt, manifestDigest: `sha256:${'f'.repeat(64)}` }), /publication|query/i,
      'a replay with a different manifest must not recover a receipt');

    const updated = await prepare('updated', 'replacement');
    const previousPdfMetadata = { source_kind: 'pdf', persistence_status: 'ready', retrieval_enabled: true, lifecycle: 'active',
      document: { source: 'legacy.pdf', trustLevel: 'external' }, pdf_visual: { assetKey: 'old-pdf-key', pages: 7 } };
    await admin.query(`insert into public.object_blobs (tenant_id,corpus_id,kind,filename,data,content_type,metadata)
      values ($1,$2,'raw',$3,$4,'application/pdf','{}'::jsonb)`, [tenantId, corpusId, 'legacy.pdf', Buffer.from('legacy PDF')]);
    await admin.query(`insert into public.document_assets (tenant_id,corpus_id,external_document_id,original_name,content_type,
      source_hash,raw_blob_filename,metadata) values ($1,$2,$3,'legacy.pdf','application/pdf','old-pdf-hash','legacy.pdf',$4::jsonb)`,
    [tenantId, corpusId, updated.documentId, JSON.stringify(previousPdfMetadata)]);
    await addSeal(updated, 'milvus'); await addSeal(updated, 'elasticsearch');
    await publishVerifiedGeneration(db, updated.attempt);
    const oldSnapshot = await admin.query(`select asset_snapshot from public.document_publication_prior_assets
      where tenant_id=$1 and corpus_id=$2 and document_id=$3 and generation=$4::bigint`,
    [tenantId, corpusId, updated.documentId, updated.attempt.generation]);
    assert.equal(oldSnapshot.rows[0].asset_snapshot.raw_blob_filename, 'legacy.pdf');
    assert.deepEqual(oldSnapshot.rows[0].asset_snapshot.metadata.pdf_visual, previousPdfMetadata.pdf_visual);
    await assert.rejects(admin.query(`update public.document_publication_prior_assets set asset_snapshot='{}'::jsonb
      where tenant_id=$1 and corpus_id=$2 and document_id=$3`, [tenantId, corpusId, updated.documentId]), /cannot be modified/);
    assert.equal((await admin.query('select data from public.object_blobs where tenant_id=$1 and corpus_id=$2 and filename=$3',
      [tenantId, corpusId, 'legacy.pdf'])).rows[0].data.toString(), 'legacy PDF');
    await admin.query(`update public.document_assets set metadata=jsonb_set(metadata,'{retrieval_enabled}','false')
      where tenant_id=$1 and corpus_id=$2 and external_document_id=$3`, [tenantId, corpusId, updated.documentId]);
    await assert.rejects(publishVerifiedGeneration(db, updated.attempt), /publication|query/i, 'disabled source is never replayed as success');
    await admin.query(`update public.document_assets set metadata=jsonb_set(metadata,'{retrieval_enabled}','true')
      where tenant_id=$1 and corpus_id=$2 and external_document_id=$3`, [tenantId, corpusId, updated.documentId]);
    await assert.rejects(publishVerifiedGeneration(db, updated.attempt), /publication|query/i, 'disable/enable must not revive an old receipt');
    await admin.query('delete from public.document_assets where tenant_id=$1 and corpus_id=$2 and external_document_id=$3',
      [tenantId, corpusId, updated.documentId]);
    assert.equal((await admin.query('select count(*)::int as n from public.document_publication_prior_assets where tenant_id=$1 and corpus_id=$2 and document_id=$3',
      [tenantId, corpusId, updated.documentId])).rows[0].n, 1, 'source locator survives deletion for later cleanup');
    await assert.rejects(publishVerifiedGeneration(db, updated.attempt), /publication|query/i, 'deleted source is never replayed');

    const nextCollection = `rag_publication_${randomUUID().replaceAll('-', '')}`;
    collectionNames.push(nextCollection);
    const newer = await control.begin({ tenantId, corpusId, documentId: first.documentId, idempotencyKey: randomUUID(),
      contentVersion: first.asset.contentVersion, manifestDigest: first.asset.manifestDigest,
      physicalCollection: nextCollection, requiredProviders: ['milvus', 'elasticsearch'] });
    await assert.rejects(publishVerifiedGeneration(db, first.attempt), /publication|query/i, 'a newer generation invalidates the old receipt');
    await control.revoke({ tenantId, corpusId, documentId: first.documentId, expectedRevision: newer.revision });
    await assert.rejects(publishVerifiedGeneration(db, first.attempt), /publication|query/i, 'revocation invalidates the old receipt');

    const sameSource = await prepare('duplicate', 'new text');
    await addSeal(sameSource, 'milvus'); await addSeal(sameSource, 'elasticsearch');
    await assert.rejects(publishVerifiedGeneration(db, sameSource.attempt));
    assert.equal((await admin.query('select active_generation from public.document_publication_heads where tenant_id=$1 and corpus_id=$2 and document_id=$3',
      [tenantId, corpusId, sameSource.documentId])).rows[0].active_generation, null);
    assert.equal((await admin.query('select count(*)::int as n from public.document_assets where tenant_id=$1 and corpus_id=$2', [tenantId, corpusId])).rows[0].n, 1);

    const racing = await prepare('racing', 'race content');
    await addSeal(racing, 'milvus'); await addSeal(racing, 'elasticsearch');
    const outcomes = await Promise.allSettled([publishVerifiedGeneration(db, racing.attempt),
      control.revoke({ tenantId, corpusId, documentId: racing.documentId, expectedRevision: racing.attempt.revision })]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1, 'publish and revoke must not both commit');
    const head = (await admin.query('select active_generation,revoked from public.document_publication_heads where tenant_id=$1 and corpus_id=$2 and document_id=$3',
      [tenantId, corpusId, racing.documentId])).rows[0];
    assert.equal(Boolean(head.active_generation), !head.revoked);
  } finally {
    await admin.query('reset role').catch(() => {});
    if (created) {
      await admin.query('delete from public.tenants where id=$1', [tenantId]);
      await admin.query('delete from public.elasticsearch_publication_operations where tenant_id=$1', [tenantId]);
      for (const name of collectionNames) await admin.query('delete from public.document_publication_collection_reservations where physical_collection=$1', [name]);
    }
    if (rolesCreated) {
      for (const role of [appRole, publisherRole]) {
        await admin.query(`drop owned by "${role}"`); await admin.query(`drop role "${role}"`);
      }
    }
    admin.release(); await pool.end();
  }
});
