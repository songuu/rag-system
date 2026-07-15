import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const {
  buildScopedMilvusSearchOptions,
  createRetrievalScope,
  getDocumentSecurityFields,
  isTenantIsolationRequired,
  isServerDerivedScope,
  stampDocumentScope,
} = await import('./retrieval-scope.ts');

test('createRetrievalScope validates identifiers and removes duplicate trust levels', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-1',
    corpusId: 'corpus:1',
    allowedTrustLevels: ['trusted', 'trusted', 'reviewed'],
    enforceIsolation: true,
  });
  assert.deepEqual(scope.allowedTrustLevels, ['trusted', 'reviewed']);
  assert.equal(scope.enforceIsolation, true);
  assert.throws(() => createRetrievalScope({ tenantId: '../tenant', corpusId: 'corpus' }));
  assert.throws(() => createRetrievalScope({ tenantId: 'tenant', corpusId: 'corpus', allowedTrustLevels: [] }));
});

test('buildScopedMilvusSearchOptions binds server scope instead of interpolating it', () => {
  const scope = createRetrievalScope({ tenantId: 'tenant-1', corpusId: 'corpus-1', enforceIsolation: true });
  const options = buildScopedMilvusSearchOptions(scope, { threshold: 0.4, searchParams: { ef: 64 } });
  assert.equal(options.filter, 'tenant_id == {tenantId} && corpus_id == {corpusId} && trust_level in {allowedTrustLevels}');
  assert.deepEqual(options.exprValues, {
    tenantId: 'tenant-1',
    corpusId: 'corpus-1',
    allowedTrustLevels: ['trusted', 'reviewed', 'external'],
  });
  assert.equal(options.threshold, 0.4);
  assert.equal(options.exprValues.allowedTrustLevels.includes('quarantined'), false);
});

test('quarantined evidence is expressible but excluded unless explicitly allowed', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-1',
    corpusId: 'corpus-1',
    allowedTrustLevels: ['quarantined'],
    enforceIsolation: true,
  });
  assert.equal(stampDocumentScope({}, scope, 'quarantined').trust_level, 'quarantined');
  assert.deepEqual(
    buildScopedMilvusSearchOptions(scope).exprValues.allowedTrustLevels,
    ['quarantined']
  );
});

test('buildScopedMilvusSearchOptions does not invent filters in local mode', () => {
  const scope = createRetrievalScope({ tenantId: 'local', corpusId: 'local', enforceIsolation: false });
  assert.deepEqual(buildScopedMilvusSearchOptions(scope, { threshold: 0.2 }), { threshold: 0.2 });
});

test('stampDocumentScope overrides spoofed user metadata', () => {
  const scope = createRetrievalScope({ tenantId: 'tenant-a', corpusId: 'corpus-a' });
  const metadata = stampDocumentScope({ tenantId: 'tenant-b', corpus_id: 'corpus-b', source: 'doc' }, scope, 'reviewed');
  assert.equal(metadata.tenantId, 'tenant-a');
  assert.equal(metadata.tenant_id, 'tenant-a');
  assert.equal(metadata.corpusId, 'corpus-a');
  assert.equal(metadata.corpus_id, 'corpus-a');
  assert.equal(metadata.trust_level, 'reviewed');
  assert.equal(isServerDerivedScope(metadata), true);
  assert.equal(isServerDerivedScope({ tenant_id: 'tenant-a', corpus_id: 'corpus-a' }), false);
});

test('stampDocumentScope rejects trust levels outside scope', () => {
  const scope = createRetrievalScope({
    tenantId: 'tenant-a',
    corpusId: 'corpus-a',
    allowedTrustLevels: ['trusted'],
  });
  assert.throws(() => stampDocumentScope({}, scope, 'external'));
});

test('getDocumentSecurityFields prefers server-stamped metadata and normalizes legacy keys', () => {
  assert.deepEqual(
    getDocumentSecurityFields(
      { tenantId: 'tenant-a', corpus_id: 'corpus-a', documentId: 'doc-1', trustLevel: 'trusted' },
      { tenantId: 'fallback', corpusId: 'fallback' }
    ),
    { tenant_id: 'tenant-a', corpus_id: 'corpus-a', document_id: 'doc-1', trust_level: 'trusted' }
  );
});

test('getDocumentSecurityFields uses safe local fallback values', () => {
  assert.deepEqual(
    getDocumentSecurityFields({ source: 'guide.md' }, { tenantId: 'local', corpusId: 'default' }),
    { tenant_id: 'local', corpus_id: 'default', document_id: 'guide.md', trust_level: 'external' }
  );
  assert.throws(() => getDocumentSecurityFields({}, { tenantId: '../bad', corpusId: 'default' }));
});

test('isTenantIsolationRequired is fail-closed for every authenticated access mode and alias', () => {
  assert.equal(isTenantIsolationRequired({}), false);
  assert.equal(isTenantIsolationRequired({ RAG_TENANT_ISOLATION_REQUIRED: 'true' }), true);
  assert.equal(isTenantIsolationRequired({ RAG_ACCESS_MODE: 'supabase' }), true);
  assert.equal(isTenantIsolationRequired({ RAG_ACCESS_MODE: 'single-tenant-token' }), true);
  assert.equal(isTenantIsolationRequired({ RAG_AUTH_MODE: 'supabase' }), true);
});
