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

const {
  assertGraphControlWorkerBackend,
  createBuildWebhookHandler,
  createPublicationWebhookPublisher,
  parseGraphControlWorkerOptions,
  processNextGraphBuildJob,
  resolveGraphBuildExecutorMode,
  resolveGraphBuildDeliveryTiming,
  resolveLocalGraphBuildLeaseMs,
  runGraphControlIteration,
} = await import('./graph-control-worker.ts');

const webhookSecret = 'test-graph-webhook-secret-at-least-32-characters';

test('parses bounded graph control worker options', () => {
  assert.deepEqual(
    parseGraphControlWorkerOptions(['--once', '--interval-ms=250', '--batch-size=7']),
    { once: true, intervalMs: 250, batchSize: 7, buildMaxAttempts: 5 }
  );
  assert.throws(() => parseGraphControlWorkerOptions(['--batch-size=0']), /between 1 and 1000/);
  assert.throws(() => parseGraphControlWorkerOptions(['--unknown']), /Unknown/);
});

test('accepts pnpm separators and typographic dashes copied from formatted text', () => {
  assert.deepEqual(
    parseGraphControlWorkerOptions(['--', '—interval-ms=250', '–batch-size=7', '－once']),
    { once: true, intervalMs: 250, batchSize: 7, buildMaxAttempts: 5 }
  );
});

test('requires HTTPS and forwards the outbox event id as idempotency key', async () => {
  assert.throws(
    () => createPublicationWebhookPublisher({ url: 'http://example.test/events', secret: webhookSecret }),
    /must use HTTPS/
  );
  let request;
  const publish = createPublicationWebhookPublisher({
    url: 'https://example.test/events',
    secret: webhookSecret,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(null, { status: 204 });
    },
  });
  await publish({
    id: '5bc631c8-4c86-4b87-af1f-055321563402',
    tenantId: 'tenant-a', corpusId: 'corpus-a', eventType: 'graph.snapshot.activated',
    graphVersion: 'graph-v1', revision: 1, payload: {}, createdAt: '2026-09-07T00:00:00Z',
    attempt: 1, leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87',
    leaseExpiresAt: '2026-09-07T00:01:00Z',
  });
  assert.equal(request.url, 'https://example.test/events');
  assert.equal(request.init.headers['idempotency-key'], '5bc631c8-4c86-4b87-af1f-055321563402');
  assert.equal(request.init.headers.authorization, `Bearer ${webhookSecret}`);
  assert.equal(request.init.redirect, 'error');
});

