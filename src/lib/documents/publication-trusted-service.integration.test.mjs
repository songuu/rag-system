import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
  throw error;
} } });

test('invalid trusted configuration is rejected before a queue claim', async () => {
  const { TrustedPublicationService } = await import('./publication-trusted-service.ts');
  const service = new TrustedPublicationService({ postgres: {}, timeoutMs: 1000,
    elasticsearch: { node: 'http://localhost', ca: '', admin: { username: 'admin', password: '' }, reader: 'r', writer: { username: 'w', password: '' }, sealer: { username: 's', password: '' } },
    milvus: { address: 'localhost', admin: { username: 'a', password: '' }, reader: { username: 'r', password: '' } } });
  await assert.rejects(service.publishNext(randomUUID()), /Invalid trusted publisher configuration|requires explicit local/);
  await assert.rejects(service.publishNext('invalid-id'), /Invalid trusted publisher operation identity/);
});

test('remote, overridden and ambiguous endpoints are rejected before opening clients', async () => {
  const { TrustedPublicationService } = await import('./publication-trusted-service.ts');
  const valid = () => ({ postgres: { host: '127.0.0.1', port: 5432, user: 'p', password: 'x', database: 'd' }, timeoutMs: 1000,
    elasticsearch: { node: 'https://127.0.0.1:9200', ca: 'unused', admin: { username: 'a', password: 'x' }, reader: 'r',
      writer: { username: 'w', password: 'x' }, sealer: { username: 's', password: 'x' } },
    milvus: { address: '127.0.0.1:19530', admin: { username: 'a', password: 'x' }, reader: { username: 'r', password: 'x' } } });
  for (const mutate of [
    cfg => { cfg.milvus.address = 'remote.example:19530'; },
    cfg => { cfg.milvus.address = 'localhost.evil.example:19530'; },
    cfg => { cfg.milvus.address = '127.0.0.1:0'; },
    cfg => { cfg.postgres.host = 'remote.example'; },
    cfg => { cfg.postgres.host = '/tmp'; },
    cfg => { cfg.postgres.connectionString = 'postgres://example.invalid/db'; },
    cfg => { cfg.postgres.stream = () => { throw new Error('must never be called'); }; },
    cfg => { cfg.postgres.hostaddr = '198.51.100.9'; },
    cfg => { cfg.postgres.application_name = 'externally controlled'; },
    cfg => { delete cfg.postgres.user; },
    cfg => { delete cfg.postgres.password; },
    cfg => { delete cfg.postgres.database; },
    cfg => { delete cfg.postgres.host; },
  ]) {
    const cfg = valid(); mutate(cfg);
    await assert.rejects(new TrustedPublicationService(cfg).publishNext(randomUUID()), /requires explicit local/);
  }
});

test('Milvus credentials cannot override endpoint or retry policy', async () => {
  const { TrustedPublicationService } = await import('./publication-trusted-service.ts');
  const valid = () => ({ postgres: { host: '127.0.0.1', port: 5432, user: 'p', password: 'x', database: 'd' }, timeoutMs: 1000,
    elasticsearch: { node: 'https://127.0.0.1:9200', ca: 'unused', admin: { username: 'a', password: 'x' }, reader: 'r',
      writer: { username: 'w', password: 'x' }, sealer: { username: 's', password: 'x' } },
    milvus: { address: '127.0.0.1:19530', admin: { username: 'a', password: 'x' }, reader: { username: 'r', password: 'x' } } });
  for (const mutate of [
    cfg => { cfg.milvus.admin.maxRetries = 3; },
    cfg => { cfg.milvus.reader.maxRetries = 3; },
    cfg => { cfg.milvus.admin.address = 'remote.example:19530'; },
    cfg => { cfg.milvus.reader.address = 'remote.example:19530'; },
    cfg => { cfg.milvus.reader.channelOptions = { 'grpc.enable_retries': 1 }; },
  ]) {
    const cfg = valid(); mutate(cfg);
    await assert.rejects(new TrustedPublicationService(cfg).publishNext(randomUUID()), /Invalid trusted publisher configuration/);
  }
});

