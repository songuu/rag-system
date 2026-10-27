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
const artifacts = await import('./production-controlled-artifacts.ts');
const suite = await import('./production-artifact-conformance.ts');
const hash = canonicalJsonSha256;
const ref = id => ({ objectId: id, objectVersion: 'v1', sha256: hash(id) });
const binding = { environment: 'isolated-test', tenantId: 'test-tenant', corpusId: 'test-corpus',
  runNonce: '1'.repeat(32), manifestHash: hash('synthetic-manifest') };
function fixture() {
  const common = { executionProfile: 'local-reference', binding, actors: { executorId: 'writer', readOnlyId: 'reader' },
    validFrom: '2026-10-09T05:00:00.000Z', validUntil: '2026-10-09T06:00:00.000Z', maxObjects: 64 };
  return { options: { schemaVersion: 'kg-isolated-artifact-conformance/v1', isolation: 'disposable-test-scope',
    executionProfile: 'local-reference', binding, writerId: 'writer', readerId: 'reader',
    writerAuthorizationDigest: hash('writer-grant'), readerAuthorizationDigest: hash('reader-grant'),
    observedAt: common.validFrom, retainUntil: '2026-10-10T05:00:00.000Z', storeIdentityRef: ref('test-store'),
    maxPlaintextBytes: 1024, operationTimeoutMs: 1000 }, ports: {
    kms: artifacts.createReferenceKmsEnvelope({ ...common, keyPolicyRef: ref('test-key-policy'), maxPlaintextBytes: 1024 }),
    store: artifacts.createReferenceArtifactStore({ ...common, storeIdentityRef: ref('test-store'), maxObjectBytes: 16384 }),
  } };
}
const run = f => suite.runIsolatedArtifactConformance(f.options, f.ports);
for (const variant of ['getter', 'nonsettling-callable']) test(`resolved payload then ${variant} is never adopted by the async artifact consumer`, { timeout: 1000 }, async () => {
  const f = fixture(); const original = f.ports.kms.encryptArtifact; let traps = 0;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: request => new Promise(resolve => {
    original(request).then(envelope => { const value = { ...envelope }; resolve(value);
      Object.defineProperty(value, 'then', variant === 'getter'
        ? { enumerable: true, get() { traps++; throw Error('payload-then-secret'); } }
        : { enumerable: true, value() { traps++; } });
    });
  }) };
  expectFailure(await run(f), 'kms-roundtrip'); assert.equal(traps, 0);
});
test('synchronous provider starvation cannot pass artifact conformance', async () => {
  const f = fixture(); f.options.operationTimeoutMs = 10; let first = true;
  const original = f.ports.kms.encryptArtifact;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: request => {
    if (first) { first = false; const deadline = performance.now() + 40;
      while (performance.now() < deadline) { /* Timers cannot preempt the provider. */ }
    }
    return original(request);
  } };
  const result = await run(f); expectFailure(result, 'kms-roundtrip');
  assert.equal(result.pendingCompletionUnknown, false); assert.equal(result.probes[0].failureCode, 'operation-timeout');
});
test('thenable getter is not executed by artifact conformance', async () => {
  const f = fixture(); let traps = 0;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: () => Object.defineProperty({}, 'then', {
    get() { traps++; throw Error('thenable-secret'); },
  }) };
  expectFailure(await run(f), 'kms-roundtrip'); assert.equal(traps, 0);
});
test('contract-invalid negative decrypt is not mistaken for an authorized rejection', async () => {
  const f = fixture(); const original = f.ports.kms.decryptArtifact; let traps = 0;
  f.ports.kms = { ...f.ports.kms, decryptArtifact: request => hash(request.aad) === request.envelope.aadSha256
    ? original(request) : Object.defineProperty({}, 'then', { get() { traps++; throw Error('negative-then-secret'); } }) };
  const result = await run(f); expectFailure(result, 'kms-aad-all-fields');
  assert.equal(result.probes.find(value => value.outcome === 'failed').failureCode, 'provider-contract-invalid');
  assert.equal(result.pendingCompletionUnknown, true); assert.equal(traps, 0);
});
test('descriptor maps cannot inherit KMS methods from an own __proto__ value', async () => {
  const f = fixture(); let calls = 0; const kms = { ...f.ports.kms }; delete kms.encryptArtifact;
  const inherited = Object.defineProperty({}, 'encryptArtifact', { get() { calls++; throw new Error('descriptor-prototype-secret'); } });
  Object.defineProperty(kms, '__proto__', { enumerable: true, value: inherited }); f.ports.kms = kms;
  await assert.rejects(() => run(f), error => { assert.equal(error.message.includes('descriptor-prototype-secret'), false); return true; });
  assert.equal(calls, 0);
});
const labWriterContextMatches = data => data.context.actorId === 'writer'
  && data.context.executionProfile === 'local-reference' && hash(data.context.binding) === hash(binding);
