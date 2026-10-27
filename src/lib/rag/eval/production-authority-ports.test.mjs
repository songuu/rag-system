import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { canonicalJsonSha256 } from './canonical-json.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
        && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const ports = await import('./production-authority-ports.ts');
const hash = canonicalJsonSha256;
const clone = value => structuredClone(value);
const scope = { environment: 'production-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
const binding = { ...scope, runNonce: 'a'.repeat(32), manifestHash: hash('manifest') };
const ref = label => ({ objectId: label, objectVersion: 'version-1', sha256: hash(label) });
const now = '2026-10-09T08:30:00.000Z';
const validFrom = '2026-10-09T08:29:00.000Z';
const expiresAt = '2026-10-09T08:31:00.000Z';
const context = (actorId = 'writer', run = binding) => ({ executionProfile: 'local-reference', binding: clone(run), actorId });
const clockOptions = () => ({ executionProfile: 'local-reference', scope: clone(scope),
  allowedActorIds: ['writer', 'reader'], sourceIdentityRef: ref('clock'), initialObservedAt: now,
  uncertaintyMs: 0, maxReadings: 100, maxAdvanceMs: 86400000 });
const storeOptions = () => ({ executionProfile: 'local-reference', scope: clone(scope),
  actors: { writerId: 'writer', readOnlyId: 'reader' }, storeIdentityRef: ref('nonce-store'),
  clockIdentityRef: ref('clock'), maxClaims: 100, maxClockUncertaintyMs: 1000 });
const clockRequest = (number = 1, run = binding, actorId = 'writer') => ({ context: context(actorId, run),
  requestNonce: hash(['clock-challenge', number]).slice(0, 32) });
const clockExpectation = (request, previousReading = null) => ({ request: clone(request),
  sourceIdentityRef: ref('clock'), maxUncertaintyMs: 1000, previousReading });

async function consumeRequest(clock, number = 1, run = binding, changes = {}) {
  const request = clockRequest(number, run);
  return { context: context('writer', run), issuerId: 'execution-issuer',
    authorizationNonce: 'b'.repeat(32), authorizationId: 'approval-1', authorizationKind: 'execution',
    envelopeDigest: hash('signed-envelope'), validFrom, expiresAt,
    clockRequestNonce: request.requestNonce, clockReading: await clock.readTime(request), ...changes };
}

function expectedClaim(request) {
  return { schemaVersion: 'kg-authorization-nonce-claim/v1', classification: 'confidential',
    binding: clone(request.context.binding), issuerId: request.issuerId,
    nonceIdentityHash: hash([request.issuerId, request.authorizationNonce]),
    authorizationId: request.authorizationId, authorizationKind: request.authorizationKind,
    envelopeDigest: request.envelopeDigest, validFrom: request.validFrom, expiresAt: request.expiresAt,
    clockReadingHash: hash(request.clockReading), claimedAt: request.clockReading.observedAt,
    consumerId: request.context.actorId };
}

test('clock readings are detached, challenge-bound, immutable and explicitly non-authoritative', async () => {
  const config = clockOptions(); const clock = ports.createReferenceAuthorityClock(config);
  config.scope.tenantId = 'changed'; config.sourceIdentityRef.objectVersion = 'changed';
  const request = clockRequest(); const reading = await clock.readTime(request);
  request.context.binding.manifestHash = hash('changed');
  assert.equal(clock.executionProfile, 'local-reference'); assert.equal(clock.productionCapable, false);
  assert.equal(reading.schemaVersion, 'kg-authority-clock-reading/v1');
  assert.equal(reading.productionTimeAuthenticated, false); assert.equal(reading.observedAt, now);
  assert.equal(reading.sequence, 1); assert.equal(reading.readerId, 'writer');
  assert.deepEqual(reading.binding, binding); assert.deepEqual(reading.sourceIdentityRef, ref('clock'));
  assert.equal(Object.isFrozen(reading.binding), true);
  const checked = ports.validateAuthorityClockReading(reading, clockExpectation(clockRequest()));
  assert.equal(checked.validationLevel, 'structural-only'); assert.equal(checked.productionAuthorized, false);
  assert.equal(checked.readingHash, hash(reading)); assert.equal(Object.isFrozen(checked), true);
});

test('clock availability failure does not consume challenges, sequence or bounded capacity', async () => {
  const clock = ports.createReferenceAuthorityClock({ ...clockOptions(), maxReadings: 1 });
  clock.setAvailability(false);
  await assert.rejects(clock.readTime(clockRequest()), /authority ports.*unavailable/);
  clock.setAvailability(true);
  assert.equal((await clock.readTime(clockRequest())).sequence, 1);
  await assert.rejects(clock.readTime(clockRequest(2)), /authority ports.*capacity/);
  clock.setAvailability(false); clock.setAvailability(true);
  await assert.rejects(clock.readTime(clockRequest(2)), /authority ports.*capacity/);
});

test('a clock challenge is never reused, including across actors and runs', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  await clock.readTime(clockRequest());
  await assert.rejects(clock.readTime(clockRequest()), /authority ports.*challenge/);
  await assert.rejects(clock.readTime(clockRequest(1, { ...binding, runNonce: 'c'.repeat(32) }, 'reader')), /authority ports.*challenge/);
  assert.equal((await clock.readTime(clockRequest(2))).sequence, 2);
});