test('isolated private publisher performs a real PG ES Milvus atomic publication',
  { skip: process.env.PUBLICATION_SANDBOX_ALLOW_MUTATIONS !== '1' || !/^[a-f0-9]{24}$/.test(process.env.PUBLICATION_SANDBOX_ID ?? ''), timeout: 180000 }, async () => {
  const { default: pg } = await import('pg');
  const { readSandboxConfig } = await import('../../../deploy/publication-sandbox/sandbox.mjs');
  const { preparePublicationAsset } = await import('./publication-asset-store.ts');
  const { PublicationRequestQueue } = await import('./publication-request-queue.ts');
  const { TrustedPublicationService } = await import('./publication-trusted-service.ts');
  const cfg = readSandboxConfig(process.env.PUBLICATION_SANDBOX_ID);
  const db = (user, password) => new pg.Client({ host: '127.0.0.1', port: cfg.ports.postgres, database: 'publication_sandbox', user, password });
  const owner = db('pub_migration', cfg.credentials.dbMigration); const app = db('pub_app', cfg.credentials.dbApp);
  await owner.connect(); await app.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const scope = { tenantId: `t-${suffix}`, corpusId: `c-${suffix}`, documentId: `d-${suffix}` };
  try {
    await owner.query('insert into public.tenants (id,name) values ($1,$2)', [scope.tenantId, 'Trusted publisher test']);
    await owner.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'integration')", [scope.tenantId, scope.corpusId, 'Trusted publisher test']);
    const asset = preparePublicationAsset({ ...scope, sourceBytes: Buffer.from('source'), sourceIdentityBytes: Buffer.from('body'),
      originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text', embedding: { model: 'm', revision: 'r', dimension: 2, indexSchema: 'milvus-publication/v1' },
      splitter: { name: 'recursive', revision: 'v1', chunkSize: 400, chunkOverlap: 40 },
      chunks: [{ chunkIndex: 0, content: 'body', trustLevel: 'external', embedding: [0.25, -0.5], metadata: {} }] });
    const requestId = randomUUID(); await new PublicationRequestQueue(app).enqueue(requestId, asset);
    const service = new TrustedPublicationService({ postgres: { host: '127.0.0.1', port: cfg.ports.postgres, database: 'publication_sandbox', user: 'pub_publisher', password: cfg.credentials.dbPublisher },
      elasticsearch: { node: `https://127.0.0.1:${cfg.ports.elasticsearch}`, ca: cfg.ca, admin: { username: 'elastic', password: cfg.credentials.elasticAdmin }, reader: 'pub_reader',
        writer: { username: 'pub_writer', password: cfg.credentials.esWriter }, sealer: { username: 'pub_sealer', password: cfg.credentials.esSealer } },
      milvus: { address: `127.0.0.1:${cfg.ports.milvus}`, admin: { username: 'root', password: cfg.credentials.milvusAdmin }, reader: { username: 'pub_reader', password: cfg.credentials.milvusReader } }, timeoutMs: 30000 });
    await service.publishNext(randomUUID());
    const result = await new PublicationRequestQueue(app).result(requestId, scope);
    assert.equal(result.currentlyActive, true); assert.equal(result.attemptState, 'published');
  } finally { await Promise.all([app.end(), owner.end()]); }
});

