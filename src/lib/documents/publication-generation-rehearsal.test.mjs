import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
  throw error;
} } });
const { rehearseGenerationWrite } = await import('./publication-generation-rehearsal.ts');
const { preparePublicationAsset } = await import('./publication-asset-store.ts');
const scope = { tenantId: 't', corpusId: 'c', enforceIsolation: true, allowedTrustLevels: ['external'] };
const asset = preparePublicationAsset({ tenantId: 't', corpusId: 'c', documentId: 'd', sourceBytes: Buffer.from('raw'),
  sourceIdentityBytes: Buffer.from('body'), originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text',
  embedding: { model: 'm', revision: 'r', dimension: 2, indexSchema: 'v1' },
  splitter: { name: 'recursive', revision: 'v1', chunkSize: 400, chunkOverlap: 40 },
  chunks: [{ chunkIndex: 0, content: 'body', trustLevel: 'external', embedding: [0.25, -0.5], metadata: {} }] });
const attempt = { tenantId: 't', corpusId: 'c', documentId: 'd', generation: '1', revision: '1',
  manifestDigest: asset.manifestDigest, physicalCollection: `rag_publication_${'a'.repeat(32)}`,
  leaseToken: '00000000-0000-4000-8000-000000000001' };
const ok = { error_code: 'Success', code: 0 };

function fixture(failIndex = false) {
  const calls = []; let rows = []; let queries = 0;
  const op = name => async () => { calls.push(name); return ok; };
  const admin = { createRole: op('role'), createUser: op('user'), addUserToRole: op('membership'), grantPrivilegeV2: op('grant'),
    createCollection: op('collection'), flushSync: op('flush'), revokePrivilegeV2: op('revoke'),
    listGrants: async () => { calls.push('list'); return { status: ok, entities: [] }; } };
  const writer = { createIndex: async () => { calls.push('index'); if (failIndex) throw new Error('failed'); return ok; },
    insert: async ({ data }) => { calls.push('insert'); rows = data; return { status: ok }; }, loadCollectionSync: op('load'),
    closeConnection: op('close') };
  const reader = { config: { maxRetries: 0 }, channelOptions: { 'grpc.enable_retries': 0 }, channelPool: {}, isGlobal: false,
    describeCollection: async () => ({ status: ok, collection_name: attempt.physicalCollection, collectionID: '123', schema: { name: attempt.physicalCollection } }),
    query: async request => { calls.push('read'); if (request.output_fields[0] === 'count(*)') return { status: ok, data: [{ 'count(*)': rows.length }] };
      return { status: ok, data: queries++ === 0 ? rows : [] }; } };
  return { calls, input: { scope, attempt, assets: { readStaged: async () => { calls.push('asset'); return asset; } },
    access: { admin, address: 'localhost:19530', checkLease: async () => true, persistIntent: async () => { calls.push('intent'); },
      createClient: () => writer }, reader, assertLease: async () => {}, timeoutMs: 10000 } };
}

test('recomputes the staged asset, serializes writes, revokes and independently reads back without issuing a seal', async () => {
  const f = fixture(); const result = await rehearseGenerationWrite(f.input);
  assert.equal(result.productionAuthorized, false); assert.equal(result.count, 1);
  for (const [before, after] of [['asset', 'intent'], ['index', 'insert'], ['insert', 'flush'], ['flush', 'load'],
    ['load', 'revoke'], ['revoke', 'read']]) assert.ok(f.calls.indexOf(before) < f.calls.indexOf(after), `${before} before ${after}`);
});

test('a failed write stops before any subsequent write, revoke or readback', async () => {
  const f = fixture(true);
  await assert.rejects(rehearseGenerationWrite(f.input), /abandoned/);
  assert.ok(f.calls.includes('index'));
  for (const operation of ['insert', 'flush', 'load', 'revoke', 'read']) assert.equal(f.calls.includes(operation), false);
});

