import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import pg from 'pg';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { readSandboxConfig } from '../../../deploy/publication-sandbox/sandbox.mjs';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e?.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(`${s}.ts`, c); throw e;
} } });
const sandboxId = process.env.PUBLICATION_INTENT_SANDBOX_ID;
test('durable journal independently revokes only its Milvus role, repeatedly', { skip: !sandboxId }, async () => {
  const config = readSandboxConfig(sandboxId);
  const db = new pg.Client({ host: '127.0.0.1', port: config.ports.postgres, database: 'publication_sandbox',
    user: 'pub_publisher', password: config.credentials.dbPublisher });
  const admin = new MilvusClient({ address: `127.0.0.1:${config.ports.milvus}`, username: 'root',
    password: config.credentials.milvusAdmin, maxRetries: 0, isGlobal: false, channelOptions: { 'grpc.enable_retries': 0 } });
  const operationId = randomUUID();
  const suffix = randomUUID().replaceAll('-', '');
  const collection = `rag_publication_${suffix}`;
  const role = `pgr_${suffix.slice(-24)}`;
  let cleanup = false;
  try {
    await db.connect();
    await db.query('select public.rag_prepare_publication_intent($1,$2,$3,$4,$5,$6,$7)',
      [operationId, `grant-test-${suffix}`, `grant-test-${suffix}`, `grant-test-${suffix}`,
        `sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`, collection]);
    const { PublicationGrantJournal } = await import('./publication-grant-journal.ts');
    const { reconcileGenerationGrants } = await import('./publication-generation-access.ts');
    const journal = new PublicationGrantJournal({ query: (sql, values) => db.query(sql, values) });
    const created = await admin.createRole({ roleName: role });
    assert.equal(created.error_code, 'Success', `Role creation failed: ${created.reason}`);
    for (const privilege of ['CollectionReadWrite', 'CreateIndex', 'Load']) {
      const result = await admin.grantPrivilegeV2({ role, privilege, db_name: 'default', collection_name: collection });
      assert.equal(result.error_code, 'Success');
    }
    const options = { operationId, admin, readIntent: journal.readIntent.bind(journal), recordEvent: journal.recordEvent.bind(journal) };
    for (let i = 0; i < 2; i++) assert.deepEqual(await reconcileGenerationGrants(options),
      { status: 'unknown', observedNoGrants: true, productionAuthorized: false, inFlightDrained: false });
    cleanup = true;
  } finally {
    if (cleanup) assert.equal((await admin.dropRole({ roleName: role })).error_code, 'Success');
    await admin.closeConnection();
    await db.end();
  }
});
