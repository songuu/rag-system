import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { wrapLocalGraphBuildStore } = await import('../../../scripts/graph-control-worker.ts');
test('local workers initially claim a short recoverable lease even with a long model budget', async () => {
  let observed;
  const wrapped = wrapLocalGraphBuildStore({ async claimNext(options) { observed = options; return null; }, async completeValidated() {}, async transition() {} });
  await wrapped.claimNext({ leaseMs: 3_600_000 });
  assert.equal(observed.leaseMs, 90_000);
});
test('standalone validation becomes terminal without activating the corpus graph or occupying queue capacity', async () => {
  const transitions = [];
  const store = wrapLocalGraphBuildStore({ async claimNext() {},
    async completeValidated() { return { id: 'own-job', status: 'validated', metadata: { trigger: 'mirofish-standalone-v1' } }; },
    async transition(input) { transitions.push(input); return { status: input.status }; },
  });
  assert.equal((await store.completeValidated({ jobId: 'own-job' })).status, 'published');
  assert.deepEqual(transitions, [{ jobId: 'own-job', expectedStatus: 'validated', status: 'published', progress: 1 }]);
});
test('ordinary vectorized document builds retain their explicit validated-to-published workflow', async () => {
  const store = wrapLocalGraphBuildStore({ async claimNext() {},
    async completeValidated() { return { id: 'document-job', status: 'validated', metadata: { trigger: 'manual-console' } }; },
    async transition() { throw new Error('Ordinary documents must not be published automatically'); },
  });
  assert.equal((await store.completeValidated({ jobId: 'document-job' })).status, 'validated');
});
