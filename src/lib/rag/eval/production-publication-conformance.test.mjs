import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) { try { return nextResolve(specifier, context); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(specifier + '.ts', context); throw error; } } });
const { canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { createReferenceAuthorityClock } = await import('./production-authority-ports.ts');
const { createReferencePublicationSources, publicationChunkManifestHash, PublicationIdentityError } = await import('../../knowledge-graph/publication-identity.ts');
const { PROVIDER_CONFORMANCE_REQUIREMENTS, PROVIDER_CONFORMANCE_REQUIREMENTS_HASH } = await import('./production-provider-trust.ts');
let subject;
try { subject = await import('./production-publication-conformance.ts'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }
const clone = value => structuredClone(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const run = (...args) => subject.runIsolatedPublicationConformance(...args);

function fixture() {
  const scope = { environment: 'disposable-lab', tenantId: 'tenant-a', corpusId: 'corpus-a' };
  const binding = { ...scope, runNonce: 'a'.repeat(32), manifestHash: hash('publication-lab') };
  const doc = { documentId: '课程/😀', documentVersion: '版本/一', trustLevel: 'trusted' };
  const rows = [0, 1].map(index => ({ id: `chunk/${index}`, content: `Synthetic content ${index}`, tenant_id: scope.tenantId, corpus_id: scope.corpusId,
    document_id: doc.documentId, document_version: doc.documentVersion, trust_level: doc.trustLevel, chunk_index: index, total_chunks: 2 }));
  const schemaManifest = { fields: ['id', 'content', 'tenant_id', 'corpus_id'] }; const indexManifest = { type: 'FLAT', metric: 'COSINE' };
  const identity = { schemaVersion: 'kg-publication-identity/v1', scope, graph: { graphVersion: 'graph-a', artifactDigest: `sha256:${hash('artifact')}`, pointerRevision: 1 },
    documents: [{ ...doc, expectedChunkCount: 2, contentManifestHash: publicationChunkManifestHash(rows) }],
    milvus: { collection: 'lab_collection', schemaManifestHash: hash(schemaManifest), indexManifestHash: hash(indexManifest) } };
  const pointer = { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', revision: 1 };
  const data = { postgres: { scope, pointer, outbox: { ...pointer, eventType: 'graph.snapshot.activated', publishedAt: '2026-10-10T06:00:00.000Z', deadLetteredAt: null },
    buildJob: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', status: 'published', artifactDigest: identity.graph.artifactDigest, documents: [doc] } },
    neo4j: { scope, pointer, snapshot: { tenantId: scope.tenantId, corpusId: scope.corpusId, graphVersion: 'graph-a', status: 'active', artifactDigest: identity.graph.artifactDigest, documents: [doc] } },
    milvus: { scope, collection: identity.milvus.collection, schemaManifest, indexManifest, rows } };
  const refs = Object.fromEntries(['postgres', 'neo4j', 'milvus'].map(source => [source, ref(`${source}-source`)]));
  const clockRef = ref('publication-clock'); const calls = []; const selections = [];
  const options = { executionProfile: 'local-reference', binding, expectedIdentity: identity, expectedIdentityRef: { ...ref('identity'), sha256: hash(identity) },
    readerId: 'publication-reader', readerAuthorizationDigest: hash('read-only-role'), sourceIdentityRefs: refs, clockIdentityRef: clockRef,
    maxClockUncertaintyMs: 0, observationWindow: { startsAt: '2026-10-10T06:00:00.000Z', endsAt: '2026-10-10T06:05:00.000Z' },
    operationTimeoutMs: 1000, maxVerifications: 1, maxPages: 4, maxRows: 16 };
  let active; let dishonest = false; let scenarioTransform;
  const control = { async selectScenario(scenario) {
    selections.push(scenario); const value = clone(data);
    if (!dishonest) {
      if (scenario === 'extra-version') value.milvus.rows.push({ ...value.milvus.rows[0], id: 'extra-version', document_version: '版本/二', total_chunks: 1 });
      if (scenario === 'missing-chunk') value.milvus.rows.pop();
      if (scenario === 'empty') value.milvus.rows = [];
      if (scenario === 'deactivated') value.neo4j.snapshot.status = 'inactive';
    }
    scenarioTransform?.(scenario, value);
    active = createReferencePublicationSources({ executionProfile: 'local-reference', binding, readerId: options.readerId, readerAuthorizationDigest: options.readerAuthorizationDigest,
      selector: { scope, graphVersion: identity.graph.graphVersion, collection: identity.milvus.collection }, sourceIdentityRefs: refs,
      validFrom: options.observationWindow.startsAt, validUntil: options.observationWindow.endsAt, maxReads: 128, pageSize: 1, data: value });
  } };
  const sources = { executionProfile: 'local-reference', productionCapable: false };
  for (const method of ['readPostgres', 'readNeo4j', 'readMilvusPage']) sources[method] = request => { calls.push({ method, nonce: request.requestNonce, cursor: request.cursor }); return active[method](request); };
  const clock = createReferenceAuthorityClock({ executionProfile: 'local-reference', scope, allowedActorIds: [options.readerId], sourceIdentityRef: clockRef,
    initialObservedAt: '2026-10-10T06:01:00.000Z', uncertaintyMs: 0, maxReadings: 512, maxAdvanceMs: 86400000 });
  const config = { schemaVersion: 'kg-isolated-publication-conformance/v1', isolation: 'disposable-test-scope', readerOptions: options, operationTimeoutMs: 1000 };
  return { config, ports: { sources, clock, control }, calls, selections, setDishonest(value) { dishonest = value; },
    setScenarioTransform(callback) { scenarioTransform = callback; } };
}

test('isolated publication conformance exposes the fixed runner and probe list', () => {
  assert.equal(typeof subject.runIsolatedPublicationConformance, 'function');
  assert.deepEqual(subject.PUBLICATION_CONFORMANCE_PROBES, ['matching-active', 'extra-version', 'missing-chunk', 'empty-active-view', 'deactivated-active-view', 'read-only-state']);
});

test('the actual whole reader runs fixed scenarios, restores legal controls, and keeps all formal requirements incomplete', async () => {
  const f = fixture(); const result = await run(f.config, f.ports);
  assert.equal(result.verdict, 'passed'); assert.equal(result.requirementVerdict, 'incomplete'); assert.equal(result.productionAccepted, false);
  assert.equal(result.pendingCompletionUnknown, false); assert.equal(result.requirementsHash, PROVIDER_CONFORMANCE_REQUIREMENTS_HASH);
  assert.deepEqual(result.unimplementedRequirements, PROVIDER_CONFORMANCE_REQUIREMENTS['publication-readback']);
  assert.equal(result.unimplementedRequirements.length, 8);
  assert.deepEqual(result.probes.map(probe => probe.outcome), ['passed', 'passed', 'passed', 'passed', 'passed', 'not-run']);
  assert.equal(result.probes.at(-1).notRunReason, 'mutation-observer-not-implemented');
  assert.equal(result.observationsHash, hash(result.observations)); assert.equal(result.configHash, hash(f.config));
  assert.ok(Object.isFrozen(result.observations.probes)); assert.equal(result.classification, 'confidential');
  assert.deepEqual(f.selections, ['matching-active', 'extra-version', 'matching-active', 'missing-chunk', 'matching-active', 'empty', 'matching-active', 'deactivated', 'matching-active']);
  // 13 scans belong to the actual reader; 18 additional complete scans are
  // independent pre/post witnesses, never substituted for the required two.
  assert.equal(f.calls.filter(call => call.method === 'readMilvusPage' && call.cursor === null).length, 31);
  assert.deepEqual(result.probes.map(probe => probe.witnessHashes.length), [2, 4, 4, 4, 4, 0]);
  assert.equal(new Set(f.calls.map(call => call.nonce)).size, f.calls.length);
});

test('a scenario controller that does not change the inventory cannot self-report passed counterexamples', async () => {
  const f = fixture(); f.setDishonest(true); const result = await run(f.config, f.ports);
  assert.equal(result.verdict, 'failed'); assert.equal(result.probes[0].outcome, 'passed');
  assert.equal(result.probes[1].failureCode, 'scenario-witness-mismatch'); assert.ok(result.probes.slice(2).every(probe => probe.outcome === 'not-run'));
  assert.deepEqual(f.selections, ['matching-active', 'extra-version']);
});

test('ordinary backend rejection is not accepted as a semantic mismatch', async () => {
  const f = fixture(); const read = f.ports.sources.readMilvusPage;
  f.ports.sources.readMilvusPage = request => f.selections.at(-1) === 'extra-version' ? Promise.reject(new Error('secret-token backend details')) : read(request);
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(result.probes[1].failureCode, 'unexpected-reader-failure'); assert.equal(result.pendingCompletionUnknown, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|backend details|Synthetic content|课程/);
});

test('owned UNKNOWN from a source stops the suite without restoration or more business IO', async () => {
  const f = fixture(); let calls = 0;
  f.ports.sources.readPostgres = () => { calls++; return Promise.reject(new PublicationIdentityError('operation-timeout', 'postgres', true)); };
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed'); assert.equal(result.pendingCompletionUnknown, true);
  assert.equal(result.probes[0].failureCode, 'reader-completion-unknown'); assert.equal(calls, 1); assert.deepEqual(f.selections, ['matching-active']);
  assert.ok(result.probes.slice(1).every(probe => probe.outcome === 'not-run'));
});

test('control timeout remains UNKNOWN after late settlement and never starts a reader or another scenario', async t => {
  const f = fixture(); f.config.operationTimeoutMs = 20; let release; let calls = 0;
  t.after(() => release?.()); f.ports.control.selectScenario = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed'); assert.equal(result.pendingCompletionUnknown, true);
  assert.equal(result.probes[0].failureCode, 'control-completion-unknown'); assert.equal(f.calls.length, 0); assert.equal(calls, 1);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal(f.calls.length, 0);
});

test('invalid control and source then carriers execute no getters and conservatively stop', async () => {
  for (const kind of ['control', 'source']) {
    const f = fixture(); let hooks = 0; const carrier = {}; Object.defineProperty(carrier, 'then', { get() { hooks++; throw new Error('secret-token'); } });
    if (kind === 'control') f.ports.control.selectScenario = () => carrier;
    else f.ports.sources.readPostgres = () => carrier;
    const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed'); assert.equal(result.pendingCompletionUnknown, true); assert.equal(hooks, 0);
    assert.ok(result.probes.slice(1).every(probe => probe.outcome === 'not-run')); assert.doesNotMatch(JSON.stringify(result), /secret-token/);
  }
});

test('configuration and ports reject before control IO, with zero raw getter or Proxy hooks', async () => {
  for (const kind of ['config-getter', 'source-proxy', 'enterprise', 'caller-reader', 'bad-identity']) {
    const f = fixture(); let hooks = 0;
    if (kind === 'config-getter') Object.defineProperty(f.config, 'readerOptions', { enumerable: true, get() { hooks++; throw new Error('secret-token'); } });
    if (kind === 'source-proxy') f.ports.sources = new Proxy(f.ports.sources, { ownKeys() { hooks++; throw new Error('secret-token'); } });
    if (kind === 'enterprise') f.config.readerOptions.executionProfile = 'enterprise';
    if (kind === 'caller-reader') f.ports.reader = { async readPublication() { hooks++; return { productionAuthorized: true }; } };
    if (kind === 'bad-identity') f.config.readerOptions.expectedIdentityRef.sha256 = '0'.repeat(64);
    await assert.rejects(run(f.config, f.ports), error => error.code === 'invalid-config' && !/secret-token/.test(error.message));
    assert.equal(hooks, 0); assert.equal(f.selections.length, 0); assert.equal(f.calls.length, 0);
  }
});

test('a mutated proof is not accepted even when the scenario data is correct', async () => {
  const f = fixture(); const read = f.ports.sources.readPostgres;
  f.ports.sources.readPostgres = async request => { const result = clone(await read(request)); result.proof.context.actorId = 'different-reader'; return result; };
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed'); assert.equal(result.probes[0].failureCode, 'unexpected-reader-failure');
  assert.equal(result.pendingCompletionUnknown, false); assert.deepEqual(f.selections, ['matching-active']);
});

test('late PostgreSQL completion cannot dispatch another source or clock after the outer reader deadline', async t => {
  const f = fixture(); f.config.operationTimeoutMs = 20; let release; let released = false; let pgEntries = 0; let clockEntries = 0;
  const original = f.ports.sources.readPostgres; const clock = f.ports.clock;
  f.ports.clock = { executionProfile: 'local-reference', productionCapable: false,
    readTime(request) { clockEntries++; return clock.readTime(request); } };
  // The first PG belongs to the full witness. Hold the actual reader's PG.
  f.ports.sources.readPostgres = request => { pgEntries++; if (pgEntries !== 2) return original(request);
    return new Promise(resolve => { release = () => { if (released) return; released = true; resolve(original(request)); }; }); };
  t.after(() => release?.()); const result = await run(f.config, f.ports);
  assert.equal(result.verdict, 'failed'); assert.equal(result.pendingCompletionUnknown, true);
  assert.equal(pgEntries, 2); assert.equal(clockEntries, 5); const clockAtClose = clockEntries;
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pgEntries, 2); assert.equal(clockEntries, clockAtClose);
  assert.equal(f.calls.length, 5); assert.deepEqual(f.selections, ['matching-active']);
});

test('late clock completion cannot begin a source after the outer reader deadline', async t => {
  const f = fixture(); f.config.operationTimeoutMs = 20; let release; let released = false; let clockEntries = 0;
  const original = f.ports.clock;
  f.ports.clock = { executionProfile: 'local-reference', productionCapable: false,
    // The full witness has four clock reads; hold the actual reader's first.
    readTime(request) { clockEntries++; if (clockEntries !== 5) return original.readTime(request);
      return new Promise(resolve => { release = () => { if (released) return; released = true; resolve(original.readTime(request)); }; }); } };
  t.after(() => release?.()); const result = await run(f.config, f.ports);
  assert.equal(result.verdict, 'failed'); assert.equal(result.pendingCompletionUnknown, true); assert.equal(f.calls.length, 4);
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(clockEntries, 5); assert.equal(f.calls.length, 4); assert.deepEqual(f.selections, ['matching-active']);
});

test('CPU-starved outer deadline blocks subsequent dispatch without waiting for the timeout callback', async () => {
  const f = fixture(); f.config.operationTimeoutMs = 20; const original = f.ports.sources.readPostgres; let pgEntries = 0;
  f.ports.sources.readPostgres = request => { pgEntries++; const until = performance.now() + (pgEntries === 2 ? 80 : 0);
    while (performance.now() < until) { /* Exercise the actual reader's fixed deadline, after the full witness. */ }
    return original(request); };
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(f.calls.length, 5); assert.deepEqual(f.selections, ['matching-active']);
});

test('four different negative scenarios cannot all be witnessed by the same extra-version inventory', async () => {
  const f = fixture(); const select = f.ports.control.selectScenario;
  f.ports.control.selectScenario = scenario => select(scenario === 'matching-active' ? scenario : 'extra-version');
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(result.probes[0].outcome, 'passed'); assert.equal(result.probes[1].outcome, 'passed');
  assert.equal(result.probes[2].outcome, 'failed'); assert.equal(result.probes[2].failureCode, 'scenario-witness-mismatch');
  assert.ok(result.probes.slice(3).every(probe => probe.outcome === 'not-run'));
});

test('an extra-version count increase that removes a baseline row is not a genuine superset', async () => {
  const f = fixture(); f.setScenarioTransform((scenario, data) => {
    if (scenario !== 'extra-version') return;
    data.milvus.rows.shift(); data.milvus.rows.push({ ...data.milvus.rows[0], id: 'another-extra', document_version: '版本/三', chunk_index: 0, total_chunks: 1 });
  });
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(result.probes[0].outcome, 'passed'); assert.equal(result.probes[1].failureCode, 'scenario-witness-mismatch');
});

test('missing-chunk cannot be aliased to an empty inventory', async () => {
  const f = fixture(); const select = f.ports.control.selectScenario;
  f.ports.control.selectScenario = scenario => select(scenario === 'missing-chunk' ? 'empty' : scenario);
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(result.probes[2].outcome, 'failed'); assert.equal(result.probes[2].failureCode, 'scenario-witness-mismatch');
});

test('missing-chunk cannot delete a baseline row and substitute another identity', async () => {
  const f = fixture(); f.setScenarioTransform((scenario, data) => {
    if (scenario !== 'missing-chunk') return;
    data.milvus.rows[0] = { ...data.milvus.rows[0], id: 'replacement', document_version: '版本/二', total_chunks: 1 };
  });
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(result.probes[2].failureCode, 'scenario-witness-mismatch');
});

test('empty-active-view cannot retain one chunk', async () => {
  const f = fixture(); const select = f.ports.control.selectScenario;
  f.ports.control.selectScenario = scenario => select(scenario === 'empty' ? 'missing-chunk' : scenario);
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(result.probes[3].failureCode, 'scenario-witness-mismatch');
});

test('deactivated-active-view cannot be an extra version or a simultaneous vector mutation', async () => {
  for (const variant of ['alias-extra', 'inactive-and-missing']) {
    const f = fixture(); const select = f.ports.control.selectScenario;
    if (variant === 'alias-extra') f.ports.control.selectScenario = scenario => select(scenario === 'deactivated' ? 'extra-version' : scenario);
    else f.setScenarioTransform((scenario, data) => { if (scenario === 'deactivated') data.milvus.rows.pop(); });
    const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
    assert.equal(result.probes[4].failureCode, 'scenario-witness-mismatch');
  }
});

test('a generic PostgreSQL mismatch cannot substitute for a missing-chunk scene', async () => {
  const f = fixture(); f.setScenarioTransform((scenario, data) => {
    if (scenario === 'missing-chunk') data.postgres.outbox.eventType = 'graph.snapshot.deactivated';
  });
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(result.probes[2].failureCode, 'scenario-witness-mismatch');
});

test('baseline must be a stable full raw projection bracketing the actual successful reader', async () => {
  const f = fixture(); const read = f.ports.sources.readMilvusPage; let scans = 0;
  f.ports.sources.readMilvusPage = async request => {
    const result = clone(await read(request)); if (request.cursor === null) scans++;
    if (scans >= 4 && f.selections.length === 1 && result.data.rows.length) result.data.rows[0].content += ' changed-after-reader';
    result.proof.dataHash = hash(result.data); return result;
  };
  const result = await run(f.config, f.ports); assert.equal(result.verdict, 'failed');
  assert.equal(result.probes[0].outcome, 'failed'); assert.equal(result.probes[0].failureCode, 'scenario-witness-mismatch');
  assert.deepEqual(f.selections, ['matching-active']);
});