test('reference clock cannot move backwards, exceed its advance bound or accept noncanonical dates', async () => {
  const clock = ports.createReferenceAuthorityClock({ ...clockOptions(), maxAdvanceMs: 1000 });
  for (const value of [validFrom, '2026-10-09T08:30:01.001Z', '2026-10-09T08:30:00Z',
    '2026-02-30T08:30:00.000Z', 'secret-invalid-date']) {
    assert.throws(() => clock.advanceTo(value), /authority ports/);
  }
  assert.equal((await clock.readTime(clockRequest())).observedAt, now);
  clock.advanceTo('2026-10-09T08:30:01.000Z');
  assert.equal((await clock.readTime(clockRequest(2))).observedAt, '2026-10-09T08:30:01.000Z');
});

test('clock scope/profile/actor failures are closed and leave the same challenge available', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  for (const edit of [value => { value.context.actorId = 'unlisted'; },
    value => { value.context.executionProfile = 'enterprise'; },
    value => { value.context.binding.tenantId = 'other'; }, value => { value.context.observedAt = now; }]) {
    const request = clockRequest(); edit(request);
    await assert.rejects(clock.readTime(request), /authority ports/);
  }
  assert.equal((await clock.readTime(clockRequest())).sequence, 1);
});

test('clock validator binds all run fields, source version/digest, reader and challenge independently', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const reading = await clock.readTime(clockRequest()); const expectation = clockExpectation(clockRequest());
  const edits = [value => { value.requestNonce = 'c'.repeat(32); },
    value => { value.readerId = 'reader'; }, value => { value.assurance = 'enterprise'; },
    value => { value.productionTimeAuthenticated = true; }, value => { value.uncertaintyMs = 1001; },
    ...Object.keys(binding).map(field => value => { value.binding[field] = field === 'runNonce'
      ? 'c'.repeat(32) : field === 'manifestHash' ? hash('other') : 'other'; }),
    ...Object.keys(ref('clock')).map(field => value => { value.sourceIdentityRef[field] = field === 'sha256' ? hash('other') : 'other'; })];
  for (const edit of edits) { const changed = clone(reading); edit(changed);
    assert.throws(() => ports.validateAuthorityClockReading(changed, expectation), /authority ports/); }
});

