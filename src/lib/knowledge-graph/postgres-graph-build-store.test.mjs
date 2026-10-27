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
  assert.equal(client.calls.length, 1); assert.match(client.calls[0].text, /metadata = metadata \|\| jsonb_build_object\('publicationManifest', \$5::jsonb\)/);
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
