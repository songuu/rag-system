import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error?.code === 'ERR_MODULE_NOT_FOUND'
        && specifier.startsWith('.')
        && !specifier.endsWith('.ts')
      ) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});

const { createRetrievalScope } = await import('../security/retrieval-scope.ts');
const { PostgresKnowledgeGraphPublicationStore } = await import(
  './postgres-publication-store.ts'
);

const scope = createRetrievalScope({
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  allowedTrustLevels: ['reviewed'],
  enforceIsolation: true,
});

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    },
  };
}

test('reads an empty active pointer without inventing a graph version', async () => {
  const client = fakeClient([{ rows: [], rowCount: 0 }]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);

  assert.deepEqual(await store.getActive(scope), {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    graphVersion: null,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  });
  assert.deepEqual(client.calls[0].values, ['tenant-a', 'corpus-a']);
});

test('uses one atomic upsert plus outbox CTE for active snapshot deactivation CAS', async () => {
  const client = fakeClient([{
    rows: [{
      graph_version: null,
      revision: '1',
      updated_at: '2026-09-07T01:00:00.000Z',
    }],
    rowCount: 1,
  }]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);

  const pointer = await store.compareAndSetActive(scope, null, 0);

  assert.equal(pointer.graphVersion, null);
  assert.equal(pointer.revision, 1);
  assert.match(client.calls[0].text, /insert into public\.graph_active_snapshots/i);
  assert.match(client.calls[0].text, /insert into public\.graph_publication_outbox/i);
  assert.match(client.calls[0].text, /on conflict \(tenant_id, corpus_id\)/i);
  assert.match(client.calls[0].text, /\$4::bigint = 0 or exists[\s\S]*current_pointer\.revision = \$4::bigint/i);
  assert.deepEqual(client.calls[0].values.slice(0, 4), [
    'tenant-a', 'corpus-a', null, 0,
  ]);
});