test('isolated service leaves a request queued if an unexpected Milvus principal exists',
  { skip: process.env.PUBLICATION_SANDBOX_ALLOW_MUTATIONS !== '1' || !/^[a-f0-9]{24}$/.test(process.env.PUBLICATION_SANDBOX_ID ?? ''), timeout: 180000 }, async () => {
  const { default: pg } = await import('pg');
  const { readSandboxConfig } = await import('../../../deploy/publication-sandbox/sandbox.mjs');
  const { preparePublicationAsset } = await import('./publication-asset-store.ts');
  const { PublicationRequestQueue } = await import('./publication-request-queue.ts');
  const { TrustedPublicationService } = await import('./publication-trusted-service.ts');
  const { MilvusClient } = await import('@zilliz/milvus2-sdk-node');
  const cfg = readSandboxConfig(process.env.PUBLICATION_SANDBOX_ID);
  const db = (user, password) => new pg.Client({ host: '127.0.0.1', port: cfg.ports.postgres,
    database: 'publication_sandbox', user, password });
  const owner = db('pub_migration', cfg.credentials.dbMigration);
  const app = db('pub_app', cfg.credentials.dbApp);
  await owner.connect(); await app.connect();
  const suffix = randomUUID().replaceAll('-', '');
  const unexpectedUser = `u_${suffix.slice(0, 24)}`;
  const milvusAdmin = new MilvusClient({ address: `127.0.0.1:${cfg.ports.milvus}`, username: 'root', password: cfg.credentials.milvusAdmin,
    maxRetries: 0, isGlobal: false, channelOptions: { 'grpc.enable_retries': 0 } });
  let userCreated = false;
  const scope = { tenantId: `t-${suffix}`, corpusId: `c-${suffix}`, documentId: `d-${suffix}` };
  try {
    await owner.query('insert into public.tenants (id,name) values ($1,$2)', [scope.tenantId, 'Trusted publisher test']);
    await owner.query("insert into public.corpora (tenant_id,id,name,source_kind) values ($1,$2,$3,'integration')", [scope.tenantId, scope.corpusId, 'Trusted publisher test']);
    const asset = preparePublicationAsset({ ...scope, sourceBytes: Buffer.from('source'), sourceIdentityBytes: Buffer.from('body'),
      originalName: 'a.txt', contentType: 'text/plain', sourceKind: 'text',
      embedding: { model: 'm', revision: 'r', dimension: 2, indexSchema: 'milvus-publication/v1' },
      splitter: { name: 'recursive', revision: 'v1', chunkSize: 400, chunkOverlap: 40 },
      chunks: [{ chunkIndex: 0, content: 'body', trustLevel: 'external', embedding: [0.25, -0.5], metadata: {} }] });
    const requestId = randomUUID();
    await new PublicationRequestQueue(app).enqueue(requestId, asset);
    const added = await milvusAdmin.createUser({ username: unexpectedUser, password: `Aa1${suffix}` });
    assert.equal((added.status ?? added).error_code, 'Success'); userCreated = true;
    const service = new TrustedPublicationService({
      postgres: { host: '127.0.0.1', port: cfg.ports.postgres, database: 'publication_sandbox', user: 'pub_publisher', password: cfg.credentials.dbPublisher },
      elasticsearch: { node: `https://127.0.0.1:${cfg.ports.elasticsearch}`, ca: cfg.ca, admin: { username: 'elastic', password: cfg.credentials.elasticAdmin }, reader: 'pub_reader',
        writer: { username: 'pub_writer', password: cfg.credentials.esWriter }, sealer: { username: 'pub_sealer', password: cfg.credentials.esSealer } },
      milvus: { address: `127.0.0.1:${cfg.ports.milvus}`, admin: { username: 'root', password: cfg.credentials.milvusAdmin },
        reader: { username: 'pub_reader', password: cfg.credentials.milvusReader } }, timeoutMs: 30000 });
    await assert.rejects(service.publishNext(randomUUID()), /inventory is not isolated/);
    const result = await new PublicationRequestQueue(app).result(requestId, scope);
    assert.equal(result.queueState, 'queued');
    assert.equal(result.currentlyActive, false);
  } finally {
    if (userCreated) { const removed = await milvusAdmin.deleteUser({ username: unexpectedUser }); assert.equal((removed.status ?? removed).error_code, 'Success'); }
    await Promise.all([app.end(), owner.end(), milvusAdmin.closeConnection()]);
  }
});
