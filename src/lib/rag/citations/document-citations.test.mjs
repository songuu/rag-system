import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
    throw error;
  }
} });
const instant = 1_800_000_000_000;
const env = { RAG_CITATION_KEYS: JSON.stringify({ test: Buffer.alloc(32, 7).toString('base64') }), RAG_CITATION_ACTIVE_KEY_ID: 'test', RAG_CITATION_ISSUER: 'test', RAG_CITATION_ENVIRONMENT: 'test', RAG_CITATION_TTL_SECONDS: '60' };
const security = { actorId: 'actor-a', tenantId: 'tenant-a', corpusId: 'corpus-a', role: 'viewer', accessMode: 'single-tenant-token', requestId: 'test', enforceIsolation: true };
const identity = { tenantId: security.tenantId, corpusId: security.corpusId, documentId: 'doc-a', documentVersion: 'version-a', trustLevel: 'external' };
const content = '开头。原文证据😀。结尾。';
const evidence = { ...identity, id: 'chunk-a', laneId: 'dense', content: '原文证据😀。', metadata: { chunkIndex: 0 } };
const deps = () => ({ async readAuthority() { return { revision: 'r1', chunkCount: 1, source: '原始资料.txt' }; }, async readChunk() { return { id: 'chunk-a', chunkIndex: 0, content }; } });

test('ordinary document locators are opaque and cannot be decoded as graph locators', async () => {
  const { issueDocumentAnswerCitations } = await import('./document-citations.ts');
  const { createCitationLocatorCodec } = await import('./locator-codec.ts');
  const issued = await issueDocumentAnswerCitations({ answer: '事实[1]', servedEvidence: [evidence], security, env, now: instant, dependencies: deps() });
  assert.equal(issued.status, 'available'); assert.equal(issued.items.length, 1);
  assert.match(issued.items[0].locator, /^rcl2\./);
  const codec = createCitationLocatorCodec(env);
  const source = codec.decodeDocument(issued.items[0].locator, instant);
  assert.equal(source.chunkId, 'chunk-a'); assert.equal(source.chunkIndex, 0);
  assert.equal(content.slice(source.startOffset, source.endOffset), evidence.content);
  assert.equal(source.chunkHash, createHash('sha256').update(content).digest('hex'));
  assert.throws(() => codec.decode(issued.items[0].locator, instant));
  assert.ok(!JSON.stringify(issued).includes('doc-a'));
});

test('preview rechecks actor, tenant, corpus, version, chunk hash and live document availability', async () => {
  const { issueDocumentAnswerCitations, previewDocumentCitation } = await import('./document-citations.ts');
  const dependencies = deps();
  const issued = await issueDocumentAnswerCitations({ answer: '[1]', servedEvidence: [evidence], security, env, now: instant, dependencies });
  const locator = issued.items[0].locator;
  const preview = overrides => previewDocumentCitation({ locator, security, dependencies, env, clock: () => instant, ...overrides });
  assert.equal((await preview()).content, evidence.content);
  for (const field of ['actorId', 'tenantId', 'corpusId']) {
    let reads = 0;
    await assert.rejects(preview({ security: { ...security, [field]: 'other' }, dependencies: { ...dependencies, async readAuthority() { reads++; return null; } } }), { code: 'RAG_CITATION_INVALID' });
    assert.equal(reads, 0);
  }
  await assert.rejects(preview({ dependencies: { ...dependencies, async readAuthority() { return null; } } }), { code: 'RAG_CITATION_SOURCE_UNAVAILABLE' });
  await assert.rejects(preview({ dependencies: { ...dependencies, async readChunk() { return { id: 'chunk-a', chunkIndex: 0, content: content + 'changed' }; } } }), { code: 'RAG_CITATION_SOURCE_UNAVAILABLE' });
  let reads = 0;
  await assert.rejects(preview({ dependencies: { ...dependencies, async readAuthority() { return ++reads === 1 ? { revision: 'r1', chunkCount: 1, source: 'a' } : null; } } }), { code: 'RAG_CITATION_SOURCE_UNAVAILABLE' });
});

test('disabled documents and unmatched served text never receive document locators', async () => {
  const { issueDocumentAnswerCitations } = await import('./document-citations.ts');
  for (const dependencies of [{ ...deps(), async readAuthority() { return null; } },
    { ...deps(), async readChunk() { return { id: 'chunk-a', chunkIndex: 0, content: 'different text' }; } }]) {
    const result = await issueDocumentAnswerCitations({ answer: '[1]', servedEvidence: [evidence], security, env, now: instant, dependencies });
    assert.equal(result.status, 'unavailable'); assert.deepEqual(result.items, []);
  }
});

test('document locators reject tampering, expiration and untrusted chunk coordinates', async () => {
  const { issueDocumentAnswerCitations } = await import('./document-citations.ts');
  const { createCitationLocatorCodec } = await import('./locator-codec.ts');
  const issued = await issueDocumentAnswerCitations({ answer: '[1]', servedEvidence: [evidence], security, env, now: instant, dependencies: deps() });
  const codec = createCitationLocatorCodec(env); const locator = issued.items[0].locator;
  assert.throws(() => codec.decodeDocument(locator, instant + 60_000));
  const pieces = locator.split('.'); pieces[3] = (pieces[3][0] === 'A' ? 'B' : 'A') + pieces[3].slice(1);
  assert.throws(() => codec.decodeDocument(pieces.join('.'), instant));
  const source = codec.decodeDocument(locator, instant);
  assert.throws(() => codec.encodeDocument({ ...source, chunkIndex: -1 }, instant));
  assert.throws(() => codec.encodeDocument({ ...source, graphVersion: 'forged' }, instant));
});

test('source numbers survive unavailable neighbors and authority changes during issuance fail closed', async () => {
  const { issueDocumentAnswerCitations } = await import('./document-citations.ts');
  const result = await issueDocumentAnswerCitations({ answer: '有效事实[2]。未知[9]。', servedEvidence: [{ ...evidence, id: 'missing' }, evidence], security, env, now: instant, dependencies: deps() });
  assert.deepEqual(result.items.map(item => item.number), [2]); assert.equal(result.diagnostics.invalidCitationCount, 1);
  let reads = 0;
  const changed = await issueDocumentAnswerCitations({ answer: '[1]', servedEvidence: [evidence], security, env, now: instant,
    dependencies: { ...deps(), async readAuthority() { return { revision: String(reads++), chunkCount: 1, source: '资料' }; } } });
  assert.deepEqual(changed.items, []);
});

test('preview detects expiry during source IO and bounds multibyte text without corrupting characters', async () => {
  const { issueDocumentAnswerCitations, previewDocumentCitation } = await import('./document-citations.ts');
  const longContent = '汉'.repeat(6000);
  const dependencies = { ...deps(), async readChunk() { return { id: 'chunk-a', chunkIndex: 0, content: longContent }; } };
  const issued = await issueDocumentAnswerCitations({ answer: '[1]', servedEvidence: [{ ...evidence, content: longContent }], security, env, now: instant, dependencies });
  const locator = issued.items[0].locator;
  const preview = await previewDocumentCitation({ locator, security, env, clock: () => instant, dependencies });
  assert.equal(preview.contentTruncated, true); assert.ok(Buffer.byteLength(preview.content) <= 16384); assert.ok(!preview.content.includes('\ufffd'));
  let now = instant;
  await assert.rejects(previewDocumentCitation({ locator, security, env, clock: () => now,
    dependencies: { ...dependencies, async readChunk(...args) { now += 60_000; return dependencies.readChunk(...args); } } }), { code: 'RAG_CITATION_INVALID' });
});