test('requires the lifecycle lease API for PostgreSQL activation', async () => {
  const store = new PostgresKnowledgeGraphPublicationStore(fakeClient([]));
  await assert.rejects(
    store.compareAndSetActive(scope, 'graph-v1', 0),
    error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
});

test('rejects a stale active pointer revision explicitly', async () => {
  const store = new PostgresKnowledgeGraphPublicationStore(
    fakeClient([{ rows: [], rowCount: 0 }])
  );

  await assert.rejects(
    store.compareAndSetActive(scope, null, 7),
    error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
});

test('lists and acknowledges bounded outbox events', async () => {
  const client = fakeClient([
    {
      rows: [{
        id: '5bc631c8-4c86-4b87-af1f-055321563402',
        event_type: 'graph.snapshot.activated',
        graph_version: 'graph-v1',
        revision: '2',
        payload: { previousGraphVersion: 'graph-v0' },
        created_at: '2026-09-07T01:00:00.000Z',
      }],
      rowCount: 1,
    },
    { rows: [{ id: '5bc631c8-4c86-4b87-af1f-055321563402' }], rowCount: 1 },
  ]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);

  const events = await store.listPendingEvents(scope, { limit: 10 });
  assert.equal(events[0].revision, 2);
  assert.equal(events[0].payload.previousGraphVersion, 'graph-v0');
  assert.equal(await store.acknowledgeEvent(scope, events[0].id), true);
  assert.equal(client.calls[0].values[2], 10);
});

test('acquires a delete lease only through the active-pointer guarded lifecycle row', async () => {
  const client = fakeClient([{
    rows: [{
      state: 'deleting',
      operation_id: '5bc631c8-4c86-4b87-af1f-055321563402',
      lease_expires_at: '2026-09-07T01:01:00.000Z',
    }],
    rowCount: 1,
  }]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);
  const lease = await store.acquireSnapshotLease(scope, 'graph-v1', 'delete');

  assert.equal(lease.operation, 'delete');
  assert.equal(lease.graphVersion, 'graph-v1');
  assert.match(client.calls[0].text, /not exists[\s\S]*graph_active_snapshots/i);
  assert.match(client.calls[0].text, /with updated as[\s\S]*lease_expires_at <= now\(\)/i);
  assert.match(client.calls[0].text, /inserted as[\s\S]*on conflict[\s\S]*do nothing/i);
  assert.match(client.calls[0].text, /state = 'deleting'[\s\S]*\$4 = 'deleting'/i);
});

test('activation leases are update-only and cannot create an unregistered snapshot', async () => {
  const client = fakeClient([{ rows: [], rowCount: 0 }]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);

  await assert.rejects(
    store.acquireSnapshotLease(scope, 'ghost-version', 'activate'),
    error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
  assert.match(client.calls[0].text, /inserted as[\s\S]*where \$4 = 'deleting'/i);
  assert.match(client.calls[0].text, /update public\.graph_snapshot_lifecycle/i);
});

test('registers only a new or already staged snapshot and preserves tombstones', async () => {
  const client = fakeClient([
    { rows: [{ graph_version: 'graph-v1' }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);
  await store.registerStagedSnapshot(scope, 'graph-v1');
  assert.match(client.calls[0].text, /where public\.graph_snapshot_lifecycle\.state = 'staged'/i);
  await assert.rejects(
    store.registerStagedSnapshot(scope, 'graph-v1'),
    error => error.code === 'KNOWLEDGE_GRAPH_CONFLICT'
  );
});

test('activation CAS requires the matching unexpired lifecycle lease', async () => {
  const operationId = '5bc631c8-4c86-4b87-af1f-055321563402';
  const client = fakeClient([{
    rows: [{ graph_version: 'graph-v1', revision: 2, updated_at: '2026-09-07T01:00:00Z' }],
    rowCount: 1,
  }]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);
  const pointer = await store.compareAndSetActiveWithLease(scope, 'graph-v1', 1, {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    operation: 'activate', operationId, leaseExpiresAt: '2026-09-07T01:01:00Z',
  });
  assert.equal(pointer.revision, 2);
  assert.match(client.calls[0].text, /state = 'activating'/i);
  assert.match(client.calls[0].text, /lease_expires_at > now\(\)/i);
  assert.equal(client.calls[0].values[5], operationId);
});

test('resolves a delete lease into a durable tombstone', async () => {
  const operationId = '5bc631c8-4c86-4b87-af1f-055321563402';
  const client = fakeClient([{ rows: [{ graph_version: 'graph-v1' }], rowCount: 1 }]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);
  assert.equal(await store.resolveSnapshotLease(scope, {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    operation: 'delete', operationId, leaseExpiresAt: '2026-09-07T01:01:00Z',
  }, 'deleted'), true);
  assert.deepEqual(client.calls[0].values.slice(3), ['deleting', operationId, 'deleted']);
});

test('never releases a delete lease back to staged', async () => {
  const store = new PostgresKnowledgeGraphPublicationStore(fakeClient([]));
  await assert.rejects(
    store.resolveSnapshotLease(scope, {
      tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
      operation: 'delete', operationId: '5bc631c8-4c86-4b87-af1f-055321563402',
      leaseExpiresAt: '2026-09-07T01:01:00Z',
    }, 'release'),
    /must resolve to a graph snapshot tombstone/
  );
});

test('claims outbox rows with skip locked and handles retry/dead-letter atomically', async () => {
  const eventId = '5bc631c8-4c86-4b87-af1f-055321563402';
  const leaseToken = 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87';
  const client = fakeClient([
    { rows: [{
      id: eventId, tenant_id: 'tenant-a', corpus_id: 'corpus-a',
      event_type: 'graph.snapshot.activated', graph_version: 'graph-v1', revision: 1,
      payload: {}, created_at: '2026-09-07T01:00:00Z', attempts: 1,
      lease_token: leaseToken, lease_expires_at: '2026-09-07T01:01:00Z',
    }], rowCount: 1 },
    { rows: [{ dead_lettered: false }], rowCount: 1 },
  ]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);
  const [event] = await store.claimPendingEvents({ limit: 5, leaseMs: 10_000 });
  assert.equal(event.attempt, 1);
  assert.equal(event.leaseToken, leaseToken);
  assert.match(client.calls[0].text, /for update skip locked/i);
  assert.match(
    client.calls[0].text,
    /not exists[\s\S]*earlier\.tenant_id = candidate\.tenant_id[\s\S]*earlier\.revision < candidate\.revision/i
  );
  assert.equal(await store.retryClaim(event.id, event.leaseToken, {
    error: new Error('temporary failure'), maxAttempts: 5, retryDelayMs: 500,
  }), 'retry');
  assert.match(client.calls[1].text, /dead_lettered_at/i);
});

test('activation CAS atomically publishes the matching validated build job', async () => {
  const operationId = '5bc631c8-4c86-4b87-af1f-055321563402';
  const client = fakeClient([{
    rows: [{ graph_version: 'graph-v1', revision: 3, updated_at: '2026-09-07T01:00:00Z' }],
    rowCount: 1,
  }]);
  const store = new PostgresKnowledgeGraphPublicationStore(client);

  await store.compareAndSetActiveWithLease(scope, 'graph-v1', 2, {
    tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1',
    operation: 'activate', operationId, leaseExpiresAt: '2026-09-07T01:01:00Z',
  });

  assert.match(
    client.calls[0].text,
    /update public\.graph_build_jobs[\s\S]*status = 'published'[\s\S]*status = 'validated'/i
  );
  assert.match(client.calls[0].text, /graph_version = \$3/i);
});