function expectFailure(result, probe) {
  assert.equal(result.verdict, 'failed');
  assert.equal(result.probes.find(value => value.probeId === probe)?.outcome, 'failed');
  const index = result.probes.findIndex(value => value.outcome === 'failed');
  assert.ok(result.probes.slice(index + 1).every(value => value.outcome === 'not-run'));
  assert.equal(result.productionAccepted, false);
  assert.equal(result.classification, 'confidential');
}

test('independent probes execute actual reference methods and cannot become a signed conformance attestation', async () => {
  const f = fixture(); const result = await run(f);
  assert.equal(result.verdict, 'passed');
  assert.equal(result.probes.length, 18);
  assert.ok(result.probes.every(value => value.outcome === 'passed'));
  assert.equal(result.requirementVerdict, 'incomplete');
  assert.equal(result.productionAccepted, false);
  assert.equal(result.pendingCompletionUnknown, false);
  assert.equal(Object.isFrozen(result.probes), true);
  assert.equal(result.observationsHash, hash(result.observations));
  for (const field of ['verdict', 'pendingCompletionUnknown', 'classification', 'requirementVerdict', 'productionAccepted']) {
    assert.equal(result.observations[field], result[field]);
    assert.notEqual(hash({ ...result.observations, [field]: 'altered' }), result.observationsHash);
  }
  assert.ok(result.unimplementedRequirements.kms.includes('structured-redaction'));
  assert.ok(result.unimplementedRequirements['tamper-store'].includes('lifecycle-and-legal-hold'));
  assert.equal(Object.hasOwn(result, 'signature'), false);
});

test('positive controls reject an adapter which always rejects', async () => {
  const f = fixture(); f.ports.kms = { ...f.ports.kms, encryptArtifact: async () => { throw Error('secret=do-not-record'); } };
  const result = await run(f); expectFailure(result, 'kms-roundtrip');
  assert.equal(JSON.stringify(result).includes('do-not-record'), false);
});

test('reused nonce is detected independently of provider verdicts', async () => {
  const f = fixture(); const original = f.ports.kms.encryptArtifact; let nonce;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: async request => {
    const envelope = await original(request); nonce ??= envelope.nonce; return { ...envelope, nonce };
  } };
  expectFailure(await run(f), 'kms-nonce-object-separation');
});

test('third-object nonce reuse cannot escape pairwise checks', async () => {
  const f = fixture(); const encrypt = f.ports.kms.encryptArtifact; let firstNonce; let successes = 0;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: async request => {
    const envelope = await encrypt(request); firstNonce ??= envelope.nonce; successes++;
    return successes === 3 ? { ...envelope, nonce: firstNonce } : envelope;
  } };
  const result = await run(f); expectFailure(result, 'kms-role-and-scope');
  assert.equal(result.probes.find(value => value.outcome === 'failed').failureCode, 'nonce-reused');
});

test('KMS ignoring AAD fails the harness even when its metadata is correct', async () => {
  const f = fixture(); const original = f.ports.kms; const aads = new Map();
  f.ports.kms = { ...original, encryptArtifact: async request => {
    const envelope = await original.encryptArtifact(request); aads.set(envelope.nonce, request.aad); return envelope;
  }, decryptArtifact: request => original.decryptArtifact({ ...request, aad: aads.get(request.envelope.nonce) }) };
  expectFailure(await run(f), 'kms-aad-all-fields');
});

