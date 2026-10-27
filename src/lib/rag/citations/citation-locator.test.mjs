import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context);
    throw error;
  }
} });

const instant = 1_800_000_000_000;
const env = {
  RAG_CITATION_KEYS: JSON.stringify({ first: Buffer.alloc(32, 7).toString('base64') }),
  RAG_CITATION_ACTIVE_KEY_ID: 'first', RAG_CITATION_ISSUER: 'test-issuer',
  RAG_CITATION_ENVIRONMENT: 'test', RAG_CITATION_TTL_SECONDS: '60', RAG_CITATION_MAX_TTL_SECONDS: '120',
};
const security = { actorId: 'actor-a', tenantId: 'tenant-a', corpusId: 'corpus-a', role: 'viewer', accessMode: 'single-tenant-token', requestId: 'request-a', enforceIsolation: true };
const { createMiroFishGraphVersion } = await import('../../knowledge-graph/mirofish-adapter.ts');
const graphIdentity = { tenantId: 'tenant-a', corpusId: 'corpus-a', documentId: 'doc-a', documentVersion: 'version-a', trustLevel: 'external' };
const graphVersion = createMiroFishGraphVersion(graphIdentity);
const graph = { id: 'graph:' + graphVersion + ':p1', ...graphIdentity, laneId: 'graph', content: '原文证据', startOffset: 0, endOffset: 4, source: '资料.pdf', page: 2, metadata: { graphVersion, graphPassageId: 'p1', graphClaimIds: ['claim-a'] } };
const rotatedEnv = () => ({ ...env, RAG_CITATION_KEYS: JSON.stringify({ first: Buffer.alloc(32, 7).toString('base64'), second: Buffer.alloc(32, 8).toString('base64') }), RAG_CITATION_ACTIVE_KEY_ID: 'second', RAG_CITATION_KEY_RETIREMENTS: JSON.stringify({ first: { issuedBefore: instant, verifyNotAfter: instant + 30_000 } }) });

test('maps only valid final served graph citations and keeps repeated references', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  const result = issueAnswerCitations({ answer: '事实[1]，再看[1]；其他[2]。', graphLaneIds: ['graph'], servedEvidence: [graph, { ...graph, id: 'dense-a', metadata: {} }], security, env, now: instant });
  assert.equal(result.status, 'available'); assert.equal(result.items.length, 1); assert.equal(result.items[0].number, 1);
  assert.equal(result.items[0].expiresAt, instant + 60_000); assert.match(result.partition, /^[a-f0-9]{64}$/);
  assert.equal(result.diagnostics.unavailableCitationCount, 1);
  assert.ok(!JSON.stringify(result).includes('tenant-a')); assert.ok(!result.items[0].locator.includes('doc-a'));
});

test('does not invent citations, excludes code and markdown links, and fails closed without stable keys', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  assert.equal(issueAnswerCitations({ answer: '没有编号。', graphLaneIds: ['graph'], servedEvidence: [graph], security, env, now: instant }).status, 'missing');
  assert.equal(issueAnswerCitations({ answer: '`[1]` [1](https://example.com)', graphLaneIds: ['graph'], servedEvidence: [graph], security, env, now: instant }).status, 'missing');
  const absent = issueAnswerCitations({ answer: '事实[1]', graphLaneIds: ['graph'], servedEvidence: [graph], security, env: {}, now: instant });
  assert.equal(absent.status, 'unavailable'); assert.equal(absent.items.length, 0); assert.equal(absent.diagnostics.reason, 'configuration-unavailable');
});

test('AEAD locators survive codec recreation and key rotation, rejecting tampering and revoked keys', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  const { createCitationLocatorCodec } = await import('./locator-codec.ts');
  const issued = issueAnswerCitations({ answer: '事实[1]', graphLaneIds: ['graph'], servedEvidence: [graph], security, env, now: instant }).items[0].locator;
  assert.equal(createCitationLocatorCodec(env).decode(issued, instant + 1).documentId, 'doc-a');
  assert.equal(createCitationLocatorCodec(rotatedEnv()).decode(issued, instant + 1).passageId, 'p1');
  const pieces = issued.split('.'); pieces[3] = (pieces[3][0] === 'A' ? 'B' : 'A') + pieces[3].slice(1);
  assert.throws(() => createCitationLocatorCodec(env).decode(pieces.join('.'), instant));
  assert.throws(() => createCitationLocatorCodec({ ...rotatedEnv(), RAG_CITATION_REVOKED_KEY_IDS: 'first' }).decode(issued, instant));
  assert.throws(() => createCitationLocatorCodec({ ...env, RAG_CITATION_KEYS: JSON.stringify({ second: Buffer.alloc(32, 8).toString('base64') }), RAG_CITATION_ACTIVE_KEY_ID: 'second' }).decode(issued, instant));
});

test('rejects expiry, future issue time, shortened maximum lifetime, and deployment replay', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  const { createCitationLocatorCodec } = await import('./locator-codec.ts');
  const issued = issueAnswerCitations({ answer: '事实[1]', graphLaneIds: ['graph'], servedEvidence: [graph], security, env, now: instant }).items[0].locator;
  assert.throws(() => createCitationLocatorCodec(env).decode(issued, instant + 60_000));
  assert.throws(() => createCitationLocatorCodec(env).decode(issued, instant - 1));
  assert.throws(() => createCitationLocatorCodec({ ...env, RAG_CITATION_TTL_SECONDS: '10', RAG_CITATION_MAX_TTL_SECONDS: '10' }).decode(issued, instant + 1));
  for (const override of [{ RAG_CITATION_ISSUER: 'other' }, { RAG_CITATION_ENVIRONMENT: 'other' }]) assert.throws(() => createCitationLocatorCodec({ ...env, ...override }).decode(issued, instant + 1));
});

