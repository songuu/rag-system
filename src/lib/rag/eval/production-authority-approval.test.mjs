import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { canonicalJson, canonicalJsonSha256 } from './canonical-json.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const authority = await import('./production-authority-approval.ts');
const ports = await import('./production-authority-ports.ts');
const hash = canonicalJsonSha256; const clone = value => structuredClone(value);
const scope = { environment: 'production-a', tenantId: 'tenant-a', corpusId: 'corpus-a' };
const ref = label => ({ objectId: label, objectVersion: 'v1', sha256: hash(label) });
const binding = { ...scope, runNonce: 'a'.repeat(32), manifestHash: hash('manifest') };
const now = '2026-10-09T08:30:00.000Z'; const issuedAt = '2026-10-09T08:29:00.000Z';
const expiresAt = '2026-10-09T08:31:00.000Z';
const participants = { executionApproverId: 'execution-issuer', executorId: 'writer', readOnlyId: 'reader',
  resultAuthorityId: 'result-issuer', recoveryAuthorityId: 'recovery-issuer' };
const kinds = ['execution', 'result', 'recovery'];
const pairs = Object.fromEntries(kinds.map(kind => [kind, generateKeyPairSync('ed25519')]));
const schemas = { execution: 'kg-execution-authorization-envelope/v1', result: 'kg-result-attestation-envelope/v1',
  recovery: 'kg-safety-recovery-authorization-envelope/v1' };
function payload(kind = 'execution') {
  const common = { stage: 'T17', scope: clone(scope), manifestHash: binding.manifestHash, runNonce: binding.runNonce,
    authorizationId: `${kind}-approval`, nonce: hash(['authorization-nonce', kind]).slice(0, 32),
    issuerId: `${kind}-issuer`, participants: clone(participants), issuedAt, notBefore: issuedAt, expiresAt };
  if (kind === 'execution') return { ...common, operation: 'execute-t17-canary', registryRef: ref('registry'),
    providersHash: hash('providers'), thresholdsHash: hash('thresholds'), window: { startsAt: issuedAt, endsAt: expiresAt } };
  if (kind === 'result') return { ...common, operation: 'attest-stage-result', executionAuthorizationRef: ref('execution'),
    receiptCoreRef: ref('receipt-core'), reportHash: hash('report'), artifactIndexHash: hash('index'),
    machineVerdict: 'passed', executionIdentityId: 'writer', finalStateHash: hash('state'), completedAt: issuedAt };
  return { ...common, operation: 'safety-recovery', frozenPolicyHash: hash('recovery-policy'),
    originalExecutionAuthorizationRef: ref('execution'), originalFencingGeneration: 7, fencingGeneration: 8,
    lineage: { predecessorRef: ref('predecessor'), targetRef: ref('target'), expectedPointerRevision: 10 },
    rollbackExpectedPointerRevision: 11, allowedActions: ['withdraw-traffic', 'revoke-existing-fault', 'set-off', 'rollback-to-predecessor'],
    credentialRef: ref('jit-credential'), roleId: 'rescue-role', approvedMaxTtlMs: 300000 };
}
function signed(kind = 'execution', input = payload(kind)) {
  const signer = { algorithm: 'Ed25519', keyId: `${kind}-key`, keyVersion: 'v1' };
  const bytes = canonicalJson({ signatureProfile: 'kg-production-authorization-signature/v1',
    schemaVersion: schemas[kind], kind, payload: input, signer });
  return { schemaVersion: schemas[kind], kind, payload: clone(input), signature: { ...signer,
    value: sign(null, Buffer.from(bytes), pairs[kind].privateKey).toString('base64url') } };
}
function request(envelope = signed()) { return { context: { executionProfile: 'local-reference', binding: clone(binding), actorId: 'writer' },
  envelope, expectedPayload: clone(envelope.payload) }; }
function options() { return { executionProfile: 'local-reference', scope: clone(scope),
  actors: { verifierId: 'writer', readOnlyId: 'reader' }, clockIdentityRef: ref('clock'), nonceStoreIdentityRef: ref('nonce-store'),
  maxClockUncertaintyMs: 1000, operationTimeoutMs: 1000, maxVerifications: 100,
  keys: kinds.map(kind => ({ keyId: `${kind}-key`, keyVersion: 'v1', issuerId: `${kind}-issuer`, role: kind,
    publicKeySpki: pairs[kind].publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    validFrom: '2026-10-09T08:00:00.000Z', validUntil: '2026-10-09T09:00:00.000Z', revoked: false })) }; }