test('forged envelope AAD digest cannot substitute for AEAD authentication', async () => {
  const f = fixture(); const original = f.ports.kms.decryptArtifact; const aads = new Map();
  const encrypt = f.ports.kms.encryptArtifact;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: async request => { const e = await encrypt(request); aads.set(e.nonce, request.aad); return e; },
    decryptArtifact: request => {
      if (request.envelope.aadSha256 !== hash(request.aad)) return original(request);
      const originalAad = aads.get(request.envelope.nonce);
      return original({ ...request, aad: originalAad,
        envelope: { ...request.envelope, aadSha256: hash(originalAad) } });
    } };
  expectFailure(await run(f), 'kms-aad-all-fields');
});

test('all ten AAD fields must remain authenticated when the public digest is recomputed', async () => {
  const f = fixture(); const original = f.ports.kms;
  const normalize = aad => ({ ...aad, ...binding, artifactType: 'response', caseId: '1'.repeat(32),
    ordinal: 0, schemaVersion: 'kg-conformance-challenge/v1' });
  f.ports.kms = { ...original, encryptArtifact: async data => {
    const envelope = await original.encryptArtifact({ ...data, aad: normalize(data.aad) });
    return { ...envelope, aadSha256: hash(data.aad) };
  }, decryptArtifact: data => {
    if (data.envelope.aadSha256 !== hash(data.aad)) throw Error('digest mismatch');
    const normalized = normalize(data.aad);
    return original.decryptArtifact({ ...data, aad: normalized, envelope: { ...data.envelope, aadSha256: hash(normalized) } });
  } };
  expectFailure(await run(f), 'kms-aad-all-fields');
});

test('plaintext size limit is tested against the configured boundary', async () => {
  const f = fixture(); f.options.maxPlaintextBytes = 512;
  expectFailure(await run(f), 'kms-plaintext-bound');
});

test('both concurrent store creates succeeding fails and stops further probes', async () => {
  const f = fixture(); const seal = f.ports.store.sealEncryptedArtifact; let last;
  f.ports.store = { ...f.ports.store, sealEncryptedArtifact: async request => {
    try { last = await seal(request); return last; } catch { return last; }
  } };
  expectFailure(await run(f), 'store-exclusive-create');
});

test('store reader proof is independently matched to the expected identity', async () => {
  const f = fixture(); const read = f.ports.store.readExact;
  f.ports.store = { ...f.ports.store, readExact: async request => {
    const result = await read(request); return { ...result, proof: { ...result.proof, readerId: 'wrong-reader' } };
  } };
  expectFailure(await run(f), 'store-exact-readback');
});

test('latest-object fallback instead of exact version readback is rejected', async () => {
  const f = fixture(); const read = f.ports.store.readExact; let known;
  f.ports.store = { ...f.ports.store, readExact: async request => {
    try { const result = await read(request); known = request.ref; return result; }
    catch { return read({ ...request, ref: known }); }
  } };
  expectFailure(await run(f), 'store-exact-reference-rejection');
});

test('revocation no-op is detected with new-key positive control', async () => {
  const f = fixture(); const original = f.ports.kms;
  f.ports.kms = { ...original, revokeKey: async data => {
    if (!labWriterContextMatches(data)) return original.revokeKey(data);
  } };
  expectFailure(await run(f), 'kms-key-revocation');
});

test('selective first-ciphertext denial is not proof the old key was revoked', async () => {
  const f = fixture(); const original = f.ports.kms; let firstRevoke = true; let selectiveDenial = false;
  f.ports.kms = { ...original, revokeKey: async data => {
    if (!labWriterContextMatches(data)) return original.revokeKey(data);
    if (firstRevoke) { firstRevoke = false; selectiveDenial = true; return; }
    return original.revokeKey(data);
  }, decryptArtifact: data => {
    if (selectiveDenial && data.aad.ordinal === 0) throw Error('selective denial');
    return original.decryptArtifact(data);
  } };
  expectFailure(await run(f), 'kms-key-revocation');
});