test('successive clock validation rejects stale sequences, backwards time, repeated challenges and foreign previous reads', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const first = await clock.readTime(clockRequest()); const second = await clock.readTime(clockRequest(2));
  const expectation = clockExpectation(clockRequest(2), first);
  assert.equal(ports.validateAuthorityClockReading(second, expectation).productionAuthorized, false);
  for (const edit of [value => { value.sequence = first.sequence; },
    value => { value.observedAt = validFrom; }, value => { value.requestNonce = first.requestNonce; }]) {
    const changed = clone(second); edit(changed);
    assert.throws(() => ports.validateAuthorityClockReading(changed, expectation), /authority ports/);
  }
  const previous = clone(first); previous.binding.runNonce = 'c'.repeat(32);
  assert.throws(() => ports.validateAuthorityClockReading(second, { ...expectation, previousReading: previous }), /authority ports/);
});

test('nonce consumption has an independently checked exact confidential readback, never production approval', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const config = storeOptions(); const store = ports.createReferenceAuthorizationNonceStore(config);
  config.actors.writerId = 'changed'; config.storeIdentityRef.objectVersion = 'changed';
  const request = await consumeRequest(clock); const claim = expectedClaim(request);
  const decision = await store.consumeAuthorizationNonce(request);
  assert.equal(decision.status, 'consumed'); assert.equal(store.productionCapable, false);
  assert.equal(Object.isFrozen(decision.claimRef), true);
  assert.deepEqual(decision.claimRef, { objectId: `nonce-${claim.nonceIdentityHash}`, objectVersion: 'v1', sha256: hash(claim) });
  const readRequest = { context: context('reader'), ref: clone(decision.claimRef) };
  const readback = await store.readExactNonceClaim(readRequest);
  assert.deepEqual(readback.object, claim); assert.equal(Object.isFrozen(readback.object.binding), true);
  assert.equal(readback.proof.productionDurable, false); assert.deepEqual(readback.proof.storeIdentityRef, ref('nonce-store'));
  assert.equal(JSON.stringify(readback).includes(request.authorizationNonce), false);
  const checked = ports.validateNonceClaimReadback(readback, { request: readRequest,
    storeIdentityRef: ref('nonce-store'), expectedClaim: claim });
  assert.equal(checked.validationLevel, 'structural-only'); assert.equal(checked.productionAuthorized, false);
  assert.equal(checked.claimHash, hash(claim));
});

test('concurrent consumption has exactly one winner and no replay receipt leakage', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock);
  const results = await Promise.all([store.consumeAuthorizationNonce(request), store.consumeAuthorizationNonce(request)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['consumed', 'replayed']);
  assert.equal(results.find(result => result.status === 'replayed').claimRef, null);
  assert.deepEqual((await store.readExactNonceClaim({ context: context('reader'), ref: results[0].claimRef })).object,
    expectedClaim(request));
});

test('two different approvals cannot concurrently reuse one clock read; the loser nonce remains available', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const first = await consumeRequest(clock); const second = { ...first, authorizationNonce: 'c'.repeat(32) };
  const results = await Promise.allSettled([store.consumeAuthorizationNonce(first), store.consumeAuthorizationNonce(second)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[0].value.status, 'consumed');
  assert.equal(results[1].status, 'rejected'); assert.match(results[1].reason.message, /authority ports.*clock/);
  assert.equal((await store.consumeAuthorizationNonce(await consumeRequest(clock, 2, binding,
    { authorizationNonce: second.authorizationNonce }))).status, 'consumed');
});

test('nonce identity excludes kind, run, manifest, approval ID and envelope so none can bypass replay', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  await store.consumeAuthorizationNonce(await consumeRequest(clock));
  for (const [index, changes] of [{ authorizationKind: 'result' }, { authorizationKind: 'recovery' },
    { envelopeDigest: hash('resigned') }, { authorizationId: 'new-approval' }].entries()) {
    assert.deepEqual(await store.consumeAuthorizationNonce(await consumeRequest(clock, index + 2, binding, changes)),
      { status: 'replayed', claimRef: null });
  }
  const run = { ...binding, runNonce: 'c'.repeat(32), manifestHash: hash('new-manifest') };
  assert.deepEqual(await store.consumeAuthorizationNonce(await consumeRequest(clock, 9, run)), { status: 'replayed', claimRef: null });
});

