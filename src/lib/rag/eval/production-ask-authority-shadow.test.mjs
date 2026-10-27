import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
const { clone, sha, flags, hash, waitForEntered, authoritySubject, authorityFailure, authorityFixture, makeAuthority } =
  await import('./production-ask-https-fixtures.test-support.mjs');

async function authorityShadowFixture(t, { largeState = false, mutate = false } = {}) {
  const state = { zeroMutation: Object.fromEntries(['graphCache', 'pointer', 'outbox', 'buildJob', 'neo4j', 'milvus', 'index', 'mode', 'traffic']
    .map(key => [key, { mutationCount: 0, state: largeState && key === 'pointer' ? { snapshot: 'RAW_AUTHORITY_SHADOW_STATE' + 'x'.repeat(270000) } : [] }])),
  allowedEffects: { encryptedAudit: 0, controlledTelemetry: 0, modelBilling: 0, equivalentOrdinaryCache: 0 } };
  const f = await authorityFixture(t, { onRequest() { state.allowedEffects.controlledTelemetry++; state.allowedEffects.modelBilling++;
    if (mutate) state.zeroMutation.pointer.mutationCount++; } });
  f.readbacks = []; f.rawStates = []; f.encryptedParts = [];
  const seal = f.authorityPorts.store.sealEncryptedArtifact, encrypt = f.authorityPorts.kms.encryptArtifact;
  f.authorityPorts.store.sealEncryptedArtifact = async request => { const result = await seal(request); state.allowedEffects.encryptedAudit++; return result; };
  f.authorityPorts.kms.encryptArtifact = request => { f.encryptedParts.push(request); return encrypt(request); };
  f.authorityPorts.readback = { ...flags, async readShadowState(request) {
    f.audit.push('readback.readShadowState'); f.readbacks.push(request);
    const row = f.state.requests.at(-1), measured = f.state.measurements.at(-1); let serving = null;
    if (row && measured) {
      const input = JSON.parse(row.bytes), index = f.base.dataset.cases.findIndex(c => c.query === input.question), e = clone(f.base.dataset.corpus[0]); delete e.metadata;
      serving = { requestPlanHash: measured.requestPlanHash, requestBodySha256: measured.requestBodySha256, responseBodySha256: measured.responseBodySha256,
        servedEvidence: index === 0 ? [{ ...e, id: e.evidenceId, retrievalScore: 1, laneId: 'dense' }] : [], context: input.question,
        prompt: { instruction: 'RAW_AUTHORITY_SHADOW_PROMPT', question: input.question }, cacheIdentity: sha(input.question) };
    }
    const value = JSON.stringify({ schemaVersion: 'kg-reference-shadow-state/v1', requestNonce: request.requestNonce, requestHash: hash(request),
      providerRegistrationHash: request.providerRegistrationHash, binding: request.binding, observedAt: request.observedAt, ...state, serving });
    f.rawStates.push(value); return value;
  } };
  return f;
}
const makeAuthorityShadow = f => authoritySubject.createReferenceAuthorityShadowAskRunner(f.authorityOptions, f.base.rawDatasetJson, f.network, f.authorityPorts);

test('authority Shadow factory requires its own captured readback and refuses caller reports before IO', async t => {
  assert.equal(typeof authoritySubject.createReferenceAuthorityShadowAskRunner, 'function');
  const f = await authorityShadowFixture(t), ports = { ...f.authorityPorts }; delete ports.readback;
  assert.throws(() => authoritySubject.createReferenceAuthorityShadowAskRunner(f.authorityOptions, f.base.rawDatasetJson, f.network, ports), authorityFailure('invalid-config'));
  assert.throws(() => makeAuthority(f), authorityFailure('invalid-config'));
  let hooks = 0; const trapped = { ...f.authorityPorts };
  Object.defineProperty(trapped, 'readback', { enumerable: true, get() { hooks++; throw Error('RAW_ACCESSOR'); } });
  assert.throws(() => authoritySubject.createReferenceAuthorityShadowAskRunner(f.authorityOptions, f.base.rawDatasetJson, f.network, trapped), authorityFailure('invalid-config'));
  const runner = makeAuthorityShadow(f); t.after(() => runner.close());
  await assert.rejects(runner.run({ sideEffects: { passed: true } }), authorityFailure('invalid-request'));
  assert.equal(hooks, 0); assert.equal(f.audit.length, 0); assert.equal(f.readbacks.length + f.state.requests.length, 0);
});

