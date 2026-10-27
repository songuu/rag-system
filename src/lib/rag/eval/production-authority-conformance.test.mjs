import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { canonicalJsonSha256 } from './canonical-json.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const authority = await import('./production-authority-ports.ts');
const suite = await import('./production-authority-conformance.ts');
const trust = await import('./production-provider-trust.ts');
const hash = canonicalJsonSha256; const clone = value => structuredClone(value);
const scope = { environment: 'isolated-lab', tenantId: 'lab-tenant', corpusId: 'lab-corpus' };
const binding = { ...scope, runNonce: 'a'.repeat(32), manifestHash: hash('manifest') };
const ref = label => ({ objectId: label, objectVersion: 'v1', sha256: hash(label) });
const initialObservedAt = '2026-10-09T10:00:00.000Z';
function options() { return { schemaVersion: 'kg-isolated-authority-conformance/v1', isolation: 'disposable-test-scope',
  executionProfile: 'local-reference', binding: clone(binding), actors: { consumerId: 'consumer', readOnlyId: 'reader' },
  clockIdentityRef: ref('clock'), nonceStoreIdentityRef: ref('nonce-store'), initialObservedAt,
  uncertaintyMs: 100, maxClockUncertaintyMs: 1000, nonceCapacity: 64, operationTimeoutMs: 1000 }; }
function fixture(changes = {}) {
  const actors = changes.actors ?? options().actors;
  const clock = authority.createReferenceAuthorityClock({ executionProfile: 'local-reference', scope,
    allowedActorIds: [actors.consumerId, actors.readOnlyId], sourceIdentityRef: ref('clock'), initialObservedAt,
    uncertaintyMs: 100, maxReadings: 2000, maxAdvanceMs: 86400000 });
  const nonceStore = authority.createReferenceAuthorizationNonceStore({ executionProfile: 'local-reference', scope,
    actors: { writerId: actors.consumerId, readOnlyId: actors.readOnlyId }, storeIdentityRef: ref('nonce-store'), clockIdentityRef: ref('clock'),
    maxClaims: 64, maxClockUncertaintyMs: 1000 });
  const calls = []; const captured = [];
  const ports = { clock: { ...clock, async readTime(request) { calls.push('clock'); captured.push(request); return clock.readTime(request); } },
    nonceStore: { ...nonceStore,
      async consumeAuthorizationNonce(request) { calls.push('consume'); captured.push(request); return nonceStore.consumeAuthorizationNonce(request); },
      async readExactNonceClaim(request) { calls.push('read'); captured.push(request); return nonceStore.readExactNonceClaim(request); } },
    clockControl: { async advanceTo(time) { calls.push('advance'); clock.advanceTo(time); },
      async setAvailability(available) { calls.push('availability'); clock.setAvailability(available); } } };
  return { clock, nonceStore, calls, captured, ports };
}
const run = (f, changes = {}) => suite.runIsolatedAuthorityConformance({ ...options(), ...changes }, f.ports);
for (const variant of ['getter', 'nonsettling-callable']) test(`resolved payload then ${variant} is never adopted by the async authority consumer`, { timeout: 1000 }, async () => {
  const f = fixture(); let traps = 0;
  f.ports.clock.readTime = request => new Promise(resolve => {
    f.clock.readTime(request).then(reading => { const value = { ...reading }; resolve(value);
      Object.defineProperty(value, 'then', variant === 'getter'
        ? { enumerable: true, get() { traps++; throw Error('payload-then-secret'); } }
        : { enumerable: true, value() { traps++; } });
    });
  });
  failed(await run(f), 'clock-identity'); assert.equal(traps, 0);
});
function failed(result, probe) {
  assert.equal(result.verdict, 'failed'); assert.equal(result.productionAccepted, false);
  assert.equal(result.requirementVerdict, 'incomplete');
  const index = result.probes.findIndex(value => value.outcome === 'failed'); assert.ok(index >= 0);
  if (probe) assert.equal(result.probes[index].probeId, probe);
  assert.ok(result.probes.slice(index + 1).every(value => value.outcome === 'not-run'));
  assert.equal(result.observationsHash, hash(result.observations));
}