function recoveryOptions(actorId = 'rescuer') {
  const config = options(); config.actors.verifierId = actorId;
  config.recoveryPrincipal = { actorId, roleId: 'rescue-role', credentialRef: ref('jit-credential') }; return config;
}
function recoveryRequest() { const input = request(signed('recovery')); input.context.actorId = 'rescuer'; return input; }
function fixture(changes = {}) {
  const consumerId = changes.consumerId ?? 'writer';
  const clock = ports.createReferenceAuthorityClock({ executionProfile: 'local-reference', scope,
    allowedActorIds: [consumerId, 'reader'], sourceIdentityRef: ref('clock'), initialObservedAt: now,
    uncertaintyMs: changes.uncertaintyMs ?? 0, maxReadings: 1000, maxAdvanceMs: 86400000 });
  const nonceStore = ports.createReferenceAuthorizationNonceStore({ executionProfile: 'local-reference', scope,
    actors: { writerId: consumerId, readOnlyId: 'reader' }, storeIdentityRef: ref('nonce-store'), clockIdentityRef: ref('clock'),
    maxClaims: changes.maxClaims ?? 100, maxClockUncertaintyMs: 1000 });
  const calls = []; const captured = [];
  const supplied = { clock: { ...clock, async readTime(input) { calls.push('clock'); captured.push(['clock', input]); return clock.readTime(input); } },
    nonceStore: { ...nonceStore, async consumeAuthorizationNonce(input) { calls.push('consume'); captured.push(['consume', input]); return nonceStore.consumeAuthorizationNonce(input); },
      async readExactNonceClaim(input) { calls.push('read'); captured.push(['read', input]); return nonceStore.readExactNonceClaim(input); } } };
  return { clock, nonceStore, calls, captured, supplied,
    create(config = options(), dependencies = supplied) { return authority.createReferenceAuthorityApprovalVerifier(config, dependencies); } };
}
const failure = (code, outcome, pending = false, phase) => error => {
  assert.equal(error.name, 'AuthorityApprovalError'); assert.equal(error.code, code);
  if (phase) assert.equal(error.phase, phase, `unexpected approval failure phase: ${error.phase}`);
  assert.equal(error.nonceOutcome, outcome); assert.equal(error.pendingCompletionUnknown, pending);
  assert.equal(error.productionAuthorized, false); assert.equal(error.cause, undefined); return true;
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
for (const variant of ['getter', 'nonsettling-callable']) test(`resolved payload then ${variant} is never adopted by the async approval consumer`, { timeout: 1000 }, async () => {
  const f = fixture(); let traps = 0;
  f.supplied.clock.readTime = input => new Promise(resolve => {
    f.clock.readTime(input).then(reading => { const value = { ...reading }; resolve(value);
      Object.defineProperty(value, 'then', variant === 'getter'
        ? { enumerable: true, get() { traps++; throw Error('payload-then-secret'); } }
        : { enumerable: true, value() { traps++; } });
    });
  });
  await assert.rejects(f.create().verifyAndConsume(request())); assert.equal(traps, 0);
});
test('native Promise own then accessors are not invoked by approval composition', async () => {
  const f = fixture(); let traps = 0;
  f.supplied.clock.readTime = input => Object.defineProperty(f.clock.readTime(input), 'then', {
    get() { traps++; throw Error('own-then-secret'); },
  });
  assert.equal((await f.create().verifyAndConsume(request())).productionAuthorized, false); assert.equal(traps, 0);
});
test('native Promise constructor accessors are rejected without invocation by approval composition', async () => {
  const f = fixture(); let traps = 0;
  f.supplied.clock.readTime = input => Object.defineProperty(f.clock.readTime(input), 'constructor', {
    get() { traps++; throw Error('constructor-secret'); },
  });
  await assert.rejects(f.create().verifyAndConsume(request()), failure('provider-contract-invalid', 'not-attempted', true));
  assert.equal(traps, 0);
});

for (const kind of ['execution', 'result']) test(`${kind} nonce consumer cannot substitute for the signed executor`, async () => {
  const f = fixture({ consumerId: 'other-actor' }); const config = options(); config.actors.verifierId = 'other-actor';
  const input = request(signed(kind)); input.context.actorId = 'other-actor';
  await assert.rejects(f.create(config).verifyAndConsume(input), failure('invalid-request', 'not-attempted'));
  assert.deepEqual(f.calls, []);
});

test('recovery without a separately frozen rescue principal cannot reuse the signed executor', async () => {
  const f = fixture();
  await assert.rejects(f.create().verifyAndConsume(request(signed('recovery'))), failure('invalid-request', 'not-attempted'));
  assert.deepEqual(f.calls, []);
});

test('all three kinds compose actual signature, two fresh clock reads and independent exact nonce readback', async () => {
  const calls = []; const challenges = [];
  for (const kind of kinds) {
    const f = fixture({ consumerId: kind === 'recovery' ? 'rescuer' : 'writer' });
    const verifier = f.create(kind === 'recovery' ? recoveryOptions() : options());
    const input = kind === 'recovery' ? recoveryRequest() : request(signed(kind));
    const decision = await verifier.verifyAndConsume(input);
    assert.equal(decision.productionAuthorized, false); assert.equal(decision.signatureVerified, true);
    assert.equal(decision.nonceClaimMatched, true); assert.equal(decision.classification, 'confidential');
    assert.equal(decision.validationLevel, 'local-reference-authority-composition');
    assert.equal(decision.envelopeDigest, hash(input.envelope)); assert.equal(decision.kind, kind);
    const { decisionHash, ...core } = decision; assert.equal(decisionHash, hash(core));
    assert.equal(Object.isFrozen(decision.binding), true); assert.equal(Object.isFrozen(decision.nonceClaimRef), true);
    assert.equal(decision.verifiedAt, now);
    assert.equal(JSON.stringify(decision).includes(input.envelope.payload.nonce), false);
    assert.equal(decision.consumerId, input.context.actorId);
    assert.equal(verifier.productionCapable, false); calls.push(...f.calls);
    challenges.push(...f.captured.filter(([kind]) => kind === 'clock').map(([, input]) => input.requestNonce));
  }
  assert.deepEqual(calls, ['clock', 'consume', 'read', 'clock', 'clock', 'consume', 'read', 'clock', 'clock', 'consume', 'read', 'clock']);
  assert.equal(new Set(challenges).size, 6); challenges.forEach(value => assert.match(value, /^[a-f0-9]{32}$/));
});

test('absent or null recovery principal rejects only recovery without blocking ordinary authorization', async () => {
  for (const includeNull of [false, true]) {
    const f = fixture(); const config = options(); if (includeNull) config.recoveryPrincipal = null;
    const verifier = f.create(config);
    await assert.rejects(verifier.verifyAndConsume(request(signed('recovery'))), failure('invalid-request', 'not-attempted'));
    assert.deepEqual(f.calls, []); assert.equal((await verifier.verifyAndConsume(request())).productionAuthorized, false);
  }
});

test('recovery principal cannot overlap any signed participant even with matching role and credential', async () => {
  for (const actorId of Object.values(participants)) {
    const f = fixture(); const config = recoveryOptions(actorId); const input = request(signed('recovery')); input.context.actorId = actorId;
    await assert.rejects(async () => f.create(config).verifyAndConsume(input),
      failure(actorId === 'reader' ? 'invalid-config' : 'invalid-request', 'not-attempted'));
    assert.deepEqual(f.calls, []);
  }
});

test('recovery binds exact frozen role and every credential reference field before external calls', async () => {
  const f = fixture({ consumerId: 'rescuer' }); const verifier = f.create(recoveryOptions());
  for (const edit of [value => { value.roleId = 'other-role'; }, ...Object.keys(ref('jit-credential')).map(field => value => {
    value.credentialRef[field] = field === 'sha256' ? hash('other') : 'other'; })]) {
    const value = payload('recovery'); edit(value); const input = request(signed('recovery', value)); input.context.actorId = 'rescuer';
    await assert.rejects(verifier.verifyAndConsume(input), failure('invalid-request', 'not-attempted'));
  }
  assert.deepEqual(f.calls, []); assert.equal((await verifier.verifyAndConsume(recoveryRequest())).consumerId, 'rescuer');
});

test('frozen rescue configuration is detached and never authorizes ordinary executor consumption', async () => {
  const f = fixture({ consumerId: 'rescuer' }); const config = recoveryOptions(); const verifier = f.create(config);
  config.recoveryPrincipal.actorId = 'writer'; config.recoveryPrincipal.roleId = 'other'; config.recoveryPrincipal.credentialRef.objectVersion = 'v2';
  const ordinary = request(); ordinary.context.actorId = 'rescuer';
  await assert.rejects(verifier.verifyAndConsume(ordinary), failure('invalid-request', 'not-attempted'));
  assert.deepEqual(f.calls, []); assert.equal((await verifier.verifyAndConsume(recoveryRequest())).consumerId, 'rescuer');
});

test('malformed or mismatched rescue configuration is rejected without accessing hostile getters', () => {
  const f = fixture(); let calls = 0;
  const getter = Object.defineProperty({}, 'actorId', { enumerable: true, get() { calls += 1; throw new Error('secret'); } });
  for (const principal of [getter, {}, { actorId: 'rescuer', roleId: 'rescue-role', credentialRef: ref('jit-credential') },
    { actorId: 'writer', roleId: 'rescue-role', credentialRef: ref('jit-credential'), extra: true }]) {
    assert.throws(() => f.create({ ...options(), recoveryPrincipal: principal }), failure('invalid-config', 'not-attempted'));
  }
  assert.equal(calls, 0); assert.deepEqual(f.calls, []);
});

test('invalid signature or independent expectation spends neither clock challenge, nonce nor attempt capacity', async () => {
  const f = fixture(); const verifier = f.create({ ...options(), maxVerifications: 1 });
  const input = request();
  for (const edit of [value => { value.envelope.signature.value = Buffer.alloc(64, 1).toString('base64url'); },
    value => { value.expectedPayload.manifestHash = hash('wrong'); }]) {
    const changed = clone(input); edit(changed);
    await assert.rejects(verifier.verifyAndConsume(changed), failure('signature-invalid', 'not-attempted'));
  }
  assert.deepEqual(f.calls, []); assert.equal((await verifier.verifyAndConsume(input)).productionAuthorized, false);
});

test('context profile, actor and every scope/run/manifest field are bound before external calls', async () => {
  const f = fixture(); const verifier = f.create();
  const edits = [value => { value.context.executionProfile = 'enterprise'; }, value => { value.context.actorId = 'reader'; },
    value => { value.observedAt = now; }, ...Object.keys(binding).map(field => value => { value.context.binding[field] = field === 'runNonce'
      ? 'c'.repeat(32) : field === 'manifestHash' ? hash('wrong') : 'other'; })];
  for (const edit of edits) { const input = request(); edit(input);
    await assert.rejects(verifier.verifyAndConsume(input), failure('invalid-request', 'not-attempted')); }
  assert.deepEqual(f.calls, []);
});

test('revoked signer keys fail before any port operation and configuration is detached', async () => {
  const f = fixture(); const revoked = options(); revoked.keys[0].revoked = true;
  await assert.rejects(f.create(revoked).verifyAndConsume(request()), failure('signature-invalid', 'not-attempted'));
  assert.deepEqual(f.calls, []);
  const config = options(); const verifier = f.create(config); config.keys[0].revoked = true;
  config.actors.readOnlyId = 'writer'; config.clockIdentityRef.objectVersion = 'changed';
  assert.equal((await verifier.verifyAndConsume(request())).productionAuthorized, false);
});

test('replay, including a re-signed different run/digest, never becomes an exact successful authorization retry', async () => {
  const f = fixture(); const verifier = f.create(); const original = request();
  await verifier.verifyAndConsume(original);
  await assert.rejects(verifier.verifyAndConsume(original), failure('nonce-replayed', 'reported-not-consumed'));
  const changed = payload(); changed.runNonce = 'c'.repeat(32); changed.manifestHash = hash('another-run');
  const next = request(signed('execution', changed)); next.context.binding.runNonce = changed.runNonce;
  next.context.binding.manifestHash = changed.manifestHash;
  await assert.rejects(verifier.verifyAndConsume(next), failure('nonce-replayed', 'reported-not-consumed'));
});

test('nonce capacity exhaustion denies verification without eviction or false success', async () => {
  const f = fixture({ maxClaims: 1 }); const verifier = f.create(); await verifier.verifyAndConsume(request());
  const next = payload(); next.nonce = 'c'.repeat(32); next.authorizationId = 'other-approval';
  await assert.rejects(verifier.verifyAndConsume(request(signed('execution', next))), failure('nonce-capacity-exhausted', 'reported-not-consumed'));
});

test('clock uncertainty and deadline boundaries fail before nonce consumption', async () => {
  for (const edit of [value => { value.notBefore = now; }, value => { value.expiresAt = '2026-10-09T08:30:01.000Z';
    value.window.endsAt = value.expiresAt; }]) {
    const f = fixture({ uncertaintyMs: 1000 }); const verifier = f.create(); const value = payload(); edit(value);
    await assert.rejects(verifier.verifyAndConsume(request(signed('execution', value))), failure('clock-invalid', 'not-attempted'));
    assert.deepEqual(f.calls, ['clock']);
  }
});

test('clock source, reader, binding, challenge and profile mutations are rejected before nonce consumption', async () => {
  for (const edit of [value => { value.sourceIdentityRef.objectVersion = 'other'; }, value => { value.readerId = 'reader'; },
    value => { value.binding.manifestHash = hash('other'); }, value => { value.requestNonce = 'd'.repeat(32); },
    value => { value.productionTimeAuthenticated = true; }]) {
    const f = fixture(); f.supplied.clock.readTime = async input => { const value = clone(await f.clock.readTime(input)); edit(value); return value; };
    await assert.rejects(f.create().verifyAndConsume(request()), failure('clock-invalid', 'not-attempted'));
    assert.equal(f.captured.some(([kind]) => kind === 'consume'), false);
  }
});

test('a settled unavailable clock allows a fresh bounded attempt and is not reported as a consumed nonce', async () => {
  const f = fixture(); const verifier = f.create(); f.clock.setAvailability(false);
  await assert.rejects(verifier.verifyAndConsume(request()), failure('clock-operation-failed', 'not-attempted'));
  f.clock.setAvailability(true); assert.equal((await verifier.verifyAndConsume(request())).productionAuthorized, false);
});

test('exact nonce claim digest mismatch stops before readback and freezes the uncertain composer', async () => {
  const f = fixture(); f.supplied.nonceStore.consumeAuthorizationNonce = async input => {
    const result = clone(await f.nonceStore.consumeAuthorizationNonce(input)); result.claimRef.sha256 = hash('wrong'); return result;
  };
  const verifier = f.create(); await assert.rejects(verifier.verifyAndConsume(request()), failure('nonce-response-invalid', 'reported-consumed'));
  assert.equal(f.calls.includes('read'), false);
  await assert.rejects(verifier.verifyAndConsume(request(signed('result'))), failure('halted', 'not-attempted'));
});

test('every independent readback object/source/reader/ref substitution denies the consumed nonce rather than approving', async () => {
  for (const edit of [value => { value.object.authorizationId = 'other'; }, value => { value.proof.readerId = 'writer'; },
    value => { value.proof.storeIdentityRef.objectVersion = 'other'; }, value => { value.proof.objectRef.sha256 = hash('other'); },
    value => { value.proof.productionDurable = true; }]) {
    const f = fixture(); f.supplied.nonceStore.readExactNonceClaim = async input => {
      const value = clone(await f.nonceStore.readExactNonceClaim(input)); edit(value); return value;
    };
    await assert.rejects(f.create().verifyAndConsume(request()), failure('nonce-read-invalid', 'reported-consumed'));
  }
});

test('nonce provider errors after commit are unknown, redacted, terminal for this composer and never silently retried', async () => {
  const secret = 'vendor-secret'; const f = fixture(); let attempts = 0;
  f.supplied.nonceStore.consumeAuthorizationNonce = async input => { attempts += 1;
    await f.nonceStore.consumeAuthorizationNonce(input); throw new Error(secret);
  };
  const verifier = f.create(); await assert.rejects(verifier.verifyAndConsume(request()), error => {
    failure('nonce-operation-failed', 'unknown')(error); assert.equal(error.message.includes(secret), false); return true;
  });
  await assert.rejects(verifier.verifyAndConsume(request()), failure('halted', 'not-attempted'));
  assert.equal(attempts, 1);
});

test('a consumed nonce cannot produce a positive decision after readback delay crosses expiry', async () => {
  const f = fixture(); f.supplied.nonceStore.readExactNonceClaim = async input => {
    const result = await f.nonceStore.readExactNonceClaim(input); f.clock.advanceTo(expiresAt); return result;
  };
  await assert.rejects(f.create().verifyAndConsume(request()), failure('clock-invalid', 'reported-consumed'));
});

test('final clock sequence, time, binding and challenge must progress independently after readback', async () => {
  for (const edit of [value => { value.sequence = 1; }, value => { value.observedAt = '2026-10-09T08:29:59.000Z'; },
    value => { value.binding.runNonce = 'c'.repeat(32); }, value => { value.requestNonce = 'd'.repeat(32); }]) {
    const f = fixture(); let count = 0;
    f.supplied.clock.readTime = async input => { count += 1; const reading = clone(await f.clock.readTime(input));
      if (count === 2) edit(reading); return reading; };
    await assert.rejects(f.create().verifyAndConsume(request()), failure('clock-invalid', 'reported-consumed'));
  }
});

test('clock monotonicity spans successive verifications, even when a new approval has another kind', async () => {
  const f = fixture(); let reads = 0; let regress = true;
  f.supplied.clock.readTime = async input => { reads += 1; const value = clone(await f.clock.readTime(input));
    if (reads === 3 && regress) value.observedAt = '2026-10-09T08:29:59.000Z'; return value; };
  const verifier = f.create(); await verifier.verifyAndConsume(request());
  await assert.rejects(verifier.verifyAndConsume(request(signed('result'))), failure('clock-invalid', 'not-attempted'));
  assert.equal(f.calls.filter(kind => kind === 'consume').length, 1);
  regress = false; assert.equal((await verifier.verifyAndConsume(request(signed('result')))).productionAuthorized, false);
});

test('malformed nonce status/ref pairs are unknown, never treated as a definite replay or grant', async () => {
  for (const value of [{ status: 'replayed', claimRef: ref('unexpected') }, { status: 'passed', claimRef: null },
    { status: 'consumed', claimRef: null }, { status: 'replayed', claimRef: null, extra: true }]) {
    const f = fixture(); f.supplied.nonceStore.consumeAuthorizationNonce = async () => clone(value);
    const verifier = f.create();
    await assert.rejects(verifier.verifyAndConsume(request()), failure('nonce-response-invalid', value.status === 'consumed' ? 'reported-consumed' : 'unknown'));
    await assert.rejects(verifier.verifyAndConsume(request()), failure('halted', 'not-attempted'));
    assert.equal(f.calls.includes('read'), false);
  }
});

test('hostile readback data getters do not execute and a source exception never escapes', async () => {
  const f = fixture(); let calls = 0;
  f.supplied.nonceStore.readExactNonceClaim = async () => Object.defineProperty({}, 'object', {
    enumerable: true, get() { calls += 1; throw new Error('readback-secret'); } });
  const verifier = f.create(); await assert.rejects(verifier.verifyAndConsume(request()), error => {
    failure('nonce-read-invalid', 'reported-consumed')(error); assert.equal(error.message.includes('readback-secret'), false); return true;
  });
  assert.equal(calls, 0);
});

test('synchronous thenables are rejected without accessing then, and Proxy methods cannot enter the factory', async () => {
  const f = fixture(); let calls = 0; const trap = () => { calls += 1; throw new Error('then-secret'); };
  f.supplied.clock.readTime = () => Object.defineProperty({}, 'then', { enumerable: true, get: trap });
  await assert.rejects(f.create().verifyAndConsume(request()), failure('provider-contract-invalid', 'not-attempted', true, 'initial-clock'));
  const proxy = new Proxy(() => {}, { apply: trap, get: trap, ownKeys: trap });
  assert.throws(() => f.create(options(), { ...f.supplied, clock: { ...f.supplied.clock, readTime: proxy } }), /authority approval/);
  assert.equal(calls, 0);
});

test('clock timeout leaves pending completion unknown, does not consume nonce, and stops future verification', async t => {
  // Hold the target operation pending independently of wall-clock scheduling.
  // Elapsed starvation uses separate real-clock tests, not this phase oracle.
  t.mock.method(performance, 'now', () => 0);
  const f = fixture(); const barrier = deferred(); let completed = false; let late;
  f.supplied.clock.readTime = input => { late = (async () => { await barrier.promise;
    completed = true; return f.clock.readTime(input); })(); return late; };
  const verifier = f.create({ ...options(), operationTimeoutMs: 20 });
  try {
    await assert.rejects(verifier.verifyAndConsume(request()), failure('operation-timeout', 'not-attempted', true, 'initial-clock'));
    assert.ok(late); assert.equal(completed, false);
    await assert.rejects(verifier.verifyAndConsume(request()), failure('halted', 'not-attempted', false, 'preflight'));
    assert.equal(f.captured.some(([kind]) => kind === 'consume'), false);
  } finally { barrier.resolve(); if (late) await late; }
  assert.equal(completed, true);
});

test('consume timeout preserves unknown commit and late consumption without cancel/rollback claims', async t => {
  t.mock.method(performance, 'now', () => 0);
  const f = fixture(); const barrier = deferred(); let completed = false; let late;
  f.supplied.nonceStore.consumeAuthorizationNonce = input => { late = (async () => { await barrier.promise;
    const result = await f.nonceStore.consumeAuthorizationNonce(input); completed = true; return result;
  })(); return late; };
  const verifier = f.create({ ...options(), operationTimeoutMs: 20 });
  try {
    await assert.rejects(verifier.verifyAndConsume(request()), failure('operation-timeout', 'unknown', true, 'consume'));
    assert.ok(late); assert.equal(completed, false);
    await assert.rejects(verifier.verifyAndConsume(request()), failure('halted', 'not-attempted', false, 'preflight'));
    assert.equal(f.calls.includes('read'), false);
  } finally { barrier.resolve(); if (late) await late; }
  assert.equal(completed, true);
});

test('readback timeout reports prior consumed claim plus pending read and never grants permission', async t => {
  t.mock.method(performance, 'now', () => 0);
  const f = fixture(); const barrier = deferred(); let late;
  f.supplied.nonceStore.readExactNonceClaim = input => { late = (async () => {
    await barrier.promise; return f.nonceStore.readExactNonceClaim(input); })(); return late; };
  const verifier = f.create({ ...options(), operationTimeoutMs: 20 });
  try {
    await assert.rejects(verifier.verifyAndConsume(request()), failure('operation-timeout', 'reported-consumed', true, 'readback'));
    assert.ok(late); await assert.rejects(verifier.verifyAndConsume(request()), failure('halted', 'not-attempted', false, 'preflight'));
    assert.equal(f.calls.filter(kind => kind === 'clock').length, 1);
  } finally { barrier.resolve(); if (late) await late; }
});

test('final clock timeout preserves reported consumption and never issues a cached decision', async t => {
  t.mock.method(performance, 'now', () => 0);
  const f = fixture(); const barrier = deferred(); let calls = 0; let late;
  f.supplied.clock.readTime = input => { calls += 1; if (calls !== 2) return f.clock.readTime(input);
    late = (async () => { await barrier.promise; return f.clock.readTime(input); })(); return late; };
  const verifier = f.create({ ...options(), operationTimeoutMs: 20 });
  try {
    await assert.rejects(verifier.verifyAndConsume(request()), failure('operation-timeout', 'reported-consumed', true, 'final-clock'));
    assert.equal(calls, 2); assert.ok(late); assert.deepEqual(f.calls, ['consume', 'read']);
    await assert.rejects(verifier.verifyAndConsume(request()), failure('halted', 'not-attempted', false, 'preflight'));
  } finally { barrier.resolve(); if (late) await late; }
});

test('settled readback starvation is attributed to readback, not a pending final clock', async t => {
  let observedTime = 0; t.mock.method(performance, 'now', () => observedTime); const f = fixture();
  f.supplied.nonceStore.readExactNonceClaim = input => { observedTime = 40; return f.nonceStore.readExactNonceClaim(input); };
  await assert.rejects(f.create({ ...options(), operationTimeoutMs: 20 }).verifyAndConsume(request()),
    failure('operation-timeout', 'reported-consumed', false, 'readback'));
  assert.equal(f.calls.filter(kind => kind === 'clock').length, 1);
});
test('settled final-clock starvation preserves its exact phase without claiming pending completion', async t => {
  let observedTime = 0; t.mock.method(performance, 'now', () => observedTime); const f = fixture(); let calls = 0;
  f.supplied.clock.readTime = input => { if (++calls === 2) observedTime = 40; return f.clock.readTime(input); };
  await assert.rejects(f.create({ ...options(), operationTimeoutMs: 20 }).verifyAndConsume(request()),
    failure('operation-timeout', 'reported-consumed', false, 'final-clock'));
  assert.equal(calls, 2);
});

test('synchronous clock blocking past the deadline is rejected even when its fulfilled Promise beats the timer', async () => {
  const f = fixture();
  f.supplied.clock.readTime = input => { const deadline = performance.now() + 40;
    while (performance.now() < deadline) { /* Isolated counterexample: JS timers cannot interrupt this. */ }
    return f.clock.readTime(input);
  };
  await assert.rejects(f.create({ ...options(), operationTimeoutMs: 10 }).verifyAndConsume(request()),
    failure('operation-timeout', 'not-attempted', false));
  assert.equal(f.calls.includes('consume'), false);
});

test('synchronous consume blocking past the deadline reports unknown commit but a settled operation', async () => {
  const f = fixture();
  f.supplied.nonceStore.consumeAuthorizationNonce = input => { const deadline = performance.now() + 40;
    while (performance.now() < deadline) { /* The real local nonce may still commit after the deadline. */ }
    return f.nonceStore.consumeAuthorizationNonce(input);
  };
  const verifier = f.create({ ...options(), operationTimeoutMs: 10 });
  await assert.rejects(verifier.verifyAndConsume(request()), failure('operation-timeout', 'unknown', false));
  await assert.rejects(verifier.verifyAndConsume(request()), failure('halted', 'not-attempted'));
  assert.equal(f.calls.includes('read'), false);
});

test('one composer serializes async attempts and has a permanent attempt budget rather than unbounded pending work', async () => {
  const f = fixture(); let release; let entered;
  const entry = new Promise(resolve => { entered = resolve; }); const barrier = new Promise(resolve => { release = resolve; });
  f.supplied.clock.readTime = async input => { entered(); await barrier; return f.clock.readTime(input); };
  const verifier = f.create({ ...options(), maxVerifications: 1 }); const first = verifier.verifyAndConsume(request());
  await entry; await assert.rejects(verifier.verifyAndConsume(request()), failure('busy', 'not-attempted'));
  release(); assert.equal((await first).productionAuthorized, false);
  await assert.rejects(verifier.verifyAndConsume(request(signed('result'))), failure('attempt-capacity', 'not-attempted'));
});

test('all provider requests and independent expectations are detached/frozen across awaits', async () => {
  const f = fixture(); const input = request(); const originalDigest = hash(input.envelope);
  const pending = f.create().verifyAndConsume(input);
  input.expectedPayload.manifestHash = hash('mutated'); input.envelope.payload.nonce = 'c'.repeat(32);
  const decision = await pending; assert.equal(decision.envelopeDigest, originalDigest);
  for (const [, captured] of f.captured) { assert.equal(Object.isFrozen(captured), true);
    assert.equal(Object.isFrozen(captured.context.binding), true); }
});

test('method replacement after await cannot replace captured clock/store methods or invoke getters', async () => {
  const f = fixture(); let calls = 0; let getters = 0;
  f.supplied.clock.readTime = async input => { calls += 1;
    Object.defineProperty(f.supplied.clock, 'readTime', { enumerable: true, configurable: true, get() { getters += 1; throw new Error('secret'); } });
    return f.clock.readTime(input);
  };
  const verifier = f.create(); assert.equal((await verifier.verifyAndConsume(request())).productionAuthorized, false);
  assert.equal(calls, 2); assert.equal(getters, 0);
});

test('hostile input and port surfaces never execute getters/proxies or leak secret diagnostics', async () => {
  const secret = 'surface-secret'; let calls = 0; const trap = () => { calls += 1; throw new Error(secret); };
  const hostile = [new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    Object.defineProperty({}, 'context', { enumerable: true, get: trap }), { [secret]: true },
    JSON.parse('{"__proto__":{"context":"surface-secret"}}')];
  const f = fixture(); const verifier = f.create();
  for (const value of hostile) {
    await assert.rejects(verifier.verifyAndConsume(value), error => { failure('invalid-request', 'not-attempted')(error);
      assert.equal(error.message.includes(secret), false); return true; });
    assert.throws(() => f.create(options(), value), error => { assert.equal(error.message.includes(secret), false); return true; });
  }
  const getterClock = Object.defineProperty({ ...f.supplied.clock }, 'readTime', { enumerable: true, get: trap });
  assert.throws(() => f.create(options(), { clock: getterClock, nonceStore: f.supplied.nonceStore }), /authority approval/);
  assert.equal(calls, 0); assert.deepEqual(f.calls, []);
});

test('enterprise/fallback claims, reader/writer overlap and unbounded configuration are refused at factory entry', () => {
  const f = fixture();
  for (const edit of [value => { value.executionProfile = 'enterprise'; }, value => { value.actors.readOnlyId = 'writer'; },
    value => { value.operationTimeoutMs = 60001; }, value => { value.maxVerifications = 10001; },
    value => { value.clockIdentityRef.objectId = '../outside'; }, value => { value.endpoint = 'https://secret'; }]) {
    const config = options(); edit(config); assert.throws(() => f.create(config), /authority approval/);
  }
  for (const changes of [{ executionProfile: 'enterprise' }, { productionCapable: true }, { fallback: true }]) {
    assert.throws(() => f.create(options(), { ...f.supplied, clock: { ...f.supplied.clock, ...changes } }), /authority approval/);
  }
});

test('positive local composition is not registry/IAM/trusted-time/durable authority and resets across new reference instances', async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const f = fixture(); const result = await f.create().verifyAndConsume(request());
    assert.equal(result.productionAuthorized, false); assert.equal(result.validationLevel, 'local-reference-authority-composition');
  }
});