test('different issuers have separate nonce namespaces but expiry never evicts an old issuer nonce', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  assert.equal((await store.consumeAuthorizationNonce(await consumeRequest(clock))).status, 'consumed');
  assert.equal((await store.consumeAuthorizationNonce(await consumeRequest(clock, 2, binding, { issuerId: 'other-issuer' }))).status, 'consumed');
  clock.advanceTo('2026-10-09T08:32:00.000Z');
  const next = await consumeRequest(clock, 3, binding, { validFrom: '2026-10-09T08:31:00.000Z', expiresAt: '2026-10-09T08:33:00.000Z' });
  assert.deepEqual(await store.consumeAuthorizationNonce(next), { status: 'replayed', claimRef: null });
});

test('capacity exhaustion is closed, never evicts tombstones, and replay is distinct from new capacity exhaustion', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const store = ports.createReferenceAuthorizationNonceStore({ ...storeOptions(), maxClaims: 1 });
  const request = await consumeRequest(clock);
  assert.equal((await store.consumeAuthorizationNonce(request)).status, 'consumed');
  const other = await consumeRequest(clock, 2, binding, { authorizationNonce: 'c'.repeat(32) });
  assert.deepEqual(await store.consumeAuthorizationNonce(other), { status: 'capacity-exhausted', claimRef: null });
  assert.deepEqual(await store.consumeAuthorizationNonce(await consumeRequest(clock, 3)), { status: 'replayed', claimRef: null });
});

test('invalid role, scope, profile and clock anchors never poison a nonce or consume store capacity', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const store = ports.createReferenceAuthorizationNonceStore({ ...storeOptions(), maxClaims: 1 });
  const request = await consumeRequest(clock);
  for (const edit of [value => { value.context.actorId = 'reader'; },
    value => { value.context.binding.tenantId = 'other'; }, value => { value.context.executionProfile = 'enterprise'; },
    value => { value.clockReading.binding.manifestHash = hash('other'); },
    value => { value.clockReading.sourceIdentityRef.objectVersion = 'other'; },
    value => { value.clockReading.readerId = 'reader'; }, value => { value.clockRequestNonce = 'c'.repeat(32); },
    value => { value.clockReading.productionTimeAuthenticated = true; }]) {
    const changed = clone(request); edit(changed);
    await assert.rejects(store.consumeAuthorizationNonce(changed), /authority ports/);
  }
  assert.equal((await store.consumeAuthorizationNonce(request)).status, 'consumed');
});

test('the full uncertainty interval must fit inside the half-open authorization validity interval', async () => {
  const clock = ports.createReferenceAuthorityClock({ ...clockOptions(), uncertaintyMs: 1000 });
  const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock);
  for (const change of [{ validFrom: now }, { expiresAt: '2026-10-09T08:30:01.000Z' },
    { expiresAt: now }, { validFrom: expiresAt }, { expiresAt: '2026-10-10T08:29:00.001Z' }]) {
    await assert.rejects(store.consumeAuthorizationNonce({ ...request, ...change }), /authority ports.*validity/);
  }
  const valid = { ...request, validFrom: '2026-10-09T08:29:59.000Z', expiresAt: '2026-10-09T08:30:01.001Z' };
  assert.equal((await store.consumeAuthorizationNonce(valid)).status, 'consumed');
});

test('nonce store rejects excessive uncertainty without consuming the same nonce', async () => {
  const clock = ports.createReferenceAuthorityClock({ ...clockOptions(), uncertaintyMs: 1001 });
  const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock);
  await assert.rejects(store.consumeAuthorizationNonce(request), /authority ports.*uncertainty/);
  const allowed = ports.createReferenceAuthorityClock(clockOptions());
  assert.equal((await store.consumeAuthorizationNonce(await consumeRequest(allowed))).status, 'consumed');
});