test('fixed black-box authority probes verify operations, exact claims and rejection recovery, not enterprise authority', async () => {
  const f = fixture(); const result = await run(f);
  assert.equal(result.verdict, 'passed'); assert.equal(result.productionAccepted, false);
  assert.equal(result.requirementVerdict, 'incomplete'); assert.equal(result.pendingCompletionUnknown, false);
  assert.equal(result.validationLevel, 'isolated-behavioral-observations'); assert.equal(result.classification, 'confidential');
  assert.deepEqual(result.probes.map(value => value.probeId), suite.AUTHORITY_CONFORMANCE_PROBES);
  assert.ok(result.probes.every(value => value.outcome === 'passed' && value.failureCode === null));
  assert.equal(result.requirementsHash, trust.PROVIDER_CONFORMANCE_REQUIREMENTS_HASH);
  for (const purpose of ['clock', 'approval']) assert.deepEqual(result.unimplementedRequirements[purpose], trust.PROVIDER_CONFORMANCE_REQUIREMENTS[purpose]);
  const { observations, observationsHash, ...core } = result;
  assert.equal(observationsHash, hash(observations)); assert.deepEqual(core, observations);
  assert.equal(Object.isFrozen(result.probes), true); assert.match(result.challengeNonce, /^[a-f0-9]{32}$/);
  assert.ok(f.calls.filter(value => value === 'consume').length > 64);
  assert.ok(f.calls.filter(value => value === 'read').length >= 64);
  for (const request of f.captured) { assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.context.binding), true); }
  assert.equal(JSON.stringify(result).includes('authorizationNonce'), false);
});

test('invalid or hostile configuration and port surfaces fail before any call or getter', async () => {
  let traps = 0; const trap = () => { traps += 1; throw new Error('secret'); };
  for (const changes of [{ isolation: 'production' }, { executionProfile: 'production' }, { nonceCapacity: 63 },
    { operationTimeoutMs: 60001 }, { initialObservedAt: '9999-12-31T23:59:59.999Z' },
    { uncertaintyMs: 1001 }, { actors: { consumerId: 'reader', readOnlyId: 'reader' } }, { endpoint: 'https://secret' }]) {
    const f = fixture(); await assert.rejects(() => run(f, changes), /authority conformance/); assert.deepEqual(f.calls, []);
  }
  const inputs = [new Proxy(options(), { ownKeys: trap, get: trap }), Object.defineProperty(options(), 'binding', { enumerable: true, get: trap })];
  for (const input of inputs) await assert.rejects(() => suite.runIsolatedAuthorityConformance(input, fixture().ports), /authority conformance/);
  for (const input of [new Proxy(fixture().ports, { ownKeys: trap }),
    { ...fixture().ports, clock: Object.defineProperty({}, 'readTime', { enumerable: true, get: trap }) },
    { ...fixture().ports, clockControl: { advanceTo: new Proxy(async () => {}, { apply: trap, get: trap }), setAvailability: async () => {} } }]) {
    await assert.rejects(() => suite.runIsolatedAuthorityConformance(options(), input), /authority conformance/);
  }
  assert.equal(traps, 0);
});

test('clock response identity, uncertainty, exact initial time and caller correlation cannot self-report through the oracle', async () => {
  for (const edit of [value => { value.sourceIdentityRef.objectVersion = 'v2'; }, value => { value.readerId = 'reader'; },
    value => { value.binding.manifestHash = hash('other'); }, value => { value.requestNonce = 'f'.repeat(32); },
    value => { value.observedAt = '2026-10-09T10:00:00.001Z'; }, value => { value.uncertaintyMs = 0; },
    value => { value.productionTimeAuthenticated = true; }]) {
    const f = fixture(); f.ports.clock.readTime = async request => { const value = clone(await f.clock.readTime(request)); edit(value); return value; };
    failed(await run(f), 'clock-identity'); assert.equal(f.calls.includes('consume'), false);
  }
});

test('clock rejection must not consume the rejected challenge or sequence', async () => {
  const f = fixture(); f.ports.clock.readTime = async request => {
    if (request.context.actorId === 'consumer' && request.context.binding.environment !== scope.environment) {
      await f.clock.readTime({ ...request, context: { ...request.context, binding } }); throw new Error('secret');
    }
    return f.clock.readTime(request);
  };
  failed(await run(f), 'clock-context');
});

