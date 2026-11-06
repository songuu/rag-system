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

test('published view requires trusted seals, isolates roles, and invalidates on revocation', {
  skip: enabled ? false : 'Requires an isolated publication test database and explicit opt-in.',
}, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  const admin = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const role = `view_test_${suffix}`;
  const tenantId = `view-tenant-${suffix}`;
  const corpusId = `view-corpus-${suffix}`;
  const documentId = `view-document-${suffix}`;
  const collection = `rag_publication_${suffix}`;
  const scope = { tenantId, corpusId, documentId };
  let created = false;
  let roleCreated = false;
  try {
    const database = await admin.query('select current_database() name, to_regprocedure($1) fn', ['public.rag_read_publication_view(text,text,text[])']);
    assert.match(database.rows[0].name, /^rag_publication_test_[a-z0-9_]+$/);
    assert.ok(database.rows[0].fn, 'Apply migrations 0001 and 0008-0011 to the isolated database.');
    await admin.query('insert into public.tenants (id,name) values ($1,$2)', [tenantId, 'View test']); created = true;
    await admin.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'test')", [tenantId, corpusId, 'View test']);
    const { preparePublicationAsset, PostgresPublicationAssetStore } = await import('./publication-asset-store.ts');
    const { PostgresDocumentPublicationStore } = await import('./publication-control.ts');
    const { readPublicationView, assertPublicationViewCurrent, readPublicationSource } = await import('./publication-view.ts');
    const { createPublicationChunk, publicationManifestEntry } = await import('./milvus-publication-generation.ts');
    const { generationDocumentDigest } = await import('../elasticsearch/generation-index.ts');
    const { canonicalJson } = await import('../rag/eval/canonical-json.ts');
    // Both source fields are legitimately over the old 24 MiB corpus budget.
    const largeSource = Buffer.alloc(13 * 1024 * 1024, 0x61);
    const prepared = preparePublicationAsset({ ...scope, sourceBytes: largeSource, sourceIdentityBytes: largeSource,
      originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text',
      embedding: { model: 'test', revision: '1', dimension: 2, indexSchema: 'v1' },
      splitter: { name: 'test', revision: '1', chunkSize: 10, chunkOverlap: 0 },
      chunks: [{ chunkIndex: 0, content: 'source', trustLevel: 'external', embedding: [0.25, 0.5] }] });
    await admin.query(`insert into public.document_assets (tenant_id,corpus_id,external_document_id,original_name,content_type,source_hash,metadata)
      values ($1,$2,$3,'a.txt','text/plain',$4,$5::jsonb)`, [tenantId, corpusId, documentId, prepared.contentVersion,
      JSON.stringify({ source_kind: 'text', persistence_status: 'ready', document: { trustLevel: 'external' } })]);
    const db = { query: (text, values) => pool.query(text, values) };
    const retrievalScope = { tenantId, corpusId, enforceIsolation: true, allowedTrustLevels: ['external'] };
    await assert.rejects(readPublicationView(retrievalScope, db), /query|view|publication/i, 'old asset without a publication must fail closed');
    const store = new PostgresDocumentPublicationStore(db);
    const candidate = await store.begin({ ...scope, idempotencyKey: 'one', contentVersion: prepared.contentVersion,
      manifestDigest: prepared.manifestDigest, physicalCollection: collection, requiredProviders: ['milvus','elasticsearch'] });
    const attempt = await store.claim(candidate);
    await new PostgresPublicationAssetStore(db).stage(attempt, prepared);
    const indexName = `codex-generation-seal-${suffix}`;
    const marker = 'a'.repeat(64);
    const indexUuid = 'test_uuid';
    await admin.query(`insert into public.elasticsearch_publication_operations (operation_id,tenant_id,corpus_id,document_id,generation,
      revision,manifest_digest,physical_collection,content_version,index_name,owner_marker,state,index_uuid)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'bound',$12)`,
      [randomUUID(),tenantId,corpusId,documentId,candidate.generation,candidate.revision,prepared.manifestDigest,collection,prepared.contentVersion,indexName,marker,indexUuid]);
    const configDigest = `sha256:${'b'.repeat(64)}`;
    const evidenceDigest = `sha256:${'c'.repeat(64)}`;
    const row = createPublicationChunk(retrievalScope, { documentId, generation: Number(candidate.generation),
      documentVersion: prepared.contentVersion, trustLevel: 'external', chunkIndex: 0, content: 'source', embedding: [0.25,0.5] }, 2);
    const entry = publicationManifestEntry(row);
    const descriptorDigest = JSON.parse(prepared.manifestJson).chunks[0].descriptorDigest;
    const lexical = { chunk_id: row.id, tenant_id: tenantId, corpus_id: corpusId, document_id: documentId,
      document_version: prepared.contentVersion, publication_generation: candidate.generation, trust_level: 'external', content: 'source', metadata: {} };
    const milvusManifest = `[${canonicalJson({ ...entry, chunkId: row.id, descriptorDigest })}]`;
    const elasticsearchManifest = `[${canonicalJson({ chunkIndex: 0, chunkId: row.id, digest: generationDocumentDigest(lexical), descriptorDigest })}]`;
    const seal = (provider,name,id,profile,providerManifest) => admin.query('select public.rag_record_publication_seal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [tenantId,corpusId,documentId,candidate.generation,candidate.revision,attempt.leaseToken,collection,provider,name,id,profile,configDigest,evidenceDigest,providerManifest]);
    await seal('milvus',collection,'123','milvus-exclusive-strong-v1',milvusManifest);
    await seal('elasticsearch',indexName,indexUuid,'elasticsearch-write-block-pit-v1',elasticsearchManifest);
    // Test-only fixture: current code deliberately has no production publish.
    await admin.query(`update public.document_publication_attempts set status='published',lease_token=null,lease_expires_at=null
      where tenant_id=$1 and corpus_id=$2 and document_id=$3 and generation=$4`, [tenantId,corpusId,documentId,candidate.generation]);
    await admin.query(`update public.document_publication_heads set active_generation=$4 where tenant_id=$1 and corpus_id=$2 and document_id=$3`,
      [tenantId,corpusId,documentId,candidate.generation]);
    // A second published document proves the budget is applied to compact
    // metadata for the whole corpus, not to all retained source bytes.
    const secondId = `second-${suffix}`;
    const secondCollection = `rag_publication_second_${suffix}`;
    const second = preparePublicationAsset({ ...scope, documentId: secondId,
      sourceBytes: largeSource, sourceIdentityBytes: Buffer.from('second-source'), originalName: 'b.txt',
      contentType: 'text/plain', sourceKind: 'text', embedding: { model: 'test', revision: '1', dimension: 2, indexSchema: 'v1' },
      splitter: { name: 'test', revision: '1', chunkSize: 10, chunkOverlap: 0 },
      chunks: [{ chunkIndex: 0, content: 'second', trustLevel: 'external', embedding: [0.5,0.25] }] });
    await admin.query(`insert into public.document_assets (tenant_id,corpus_id,external_document_id,original_name,content_type,source_hash,metadata)
      values ($1,$2,$3,'b.txt','text/plain',$4,$5::jsonb)`, [tenantId,corpusId,secondId,second.contentVersion,
      JSON.stringify({ source_kind: 'text', persistence_status: 'ready', document: { trustLevel: 'external' } })]);
    const candidate2 = await store.begin({ tenantId,corpusId,documentId: secondId, idempotencyKey:'two',
      contentVersion:second.contentVersion, manifestDigest:second.manifestDigest, physicalCollection:secondCollection,
      requiredProviders:['milvus','elasticsearch'] });
    const attempt2 = await store.claim(candidate2);
    await new PostgresPublicationAssetStore(db).stage(attempt2, second);
    const index2 = `codex-generation-seal-${randomUUID().replaceAll('-', '')}`;
    await admin.query(`insert into public.elasticsearch_publication_operations (operation_id,tenant_id,corpus_id,document_id,generation,
      revision,manifest_digest,physical_collection,content_version,index_name,owner_marker,state,index_uuid)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'bound',$12)`,
      [randomUUID(),tenantId,corpusId,secondId,candidate2.generation,candidate2.revision,second.manifestDigest,secondCollection,second.contentVersion,index2,marker,'uuid_2']);
    const row2 = createPublicationChunk(retrievalScope, { documentId: secondId, generation:Number(candidate2.generation),
      documentVersion:second.contentVersion, trustLevel:'external', chunkIndex:0, content:'second', embedding:[0.5,0.25] }, 2);
    const entry2 = publicationManifestEntry(row2);
    const descriptor2 = JSON.parse(second.manifestJson).chunks[0].descriptorDigest;
    const lexical2 = { chunk_id:row2.id, tenant_id:tenantId, corpus_id:corpusId, document_id:secondId,
      document_version:second.contentVersion, publication_generation:candidate2.generation, trust_level:'external', content:'second', metadata:{} };
    const manifests2 = [`[${canonicalJson({ ...entry2, chunkId:row2.id, descriptorDigest:descriptor2 })}]`,
      `[${canonicalJson({ chunkIndex:0, chunkId:row2.id, digest:generationDocumentDigest(lexical2), descriptorDigest:descriptor2 })}]`];
    for (const [provider,name,id,profile,providerManifest] of [
      ['milvus',secondCollection,'124','milvus-exclusive-strong-v1',manifests2[0]],
      ['elasticsearch',index2,'uuid_2','elasticsearch-write-block-pit-v1',manifests2[1]],
    ]) await admin.query('select public.rag_record_publication_seal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [tenantId,corpusId,secondId,candidate2.generation,candidate2.revision,attempt2.leaseToken,secondCollection,provider,name,id,profile,configDigest,evidenceDigest,providerManifest]);
    await admin.query(`update public.document_publication_attempts set status='published',lease_token=null,lease_expires_at=null
      where tenant_id=$1 and corpus_id=$2 and document_id=$3 and generation=$4`, [tenantId,corpusId,secondId,candidate2.generation]);
    await admin.query(`update public.document_publication_heads set active_generation=$4 where tenant_id=$1 and corpus_id=$2 and document_id=$3`,
      [tenantId,corpusId,secondId,candidate2.generation]);
    await admin.query(`create role "${role}" nologin`); roleCreated = true;
    await admin.query(`grant usage on schema public to "${role}"`);
    await admin.query(`grant execute on function public.rag_read_publication_view(text,text,text[]) to "${role}"`);
    await admin.query(`grant execute on function public.rag_read_publication_source(text,text,text,bigint,bigint,uuid,text,text[],text) to "${role}"`);
    await admin.query(`set role "${role}"`);
    await assert.rejects(admin.query('select public.rag_record_publication_seal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [tenantId,corpusId,documentId,candidate.generation,candidate.revision,attempt.leaseToken,collection,'milvus',collection,'123',
        'milvus-exclusive-strong-v1',configDigest,evidenceDigest,milvusManifest]), /permission denied/);
    const restricted = { query: (text, values) => admin.query(text, values) };
    const view = await readPublicationView(retrievalScope, restricted);
    assert.equal(view.documents.length, 2);
    assert.equal(view.documents.find(item => item.documentId === documentId).indexUuid, indexUuid);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < 100000, 'the corpus view must not return original source bytes or vectors');
    await assertPublicationViewCurrent(view, retrievalScope, restricted);
    const source = await readPublicationSource(view, documentId, retrievalScope, restricted);
    assert.equal(source.bytes.length, largeSource.length);
    assert.equal(source.originalName, 'a.txt');
    await admin.query('reset role');
    const mutateSource = bytes => admin.query(`update public.document_publication_assets set source_bytes=$4 where tenant_id=$1 and corpus_id=$2 and document_id=$3`,
      [tenantId,corpusId,documentId,bytes]);
    await assert.rejects(mutateSource(Buffer.from('tampered')), /cannot be modified/);
    // Deliberately bypass immutability only inside this isolated database to
    // simulate damaged storage, then restore both data and trigger immediately.
    await admin.query('alter table public.document_publication_assets disable trigger document_publication_asset_immutable');
    try {
      await mutateSource(Buffer.from('tampered'));
      await assert.rejects(readPublicationSource(view, documentId, retrievalScope, db), /source|query/i);
      await mutateSource(largeSource);
    } finally { await admin.query('alter table public.document_publication_assets enable trigger document_publication_asset_immutable'); }
    const descriptor = JSON.parse(prepared.chunksJson)[0].descriptorJson;
    const mutateDescriptor = value => admin.query(`update public.document_publication_asset_chunks set payload=jsonb_set(payload,'{descriptorJson}',to_jsonb($4::text))
      where tenant_id=$1 and corpus_id=$2 and document_id=$3`, [tenantId,corpusId,documentId,value]);
    await assert.rejects(mutateDescriptor(descriptor.replace('external','trusted')), /cannot be modified/);
    await admin.query('alter table public.document_publication_asset_chunks disable trigger document_publication_chunk_immutable');
    try {
      await mutateDescriptor(descriptor.replace('external','trusted'));
      await assert.rejects(readPublicationView(retrievalScope, db));
      await mutateDescriptor(descriptor);
    } finally { await admin.query('alter table public.document_publication_asset_chunks enable trigger document_publication_chunk_immutable'); }
    await admin.query(`update public.document_assets set metadata=jsonb_set(metadata,'{retrieval_enabled}','false') where tenant_id=$1 and corpus_id=$2 and external_document_id=$3`,
      [tenantId,corpusId,documentId]);
    await assert.rejects(assertPublicationViewCurrent(view, retrievalScope, db), /changed/);
    await admin.query(`update public.document_assets set metadata=jsonb_set(metadata,'{retrieval_enabled}','true') where tenant_id=$1 and corpus_id=$2 and external_document_id=$3`,
      [tenantId,corpusId,documentId]);
    await admin.query(`delete from public.document_publication_provider_seals where tenant_id=$1 and corpus_id=$2 and document_id=$3 and provider='elasticsearch'`,
      [tenantId,corpusId,documentId]);
    await assert.rejects(readPublicationView(retrievalScope, db), /query|view|publication/i);
  } finally {
    await admin.query('reset role').catch(() => {});
    if (created) {
      await admin.query('delete from public.tenants where id=$1', [tenantId]);
      await admin.query('delete from public.elasticsearch_publication_operations where tenant_id=$1', [tenantId]);
      await admin.query('delete from public.document_publication_collection_reservations where physical_collection=$1', [collection]);
      await admin.query('delete from public.document_publication_collection_reservations where physical_collection=$1', [`rag_publication_second_${suffix}`]);
    }
    if (roleCreated) { await admin.query(`drop owned by "${role}"`); await admin.query(`drop role "${role}"`); }
    admin.release(); await pool.end();
  }
});
