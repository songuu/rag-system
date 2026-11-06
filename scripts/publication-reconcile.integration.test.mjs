import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { reconcileSandbox } from './publication-reconcile.mjs';

test('real read-only reconciliation verifies three backends and leaves publication heads unchanged', {
  skip: process.env.PUBLICATION_RECONCILE !== '1', timeout: 180000,
}, async () => {
  const input = { sandboxId: process.env.PUBLICATION_RECONCILE_SANDBOX,
    tenantId: process.env.PUBLICATION_RECONCILE_TENANT, corpusId: process.env.PUBLICATION_RECONCILE_CORPUS };
  const { readSandboxConfig } = await import('../deploy/publication-sandbox/sandbox.mjs');
  const { default: pg } = await import('pg');
  const config = readSandboxConfig(input.sandboxId);
  const client = new pg.Client({ host: '127.0.0.1', port: config.ports.postgres, database: config.database,
    user: 'pub_migration', password: config.credentials.dbMigration, options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 5000, query_timeout: 10000 });
  await client.connect();
  const readHeads = async () => (await client.query(`select row_to_json(h) as head from public.document_publication_heads h
    where tenant_id=$1 and corpus_id=$2 order by document_id`, [input.tenantId, input.corpusId])).rows;
  try {
    const before = await readHeads();
    assert.ok(before.length > 0, 'an already published fixture is required; this test never creates one');
    const report = await reconcileSandbox(input);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.outcome, 'verified');
    assert.equal(report.currentHeads, 'unchanged');
    assert.ok(report.documents.length > 0);
    for (const document of report.documents) {
      for (const backend of ['elasticsearch', 'milvus', 'neo4j']) assert.equal(document.backends[backend].status, 'verified');
      assert.ok(document.backends.elasticsearch.count > 0); assert.ok(document.backends.milvus.count > 0);
      assert.ok(document.backends.neo4j.passages > 0);
    }
    assert.deepEqual(await readHeads(), before);
    writeFileSync(join(config.path, `reconciliation-report-${randomUUID()}.json`), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  } finally { await client.end(); }
});