test('all five context binding fields must be independently enforced', async () => {
  const f = fixture(); const original = f.ports;
  const normalize = data => ({ ...data, context: { ...data.context, binding: {
    ...binding, corpusId: data.context.binding.corpusId } } });
  f.ports = { kms: { ...original.kms,
    encryptArtifact: data => original.kms.encryptArtifact(normalize(data)),
    decryptArtifact: data => original.kms.decryptArtifact(normalize(data)),
    rotateKey: data => original.kms.rotateKey(normalize(data)), revokeKey: data => original.kms.revokeKey(normalize(data)) },
  store: { ...original.store, sealEncryptedArtifact: data => original.store.sealEncryptedArtifact(normalize(data)),
    readExact: data => original.store.readExact(normalize(data)) } };
  expectFailure(await run(f), 'kms-role-and-scope');
});

test('store write scope probe must use valid AAD rather than fail incidentally on AAD mismatch', async () => {
  const f = fixture(); const seal = f.ports.store.sealEncryptedArtifact;
  f.ports.store = { ...f.ports.store, sealEncryptedArtifact: data => seal({ ...data,
    context: { ...data.context, binding } }) };
  expectFailure(await run(f), 'store-role-and-scope');
});

test('read-only credentials cannot rotate or revoke KMS keys', async () => {
  const f = fixture(); const original = f.ports.kms;
  const elevate = data => ({ ...data, context: { ...data.context, actorId: 'writer' } });
  f.ports.kms = { ...original, rotateKey: data => original.rotateKey(elevate(data)),
    revokeKey: data => original.revokeKey(elevate(data)) };
  expectFailure(await run(f), 'kms-role-and-scope');
});

test('per-request profile cannot be silently normalized to an authorized profile', async () => {
  const f = fixture(); const encrypt = f.ports.kms.encryptArtifact;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: data => encrypt({ ...data,
    context: { ...data.context, executionProfile: 'local-reference' } }) };
  expectFailure(await run(f), 'kms-role-and-scope');
});

test('rejected key management cannot secretly rotate the active key first', async () => {
  const f = fixture(); const original = f.ports.kms;
  f.ports.kms = { ...original, rotateKey: async data => {
    if (labWriterContextMatches(data)) return original.rotateKey(data);
    await original.rotateKey({ context: { ...data.context, actorId: 'writer', executionProfile: 'local-reference', binding } });
    throw Error('denied after mutation');
  } };
  expectFailure(await run(f), 'kms-role-and-scope');
});

test('rejected encryption cannot secretly consume the object identity', async () => {
  const f = fixture(); const original = f.ports.kms;
  f.ports.kms = { ...original, encryptArtifact: async data => {
    if (labWriterContextMatches(data)) return original.encryptArtifact(data);
    await original.encryptArtifact({ ...data, context: { ...data.context, actorId: 'writer', executionProfile: 'local-reference', binding } });
    throw Error('denied after encryption');
  } };
  expectFailure(await run(f), 'kms-role-and-scope');
});

test('rejected store seal cannot leave a hidden immutable object behind', async () => {
  const f = fixture(); const original = f.ports.store;
  f.ports.store = { ...original, sealEncryptedArtifact: async data => {
    if (labWriterContextMatches(data)) return original.sealEncryptedArtifact(data);
    await original.sealEncryptedArtifact({ ...data, context: { ...data.context, actorId: 'writer', executionProfile: 'local-reference', binding } });
    throw Error('denied after seal');
  } };
  expectFailure(await run(f), 'store-role-and-scope');
});

test('nonce is authenticated, not a unique decorative envelope field', async () => {
  const f = fixture(); const original = f.ports.kms; const nonceByCiphertext = new Map();
  f.ports.kms = { ...original, encryptArtifact: async data => {
    const envelope = await original.encryptArtifact(data); nonceByCiphertext.set(envelope.ciphertext, envelope.nonce); return envelope;
  }, decryptArtifact: data => original.decryptArtifact({ ...data, envelope: { ...data.envelope,
    nonce: nonceByCiphertext.get(data.envelope.ciphertext) ?? data.envelope.nonce } }) };
  expectFailure(await run(f), 'kms-ciphertext-authentication');
});

