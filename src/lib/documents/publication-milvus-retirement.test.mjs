import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context); throw error;
} } });
const { retireGenerationIdentity } = await import('./publication-milvus-retirement.ts');
const identity = { collection: `rag_publication_${'a'.repeat(32)}`, username: `pgu_${'a'.repeat(24)}`, role: `pgr_${'a'.repeat(24)}` };
const ok = { error_code: 'Success', code: 0 };
function fixture() {
  const calls = []; let alive = true; let persisted = identity;
  const admin = Object.fromEntries(['removeUserFromRole', 'deleteUser', 'dropRole'].map(name => [name, async () => { calls.push(name); return ok; }]));
  const journal = { readIntent: async () => persisted, recordEvent: async event => { calls.push(event.phase); } };
  return { calls, admin, journal, lose: () => { alive = false; }, mismatch: () => { persisted = { ...identity, role: 'other' }; },
    input: { operationId: '00000000-0000-4000-8000-000000000001', identity, journal, admin, check: async () => { if (!alive) throw new Error('lease lost'); } } };
}
test('pre-existing intent and a forged actor cannot authorize retirement', async () => {
  const f = fixture(); f.input.actor = { identity };
  await assert.rejects(retireGenerationIdentity(f.input), /not eligible/); assert.deepEqual(f.calls, []);
});
test('lease loss prevents retirement before checking proof', async () => {
  const f = fixture(); f.lose(); await assert.rejects(retireGenerationIdentity(f.input), /lease lost/); assert.deepEqual(f.calls, []);
});