test('unavailability control must cause an actual fail-closed read, not an adapter availability claim', async () => {
  const f = fixture(); f.ports.clockControl.setAvailability = async () => {};
  failed(await run(f), 'clock-unavailable');
});

test('a cached clock success cannot acknowledge both concurrent uses of one challenge', async () => {
  const f = fixture(); const seen = new Map();
  f.ports.clock.readTime = async request => {
    if (!seen.has(request.requestNonce)) seen.set(request.requestNonce, f.clock.readTime(request));
    try { return await seen.get(request.requestNonce); } catch (error) { seen.delete(request.requestNonce); throw error; }
  };
  failed(await run(f), 'clock-challenge');
});

test('nonce success without a stored exact claim fails independent readback', async () => {
  const f = fixture(); f.ports.nonceStore.consumeAuthorizationNonce = async () => ({ status: 'consumed', claimRef: ref('invented') });
  failed(await run(f), 'nonce-consume-readback');
});

test('nonce rejection must leave its nonce and clock available for the corrected operation', async () => {
  const f = fixture(); f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    if (request.context.binding.environment !== scope.environment) {
      await f.nonceStore.consumeAuthorizationNonce({ ...request, context: { ...request.context, binding } }); throw new Error('secret');
    }
    return f.nonceStore.consumeAuthorizationNonce(request);
  };
  failed(await run(f), 'nonce-context');
});

test('replay cannot be re-signed or relabeled into a fresh kind, run or digest', async () => {
  const f = fixture(); f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    if (request.authorizationKind === 'result') return f.nonceStore.consumeAuthorizationNonce({ ...request, authorizationNonce: hash(['bad-kind', request.authorizationNonce]).slice(0, 32) });
    return f.nonceStore.consumeAuthorizationNonce(request);
  };
  failed(await run(f), 'nonce-replay-identity');
});

test('consumer and independent reader cannot be substituted and every readback field remains independently expected', async () => {
  for (const edit of [value => { value.object.authorizationId = 'other'; }, value => { value.proof.readerId = 'consumer'; },
    value => { value.proof.storeIdentityRef.sha256 = hash('other'); }, value => { value.proof.objectRef.objectVersion = 'v2'; },
    value => { value.proof.productionDurable = true; }]) {
    const f = fixture(); f.ports.nonceStore.readExactNonceClaim = async request => { const value = clone(await f.nonceStore.readExactNonceClaim(request)); edit(value); return value; };
    failed(await run(f), 'nonce-consume-readback');
  }
});

test('method capture resists replacement after await and ignores callable metadata getters', async () => {
  const f = fixture(); let getters = 0;
  const method = async request => {
    Object.defineProperty(f.ports.clock, 'readTime', { configurable: true, enumerable: true, get() { getters += 1; throw new Error('secret'); } });
    return f.clock.readTime(request);
  };
  for (const name of ['bind', 'length', 'name']) Object.defineProperty(method, name, { get() { getters += 1; throw new Error('secret'); } });
  f.ports.clock.readTime = method; assert.equal((await run(f)).verdict, 'passed'); assert.equal(getters, 0);
});

test('hostile readback getters and arbitrary provider rejection never execute or leak diagnostics', async () => {
  const f = fixture(); let getters = 0;
  f.ports.nonceStore.readExactNonceClaim = async () => Object.defineProperty({}, 'object', { enumerable: true, get() { getters += 1; throw new Error('source-secret'); } });
  const result = await run(f); failed(result, 'nonce-consume-readback');
  assert.equal(getters, 0); assert.equal(JSON.stringify(result).includes('source-secret'), false);
});

test('pending timeout is unknown completion and halts later probes without swallowing late rejection', async () => {
  const f = fixture(); let completed = false;
  f.ports.clock.readTime = async () => { await new Promise(resolve => setTimeout(resolve, 50)); completed = true; throw new Error('late-secret'); };
  const result = await run(f, { operationTimeoutMs: 10 }); failed(result, 'clock-identity'); assert.equal(result.pendingCompletionUnknown, true);
  assert.equal(f.calls.includes('consume'), false); await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(completed, true);
  assert.equal(JSON.stringify(result).includes('late-secret'), false);
});

