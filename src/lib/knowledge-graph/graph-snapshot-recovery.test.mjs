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

const { recoverExpiredKnowledgeGraphMutations } = await import('./graph-snapshot-recovery.ts');
const mutation = {
  tenantId: 'tenant-a', corpusId: 'corpus-a', graphVersion: 'graph-v1', operation: 'delete',
  operationId: '5bc631c8-4c86-4b87-af1f-055321563402',
  leaseExpiresAt: '2026-09-07T00:00:00.000Z',
};

test('resolves an inspected expired mutation without broad cleanup', async () => {
  const resolutions = [];
  const store = {
    async listExpiredSnapshotMutations() { return [mutation]; },
    async resolveSnapshotLease(scope, lease, resolution) {
      resolutions.push({ scope, lease, resolution });
      return true;
    },
  };
  assert.deepEqual(
    await recoverExpiredKnowledgeGraphMutations({ store, inspect: async () => 'deleted' }),
    { inspected: 1, resolved: 1, failed: 0 }
  );
  assert.equal(resolutions[0].scope.tenantId, 'tenant-a');
  assert.equal(resolutions[0].lease.operationId, mutation.operationId);
  assert.equal(resolutions[0].resolution, 'deleted');
});

test('leaves failed compensation visible for a later retry', async () => {
  const store = {
    async listExpiredSnapshotMutations() { return [mutation]; },
    async resolveSnapshotLease() { return true; },
  };
  assert.deepEqual(
    await recoverExpiredKnowledgeGraphMutations({ store, inspect: async () => { throw new Error('neo4j offline'); } }),
    { inspected: 1, resolved: 0, failed: 1 }
  );
});

test('does not release an expired delete mutation back to staged', async () => {
  let resolved = false;
  const store = {
    async listExpiredSnapshotMutations() { return [mutation]; },
    async resolveSnapshotLease() { resolved = true; return true; },
  };
  assert.deepEqual(
    await recoverExpiredKnowledgeGraphMutations({ store, inspect: async () => 'release' }),
    { inspected: 1, resolved: 0, failed: 1 }
  );
  assert.equal(resolved, false);
});
