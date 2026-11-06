import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.')) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { getUnifiedPublicationWriteBlock } = await import('./unified-publication-write-guard.ts');

test('legacy writes are available only when unified publication is off', () => {
  assert.equal(getUnifiedPublicationWriteBlock({}), null);
  assert.equal(getUnifiedPublicationWriteBlock({ RAG_UNIFIED_PUBLICATION_MODE: ' OFF ' }), null);
  for (const mode of ['active', '', 'invalid']) {
    assert.deepEqual(getUnifiedPublicationWriteBlock({ RAG_UNIFIED_PUBLICATION_MODE: mode }), {
      status: 503, code: 'PUBLICATION_LEGACY_WRITE_UNAVAILABLE',
      message: '统一发布模式下旧检索和修改入口暂不可用。',
    });
  }
});