test('non-2xx publication responses fail and are not eligible for acknowledgement', async () => {
  const publish = createPublicationWebhookPublisher({
    url: 'https://example.test/events',
    secret: webhookSecret,
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(() => publish({
    id: '5bc631c8-4c86-4b87-af1f-055321563402', tenantId: 'tenant-a', corpusId: 'corpus-a',
    eventType: 'graph.snapshot.activated', graphVersion: 'graph-v1', revision: 1,
    payload: {}, createdAt: '2026-09-07T00:00:00Z', attempt: 1,
    leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87', leaseExpiresAt: '2026-09-07T00:01:00Z',
  }), /HTTP 503/);
});

test('projects publication revisions into Neo4j before webhook delivery and acknowledgement', async () => {
  const sequence = [];
  let claimed = false;
  const publicationEvent = {
    id: '5bc631c8-4c86-4b87-af1f-055321563402',
    tenantId: 'tenant-a', corpusId: 'corpus-a',
    eventType: 'graph.snapshot.activated', graphVersion: 'graph-v1', revision: 1,
    payload: { expectedRevision: 0 }, createdAt: '2026-09-07T00:00:00Z',
    attempt: 1, leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87',
    leaseExpiresAt: '2026-09-07T00:01:00Z',
  };
  const result = await runGraphControlIteration({
    publicationStore: {
      async listExpiredSnapshotMutations() { return []; },
      async claimPendingEvents() {
        if (claimed) return [];
        claimed = true;
        sequence.push('claim');
        return [publicationEvent];
      },
      async acknowledgeClaim() { sequence.push('ack'); return true; },
      async retryClaim() { throw new Error('unexpected retry'); },
    },
    commandStore: {
      async getActive() {
        sequence.push('neo4j:get');
        return {
          tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: null,
          revision: 0, updatedAt: '1970-01-01T00:00:00.000Z',
        };
      },
      async getCompatibilityDescriptor() {
        sequence.push('neo4j:descriptor');
        return { document: { trustLevel: 'reviewed' } };
      },
      async compareAndSetActive(scope, graphVersion, expectedRevision) {
        sequence.push(`neo4j:cas:${scope.allowedTrustLevels.join(',')}:${graphVersion}:${expectedRevision}`);
        return {
          tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion,
          revision: expectedRevision + 1, updatedAt: '2026-09-07T00:00:01.000Z',
        };
      },
    },
    publish: async () => { sequence.push('webhook'); },
    batchSize: 1,
  });

  assert.equal(result.outbox.published, 1);
  assert.deepEqual(sequence, [
    'claim',
    'neo4j:get',
    'neo4j:descriptor',
    'neo4j:cas:reviewed:graph-v1:0',
    'webhook',
    'ack',
  ]);
});

test('does not claim outbox or build work when reliable sinks are absent', async () => {
  let outboxClaims = 0;
  let buildClaims = 0;
  const publicationStore = {
    async listExpiredSnapshotMutations() { return []; },
    async resolveSnapshotLease() { return true; },
    async claimPendingEvents() { outboxClaims += 1; return []; },
  };
  await runGraphControlIteration({
    publicationStore,
    commandStore: {},
    buildStore: { async claimNext() { buildClaims += 1; return null; } },
    batchSize: 10,
  });
  assert.equal(outboxClaims, 0);
  assert.equal(buildClaims, 0);
});

test('recovery does not tombstone a delete while Neo4j still has the snapshot', async () => {
  let resolutions = 0;
  const publicationStore = {
    async listExpiredSnapshotMutations() {
      return [{
        tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
        operation: 'delete', operationId: '5bc631c8-4c86-4b87-af1f-055321563402',
        leaseExpiresAt: '2026-09-07T00:00:00Z',
      }];
    },
    async resolveSnapshotLease() { resolutions += 1; return true; },
  };
  const result = await runGraphControlIteration({
    publicationStore,
    commandStore: {
      async deleteSnapshotWithPostgresLease() { return false; },
      async snapshotExists() { return true; },
      async getCompatibilityDescriptor() { return { graphVersion: 'graph-v1' }; },
    },
    batchSize: 10,
  });
  assert.deepEqual(result.recovery, { inspected: 1, resolved: 0, failed: 1 });
  assert.equal(resolutions, 0);
});

test('build webhook uses the job id and a delivery failure safely requeues the leased job', async () => {
  let idempotencyKey;
  const handler = createBuildWebhookHandler({
    url: 'https://example.test/build',
    secret: webhookSecret,
    timeoutMs: 120_000,
    fetchImpl: async (_url, init) => {
      idempotencyKey = init.headers['idempotency-key'];
      return new Response(JSON.stringify({
        status: 'staged', progress: 1, artifactDigest: `sha256:${'a'.repeat(64)}`,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const job = {
    id: '5bc631c8-4c86-4b87-af1f-055321563402', tenantId: 'tenant-a', corpusId: 'corpus-a',
    graphVersion: 'graph-v1', status: 'running', progress: 0, artifactDigest: null,
    errorCode: null, errorMessage: null, metadata: {}, attempts: 1,
    leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87',
    leaseExpiresAt: '2026-09-07T00:01:00Z', createdAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z',
  };
  assert.equal((await handler(job)).status, 'staged');
  assert.equal(idempotencyKey, job.id);

  const transitions = [];
  const summary = await processNextGraphBuildJob({
    store: {
      async claimNext() { return job; },
      async transition(input) { transitions.push(input); return { ...job, status: input.status }; },
    },
    handle: async () => { throw new Error('temporary timeout'); },
    maxAttempts: 3,
  });
  assert.equal(summary.retried, 1);
  assert.equal(transitions[0].status, 'queued');
  assert.equal(transitions[0].leaseToken, job.leaseToken);
});

test('fails closed outside the Neo4j backend and coordinates build timeout with a longer lease', () => {
  assert.doesNotThrow(() => assertGraphControlWorkerBackend({ RAG_GRAPH_BACKEND: 'neo4j' }));
  assert.throws(
    () => assertGraphControlWorkerBackend({ RAG_GRAPH_BACKEND: 'file' }),
    /RAG_GRAPH_BACKEND=neo4j/
  );
  assert.deepEqual(resolveGraphBuildDeliveryTiming({}), {
    timeoutMs: 120_000,
    leaseMs: 150_000,
  });
  assert.deepEqual(resolveGraphBuildDeliveryTiming({
    RAG_GRAPH_BUILD_WEBHOOK_TIMEOUT_MS: '300000',
  }), {
    timeoutMs: 300_000,
    leaseMs: 330_000,
  });
});

test('selects local, webhook, and disabled graph build executors explicitly', () => {
  assert.equal(resolveGraphBuildExecutorMode({}), 'disabled');
  assert.equal(resolveGraphBuildExecutorMode({
    RAG_GRAPH_BUILD_WEBHOOK_URL: 'https://example.test/build',
    RAG_GRAPH_WEBHOOK_SECRET: webhookSecret,
  }), 'webhook');
  assert.equal(resolveGraphBuildExecutorMode({ RAG_GRAPH_BUILD_EXECUTOR: 'local' }), 'local');
  assert.equal(resolveGraphBuildExecutorMode({ RAG_GRAPH_BUILD_EXECUTOR: 'disabled' }), 'disabled');
  assert.throws(
    () => resolveGraphBuildExecutorMode({ RAG_GRAPH_BUILD_EXECUTOR: 'webhook' }),
    /requires RAG_GRAPH_BUILD_WEBHOOK_URL and RAG_GRAPH_WEBHOOK_SECRET/
  );
  assert.throws(
    () => resolveGraphBuildExecutorMode({ RAG_GRAPH_BUILD_EXECUTOR: 'unknown' }),
    /must be local, webhook, or disabled/
  );
  assert.equal(resolveLocalGraphBuildLeaseMs({}), 3_600_000);
  assert.equal(resolveLocalGraphBuildLeaseMs({ RAG_GRAPH_LOCAL_BUILD_LEASE_MS: '60000' }), 60_000);
  assert.throws(
    () => resolveLocalGraphBuildLeaseMs({ RAG_GRAPH_LOCAL_BUILD_LEASE_MS: '59999' }),
    /between 60000 and 3600000/
  );
});

test('requires a strong webhook secret and accepts long build delivery timeouts', async () => {
  assert.throws(
    () => createBuildWebhookHandler({ url: 'https://example.test/build', secret: 'short' }),
    /at least 32/
  );
  const handler = createBuildWebhookHandler({
    url: 'https://example.test/build',
    secret: webhookSecret,
    timeoutMs: 300_000,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${webhookSecret}`);
      return new Response(JSON.stringify({
        status: 'staged', progress: 1, artifactDigest: `sha256:${'a'.repeat(64)}`,
      }), { status: 200 });
    },
  });
  assert.equal((await handler(buildJob())).status, 'staged');
});

test('build completion verifies Neo4j identity and digest before the atomic validated transition', async () => {
  const job = buildJob();
  const transitions = [];
  const completions = [];
  const registrations = [];
  const summary = await processNextGraphBuildJob({
    store: {
      async claimNext() { return job; },
      async transition(input) {
        transitions.push(input);
        return { ...job, status: input.status, artifactDigest: input.artifactDigest ?? job.artifactDigest };
      },
      async completeValidated(input) {
        completions.push(input);
        return { ...job, status: 'validated', progress: 1, artifactDigest: input.artifactDigest };
      },
    },
    handle: async () => ({
      status: 'staged', progress: 0.8, artifactDigest: `sha256:${'a'.repeat(64)}`,
    }),
    finalizeStaged: async (claimed, result) => {
      assert.equal(claimed.graphVersion, 'graph-v1');
      assert.equal(result.artifactDigest, `sha256:${'a'.repeat(64)}`);
      registrations.push(claimed.graphVersion);
    },
  });

  assert.deepEqual(summary, { claimed: 1, validated: 1, failed: 0, retried: 0 });
  assert.deepEqual(transitions, []);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].leaseToken, job.leaseToken);
  assert.deepEqual(registrations, ['graph-v1']);
});

test('atomic validation failure leaves the running lease retryable instead of stranding staged work', async () => {
  const job = buildJob();
  const transitions = [];
  const summary = await processNextGraphBuildJob({
    store: {
      async claimNext(options) {
        assert.deepEqual(options, { leaseMs: 180_000 });
        return job;
      },
      async completeValidated() { throw new Error('transient database failure'); },
      async transition(input) {
        transitions.push(input);
        return { ...job, status: input.status };
      },
    },
    handle: async () => ({
      status: 'staged', progress: 1, artifactDigest: `sha256:${'a'.repeat(64)}`,
    }),
    finalizeStaged: async () => {},
    leaseMs: 180_000,
  });

  assert.equal(summary.retried, 1);
  assert.deepEqual(transitions.map(item => [item.expectedStatus, item.status]), [
    ['running', 'queued'],
  ]);
});

test('control iteration refuses to validate a webhook result whose Neo4j digest differs', async () => {
  const job = buildJob({ metadata: {
    documentIdentity: {
      tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a',
      documentVersion: 'sha256:doc-v1', trustLevel: 'reviewed',
    },
  } });
  const transitions = [];
  let registrations = 0;
  const result = await runGraphControlIteration({
    publicationStore: {
      async listExpiredSnapshotMutations() { return []; },
      async resolveSnapshotLease() { return true; },
      async registerStagedSnapshot() { registrations += 1; },
    },
    commandStore: {
      async getCompatibilityDescriptor() {
        return {
          graphVersion: 'graph-v1', artifactDigest: `sha256:${'b'.repeat(64)}`,
          document: job.metadata.documentIdentity,
        };
      },
    },
    buildStore: {
      async claimNext() { return job; },
      async completeValidated() { throw new Error('must not complete'); },
      async transition(input) {
        transitions.push(input);
        return { ...job, status: input.status };
      },
    },
    handleBuild: async () => ({
      status: 'staged', progress: 1, artifactDigest: `sha256:${'a'.repeat(64)}`,
    }),
    batchSize: 10,
  });

  assert.equal(result.build.retried, 1);
  assert.equal(registrations, 0);
  assert.equal(transitions[0].status, 'queued');
  assert.match(transitions[0].metadata.lastDeliveryError, /digest/i);
});

function buildJob(overrides = {}) {
  return {
    id: '5bc631c8-4c86-4b87-af1f-055321563402', tenantId: 'tenant-a', corpusId: 'corpus-a',
    graphVersion: 'graph-v1', status: 'running', progress: 0, artifactDigest: null,
    errorCode: null, errorMessage: null, metadata: {}, attempts: 1,
    leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87',
    leaseExpiresAt: '2026-09-07T00:01:00Z', createdAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z', ...overrides,
  };
}
