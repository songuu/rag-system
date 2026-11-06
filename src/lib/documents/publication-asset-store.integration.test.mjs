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

test('immutable assets are scoped, lease-fenced, idempotent and preserved across generations', {
  skip: enabled ? false : 'Set PUBLICATION_TEST_DATABASE_URL and PUBLICATION_TEST_ALLOW_MUTATIONS=1 for an isolated database.',
}, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const admin = await pool.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const role = `publication_asset_test_${suffix}`;
  const scope = { tenantId: `asset-tenant-${suffix}`, corpusId: `asset-corpus-${suffix}`, documentId: `asset-document-${suffix}` };
  const collection = label => `publication_${suffix}_${label}`;
  const reserved = ['first', 'second', 'many', 'after_revoke'].map(collection);
  let created = false;
  let roleCreated = false;
  try {
    const database = await admin.query('select current_database() as name, to_regclass($1) as table_name', ['public.document_publication_assets']);
    assert.match(database.rows[0].name, /^rag_publication_test_[a-z0-9_]+$/, 'A dedicated publication test database is required.');
    assert.ok(database.rows[0].table_name, 'Apply publication-control and publication asset migrations first.');
    await admin.query('insert into public.tenants (id,name) values ($1,$2)', [scope.tenantId, 'Asset integration test']);
    created = true;
    await admin.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'integration')",
      [scope.tenantId, scope.corpusId, 'Asset test']);
    await admin.query(`create role "${role}" nologin`);
    roleCreated = true;
    await admin.query(`grant usage on schema public to "${role}"`);
    await admin.query(`grant execute on function public.rag_publication_control(text,text,text,text,jsonb) to "${role}"`);
    await admin.query(`grant execute on function public.rag_stage_publication_asset(text,text,text,bigint,bigint,uuid,text,text,text,bytea,bytea,jsonb) to "${role}"`);
    await admin.query(`grant execute on function public.rag_read_staged_publication_asset(text,text,text,bigint,bigint,uuid,text) to "${role}"`);
    const wrap = () => ({
      async query(sql, values) {
        const connection = await pool.connect();
        try {
          await connection.query('begin');
          await connection.query(`set local role "${role}"`);
          const result = await connection.query(sql, values);
          await connection.query('commit');
          return result;
        } catch (error) { await connection.query('rollback'); throw error; }
        finally { connection.release(); }
      },
    });
    const { PostgresDocumentPublicationStore } = await import('./publication-control.ts');
    const { PostgresPublicationAssetStore, preparePublicationAsset } = await import('./publication-asset-store.ts');
    const control = new PostgresDocumentPublicationStore(wrap());
    const assets = new PostgresPublicationAssetStore(wrap());
    const inputFor = source => ({ ...scope, sourceBytes: Buffer.from(`original:${source}`),
      sourceIdentityBytes: Buffer.from(source), originalName: 'document.pdf', contentType: 'application/pdf', sourceKind: 'pdf',
      embedding: { model: 'model-a', revision: 'r1', dimension: 2, indexSchema: 'schema-v1' },
      splitter: { name: 'recursive', revision: 'v1', chunkSize: 400, chunkOverlap: 40 },
      chunks: [{ chunkIndex: 0, content: source, trustLevel: 'external', startOffset: 0,
        endOffset: source.length, embedding: [0.25, -0.5] }] });
    const prepare = source => preparePublicationAsset(inputFor(source));
    const firstAsset = prepare('version one');
    const first = await control.claim(await control.begin({ ...scope, idempotencyKey: 'first',
      contentVersion: firstAsset.contentVersion, manifestDigest: firstAsset.manifestDigest,
      physicalCollection: collection('first'), requiredProviders: ['milvus', 'elasticsearch'] }));
    await assets.stage(first, firstAsset);
    await assets.stage(first, firstAsset);
    const staged = await assets.readStaged(first);
    assert.equal(staged.sourceBytes.toString(), 'original:version one');
    assert.equal(JSON.parse(staged.chunksJson)[0].content, 'version one');
    await assert.rejects(assets.readStaged({ ...first, leaseToken: randomUUID() }));
    const storedChunks = await admin.query('select payload from public.document_publication_asset_chunks where tenant_id=$1 and corpus_id=$2 and document_id=$3',
      [scope.tenantId, scope.corpusId, scope.documentId]);
    assert.equal(storedChunks.rows.length, 1);
    assert.equal(storedChunks.rows[0].payload.content, 'version one');
    assert.equal(Buffer.from(storedChunks.rows[0].payload.embeddingBase64, 'base64').readFloatLE(0), 0.25);
    const changedPayload = JSON.parse(firstAsset.chunksJson);
    changedPayload[0].content = 'tampered';
    await assert.rejects(assets.stage(first, { ...firstAsset, chunksJson: JSON.stringify(changedPayload) }));
    const changedVector = JSON.parse(firstAsset.chunksJson);
    changedVector[0].embeddingBase64 = Buffer.alloc(8).toString('base64');
    await assert.rejects(assets.stage(first, { ...firstAsset, chunksJson: JSON.stringify(changedVector) }));
    const changedMetadata = JSON.parse(firstAsset.chunksJson);
    changedMetadata[0].metadataJson = '{"tampered":true}';
    await assert.rejects(assets.stage(first, { ...firstAsset, chunksJson: JSON.stringify(changedMetadata) }));
    const changedDescriptor = JSON.parse(firstAsset.chunksJson);
    const descriptor = JSON.parse(changedDescriptor[0].descriptorJson);
    descriptor.trustLevel = 'trusted';
    changedDescriptor[0].descriptorJson = JSON.stringify(descriptor);
    await assert.rejects(assets.stage(first, { ...firstAsset, chunksJson: JSON.stringify(changedDescriptor) }));
    const before = await admin.query('select generation::text, source_bytes from public.document_publication_assets where tenant_id=$1 and corpus_id=$2 and document_id=$3',
      [scope.tenantId, scope.corpusId, scope.documentId]);
    assert.equal(before.rows.length, 1);
    assert.equal(before.rows[0].source_bytes.toString(), 'original:version one');
    await assert.rejects(wrap().query('select * from public.document_publication_assets', []), error => error.code === '42501');
    await assert.rejects(admin.query('update public.document_publication_assets set source_bytes=$4 where tenant_id=$1 and corpus_id=$2 and document_id=$3',
      [scope.tenantId, scope.corpusId, scope.documentId, Buffer.from('tampered')]), error => error.code === '23514');
    const secondAsset = prepare('version two');
    const second = await control.claim(await control.begin({ ...scope, idempotencyKey: 'second',
      contentVersion: secondAsset.contentVersion, manifestDigest: secondAsset.manifestDigest,
      physicalCollection: collection('second'), requiredProviders: ['milvus', 'elasticsearch'] }));
    await assert.rejects(assets.stage(first, firstAsset));
    await assert.rejects(assets.readStaged(first));
    await assets.stage(second, secondAsset);
    const rows = await admin.query('select generation::text, source_bytes from public.document_publication_assets where tenant_id=$1 and corpus_id=$2 and document_id=$3 order by generation',
      [scope.tenantId, scope.corpusId, scope.documentId]);
    assert.deepEqual(rows.rows.map(row => row.source_bytes.toString()), ['original:version one', 'original:version two']);
    const manyInput = inputFor('long source');
    manyInput.chunks = Array.from({ length: 1000 }, (_, chunkIndex) => ({ chunkIndex, content: `chunk ${chunkIndex}`,
      trustLevel: 'external', source: `https://example.test/${'a'.repeat(4800)}`, embedding: [0.25, -0.5] }));
    const manyAsset = preparePublicationAsset(manyInput);
    const many = await control.claim(await control.begin({ ...scope, idempotencyKey: 'many',
      contentVersion: manyAsset.contentVersion, manifestDigest: manyAsset.manifestDigest,
      physicalCollection: collection('many'), requiredProviders: ['milvus', 'elasticsearch'] }));
    await assets.stage(many, manyAsset);
    const manyStaged = await assets.readStaged(many);
    assert.equal(JSON.parse(manyStaged.chunksJson).length, 1000);
    await control.revoke({ ...scope, expectedRevision: many.revision });
    await assert.rejects(assets.stage(second, secondAsset));
    // The production control plane requires an explicit authorized restore
    // against an independently enabled source before allocating another attempt.
    await assert.rejects(control.begin({ ...scope, idempotencyKey: 'after-revoke',
      contentVersion: secondAsset.contentVersion, manifestDigest: secondAsset.manifestDigest,
      physicalCollection: collection('after_revoke'), requiredProviders: ['milvus', 'elasticsearch'] }),
    error => error.code === 'PUBLICATION_CONFLICT');
  } finally {
    if (created) await admin.query('delete from public.tenants where id=$1', [scope.tenantId]);
    if (created) await admin.query('delete from public.document_publication_collection_reservations where physical_collection=any($1::text[])', [reserved]);
    if (roleCreated) { await admin.query(`drop owned by "${role}"`); await admin.query(`drop role "${role}"`); }
    admin.release();
    await pool.end();
  }
});