test('synchronous blocking cannot win a fulfilled Promise race after the operation budget elapsed', async () => {
  const f = fixture(); f.ports.clock.readTime = request => { const until = performance.now() + 40;
    while (performance.now() < until) { /* Counterexample to trusting timer order. */ }
    return f.clock.readTime(request);
  };
  const result = await run(f, { operationTimeoutMs: 10 }); failed(result, 'clock-identity');
  assert.equal(result.pendingCompletionUnknown, false); assert.equal(result.probes[0].failureCode, 'operation-timeout');
});

test('synchronous thenables are rejected without reading then and profile claims fail at entry', async () => {
  const f = fixture(); let getters = 0;
  f.ports.clock.readTime = () => Object.defineProperty({}, 'then', { get() { getters += 1; throw new Error('then-secret'); } });
  failed(await run(f), 'clock-identity'); assert.equal(getters, 0);
  const bad = fixture(); bad.ports.clock.productionCapable = true;
  await assert.rejects(() => run(bad), /authority conformance/); assert.deepEqual(bad.calls, []);
});

test('issuer namespaces remain independent rather than sharing a global nonce tombstone', async () => {
  const f = fixture(); f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    if (request.issuerId !== 'lab-issuer') return { status: 'replayed', claimRef: null };
    return f.nonceStore.consumeAuthorizationNonce(request);
  };
  failed(await run(f), 'nonce-issuer-namespace');
});

test('two concurrent nonce callers cannot both acknowledge the one stored claim as consumed', async () => {
  const f = fixture(); let lastClaim; let concurrentNonce;
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const result = await f.nonceStore.consumeAuthorizationNonce(request);
    if (result.status === 'consumed') lastClaim = result.claimRef;
    if (result.status === 'replayed' && concurrentNonce === request.authorizationNonce) return { status: 'consumed', claimRef: lastClaim };
    return result;
  };
  let readsSinceConsume = 0; const originalClock = f.ports.clock.readTime;
  f.ports.clock.readTime = async request => { readsSinceConsume += 1; return originalClock(request); };
  const originalConsume = f.ports.nonceStore.consumeAuthorizationNonce; let consumedCalls = 0;
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    if (consumedCalls > 0 && readsSinceConsume === 2) concurrentNonce = request.authorizationNonce;
    consumedCalls += 1; readsSinceConsume = 0; return originalConsume(request);
  };
  failed(await run(f), 'nonce-concurrent-replay');
});

test('rejecting the second nonce on a shared clock must not secretly consume that loser nonce', async () => {
  const f = fixture(); const usedChallenges = new Set(); const pendingChallenges = new Set(); const usedNonces = new Set(); let poisonedNonce;
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const key = hash([request.issuerId, request.authorizationNonce]);
    if (poisonedNonce === key) return { status: 'replayed', claimRef: null };
    if ((usedChallenges.has(request.clockRequestNonce) || pendingChallenges.has(request.clockRequestNonce)) && !usedNonces.has(key)) {
      usedNonces.add(key); poisonedNonce = key; throw new Error('secret');
    }
    pendingChallenges.add(request.clockRequestNonce);
    try { const result = await f.nonceStore.consumeAuthorizationNonce(request);
      if (result.status === 'consumed') { usedChallenges.add(request.clockRequestNonce); usedNonces.add(key); } return result;
    } finally { pendingChallenges.delete(request.clockRequestNonce); }
  };
  failed(await run(f), 'nonce-concurrent-clock');
});

test('full clock validity rejection must leave the corrected nonce unconsumed', async () => {
  const f = fixture(); let poisoned;
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    if (request.clockRequestNonce !== request.clockReading.requestNonce) { poisoned = request.authorizationNonce; throw new Error('secret'); }
    if (request.authorizationNonce === poisoned) return { status: 'replayed', claimRef: null };
    return f.nonceStore.consumeAuthorizationNonce(request);
  };
  failed(await run(f), 'nonce-clock-validity');
});

test('rejecting an exact-readback substitution cannot destroy subsequent legitimate readback', async () => {
  const f = fixture(); let poisoned = false;
  f.ports.nonceStore.readExactNonceClaim = async request => {
    if (request.ref.objectVersion !== 'v1') { poisoned = true; throw new Error('secret'); }
    if (poisoned) throw new Error('legitimate claim lost'); return f.nonceStore.readExactNonceClaim(request);
  };
  failed(await run(f), 'nonce-exact-readback');
});