test('portable parser retains UTF16 source ranges, groups and duplicate legal numbers', async () => {
  const { parseCitationReferences } = await import('./reference-parser.ts');
  const answer = '😀事实[1, 2]和[1]\n\n```text\n[2]\n```\n[1](https://example.com)\n\n[ref]: https://example.com\n[2][ref]';
  const parsed = parseCitationReferences(answer, 2);
  assert.deepEqual(parsed.ranges.map(range => answer.slice(range.start, range.end)), ['[1, 2]', '[1]']);
  assert.deepEqual(parsed.ranges.map(range => range.numbers), [[1, 2], [1]]);
  assert.equal(parsed.citationCount, 3); assert.equal(parsed.invalidCitationCount, 0);
  assert.equal(parseCitationReferences('[0] [999999999999999999999999]', 2).invalidCitationCount, 2);
});

test('does not issue a locator for inconsistent graph metadata or forbidden evidence scope', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  for (const bad of [{ ...graph, tenantId: 'other' }, { ...graph, trustLevel: 'quarantined' }, { ...graph, endOffset: 900 }, { ...graph, metadata: { graphVersion: 'g2', graphPassageId: 'p1' } }]) {
    const issued = issueAnswerCitations({ answer: '[1]', graphLaneIds: ['graph'], servedEvidence: [bad], security, env, now: instant });
    assert.equal(issued.status, 'unavailable'); assert.deepEqual(issued.items, []);
  }
});

test('accepts the existing File GraphLane evidence identity without changing its public ID', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  const fileEvidence = { ...graph, id: 'graph:' + graph.documentVersion + ':p1' };
  assert.equal(issueAnswerCitations({ answer: '[1]', graphLaneIds: ['graph'], servedEvidence: [fileEvidence], security, env, now: instant }).status, 'available');
});

test('requires server-owned completed GraphLane membership even when dense metadata forges every graph identifier', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  const forged = { ...graph, laneId: 'dense' };
  const unknownLane = issueAnswerCitations({ answer: '[1]', servedEvidence: [graph], security, env, now: instant });
  const dense = issueAnswerCitations({ answer: '[1]', graphLaneIds: ['graph'], servedEvidence: [forged], security, env, now: instant });
  assert.equal(unknownLane.status, 'unavailable'); assert.equal(dense.status, 'unavailable');
  assert.deepEqual(unknownLane.items, []); assert.deepEqual(dense.items, []);
});

test('old verification keys need bounded retirement metadata and reject post-retirement minting or window expiry', async () => {
  const { createCitationLocatorCodec } = await import('./locator-codec.ts');
  const { issueAnswerCitations } = await import('./issuance.ts');
  const issue = now => issueAnswerCitations({ answer: '[1]', graphLaneIds: ['graph'], servedEvidence: [graph], security, env, now }).items[0].locator;
  const old = issue(instant);
  assert.equal(createCitationLocatorCodec(rotatedEnv()).decode(old, instant + 1).exp, instant + 60_000);
  assert.throws(() => createCitationLocatorCodec(rotatedEnv()).decode(old, instant + 30_000));
  assert.throws(() => createCitationLocatorCodec(rotatedEnv()).decode(issue(instant + 1), instant + 2));
  const missing = rotatedEnv(); delete missing.RAG_CITATION_KEY_RETIREMENTS;
  assert.throws(() => createCitationLocatorCodec(missing));
  for (const retirements of [{ second: { issuedBefore: instant, verifyNotAfter: instant + 1 } }, { first: { issuedBefore: instant, verifyNotAfter: instant + 120_001 } }, { first: { issuedBefore: instant, verifyNotAfter: instant + 1, extra: true } }, { unknown: { issuedBefore: instant, verifyNotAfter: instant + 1 } }]) {
    assert.throws(() => createCitationLocatorCodec({ ...rotatedEnv(), RAG_CITATION_KEY_RETIREMENTS: JSON.stringify(retirements) }));
  }
});

test('derives only bounded claims actually supported by this passage and ignores unrelated high-degree legacy claim metadata', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  const { createCitationLocatorCodec } = await import('./locator-codec.ts');
  const relation = { claimId: 'claim-a', sourceEntityId: 'alice', sourceEntityName: 'Alice', predicate: 'manages', targetEntityId: 'project', targetEntityName: 'Project', passageIds: ['p1'] };
  const evidence = { ...graph, metadata: { ...graph.metadata, graphClaimIds: Array.from({ length: 100 }, (_, i) => 'unrelated-' + i), graphPaths: [[relation], [{ ...relation, claimId: 'other-source', passageIds: ['p2'] }]] } };
  const result = issueAnswerCitations({ answer: '[1]', graphLaneIds: ['graph'], servedEvidence: [evidence], security, env, now: instant });
  assert.equal(result.status, 'available'); assert.deepEqual(createCitationLocatorCodec(env).decode(result.items[0].locator, instant).claimIds, ['claim-a']);
});

test('public citation items never retain raw sources containing signed query tokens or URL userinfo', async () => {
  const { issueAnswerCitations } = await import('./issuance.ts');
  for (const source of ['https://storage.example/document.pdf?X-Amz-Signature=private-signature', 'https://private-user:private-password@storage.example/document.pdf', 'ordinary-document.pdf']) {
    const result = issueAnswerCitations({ answer: '[1]', graphLaneIds: ['graph'], servedEvidence: [{ ...graph, source }], security, env, now: instant });
    assert.equal(result.status, 'available');
    assert.equal(result.items.length, 1);
    assert.equal(Object.hasOwn(result.items[0], 'source'), false);
    assert.ok(!JSON.stringify(result.items).includes(source));
    assert.equal(result.items[0].page, graph.page);
  }
});