test('accepted clock progress is monotonic across runs and failures cannot advance the committed clock fence', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions());
  const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const first = await consumeRequest(clock);
  assert.equal((await store.consumeAuthorizationNonce(first)).status, 'consumed');
  const second = await consumeRequest(clock, 2, { ...binding, runNonce: 'c'.repeat(32) }, { authorizationNonce: 'c'.repeat(32) });
  const futureRejected = clone(second); futureRejected.clockReading.sequence = 99; futureRejected.context.actorId = 'reader';
  await assert.rejects(store.consumeAuthorizationNonce(futureRejected), /authority ports/);
  for (const edit of [value => { value.clockReading.sequence = 1; },
    value => { value.clockReading.observedAt = '2026-10-09T08:29:59.000Z'; },
    value => { value.clockRequestNonce = first.clockRequestNonce; value.clockReading.requestNonce = first.clockRequestNonce; }]) {
    const changed = clone(second); edit(changed);
    await assert.rejects(store.consumeAuthorizationNonce(changed), /authority ports.*clock/);
  }
  assert.equal((await store.consumeAuthorizationNonce(second)).status, 'consumed');
});

test('exact nonce reads require separate local reader and every reference field, with no latest fallback', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions()); const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const result = await store.consumeAuthorizationNonce(await consumeRequest(clock));
  const request = { context: context('reader'), ref: clone(result.claimRef) };
  for (const edit of [value => { value.context.actorId = 'writer'; },
    value => { value.context.binding.runNonce = 'c'.repeat(32); }, value => { value.context.binding.manifestHash = hash('other'); },
    value => { value.context.binding.corpusId = 'other'; }, value => { value.context.executionProfile = 'enterprise'; },
    ...Object.keys(ref('store')).map(field => value => { value.ref[field] = field === 'sha256' ? hash('other') : 'other'; })]) {
    const changed = clone(request); edit(changed); await assert.rejects(store.readExactNonceClaim(changed), /authority ports/);
  }
  assert.equal((await store.readExactNonceClaim(request)).proof.readerId, 'reader');
});

test('readback validator checks independent object, exact hash and source/reader proof rather than provider flags', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions()); const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock); const result = await store.consumeAuthorizationNonce(request);
  const readRequest = { context: context('reader'), ref: clone(result.claimRef) };
  const readback = await store.readExactNonceClaim(readRequest);
  const expected = { request: readRequest, storeIdentityRef: ref('nonce-store'), expectedClaim: expectedClaim(request) };
  for (const edit of [value => { value.object.authorizationId = 'other'; },
    value => { value.proof.productionDurable = true; }, value => { value.proof.assurance = 'enterprise'; },
    value => { value.proof.readerId = 'writer'; }, value => { value.proof.objectRef.sha256 = hash('other'); },
    ...Object.keys(ref('store')).map(field => value => { value.proof.storeIdentityRef[field] = field === 'sha256' ? hash('other') : 'other'; })]) {
    const changed = clone(readback); edit(changed);
    assert.throws(() => ports.validateNonceClaimReadback(changed, expected), /authority ports/);
  }
  const wrongExpectation = clone(expected); wrongExpectation.expectedClaim.envelopeDigest = hash('other');
  assert.throws(() => ports.validateNonceClaimReadback(readback, wrongExpectation), /authority ports/);
  assert.equal(ports.validateNonceClaimReadback(readback, expected).productionAuthorized, false);
});

