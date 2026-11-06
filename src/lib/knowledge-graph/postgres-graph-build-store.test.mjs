import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { createRetrievalScope } = await import('../security/retrieval-scope.ts');
const { PostgresKnowledgeGraphBuildJobStore } = await import('./postgres-graph-build-store.ts');
const { PostgresQueryError } = await import('../postgres/client.ts');
const { KnowledgeGraphError } = await import('./contracts.ts');

const scope = createRetrievalScope({
  tenantId: 'tenant-a', corpusId: 'corpus-a', allowedTrustLevels: ['reviewed'], enforceIsolation: true,
});
const id = '5bc631c8-4c86-4b87-af1f-055321563402';
const lease = 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87';
const publicationManifest = () => ({ schemaVersion: 'kg-build-publication-manifest/v1', tenantId: scope.tenantId, corpusId: scope.corpusId,
  graphVersion: 'graph-v1', artifactDigest: `sha256:${'a'.repeat(64)}`,
  documents: [{ documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed' }] });

function row(overrides = {}) {
  return {
    id, tenant_id: 'tenant-a', corpus_id: 'corpus-a', graph_version: 'graph-v1',
    status: 'queued', progress: 0, artifact_digest: null, error_code: null,
    error_message: null, metadata: {}, attempts: 0, lease_token: null,
    lease_expires_at: null, created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z', ...overrides,
  };
}

function fakeClient(responses) {
  const calls = [];
  const transactions = [];
  const client = {
    calls,
    transactions,
    async query(text, values) {
      calls.push({ text, values });
      if (/pg_advisory_xact_lock/i.test(text)) return { rows: [{}], rowCount: 1 };
      return responses.shift();
    },
    async withTransaction(operation, work) {
      transactions.push(operation);
      return work(client);
    },
  };
  return client;
}

test('enqueue is idempotent for one scope and graph version', async () => {
  const client = fakeClient([{ rows: [row()], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  assert.equal((await store.enqueue(scope, 'graph-v1')).status, 'queued');
  assert.deepEqual(client.transactions, ['enqueue knowledge graph build job']);
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[0].text, /pg_advisory_xact_lock/i);
  assert.doesNotMatch(client.calls[0].text, /chr\(0\)/i);
  assert.deepEqual(client.calls[0].values, ['tenant-a', 'corpus-a']);
  assert.match(client.calls[1].text, /on conflict \(tenant_id, corpus_id, graph_version\)/i);
  assert.doesNotMatch(client.calls[1].text, /pg_advisory_xact_lock/i);
  assert.match(client.calls[1].text, /status in \('queued', 'running', 'staged', 'validated'\)/i);
  assert.deepEqual(client.calls[1].values.slice(0, 3), ['tenant-a', 'corpus-a', 'graph-v1']);
});

test('enqueue atomically retries a failed graph version without reviving cancelled work', async () => {
  const client = fakeClient([{ rows: [row()], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);

  await store.enqueue(scope, 'graph-v1', { trigger: 'retry' });

  const sql = client.calls[1].text;
  assert.match(sql, /when public\.graph_build_jobs\.status = 'failed' then 'queued'/i);
  assert.match(sql, /when public\.graph_build_jobs\.status = 'failed' then 0/i);
  assert.match(sql, /when public\.graph_build_jobs\.status = 'failed' then excluded\.metadata/i);
  assert.match(sql, /when public\.graph_build_jobs\.status = 'failed' then null/i);
  assert.doesNotMatch(sql, /status = 'cancelled' then 'queued'/i);
});

test('atomically rejects a full per-scope build queue', async () => {
  const client = fakeClient([{ rows: [], rowCount: 0 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  await assert.rejects(
    store.enqueue(scope, 'graph-v2', {}, { maxPendingJobs: 2 }),
    error => error.code === 'KNOWLEDGE_GRAPH_CAPACITY'
  );
  assert.equal(client.calls[1].values[4], 2);
});

test('status lookup is scoped to the authenticated tenant and corpus', async () => {
  const client = fakeClient([{ rows: [row()], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);

  assert.equal((await store.get(scope, id))?.id, id);
  assert.deepEqual(client.calls[0].values, [id, 'tenant-a', 'corpus-a']);
  assert.match(client.calls[0].text, /tenant_id = \$2 and corpus_id = \$3/i);
  assert.match(client.calls[0].text, /metadata\s*-\s*'graphExtractionCheckpoint'/);
});

test('document sources require visible assets in the authorized trust scope', async () => {
  const source = { asset_id: id, document_id: 'doc-a', document_version: 'v1', source_name: 'a.txt', content_type: 'text/plain', chunk_count: 2, trust_level: 'reviewed', updated_at: '2026-09-07T00:00:00.000Z' };
  const client = fakeClient([{ rows: [source] }, { rows: [source] }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  assert.equal((await store.listDocumentSources(scope))[0].trustLevel, 'reviewed');
  assert.equal((await store.findDocumentSource(scope, { documentId: 'doc-a', documentVersion: 'v1' })).trustLevel, 'reviewed');
  for (const call of client.calls) {
    assert.match(call.text, /retrieval_enabled/);
    assert.match(call.text, /lifecycle/);
    assert.match(call.text, /any\(\$[45]::text\[\]\)/);
    assert.deepEqual(call.values.at(-1), ['reviewed']);
  }
});

test('the latest document build is read only within its authenticated document scope', async () => {
  const client = fakeClient([{ rows: [row({ status: 'failed' })], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  const identity = { documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed' };
  const result = await store.findLatestDocumentBuild(scope, identity);
  assert.equal(result.status, 'failed');
  assert.deepEqual(client.calls[0].values, ['tenant-a', 'corpus-a', 'doc-a', 'v1', 'reviewed']);
  assert.match(client.calls[0].text, /tenant_id = \$1 and corpus_id = \$2/i);
  assert.match(client.calls[0].text, /documentIdentity,documentId/);
  assert.match(client.calls[0].text, /metadata\s*-\s*'graphExtractionCheckpoint'/);
  await assert.rejects(store.findLatestDocumentBuild(scope, { ...identity, trustLevel: 'external' }), /scope/i);
});

test('a failed document job resumes under the scoped queue lock without replacing checkpoints', async () => {
  const client = fakeClient([{ rows: [row({ status: 'queued', progress: 0.4 })], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  const identity = { documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed' };
  const result = await store.resumeFailedDocumentBuild(scope, identity, id, { maxPendingJobs: 3 });
  assert.equal(result.progress, 0.4);
  assert.match(client.calls[0].text, /pg_advisory_xact_lock/i);
  assert.match(client.calls[1].text, /status = 'failed'/i);
  assert.match(client.calls[1].text, /documentIdentity,documentVersion/);
  assert.doesNotMatch(client.calls[1].text, /metadata\s*=/i);
  assert.deepEqual(client.calls[1].values, [id, 'tenant-a', 'corpus-a', 'doc-a', 'v1', 'reviewed', 3]);
});

test('queue capacity and resume conflicts remain business errors through the PostgreSQL transaction wrapper', async () => {
  for (const operation of ['enqueue', 'resume']) {
    const client = fakeClient([{ rows: [], rowCount: 0 }]);
    client.withTransaction = async (name, work) => {
      try { return await work(client); } catch (error) { throw new PostgresQueryError(name, error); }
    };
    const store = new PostgresKnowledgeGraphBuildJobStore(client);
    const result = operation === 'enqueue'
      ? store.enqueue(scope, 'graph-v1')
      : store.resumeFailedDocumentBuild(scope, { documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed' }, id);
    await assert.rejects(result, error => error instanceof KnowledgeGraphError
      && error.code === (operation === 'enqueue' ? 'KNOWLEDGE_GRAPH_CAPACITY' : 'KNOWLEDGE_GRAPH_CONFLICT'));
  }
});

test('rejects oversized or reserved build metadata before PostgreSQL', async () => {
  const client = fakeClient([]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  await assert.rejects(
    store.enqueue(scope, 'graph-v1', { payload: 'x'.repeat(16_385) }),
    /metadata.*too large/i
  );
  await assert.rejects(
    store.enqueue(scope, 'graph-v1', { documentIdentity: 'client-forged' }),
    /reserved/i
  );
  assert.equal(client.calls.length, 0);
});

test('derives graph version from the authenticated full document identity on the server', async () => {
  const client = fakeClient([{ rows: [row({
    graph_version: 'mirofish:expected',
    metadata: {
      label: 'nightly',
      documentIdentity: {
        tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a',
        documentVersion: 'sha256:doc-v1', trustLevel: 'reviewed',
      },
    },
  })], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  const identity = {
    tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a',
    documentVersion: 'sha256:doc-v1', trustLevel: 'reviewed',
  };

  await store.enqueueDocumentBuild(scope, identity, { label: 'nightly' });

  assert.match(client.calls[1].values[2], /^mirofish:[0-9a-f]{64}$/);
  const storedMetadata = JSON.parse(client.calls[1].values[3]);
  assert.deepEqual(storedMetadata.documentIdentity, identity);
  assert.equal(storedMetadata.label, 'nightly');
});

test('regeneration creates a new server-owned graph generation without changing document version', async () => {
  const client = fakeClient([{ rows: [row()], rowCount: 1 }, { rows: [row()], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  const identity = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a', documentVersion: 'v1', trustLevel: 'reviewed' };
  await store.enqueueDocumentBuild(scope, identity, {}, { regenerate: true });
  await store.enqueueDocumentBuild(scope, identity, {}, { regenerate: true });
  const first = client.calls[1].values;
  const second = client.calls[3].values;
  const stored = JSON.parse(first[3]).documentIdentity;
  assert.match(stored.graphGeneration, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(stored.documentVersion, 'v1');
  assert.ok(first[2].endsWith(`:${stored.graphGeneration}`));
  assert.notEqual(first[2], second[2]);
});

test('claim uses skip locked and creates a renewable ownership token', async () => {
  const client = fakeClient([{ rows: [row({
    status: 'running', attempts: 1, lease_token: lease,
    lease_expires_at: '2026-09-07T00:01:00.000Z',
  })], rowCount: 1 }]);
  const job = await new PostgresKnowledgeGraphBuildJobStore(client).claimNext({ leaseMs: 10_000 });
  assert.equal(job?.status, 'running');
  assert.equal(job?.attempts, 1);
  assert.match(client.calls[0].text, /for update skip locked/i);
  assert.match(client.calls[0].text, /candidate_id/i);
});

test('a targeted claim scopes both queued and expired work and retains the shared lease fence', async () => {
  const client = fakeClient([{ rows: [row({ status: 'running', attempts: 3, lease_token: lease,
    lease_expires_at: '2026-09-07T00:01:00.000Z' })], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  const job = await store.claimSpecific(scope, id, { leaseMs: 10_000 });
  assert.equal(job.status, 'running');
  assert.equal(job.attempts, 3);
  const { text, values } = client.calls[0];
  assert.deepEqual(values.slice(1), [10_000, 'tenant-a', 'corpus-a', id]);
  assert.match(values[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(values[0], lease);
  assert.match(text, /where \(status = 'queued' or \(status = 'running' and lease_expires_at <= now\(\)\)\)\s+and tenant_id = \$3 and corpus_id = \$4 and id = \$5::uuid/i);
  assert.match(text, /for update skip locked/i);
  assert.match(text, /attempts = attempts \+ 1, lease_token = \$1::uuid/i);
  assert.match(text, /make_interval\(secs => \$2::double precision \/ 1000\)/i);
});

test('a targeted claim returns null when no scoped eligible row exists and allocates fresh tokens', async () => {
  const client = fakeClient([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  assert.equal(await store.claimSpecific(scope, id), null);
  assert.equal(await store.claimSpecific(scope, id), null);
  assert.equal(client.calls[0].values[1], 60_000);
  assert.notEqual(client.calls[0].values[0], client.calls[1].values[0]);
});

test('targeted claims reject malformed identity and unsafe lease budgets before querying', async () => {
  const client = fakeClient([]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  for (const badScope of [{ tenantId: '', corpusId: 'corpus-a' }, { tenantId: 'tenant-a', corpusId: ' ' }]) {
    await assert.rejects(store.claimSpecific(badScope, id), /malformed/);
  }
  await assert.rejects(store.claimSpecific(scope, 'not-a-uuid'), /identifier is malformed/);
  for (const leaseMs of [0, 999, 3_600_001, Infinity, 1000.5]) {
    await assert.rejects(store.claimSpecific(scope, id, { leaseMs }), /lease must be between/);
  }
  assert.equal(client.calls.length, 0);
});

test('targeted PostgreSQL claims leave foreign and active leases alone and reclaim only expired work', {
  skip: process.env.RUN_GRAPH_CLAIM_POSTGRES_TESTS !== '1',
}, async () => {
  const { default: pg } = await import('pg');
  const { getPostgresRuntimeConfig } = await import('../postgres/env.ts');
  const { randomUUID } = await import('node:crypto');
  const config = getPostgresRuntimeConfig();
  const target = new URL(config.databaseUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'integration fixture must use local PostgreSQL');
  const database = new pg.Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  await database.connect();
  try {
    await database.query('begin');
    // Run the actual claim SQL on an isolated copy of the real schema. No
    // production queue row can be selected or updated by this fixture.
    await database.query('create temporary table graph_build_jobs (like public.graph_build_jobs including defaults including constraints) on commit drop');
    const expiredId = randomUUID();
    const cancelledId = randomUUID();
    const otherTenantId = randomUUID();
    const otherCorpusId = randomUUID();
    const ids = [id, expiredId, cancelledId, otherTenantId, otherCorpusId];
    for (const [index, jobId] of ids.entries()) {
      await database.query(`insert into pg_temp.graph_build_jobs
        (id, tenant_id, corpus_id, graph_version, status, attempts, lease_token, lease_expires_at)
        values ($1, $2, $3, $4, $5, $6, $7,
          case when $5 = 'running' then now() - interval '1 second' else null end)`,
      [jobId, index === 3 ? 'tenant-b' : 'tenant-a', index === 4 ? 'corpus-b' : 'corpus-a',
        `claim-fixture-${index}`, index === 1 ? 'running' : index === 2 ? 'cancelled' : 'queued', index === 1 ? 2 : 0, index === 1 ? lease : null]);
    }
    const client = { query(text, values) {
      assert.match(text, /and tenant_id = \$3 and corpus_id = \$4 and id = \$5::uuid/i);
      return database.query(text.replaceAll('public.graph_build_jobs', 'pg_temp.graph_build_jobs'), values);
    } };
    const store = new PostgresKnowledgeGraphBuildJobStore(client);
    assert.equal(await store.claimSpecific(scope, randomUUID()), null);
    assert.equal(await store.claimSpecific(scope, otherTenantId), null);
    assert.equal(await store.claimSpecific(scope, otherCorpusId), null);
    assert.equal(await store.claimSpecific(scope, cancelledId), null);
    const queued = await store.claimSpecific(scope, id, { leaseMs: 60_000 });
    assert.equal(queued.status, 'running');
    assert.equal(queued.attempts, 1);
    assert.ok(queued.leaseToken);
    assert.ok(Date.parse(queued.leaseExpiresAt) > Date.now());
    assert.equal(await store.claimSpecific(scope, id), null, 'a live lease must not be replaced');
    const expired = await store.claimSpecific(scope, expiredId, { leaseMs: 10_000 });
    assert.equal(expired.status, 'running');
    assert.equal(expired.attempts, 3);
    assert.notEqual(expired.leaseToken, lease);
    const untouched = await database.query('select status, attempts, lease_token from pg_temp.graph_build_jobs where id = any($1::uuid[])',
      [[otherTenantId, otherCorpusId]]);
    assert.deepEqual(untouched.rows, [
      { status: 'queued', attempts: 0, lease_token: null },
      { status: 'queued', attempts: 0, lease_token: null },
    ]);
  } finally {
    await database.query('rollback');
    await database.end();
  }
});

test('extraction checkpoints are scoped, lease fenced, bounded and monotonic', async () => {
  const client = fakeClient([{ rows: [{ id }], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  const record = { sourceDigest: `sha256:${'a'.repeat(64)}`, value: { kind: 'split' } };
  await store.saveExtractionCheckpoint({
    jobId: id, tenantId: scope.tenantId, corpusId: scope.corpusId,
    graphVersion: 'graph-v1', leaseToken: lease, profile: 'profile-v1',
    segmentKey: '0:0:10', record, progress: 0.2, leaseMs: 60_000,
  });
  const { text, values } = client.calls[0];
  assert.match(text, /tenant_id\s*=\s*\$3/i);
  assert.match(text, /corpus_id\s*=\s*\$4/i);
  assert.match(text, /graph_version\s*=\s*\$5/i);
  assert.match(text, /lease_token\s*=\s*\$2::uuid/i);
  assert.match(text, /lease_expires_at\s*>\s*clock_timestamp\(\)/i);
  assert.match(text, /greatest\(.*progress/i);
  assert.match(text, /octet_length/i);
  assert.deepEqual(JSON.parse(values[7]), record);
  assert.equal(values[1], lease);
});

test('checkpoint writes reject stale leases and reserve their metadata namespace', async () => {
  const client = fakeClient([{ rows: [], rowCount: 0 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  await assert.rejects(store.saveExtractionCheckpoint({
    jobId: id, tenantId: scope.tenantId, corpusId: scope.corpusId,
    graphVersion: 'graph-v1', leaseToken: lease, profile: 'profile-v1',
    segmentKey: '0:0:10', record: { sourceDigest: `sha256:${'a'.repeat(64)}`, value: { kind: 'split' } },
    progress: 0, leaseMs: 60_000,
  }), error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT');
  await assert.rejects(store.enqueue(scope, 'graph-v1', { graphExtractionCheckpoint: {} }), /reserved/i);
});


test('enforces the build state machine and lease-aware transition', async () => {
  const client = fakeClient([{ rows: [row({ status: 'staged', progress: 0.7 })], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  await assert.rejects(
    store.transition({ jobId: id, expectedStatus: 'queued', status: 'published', progress: 1 }),
    /Invalid graph build transition/
  );
  await assert.rejects(
    store.transition({ jobId: id, expectedStatus: 'running', status: 'staged', progress: 0.7 }),
    /requires its lease token/
  );
  const staged = await store.transition({
    jobId: id, expectedStatus: 'running', status: 'staged', progress: 0.7, leaseToken: lease,
  });
  assert.equal(staged.status, 'staged');
  assert.equal(client.calls[0].values[8], lease);
  assert.match(client.calls[0].text, /\$2 <> 'running' or lease_token = \$9::uuid/i);
});

test('failed transitions require actionable error context', async () => {
  const store = new PostgresKnowledgeGraphBuildJobStore(fakeClient([]));
  await assert.rejects(
    store.transition({ jobId: id, expectedStatus: 'running', status: 'failed', progress: 0.5, leaseToken: lease }),
    /requires an error code and message/
  );
});

test('a leased running job can be returned to the queue for an idempotent retry', async () => {
  const client = fakeClient([{ rows: [row({ status: 'queued', attempts: 1 })], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  const queued = await store.transition({
    jobId: id,
    expectedStatus: 'running',
    status: 'queued',
    progress: 0,
    leaseToken: lease,
    metadata: { lastDeliveryError: 'timeout' },
  });
  assert.equal(queued.status, 'queued');
  assert.equal(client.calls[0].values[8], lease);
});

test('atomically records validated completion under the running lease without a staged window', async () => {
  const client = fakeClient([{ rows: [row({
    status: 'validated', progress: 1, artifact_digest: `sha256:${'a'.repeat(64)}`,
  })], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphBuildJobStore(client);
  const completed = await store.completeValidated({
    jobId: id,
    progress: 1,
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    leaseToken: lease,
    publicationManifest: publicationManifest(),
  });
  assert.equal(completed.status, 'validated');
  assert.doesNotMatch(client.calls[0].text, /status = 'staged'/i);
  assert.match(client.calls[0].text, /status = 'validated'/i);
  assert.equal(client.calls[0].values[3], lease);
});

test('validated completion persists the full publication manifest atomically with digest and job scope', async () => {
  const manifest = publicationManifest(); const client = fakeClient([{ rows: [row({ status: 'validated', progress: 1,
    artifact_digest: manifest.artifactDigest, metadata: { publicationManifest: manifest } })], rowCount: 1 }]);
  await new PostgresKnowledgeGraphBuildJobStore(client).completeValidated({ jobId: id, progress: 1,
    artifactDigest: manifest.artifactDigest, leaseToken: lease, publicationManifest: manifest });
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0].text, /metadata\s*-\s*'graphExtractionCheckpoint'/);
  assert.match(client.calls[0].text, /jsonb_build_object\('publicationManifest', \$5::jsonb\)/);
  assert.match(client.calls[0].text, /tenant_id = \$6 and corpus_id = \$7 and graph_version = \$8/);
  assert.match(client.calls[0].text, /lease_expires_at > clock_timestamp\(\)/);
  assert.deepEqual(JSON.parse(client.calls[0].values[4]), manifest);
  assert.deepEqual(client.calls[0].values.slice(5), ['tenant-a', 'corpus-a', 'graph-v1']);
});

test('validated completion binds one observed digest to both SQL and the publication manifest', async () => {
  const manifest = publicationManifest(); const client = fakeClient([{ rows: [row({ status: 'validated', progress: 1,
    artifact_digest: manifest.artifactDigest, metadata: { publicationManifest: manifest } })], rowCount: 1 }]);
  let reads = 0; const input = { jobId: id, progress: 1, leaseToken: lease, publicationManifest: manifest };
  Object.defineProperty(input, 'artifactDigest', { enumerable: true, get() { reads++; return reads === 1 ? manifest.artifactDigest : `sha256:${'b'.repeat(64)}`; } });
  await new PostgresKnowledgeGraphBuildJobStore(client).completeValidated(input);
  assert.equal(client.calls[0].values[2], JSON.parse(client.calls[0].values[4]).artifactDigest);
  assert.equal(reads, 1);
});

test('unvalidated manifests and reserved publication metadata are rejected before database IO', async () => {
  const client = fakeClient([]); const store = new PostgresKnowledgeGraphBuildJobStore(client);
  for (const manifest of [undefined, { ...publicationManifest(), artifactDigest: `sha256:${'b'.repeat(64)}` },
    { ...publicationManifest(), documents: [] }]) await assert.rejects(store.completeValidated({ jobId: id, progress: 1,
    artifactDigest: `sha256:${'a'.repeat(64)}`, leaseToken: lease, publicationManifest: manifest }));
  await assert.rejects(store.enqueue(scope, 'graph-v1', { publicationManifest: publicationManifest() }), /reserved/);
  for (const key of ['publicationManifest', 'documentIdentity']) await assert.rejects(store.transition({ jobId: id, expectedStatus: 'running',
    status: 'queued', progress: 0, leaseToken: lease, metadata: { [key]: publicationManifest() } }), /reserved/);
  assert.equal(client.calls.length, 0);
});

test('unsafe metadata cannot inject reserved fields or execute hooks before database IO', async () => {
  for (const operation of ['transition', 'enqueue']) for (const kind of ['getter', 'nested-getter', 'toJSON', 'proxy']) {
    const client = fakeClient([{ rows: [row({ status: 'published' })], rowCount: 1 }]);
    const store = new PostgresKnowledgeGraphBuildJobStore(client); let hooks = 0; let metadata = {};
    const inject = () => { hooks++; metadata.publicationManifest = publicationManifest(); return 'secret-token'; };
    if (kind === 'getter') Object.defineProperty(metadata, 'note', { enumerable: true, get: inject });
    if (kind === 'nested-getter') metadata.note = { get value() { return inject(); } };
    if (kind === 'toJSON') metadata.note = { toJSON: inject };
    if (kind === 'proxy') metadata = new Proxy({}, { ownKeys() { hooks++; return []; } });
    const pending = operation === 'transition'
      ? store.transition({ jobId: id, expectedStatus: 'validated', status: 'published', progress: 1, metadata })
      : store.enqueue(scope, 'graph-v1', metadata);
    await assert.rejects(pending, e => /Graph build metadata/.test(e.message) && !/secret-token/.test(e.message));
    assert.equal(hooks, 0); assert.equal(client.calls.length, 0); assert.equal(client.transactions.length, 0);
  }
});

test('reports a concurrent status or lease change as a conflict', async () => {
  const store = new PostgresKnowledgeGraphBuildJobStore(fakeClient([{ rows: [], rowCount: 0 }]));
  await assert.rejects(
    store.transition({ jobId: id, expectedStatus: 'staged', status: 'validated', progress: 1 }),
    error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
});