test('same artifact ID cannot be re-encrypted by changing AAD or plaintext', async () => {
  const f = fixture(); const original = f.ports.kms; const seen = new Map();
  f.ports.kms = { ...original, encryptArtifact: async data => {
    const identity = hash([data.aad, data.plaintextBase64url]);
    if (seen.has(data.aad.artifactId) && seen.get(data.aad.artifactId) !== identity) return fixture().ports.kms.encryptArtifact(data);
    const envelope = await original.encryptArtifact(data); seen.set(data.aad.artifactId, identity); return envelope;
  } };
  expectFailure(await run(f), 'kms-duplicate-object-rejection');
});

test('same sealed artifact ID cannot gain a replacement version by changing retention', async () => {
  const f = fixture(); const original = f.ports.store; const retained = new Map();
  f.ports.store = { ...original, sealEncryptedArtifact: async data => {
    if (retained.has(data.aad.artifactId) && retained.get(data.aad.artifactId) !== data.retainUntil) {
      return fixture().ports.store.sealEncryptedArtifact(data);
    }
    const result = await original.sealEncryptedArtifact(data); retained.set(data.aad.artifactId, data.retainUntil); return result;
  } };
  expectFailure(await run(f), 'store-immutable-retry');
});

test('rotation cannot be implemented as aliases for one old key', async () => {
  const f = fixture(); const original = f.ports.kms; let old; let active; let alias; const revoked = new Set();
  const keyId = value => hash(value);
  f.ports.kms = { ...original, encryptArtifact: async data => {
    if (active && revoked.has(keyId(active))) throw Error('revoked');
    const envelope = await original.encryptArtifact(data); old ??= envelope.keyRef; active ??= old;
    return { ...envelope, keyRef: active };
  }, rotateKey: async data => {
    if (!labWriterContextMatches(data)) return original.rotateKey(data);
    alias = ref('metadata-only-new-key'); active = alias; return alias;
  },
  decryptArtifact: data => {
    const identity = keyId(data.envelope.keyRef);
    if (revoked.has(identity)) throw Error('revoked');
    const known = identity === keyId(old) || (alias && identity === keyId(alias));
    return original.decryptArtifact({ ...data, envelope: { ...data.envelope, keyRef: known ? old : data.envelope.keyRef } });
  }, revokeKey: async data => {
    if (!labWriterContextMatches(data)) return original.revokeKey(data);
    revoked.add(keyId(data.keyRef));
  } };
  expectFailure(await run(f), 'kms-key-rotation');
});

test('captured adapter methods survive caller mutation during an await', async () => {
  const f = fixture(); const port = { ...f.ports.kms }; const original = port.encryptArtifact;
  port.encryptArtifact = async request => { port.decryptArtifact = async () => 'fake'; return original(request); };
  f.ports.kms = port;
  assert.equal((await run(f)).verdict, 'passed');
});

test('getters and Proxy functions are rejected before any adapter method executes', async () => {
  const f = fixture(); let calls = 0;
  Object.defineProperty(f.ports, 'kms', { get() { calls++; return fixture().ports.kms; } });
  await assert.rejects(run(f), /conformance/); assert.equal(calls, 0);
  const g = fixture(); let traps = 0;
  g.ports.kms = { ...g.ports.kms, encryptArtifact: new Proxy(() => {}, { get() { traps++; throw Error(); } }) };
  await assert.rejects(run(g), /conformance/); assert.equal(traps, 0);
});

test('timeout is not treated as successful rejection and late completion is explicitly unknown', async () => {
  const f = fixture(); f.options.operationTimeoutMs = 20;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: () => new Promise(() => {}) };
  const result = await run(f); expectFailure(result, 'kms-roundtrip');
  assert.equal(result.pendingCompletionUnknown, true);
  assert.equal(result.observations.pendingCompletionUnknown, true);
  assert.equal(result.probes[0].failureCode, 'operation-timeout');
});

