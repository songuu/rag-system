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

const { dispatchKnowledgeGraphOutbox } = await import('./graph-outbox-dispatcher.ts');
const event = {
  id: '5bc631c8-4c86-4b87-af1f-055321563402', tenantId: 'tenant-a', corpusId: 'corpus-a',
  eventType: 'graph.snapshot.activated', graphVersion: 'graph-v1', revision: 1,
  payload: {}, createdAt: '2026-09-07T00:00:00.000Z', attempt: 1,
  leaseToken: 'c79a0a13-9d42-41ce-82f8-c9cba35f8d87',
  leaseExpiresAt: '2026-09-07T00:01:00.000Z',
};

test('acknowledges successful publication using the claim token', async () => {
  const calls = [];
  let claimed = false;
  const store = {
    async claimPendingEvents() {
      if (claimed) return [];
      claimed = true;
      return [event];
    },
    async acknowledgeClaim(id, token) { calls.push({ id, token }); return true; },
    async retryClaim() { throw new Error('unexpected retry'); },
  };
  const summary = await dispatchKnowledgeGraphOutbox({ store, publish: async () => {} });
  assert.deepEqual(summary, { claimed: 1, published: 1, retried: 0, deadLettered: 0, lostLease: 0 });
  assert.deepEqual(calls, [{ id: event.id, token: event.leaseToken }]);
});

test('retries transient failures and dead-letters exhausted events', async () => {
  let deadLetterCalls = 0;
  const results = ['retry', 'dead-letter'];
  const pending = [event, { ...event, id: 'dba6bb44-d7b6-4eb5-80dc-8f7ff0f2dc68' }];
  const store = {
    async claimPendingEvents(options) {
      assert.equal(options.limit, 1);
      return pending.length > 0 ? [pending.shift()] : [];
    },
    async acknowledgeClaim() { return false; },
    async retryClaim() { return results.shift(); },
  };
  const summary = await dispatchKnowledgeGraphOutbox({
    store,
    publish: async () => { throw new Error('sink unavailable'); },
    onDeadLetter: async () => { deadLetterCalls += 1; },
    limit: 2,
  });
  assert.deepEqual(summary, { claimed: 2, published: 0, retried: 1, deadLettered: 1, lostLease: 0 });
  assert.equal(deadLetterCalls, 1);
});

test('claims each event only after the previous webhook is acknowledged', async () => {
  const second = { ...event, id: 'dba6bb44-d7b6-4eb5-80dc-8f7ff0f2dc68' };
  const pending = [event, second];
  const sequence = [];
  const store = {
    async claimPendingEvents(options) {
      assert.deepEqual(options, { limit: 1, leaseMs: 40_000 });
      const next = pending.shift();
      if (next) sequence.push(`claim:${next.id}`);
      return next ? [next] : [];
    },
    async acknowledgeClaim(id) { sequence.push(`ack:${id}`); return true; },
    async retryClaim() { throw new Error('unexpected retry'); },
  };

  const summary = await dispatchKnowledgeGraphOutbox({
    store,
    publish: async claimed => { sequence.push(`publish:${claimed.id}`); },
    limit: 2,
    leaseMs: 40_000,
  });

  assert.equal(summary.claimed, 2);
  assert.deepEqual(sequence, [
    `claim:${event.id}`,
    `publish:${event.id}`,
    `ack:${event.id}`,
    `claim:${second.id}`,
    `publish:${second.id}`,
    `ack:${second.id}`,
  ]);
});

test('does not acknowledge a lost lease after a duplicate-safe publish', async () => {
  let claimed = false;
  const store = {
    async claimPendingEvents() {
      if (claimed) return [];
      claimed = true;
      return [event];
    },
    async acknowledgeClaim() { return false; },
    async retryClaim() { throw new Error('unexpected retry'); },
  };
  const summary = await dispatchKnowledgeGraphOutbox({ store, publish: async () => {} });
  assert.equal(summary.lostLease, 1);
  assert.equal(summary.published, 0);
});