test('authority Shadow owns one grant complete native population and the same encrypted side effect observations', async t => {
  const f = await authorityShadowFixture(t), runner = makeAuthorityShadow(f); t.after(() => runner.close());
  const out = await runner.run({});
  assert.equal(out.schemaVersion, 'kg-reference-authority-shadow-ask-run/v1');
  assert.equal(out.executionSignatureVerified, true); assert.equal(out.executionNonceConsumed, true);
  assert.equal(out.run.transportCalls, 12); assert.equal(out.run.warmups.length, 1); assert.equal(out.run.trials.length, 2);
  // Intern only identical provider tables; every actual decision remains fully
  // reconstructible and its original hash must still authenticate all fields.
  assert.equal(out.checkpointProviderSets.length, 1);
  assert.ok(out.checkpoints.length > 440);
  const nodes = value => 1 + (value && typeof value === 'object' ? Object.values(value).reduce((n, child) => n + nodes(child), 0) : 0);
  let expandedNodes = 1;
  for (const checkpoint of out.checkpoints) {
    const { providerSetIndex, decisionHash, ...core } = checkpoint;
    assert.ok(Number.isSafeInteger(providerSetIndex) && providerSetIndex >= 0 && providerSetIndex < out.checkpointProviderSets.length);
    const restored = { ...core, providers: out.checkpointProviderSets[providerSetIndex] };
    assert.equal(decisionHash, hash(restored));
    expandedNodes += nodes({ ...restored, decisionHash });
  }
  assert.ok(expandedNodes > 200000);
  assert.ok(nodes(out) <= 200000); assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 8 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ schemaVersion: 'authority-shadow-capacity/v1', checkpointCount: out.checkpoints.length,
    expandedNodes, compactNodes: nodes(out), proofBytes: Buffer.byteLength(JSON.stringify(out)) }));
  assert.equal(out.sideEffects.observationCount, 26); assert.equal(out.sideEffects.pairedCaseCount, 6);
  assert.equal(out.sideEffects.bindingHash, out.run.bindingHash); assert.equal(out.sideEffects.rawReadbacksEncryptedAndMatched, true);
  assert.deepEqual(out.sideEffects.observations.map(o => o.rawSha256), f.rawStates.map(value => sha(value)));
  assert.equal(out.sideEffects.observations.every(o => o.archive.bodySha256 === o.rawSha256 && o.archive.encryptedReadbackMatched), true);
  assert.equal(f.audit.filter(x => x === 'nonceStore.consumeAuthorizationNonce').length, 1);
  assert.ok(f.audit.indexOf('nonceStore.readExactNonceClaim') < f.audit.indexOf('readback.readShadowState'));
  assert.ok(f.audit.indexOf('readback.readShadowState') < f.audit.indexOf('kms.encryptArtifact'));
  assert.equal(f.readbacks[0].point, 'run-before'); assert.equal(f.readbacks.at(-1).point, 'run-after');
  assert.equal(f.readbacks.every(r => r.actorId === f.options.askOptions.expectedExecutionPayload.participants.readOnlyId), true);
  assert.equal(f.state.requests.length, 12); assert.equal(f.state.secrets.length, 12);
  for (const key of ['productionAccepted', 'stageAcceptanceComplete', 'executionAuthorized', 'sourceAuthenticated', 'machineGateComputed', 'sideEffectPolicyVerified']) assert.equal(out[key], false);
  assert.deepEqual(out.sideEffects.blockers, ['source-iam-and-authentication-unverified', 'ordinary-cache-equivalence-definition-unavailable']);
  const { proofHash, ...core } = out;
  assert.equal(proofHash, hash({ ...core, run: out.run.proofHash, checkpoints: hash(out.checkpoints.map(c => c.decisionHash)), sideEffects: out.sideEffects.reportHash }));
  assert.equal(Object.isFrozen(out), true); assert.equal(/RAW_|CANARY|reference-ask-token|"question":|"context":|"prompt":/.test(JSON.stringify(out)), false);
  const before = f.audit.filter(x => /^(readback|kms|store|secret|deployment|measurement)\./.test(x)).length;
  const replay = makeAuthorityShadow(f); t.after(() => replay.close());
  await assert.rejects(replay.run({}), e => authorityFailure('approval-failed')(e) && e.nonceOutcome === 'reported-not-consumed');
  assert.equal(f.audit.filter(x => /^(readback|kms|store|secret|deployment|measurement)\./.test(x)).length, before);
});

