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
      ) return nextResolve(specifier + '.ts', context);
      throw error;
    }
  },
});

const { PostgresElasticsearchOutboxStore } = await import('./postgres-outbox-store.ts');

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

test('atomically stages exact lexical chunks and an idempotent upsert event', async () => {
  const client = fakeClient([{ rows: [{ id: 'event-1' }], rowCount: 1 }]);
  const store = new PostgresElasticsearchOutboxStore(client);
  const eventId = await store.enqueueUpsert([chunk('chunk-1'), chunk('chunk-2')]);

  assert.equal(eventId, 'event-1');
  assert.match(client.calls[0].text, /jsonb_to_recordset/i);
  assert.match(client.calls[0].text, /delete from public\.elasticsearch_lexical_chunks/i);
  assert.match(client.calls[0].text, /not exists/i);
  assert.match(client.calls[0].text, /insert into public\.elasticsearch_lexical_chunks/i);
  assert.match(client.calls[0].text, /insert into public\.elasticsearch_lexical_outbox/i);
  assert.match(client.calls[0].text, /on conflict \(tenant_id, corpus_id, document_id, document_version, event_type\)/i);
  assert.match(client.calls[0].text, /published_at = null/i);
  assert.equal(client.calls[0].values[1], 'tenant-a');
  assert.equal(client.calls[0].values[3], 'doc-1');
});

test('rejects a projection that crosses a document identity boundary', async () => {
  const store = new PostgresElasticsearchOutboxStore(fakeClient([]));
  await assert.rejects(
    store.enqueueUpsert([chunk('chunk-1'), { ...chunk('chunk-2'), corpusId: 'corpus-b' }]),
    /one tenant, corpus, document, and version/
  );
});

test('accepts normal multiline source text while rejecting identity control characters', async () => {
  const client = fakeClient([{ rows: [{ id: 'event-multiline' }], rowCount: 1 }]);
  const store = new PostgresElasticsearchOutboxStore(client);

  const eventId = await store.enqueueUpsert([{
    ...chunk('chunk-multiline'),
    content: '第一段\n\n第二段\t带制表符',
  }]);

  assert.equal(eventId, 'event-multiline');
  await assert.rejects(
    store.enqueueUpsert([{ ...chunk('chunk-invalid'), documentId: 'doc\ninvalid' }]),
    /documentId is invalid/
  );
});

test('qualifies delete conflict references so PostgreSQL does not see ambiguous columns', async () => {
  const client = fakeClient([{ rows: [{ id: 'event-delete' }], rowCount: 1 }]);
  const store = new PostgresElasticsearchOutboxStore(client);

  const eventId = await store.enqueueDelete({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'doc-1',
  });

  assert.equal(eventId, 'event-delete');
  assert.match(
    client.calls[0].text,
    /delete from public\.elasticsearch_lexical_chunks/i
  );
  assert.match(
    client.calls[0].text,
    /public\.elasticsearch_lexical_outbox\.lease_token is null/i
  );
  assert.doesNotMatch(client.calls[0].text, /case when lease_token is null/i);
});

test('claims events with skip locked and carries a lease token', async () => {
  const client = fakeClient([{ rows: [{
    id: 'event-1', sequence: '3', tenant_id: 'tenant-a', corpus_id: 'corpus-a',
    document_id: 'doc-1', document_version: 'v1', event_type: 'upsert', attempts: 1,
    projection_digest: 'sha256:projection-1',
    lease_token: 'lease-1', lease_expires_at: '2026-09-14T01:00:00Z',
  }], rowCount: 1 }]);
  const store = new PostgresElasticsearchOutboxStore(client);
  const [event] = await store.claim({ limit: 10, leaseMs: 30_000 });
  assert.equal(event.sequence, 3);
  assert.equal(event.projectionDigest, 'sha256:projection-1');
  assert.equal(event.leaseToken, 'lease-1');
  assert.match(client.calls[0].text, /for update skip locked/i);
  assert.match(client.calls[0].text, /earlier\.sequence < candidate\.sequence/i);
});

test('acknowledges only the exact leased projection digest', async () => {
  const client = fakeClient([{ rows: [{ id: 'event-1' }], rowCount: 1 }]);
  const store = new PostgresElasticsearchOutboxStore(client);

  const acknowledged = await store.acknowledge({
    id: 'event-1',
    sequence: 3,
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    documentId: 'doc-1',
    documentVersion: 'v1',
    eventType: 'upsert',
    projectionDigest: 'sha256:projection-1',
    attempt: 1,
    leaseToken: 'lease-1',
    leaseExpiresAt: '2026-09-14T01:00:00.000Z',
  });

  assert.equal(acknowledged, true);
  assert.match(client.calls[0].text, /projection_digest = \$3/i);
  assert.equal(client.calls[0].values[2], 'sha256:projection-1');
});

function chunk(id) {
  return {
    id,
    tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-1',
    documentVersion: 'v1', trustLevel: 'reviewed', content: `content-${id}`,
    source: 'manual.pdf', startOffset: 0, endOffset: 10, metadata: {},
  };
}