test('enterprise-shaped clock/readback claims are still structural only, not authenticated enterprise authority', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions()); const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock); const result = await store.consumeAuthorizationNonce(request);
  const reading = clone(request.clockReading); reading.assurance = 'enterprise'; reading.productionTimeAuthenticated = true;
  const expectation = clockExpectation(clockRequest()); expectation.request.context.executionProfile = 'enterprise';
  assert.equal(ports.validateAuthorityClockReading(reading, expectation).productionAuthorized, false);
  const readRequest = { context: context('reader'), ref: result.claimRef };
  const readback = clone(await store.readExactNonceClaim(readRequest));
  readback.proof.assurance = 'enterprise'; readback.proof.productionDurable = true;
  readRequest.context.executionProfile = 'enterprise';
  assert.equal(ports.validateNonceClaimReadback(readback, { request: readRequest,
    storeIdentityRef: ref('nonce-store'), expectedClaim: expectedClaim(request) }).productionAuthorized, false);
});

test('a well-formed clock label and envelope digest are not signature/source authentication or production permission', async () => {
  const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = clockRequest();
  // No clock or signer is invoked: this deliberately demonstrates the local
  // store's structural-only boundary, not a trusted time/approval guarantee.
  const reading = { schemaVersion: 'kg-authority-clock-reading/v1', classification: 'confidential',
    assurance: 'local-reference', productionTimeAuthenticated: false, binding: clone(binding),
    requestNonce: request.requestNonce, sourceIdentityRef: ref('clock'), readerId: 'writer',
    sequence: 1, observedAt: now, uncertaintyMs: 0 };
  const input = { context: context(), issuerId: 'execution-issuer', authorizationNonce: 'b'.repeat(32),
    authorizationId: 'unsigned-label', authorizationKind: 'execution', envelopeDigest: hash('no-signature'),
    validFrom, expiresAt, clockRequestNonce: request.requestNonce, clockReading: reading };
  assert.equal(ports.validateAuthorityClockReading(reading, clockExpectation(request)).productionAuthorized, false);
  assert.equal((await store.consumeAuthorizationNonce(input)).status, 'consumed');
  assert.equal(store.productionCapable, false);
});

test('new reference instances have no restart continuity or shared durable nonce history', async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clock = ports.createReferenceAuthorityClock(clockOptions());
    const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
    assert.equal((await store.consumeAuthorizationNonce(await consumeRequest(clock))).status, 'consumed');
    assert.equal(store.productionCapable, false); assert.equal(clock.productionCapable, false);
  }
});

test('options reject enterprise reference profiles, ambiguous actors, unbounded resources and arbitrary external locations', () => {
  for (const edit of [value => { value.executionProfile = 'enterprise'; },
    value => { value.allowedActorIds.push('writer'); }, value => { value.allowedActorIds = []; },
    value => { value.maxReadings = 10001; }, value => { value.uncertaintyMs = 60001; },
    value => { value.sourceIdentityRef.objectId = '../outside'; }, value => { value.url = 'https://secret-host'; }]) {
    const config = clockOptions(); edit(config); assert.throws(() => ports.createReferenceAuthorityClock(config), /authority ports/);
  }
  for (const edit of [value => { value.executionProfile = 'enterprise'; },
    value => { value.actors.readOnlyId = 'writer'; }, value => { value.maxClaims = 0; },
    value => { value.clockIdentityRef.objectId = 'https://secret-host'; }, value => { value.path = '../outside'; }]) {
    const config = storeOptions(); edit(config); assert.throws(() => ports.createReferenceAuthorizationNonceStore(config), /authority ports/);
  }
});