test('authority Shadow rejects substituted evidence before nonce readback archives credential or POST', async t => {
  const f = await authorityShadowFixture(t), read = f.authorityPorts.evidence.readRuntimeMeasurement;
  f.authorityPorts.evidence.readRuntimeMeasurement = async request => { const value = clone(await read(request)); value.object.attestation.body.instanceId = 'swapped'; return value; };
  const runner = makeAuthorityShadow(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), authorityFailure('evidence-failed'));
  assert.equal(f.audit.some(x => /^(nonceStore|readback|kms|store|secret)\./.test(x)), false); assert.equal(f.state.requests.length, 0);
});

test('authority Shadow observed mutation stops the actual complete schedule after its first POST', async t => {
  const f = await authorityShadowFixture(t, { mutate: true }), runner = makeAuthorityShadow(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), e => authorityFailure('side-effect-failed')(e) && e.nonceOutcome === 'reported-consumed'
    && e.mutationMayHaveOccurred && e.requestMayHaveBeenDispatched);
  assert.equal(f.state.requests.length, 1); assert.equal(f.state.secrets.length, 1); assert.equal(f.readbacks.length, 3);
});

test('authority Shadow rejects foreign source scope registration or selector before archiving', async t => {
  for (const change of [v => { v.binding.corpusId = 'foreign'; }, v => { v.providerRegistrationHash = '0'.repeat(64); }, v => { v.requestHash = '0'.repeat(64); }]) {
    const f = await authorityShadowFixture(t), read = f.authorityPorts.readback.readShadowState;
    f.authorityPorts.readback.readShadowState = async request => { const value = JSON.parse(await read(request)); change(value); return JSON.stringify(value); };
    const runner = makeAuthorityShadow(f); t.after(() => runner.close());
    await assert.rejects(runner.run({}), e => authorityFailure('side-effect-failed')(e) && e.nonceOutcome === 'reported-consumed');
    assert.equal(f.encryptedParts.length + f.state.secrets.length + f.state.requests.length, 0);
  }
});

test('authority Shadow close fences a late held readback with consumed nonce and UNKNOWN intact', async t => {
  const f = await authorityShadowFixture(t), read = f.authorityPorts.readback.readShadowState; let enter, release;
  const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  f.authorityPorts.readback.readShadowState = async request => { const value = await read(request); enter(); await held; return value; };
  const runner = makeAuthorityShadow(f); t.after(() => { release(); runner.close(); }); const pending = runner.run({});
  await waitForEntered(entered, pending); runner.close();
  await assert.rejects(pending, e => authorityFailure('halted')(e) && e.nonceOutcome === 'reported-consumed' && e.pendingCompletionUnknown && e.mutationMayHaveOccurred && !e.requestMayHaveBeenDispatched);
  const before = f.audit.length; release(); await nextTurn(); await nextTurn();
  assert.equal(f.audit.length, before); assert.equal(f.encryptedParts.length + f.state.requests.length + f.state.secrets.length, 0);
});