test('capacity cannot evict an old nonce tombstone and turn a later replay into consumption', async () => {
  const f = fixture(); let full = false; let firstRef;
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const result = await f.nonceStore.consumeAuthorizationNonce(request);
    if (result.status === 'consumed' && !firstRef) firstRef = result.claimRef;
    if (result.status === 'capacity-exhausted') full = true;
    if (full && result.status === 'replayed') return { status: 'consumed', claimRef: firstRef }; return result;
  };
  failed(await run(f), 'nonce-capacity');
});

test('capacity-exhausted status cannot leak a prior run exact claim reference', async () => {
  const f = fixture(); let firstRef;
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const result = await f.nonceStore.consumeAuthorizationNonce(request);
    if (result.status === 'consumed' && !firstRef) firstRef = result.claimRef;
    return result.status === 'capacity-exhausted' ? { ...result, claimRef: firstRef } : result;
  };
  failed(await run(f), 'nonce-capacity');
});

test('both concurrent clock outcomes are observed before freezing a pending-completion report', async () => {
  const f = fixture(); const active = new Set(); let completed = false;
  f.ports.clock.readTime = async request => {
    if (active.has(request.requestNonce)) { await new Promise(resolve => setTimeout(resolve, 80)); completed = true; throw new Error('late-secret'); }
    active.add(request.requestNonce); try { return await f.clock.readTime(request); } finally { active.delete(request.requestNonce); }
  };
  const result = await run(f, { operationTimeoutMs: 20 }); failed(result, 'clock-concurrent-challenge');
  assert.equal(result.pendingCompletionUnknown, true); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(completed, true);
  assert.equal(f.calls.includes('consume'), false);
});

test('a quick concurrent nonce rejection does not hide another already-started late commit', async () => {
  const f = fixture(); let readsSinceConsume = 0; let consumeCalls = 0; let concurrentNonce; let completed = false;
  f.ports.clock.readTime = async request => { readsSinceConsume += 1; return f.clock.readTime(request); };
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    if (consumeCalls > 0 && readsSinceConsume === 2) {
      concurrentNonce = request.authorizationNonce; readsSinceConsume = 0; consumeCalls += 1; throw new Error('early-secret');
    }
    readsSinceConsume = 0; consumeCalls += 1;
    if (request.authorizationNonce === concurrentNonce) {
      await new Promise(resolve => setTimeout(resolve, 80)); const result = await f.nonceStore.consumeAuthorizationNonce(request); completed = true; return result;
    }
    return f.nonceStore.consumeAuthorizationNonce(request);
  };
  const result = await run(f, { operationTimeoutMs: 20 }); failed(result, 'nonce-concurrent-replay');
  assert.equal(result.pendingCompletionUnknown, true); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(completed, true);
  assert.equal(JSON.stringify(result).includes('early-secret'), false); assert.equal(JSON.stringify(result).includes('late-secret'), false);
});

test('enterprise boolean labels cannot turn the local reference into an enterprise authority source', async () => {
  const f = fixture(); f.ports.clock.executionProfile = 'enterprise'; f.ports.clock.productionCapable = true;
  f.ports.nonceStore.executionProfile = 'enterprise'; f.ports.nonceStore.productionCapable = true;
  const result = await run(f, { executionProfile: 'enterprise' }); failed(result, 'clock-identity');
  assert.equal(result.productionAccepted, false); assert.equal(result.requirementVerdict, 'incomplete');
});

test('capacity rejection must not secretly tombstone the rejected issuer and nonce', async () => {
  const f = fixture(); const secretlyConsumed = new Set();
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const key = hash([request.issuerId, request.authorizationNonce]);
    if (secretlyConsumed.has(key)) return { status: 'replayed', claimRef: null };
    const result = await f.nonceStore.consumeAuthorizationNonce(request);
    if (result.status === 'capacity-exhausted') secretlyConsumed.add(key); return result;
  };
  failed(await run(f), 'nonce-capacity');
});

test('replay rejection must not burn the fresh clock that another legitimate nonce can use', async () => {
  const f = fixture(); const burned = new Set(); const consumed = new Set();
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const key = hash([request.issuerId, request.authorizationNonce]);
    if (burned.has(request.clockRequestNonce) && !consumed.has(key)) throw new Error('clock secretly burned');
    const result = await f.nonceStore.consumeAuthorizationNonce(request);
    if (result.status === 'consumed') consumed.add(key);
    if (result.status === 'replayed') burned.add(request.clockRequestNonce); return result;
  };
  failed(await run(f), 'nonce-replay-identity');
});