test('calendar boundary uncertainty cannot overflow or underflow the canonical UTC domain', () => {
  for (const initialObservedAt of ['0000-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
    assert.throws(() => ports.createReferenceAuthorityClock({ ...clockOptions(), initialObservedAt, uncertaintyMs: 1 }), /authority ports/);
  }
});

test('hostile getters, proxies, symbols, secret extra fields and prototype keys never execute or leak', async () => {
  const secret = 'secret-must-not-appear'; let calls = 0;
  const trap = () => { calls += 1; throw new Error(secret); };
  const clock = ports.createReferenceAuthorityClock(clockOptions()); const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock);
  const hostile = [new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap }),
    Object.defineProperty({}, 'context', { enumerable: true, get: trap }),
    { ...request, [Symbol(secret)]: true }, { ...request, [secret]: true },
    JSON.parse('{"__proto__":{"context":"secret-must-not-appear"}}')];
  for (const value of hostile) {
    await assert.rejects(store.consumeAuthorizationNonce(value), error => {
      assert.match(error.message, /authority ports/); assert.equal(error.message.includes(secret), false); return true;
    });
    assert.throws(() => ports.createReferenceAuthorityClock(value), error => {
      assert.equal(error.message.includes(secret), false); return true;
    });
  }
  assert.equal(calls, 0);
  assert.equal((await store.consumeAuthorizationNonce(request)).status, 'consumed');
});

test('both structural validators reject hostile nested expectation and response inputs without executing them', async () => {
  const secret = 'validator-secret-must-not-appear'; let calls = 0;
  const trap = () => { calls += 1; throw new Error(secret); };
  const hostile = [new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap }),
    Object.defineProperty({}, 'binding', { enumerable: true, get: trap }), { [secret]: true },
    JSON.parse('{"__proto__":{"binding":"validator-secret-must-not-appear"}}')];
  const clock = ports.createReferenceAuthorityClock(clockOptions()); const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock); const result = await store.consumeAuthorizationNonce(request);
  const readRequest = { context: context('reader'), ref: result.claimRef };
  const readback = await store.readExactNonceClaim(readRequest);
  const readExpectation = { request: readRequest, storeIdentityRef: ref('nonce-store'), expectedClaim: expectedClaim(request) };
  const expectation = clockExpectation(clockRequest());
  for (const value of hostile) {
    const cases = [() => ports.validateAuthorityClockReading(value, expectation),
      () => ports.validateAuthorityClockReading(request.clockReading, value),
      () => ports.validateAuthorityClockReading(request.clockReading, { ...expectation, previousReading: value }),
      () => ports.validateNonceClaimReadback(value, readExpectation),
      () => ports.validateNonceClaimReadback(readback, value),
      () => ports.validateNonceClaimReadback(readback, { ...readExpectation, expectedClaim: value })];
    for (const check of cases) assert.throws(check, error => {
      assert.match(error.message, /authority ports/); assert.equal(error.message.includes(secret), false); return true;
    });
  }
  assert.equal(calls, 0);
});

test('readback validation requires distinct consumer/reader even with self-consistent provider hashes', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions()); const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock); const result = await store.consumeAuthorizationNonce(request);
  const readback = clone(await store.readExactNonceClaim({ context: context('reader'), ref: result.claimRef }));
  const expected = expectedClaim(request); expected.consumerId = 'reader';
  readback.object = clone(expected); readback.proof.objectRef.sha256 = hash(expected);
  assert.throws(() => ports.validateNonceClaimReadback(readback, { request: { context: context('reader'), ref: readback.proof.objectRef },
    storeIdentityRef: ref('nonce-store'), expectedClaim: expected }), /authority ports.*expectation/);
});

test('all operation and validation inputs are detached before their first asynchronous boundary', async () => {
  const clock = ports.createReferenceAuthorityClock(clockOptions()); const store = ports.createReferenceAuthorizationNonceStore(storeOptions());
  const request = await consumeRequest(clock); const expected = expectedClaim(request);
  const pending = store.consumeAuthorizationNonce(request);
  request.authorizationId = 'mutated'; request.clockReading = { secret: 'mutated' };
  const decision = await pending;
  const readRequest = { context: context('reader'), ref: clone(decision.claimRef) };
  const readPending = store.readExactNonceClaim(readRequest); readRequest.ref.sha256 = hash('mutated');
  const readback = await readPending; assert.deepEqual(readback.object, expected);
});