test('isolated PostgreSQL staged asset and independent Milvus reader are exercised end to end',
  { skip: process.env.PUBLICATION_SANDBOX_ALLOW_MUTATIONS !== '1' || !/^[a-f0-9]{24}$/.test(process.env.PUBLICATION_SANDBOX_ID ?? ''), timeout: 180000 }, async () => {
  const { randomUUID } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { default: pg } = await import('pg');
  const { MilvusClient } = await import('@zilliz/milvus2-sdk-node');
  const { readSandboxConfig } = await import('../../../deploy/publication-sandbox/sandbox.mjs');
  const { PostgresDocumentPublicationStore } = await import('./publication-control-cas.ts');
  const { PostgresPublicationAssetStore } = await import('./publication-asset-store.ts');
  const cfg = readSandboxConfig(process.env.PUBLICATION_SANDBOX_ID);
  const db = user => new pg.Client({ host: '127.0.0.1', port: cfg.ports.postgres, database: 'publication_sandbox',
    user, password: user === 'pub_migration' ? cfg.credentials.dbMigration : cfg.credentials.dbPublisher });
  const owner = db('pub_migration'); const publisher = db('pub_publisher');
  const suffix = randomUUID().replaceAll('-', '');
  const scoped = { tenantId: `t-${suffix}`, corpusId: `c-${suffix}`, documentId: `d-${suffix}` };
  const collection = `rag_publication_${suffix}`;
  const config = { address: `127.0.0.1:${cfg.ports.milvus}`, maxRetries: 0, isGlobal: false,
    channelOptions: { 'grpc.enable_retries': 0 } };
  const admin = new MilvusClient({ ...config, username: 'root', password: cfg.credentials.milvusAdmin });
  const reader = new MilvusClient({ ...config, username: 'pub_reader', password: cfg.credentials.milvusReader });
  let identity;
  await owner.connect(); await publisher.connect();
  try {
    await owner.query('insert into public.tenants (id,name) values ($1,$2)', [scoped.tenantId, 'Generation test']);
    await owner.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'integration')", [scoped.tenantId, scoped.corpusId, 'Generation test']);
    const prepared = preparePublicationAsset({ ...scoped, sourceBytes: Buffer.from('source'), sourceIdentityBytes: Buffer.from('body'),
      originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text',
      embedding: { model: 'm', revision: 'r', dimension: 2, indexSchema: 'v1' },
      splitter: { name: 'recursive', revision: 'v1', chunkSize: 400, chunkOverlap: 40 },
      chunks: [{ chunkIndex: 0, content: 'body', trustLevel: 'external', embedding: [0.25, -0.5], metadata: {} }] });
    const store = new PostgresDocumentPublicationStore(publisher); const assets = new PostgresPublicationAssetStore(publisher);
    const claimed = await store.claim(await store.begin({ ...scoped, idempotencyKey: randomUUID(),
      contentVersion: prepared.contentVersion, manifestDigest: prepared.manifestDigest, physicalCollection: collection,
      requiredProviders: ['milvus', 'elasticsearch'] }), 120000);
    await assets.stage(claimed, prepared);
    const check = async () => { await store.renew(claimed, 120000); return true; };
    const result = await rehearseGenerationWrite({ scope: { ...scoped, enforceIsolation: true, allowedTrustLevels: ['external'] },
      attempt: claimed, assets, reader, timeoutMs: 30000, assertLease: async () => { await check(); },
      access: { admin, address: config.address, checkLease: check, timeoutMs: 30000, persistIntent: async value => {
        identity = value;
        await writeFile(join(cfg.path, `generation-rehearsal-${suffix}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      } } });
    assert.equal(result.count, 1); assert.equal(result.productionAuthorized, false);
    await store.abandon(claimed);
    // Leave all test resources in place: authorization was revoked but the
    // backend does not provide a general proof that older RPCs drained.
    assert.equal(identity.collection, collection);
  } finally {
    await Promise.all([publisher.end(), owner.end(), admin.closeConnection(), reader.closeConnection()]);
  }
});