test('authority Shadow synchronous readback close and throw cannot erase UNKNOWN or consumed nonce', async t => {
  const f = await authorityShadowFixture(t); let runner, entries = 0;
  f.authorityPorts.readback.readShadowState = () => { entries++; runner.close(); throw Error('RAW_CLOSE_THROW'); };
  runner = makeAuthorityShadow(f); t.after(() => runner.close());
  // The actual callback fault wins error classification; closing during it must
  // still retain UNKNOWN and the already-consumed nonce, not imply no dispatch.
  await assert.rejects(runner.run({}), e => authorityFailure('operation-failed')(e) && e.pendingCompletionUnknown
    && e.nonceOutcome === 'reported-consumed' && e.mutationMayHaveOccurred && !e.requestMayHaveBeenDispatched);
  await nextTurn(); assert.equal(entries, 1); assert.equal(f.encryptedParts.length + f.state.requests.length + f.state.secrets.length, 0);
});

test('authority Shadow primitive payload fence never adopts a native Promise value then getter', async t => {
  const f = await authorityShadowFixture(t); let hooks = 0;
  f.authorityPorts.readback.readShadowState = () => { const value = {}, pending = Promise.resolve(value);
    Object.defineProperty(value, 'then', { get() { hooks++; throw Error('RAW_THEN_GETTER'); } }); return pending; };
  const runner = makeAuthorityShadow(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), authorityFailure('operation-failed'));
  assert.equal(hooks, 0); assert.equal(f.encryptedParts.length + f.state.requests.length + f.state.secrets.length, 0);
});

test('authority Shadow raw payload keeps its original eight MiB ceiling before parsing or crypto', async t => {
  const f = await authorityShadowFixture(t); let entries = 0;
  f.authorityPorts.readback.readShadowState = () => { entries++; return Promise.resolve('x'.repeat(8 * 1024 * 1024 + 1)); };
  const runner = makeAuthorityShadow(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), authorityFailure('capacity-exhausted'));
  assert.equal(entries, 1); assert.equal(f.encryptedParts.length + f.state.requests.length + f.state.secrets.length, 0);
});

test('authority Shadow archives full over-control-ceiling state bytes before a separately denied credential', async t => {
  const f = await authorityShadowFixture(t, { largeState: true });
  f.authorityPorts.secret.readAskCredential = request => { f.state.secrets.push(request); return Promise.reject(Error('RAW_SEPARATE_CREDENTIAL_DENIAL')); };
  const runner = makeAuthorityShadow(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), authorityFailure('operation-failed'));
  const parts = f.encryptedParts.filter(p => p.aad.artifactType === 'readback-proof' && p.aad.ordinal >= 1 && p.aad.ordinal <= 128);
  assert.equal(parts.length, 5); const complete = Buffer.concat(parts.map(p => Buffer.from(p.plaintextBase64url, 'base64url')));
  assert.ok(complete.length > 256 * 1024); assert.equal(sha(complete), sha(f.rawStates[0]));
  assert.equal(f.readbacks.length, 2); assert.equal(f.state.secrets.length, 1); assert.equal(f.state.requests.length, 0);
});

test('authority Shadow rechecks expiry after actual source readback before first archive mutation', async t => {
  const f = await authorityShadowFixture(t), read = f.authorityPorts.readback.readShadowState;
  f.authorityPorts.readback.readShadowState = async request => { const value = await read(request); f.clock.advanceTo(f.options.askOptions.expectedExecutionPayload.expiresAt); return value; };
  const runner = makeAuthorityShadow(f); t.after(() => runner.close());
  await assert.rejects(runner.run({}), authorityFailure('clock-failed'));
  assert.equal(f.readbacks.length, 1); assert.equal(f.encryptedParts.length + f.state.secrets.length + f.state.requests.length, 0);
});