test('unsafe options fail before adapter calls and caller data is snapshotted', async () => {
  for (const mutate of [o => { o.isolation = 'production'; }, o => { o.writerId = o.readerId; },
    o => { o.executionProfile = 'fake'; }, o => { o.endpoint = 'https://evil.example'; },
    o => { o.retainUntil = o.observedAt; }, o => { o.operationTimeoutMs = 0; }]) {
    const f = fixture(); mutate(f.options); let called = false;
    f.ports.kms = { ...f.ports.kms, encryptArtifact: () => { called = true; throw Error(); } };
    await assert.rejects(run(f), /conformance/); assert.equal(called, false);
  }
  const f = fixture(); const encrypt = f.ports.kms.encryptArtifact;
  f.ports.kms = { ...f.ports.kms, encryptArtifact: async request => {
    f.options.writerId = 'attacker'; f.options.storeIdentityRef.objectId = 'changed'; return encrypt(request);
  } };
  assert.equal((await run(f)).verdict, 'passed');
});

test('local ports cannot be relabelled as enterprise or claim capability through booleans', async () => {
  const f = fixture(); f.options.executionProfile = 'enterprise';
  await assert.rejects(run(f), /conformance/);
  const g = fixture(); g.ports.kms = { ...g.ports.kms, productionCapable: true };
  await assert.rejects(run(g), /conformance/);
});

test('same probes run against enterprise-profile lab wrappers without granting enterprise trust', async () => {
  const f = fixture(); f.options.executionProfile = 'enterprise';
  const local = f.ports;
  const request = data => {
    if (data.context.executionProfile !== 'enterprise') throw Error('lab profile mismatch');
    return { ...data, context: { ...data.context, executionProfile: 'local-reference' } };
  };
  f.ports = { kms: { executionProfile: 'enterprise', productionCapable: true,
    encryptArtifact: data => local.kms.encryptArtifact(request(data)),
    decryptArtifact: data => local.kms.decryptArtifact(request(data)),
    rotateKey: data => local.kms.rotateKey(request(data)), revokeKey: data => local.kms.revokeKey(request(data)) },
  store: { executionProfile: 'enterprise', productionCapable: true,
    sealEncryptedArtifact: data => local.store.sealEncryptedArtifact(request(data)),
    readExact: async data => { const result = await local.store.readExact(request(data));
      return { ...result, proof: { ...result.proof, assurance: 'enterprise', productionTamperResistant: true,
        lockMode: 'compliance-worm', observedAt: '2026-10-09T05:00:00.001Z' } }; } } };
  const result = await run(f);
  assert.equal(result.verdict, 'passed');
  assert.equal(result.requirementVerdict, 'incomplete');
  assert.equal(result.productionAccepted, false);
  // These are deliberately labelled lab fakes, not authenticated enterprise providers.
  assert.ok(Object.values(result.unimplementedRequirements).every(values => values.includes('exact-identity')));
});

test('timeout on a negative probe remains failure rather than a safe rejection', async () => {
  const f = fixture(); f.options.operationTimeoutMs = 20; const decrypt = f.ports.kms.decryptArtifact;
  f.ports.kms = { ...f.ports.kms, decryptArtifact: data => data.aad.environment !== binding.environment
    ? new Promise(() => {}) : decrypt(data) };
  const result = await run(f); expectFailure(result, 'kms-aad-all-fields');
  assert.equal(result.probes.find(value => value.probeId === 'kms-aad-all-fields').failureCode, 'operation-timeout');
  assert.equal(result.pendingCompletionUnknown, true);
});

test('unsafe readback timestamps and accessor outputs are rejected without leaking values', async () => {
  for (const observedAt of ['2026-10-09T04:59:59.999Z', '2026-10-10T05:00:00.000Z', 'invalid']) {
    const f = fixture(); const read = f.ports.store.readExact;
    f.ports.store = { ...f.ports.store, readExact: async data => {
      const result = await read(data); return { ...result, proof: { ...result.proof, observedAt } };
    } };
    expectFailure(await run(f), 'store-exact-readback');
  }
  const f = fixture(); let calls = 0; const read = f.ports.store.readExact;
  f.ports.store = { ...f.ports.store, readExact: async data => {
    const result = await read(data); const output = { proof: result.proof };
    Object.defineProperty(output, 'object', { enumerable: true, get() { calls++; throw Error('private secret'); } });
    return output;
  } };
  const result = await run(f); expectFailure(result, 'store-exact-readback'); assert.equal(calls, 0);
  assert.equal(JSON.stringify(result).includes('private secret'), false);
});
