import assert from 'node:assert/strict';
import test from 'node:test';

const {
  MIROFISH_GRAPH_TASK_SCOPE_KEY,
  createMiroFishGraphTaskScope,
  createMiroFishGraphTaskScopeMetadata,
  filterMiroFishGraphTasksByScope,
  isMiroFishGraphTaskInScope,
  readMiroFishGraphTaskScope,
} = await import('./graph-api-scope.ts');

const isolatedContext = {
  tenantId: 'tenant-a',
  corpusId: 'corpus-a',
  actorId: 'actor-a',
  enforceIsolation: true,
};

test('creates an immutable-value scope stamp from authenticated context fields', () => {
  const stamp = createMiroFishGraphTaskScope(isolatedContext);

  assert.deepEqual(stamp, {
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    actorId: 'actor-a',
  });
  assert.notEqual(stamp, isolatedContext);
});

test('wraps the authenticated scope under the reserved metadata key', () => {
  assert.deepEqual(createMiroFishGraphTaskScopeMetadata(isolatedContext), {
    [MIROFISH_GRAPH_TASK_SCOPE_KEY]: {
      tenantId: 'tenant-a',
      corpusId: 'corpus-a',
      actorId: 'actor-a',
    },
  });
});

test('reads a complete scope stamp', () => {
  assert.deepEqual(
    readMiroFishGraphTaskScope(task(createMiroFishGraphTaskScopeMetadata(isolatedContext))),
    { tenantId: 'tenant-a', corpusId: 'corpus-a', actorId: 'actor-a' }
  );
});

test('distinguishes a legacy task without a scope stamp', () => {
  assert.equal(readMiroFishGraphTaskScope(task()), undefined);
});

test('rejects a present non-object scope stamp', () => {
  assert.equal(readMiroFishGraphTaskScope(task({ ragScope: [] })), null);
});

test('rejects a scope stamp missing actor provenance', () => {
  assert.equal(
    readMiroFishGraphTaskScope(task({
      ragScope: { tenantId: 'tenant-a', corpusId: 'corpus-a' },
    })),
    null
  );
});

test('rejects blank scope identifiers', () => {
  assert.equal(
    readMiroFishGraphTaskScope(task({
      ragScope: { tenantId: 'tenant-a', corpusId: ' ', actorId: 'actor-a' },
    })),
    null
  );
});

test('allows the exact tenant and corpus scope', () => {
  assert.equal(isMiroFishGraphTaskInScope(scopedTask(), isolatedContext), true);
});

test('allows a different actor with query capability in the same corpus', () => {
  assert.equal(
    isMiroFishGraphTaskInScope(scopedTask(), { ...isolatedContext, actorId: 'actor-b' }),
    true
  );
});

test('denies cross-tenant task access', () => {
  assert.equal(
    isMiroFishGraphTaskInScope(scopedTask(), { ...isolatedContext, tenantId: 'tenant-b' }),
    false
  );
});

test('denies cross-corpus task access', () => {
  assert.equal(
    isMiroFishGraphTaskInScope(scopedTask(), { ...isolatedContext, corpusId: 'corpus-b' }),
    false
  );
});

test('hides legacy unscoped tasks when isolation is enforced', () => {
  assert.equal(isMiroFishGraphTaskInScope(task(), isolatedContext), false);
});

test('keeps legacy unscoped tasks visible only in local-dev compatibility mode', () => {
  assert.equal(
    isMiroFishGraphTaskInScope(task(), { ...isolatedContext, enforceIsolation: false }),
    true
  );
});

test('fails closed on malformed scope metadata even without enforced isolation', () => {
  assert.equal(
    isMiroFishGraphTaskInScope(
      task({ ragScope: { tenantId: 'tenant-a', corpusId: 'corpus-a' } }),
      { ...isolatedContext, enforceIsolation: false }
    ),
    false
  );
});

test('does not accept an inherited scope stamp', () => {
  const metadata = Object.create(createMiroFishGraphTaskScopeMetadata(isolatedContext));
  assert.equal(readMiroFishGraphTaskScope(task(metadata)), undefined);
  assert.equal(isMiroFishGraphTaskInScope(task(metadata), isolatedContext), false);
});

test('filters list, data, and delete candidates to the current corpus', () => {
  const current = scopedTask('task-current');
  const foreignTenant = scopedTask('task-foreign-tenant', {
    ...isolatedContext,
    tenantId: 'tenant-b',
  });
  const foreignCorpus = scopedTask('task-foreign-corpus', {
    ...isolatedContext,
    corpusId: 'corpus-b',
  });
  const legacy = task(undefined, 'task-legacy');

  assert.deepEqual(
    filterMiroFishGraphTasksByScope(
      [current, foreignTenant, foreignCorpus, legacy],
      isolatedContext
    ).map(candidate => candidate.task_id),
    ['task-current']
  );
});

test('still denies a foreign scoped task in local-dev compatibility mode', () => {
  assert.equal(
    isMiroFishGraphTaskInScope(
      scopedTask('task-foreign', { ...isolatedContext, tenantId: 'tenant-b' }),
      { ...isolatedContext, enforceIsolation: false }
    ),
    false
  );
});

function scopedTask(taskId = 'task-current', context = isolatedContext) {
  return task(createMiroFishGraphTaskScopeMetadata(context), taskId);
}

function task(metadata, taskId = 'task-1') {
  return {
    task_id: taskId,
    task_type: 'graph_build',
    status: 'completed',
    progress: 100,
    message: 'done',
    metadata,
    result: { graphId: `graph-${taskId}` },
    created_at: 1,
    updated_at: 1,
  };
}