test('readback cannot normalize a wrong execution profile into access to the exact claim', async () => {
  const f = fixture(); f.ports.nonceStore.readExactNonceClaim = async request =>
    f.nonceStore.readExactNonceClaim({ ...request, context: { ...request.context, executionProfile: 'local-reference' } });
  failed(await run(f), 'nonce-exact-readback');
});

test('clock proof cannot normalize any wrong scope field into the legal request binding', async () => {
  for (const field of ['environment', 'tenantId', 'corpusId']) {
    const f = fixture(); f.ports.nonceStore.consumeAuthorizationNonce = async request => f.nonceStore.consumeAuthorizationNonce({
      ...request, clockReading: { ...request.clockReading, binding: { ...request.clockReading.binding, [field]: request.context.binding[field] } } });
    failed(await run(f), 'nonce-clock-validity');
  }
});

test('unknown nonce consumer cannot be normalized into the configured writer role', async () => {
  const f = fixture(); f.ports.nonceStore.consumeAuthorizationNonce = async request => f.nonceStore.consumeAuthorizationNonce({
    ...request, context: { ...request.context, actorId: ['consumer', 'reader'].includes(request.context.actorId) ? request.context.actorId : 'consumer' } });
  failed(await run(f), 'nonce-context');
});

test('a concurrent replay loser must not burn its otherwise reusable higher-sequence clock', async () => {
  const f = fixture(); const active = new Map(); const consumed = new Set(); const burned = new Set();
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const key = hash([request.issuerId, request.authorizationNonce]); const count = active.get(key) ?? 0;
    if (burned.has(request.clockRequestNonce) && !consumed.has(key)) throw new Error('concurrent clock secretly burned');
    active.set(key, count + 1);
    try { const result = await f.nonceStore.consumeAuthorizationNonce(request);
      if (result.status === 'consumed') consumed.add(key);
      if (result.status === 'replayed' && count > 0) burned.add(request.clockRequestNonce); return result;
    } finally { active.set(key, active.get(key) - 1); }
  };
  failed(await run(f), 'nonce-concurrent-replay');
});

test('the nonce race oracle also accepts a genuine higher-sequence winner without admitting stale loser clocks', async () => {
  const f = fixture(); let readsSinceConsume = 0; let consumeCalls = 0; let pairKey; let release; let reordered = false;
  f.ports.clock.readTime = async request => { readsSinceConsume += 1; return f.clock.readTime(request); };
  f.ports.nonceStore.consumeAuthorizationNonce = async request => {
    const key = hash([request.issuerId, request.authorizationNonce]); const shouldHold = consumeCalls > 0 && readsSinceConsume === 2 && !pairKey;
    consumeCalls += 1; readsSinceConsume = 0;
    if (shouldHold) {
      pairKey = key; await new Promise(resolve => { release = resolve; }); return f.nonceStore.consumeAuthorizationNonce(request);
    }
    if (key === pairKey && !reordered) {
      const result = await f.nonceStore.consumeAuthorizationNonce(request); assert.equal(result.status, 'consumed');
      reordered = true; release(); return result;
    }
    return f.nonceStore.consumeAuthorizationNonce(request);
  };
  assert.equal((await run(f)).verdict, 'passed'); assert.equal(reordered, true);
});

test('adversarial actor labels cannot collide with the actual independent reader role', async () => {
  const actors = { consumerId: 'adversarial', readOnlyId: 'alternate' }; const f = fixture({ actors });
  assert.equal((await run(f, { actors })).verdict, 'passed');
});

test('configuration and expected identities are detached before the first asynchronous boundary', async () => {
  const f = fixture(); const config = options(); const configHash = hash(config);
  const pending = suite.runIsolatedAuthorityConformance(config, f.ports);
  config.actors.consumerId = 'changed'; config.clockIdentityRef.objectVersion = 'v2'; config.nonceCapacity = 65;
  const result = await pending; assert.equal(result.verdict, 'passed'); assert.equal(result.configHash, configHash);
});
