import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { canonicalJson, canonicalJsonSha256 as hash } from './canonical-json.ts';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const api = await import('./production-authorized-journal.ts');
const journal = await import('./production-run-journal.ts');
const receipts = await import('./production-receipts.ts');
const clone = value => structuredClone(value);
const scope = { environment: 'local-test', tenantId: 'tenant-a', corpusId: 'corpus-a' };
const ref = (id, digest = hash(id)) => ({ objectId: id, objectVersion: 'v1', sha256: digest });
const roles = { executionApproverId: 'approver-a', executorId: 'executor-a', readOnlyId: 'reader-a',
  resultAuthorityId: 'result-a', recoveryAuthorityId: 'recovery-a' };
const pairs = Object.fromEntries(['execution', 'recovery'].map(kind => [kind, generateKeyPairSync('ed25519')]));
const executor = { actorId: roles.executorId, roleId: null, credentialRef: null };
const rescuer = { actorId: 'rescuer-a', roleId: 'rescue-role', credentialRef: ref('rescue-credential') };
function signEnvelope(kind, payload) {
  const schemaVersion = kind === 'execution' ? 'kg-execution-authorization-envelope/v1' : 'kg-safety-recovery-authorization-envelope/v1';
  const signer = { algorithm: 'Ed25519', keyId: `${kind}-key`, keyVersion: 'v1' };
  const bytes = canonicalJson({ signatureProfile: 'kg-production-authorization-signature/v1', schemaVersion, kind, payload, signer });
  return { schemaVersion, kind, payload: clone(payload), signature: { ...signer,
    value: sign(null, Buffer.from(bytes), pairs[kind].privateKey).toString('base64url') } };
}
function fixture(stage = 'T17') {
  const payload = { stage, scope: clone(scope), manifestHash: hash('manifest'), runNonce: '1'.repeat(32),
    authorizationId: 'execution-a', nonce: '2'.repeat(32), issuerId: roles.executionApproverId,
    participants: { ...roles, recoveryAuthorityId: stage === 'T17' ? roles.recoveryAuthorityId : null },
    issuedAt: '2026-10-09T05:00:00.000Z', notBefore: '2026-10-09T05:00:00.000Z', expiresAt: '2026-10-09T05:01:00.000Z',
    operation: stage === 'T17' ? 'execute-t17-canary' : stage === 'T16' ? 'execute-t16-shadow' : 'verify-retention',
    registryRef: ref('registry'), providersHash: hash('providers'), thresholdsHash: hash('thresholds'),
    window: { startsAt: '2026-10-09T05:00:00.000Z', endsAt: '2026-10-09T05:01:00.000Z' } };
  const execution = signEnvelope('execution', payload); const executionRef = ref('execution-a', hash(execution));
  const unsignedPolicy = { schemaVersion: 'kg-safety-recovery-policy/v1', authorityId: roles.recoveryAuthorityId,
    roleId: rescuer.roleId, scopeHash: hash(scope),
    allowedActions: ['withdraw-traffic', 'revoke-existing-fault', 'set-off', 'rollback-to-predecessor'],
    lineage: { predecessorRef: ref('predecessor'), targetRef: ref('target'), expectedPointerRevision: 3 },
    maxAuthorizationTtlMs: 30000, credentialPolicyRef: ref('credential-policy') };
  const policy = { ...unsignedPolicy, policyHash: hash(unsignedPolicy) };
  const options = { schemaVersion: 'kg-reference-authorized-journal/v1', executionProfile: 'local-reference',
    expectedExecutionPayload: payload, executionAuthorizationRef: executionRef, originalFencingGeneration: 7,
    recoveryPolicy: stage === 'T17' ? policy : null, recoveryActorId: stage === 'T17' ? rescuer.actorId : null,
    initialTime: '2026-10-09T05:00:10.000Z', approvalOptions: { executionProfile: 'local-reference', maxConsumedNonces: 17,
      keys: ['execution', 'recovery'].map(kind => ({ keyId: `${kind}-key`, keyVersion: 'v1',
        issuerId: kind === 'execution' ? roles.executionApproverId : roles.recoveryAuthorityId, role: kind,
        publicKeySpki: pairs[kind].publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        validFrom: '2026-10-09T04:00:00.000Z', validUntil: '2026-10-09T06:00:00.000Z', revoked: false })) } };
  return { options, execution, executionRef, policy };
}
async function setup(stage = 'T17') {
  const f = fixture(stage); const writer = api.createReferenceAuthorizedJournal(f.options);
  await writer.authorizeExecution({ envelope: f.execution }); return { ...f, writer };
}
function recovery(f, overrides = {}) {
  const payload = { stage: 'T17', scope: clone(scope), manifestHash: f.options.expectedExecutionPayload.manifestHash,
    runNonce: f.options.expectedExecutionPayload.runNonce, authorizationId: 'recovery-a', nonce: '3'.repeat(32),
    issuerId: roles.recoveryAuthorityId, participants: clone(roles), issuedAt: '2026-10-09T05:02:00.000Z',
    notBefore: '2026-10-09T05:02:00.000Z', expiresAt: '2026-10-09T05:02:30.000Z', operation: 'safety-recovery',
    frozenPolicyHash: f.policy.policyHash, originalExecutionAuthorizationRef: f.executionRef,
    originalFencingGeneration: 7, fencingGeneration: 8, lineage: clone(f.policy.lineage),
    rollbackExpectedPointerRevision: 4, allowedActions: clone(f.policy.allowedActions),
    credentialRef: rescuer.credentialRef, roleId: rescuer.roleId, approvedMaxTtlMs: 30000, ...overrides };
  const envelope = signEnvelope('recovery', payload); return { envelope, authorizationRef: ref('recovery-a', hash(envelope)) };
}
function request(expectedHead, authorizationRef, overrides = {}) {
  return { expectedHead, authorizationRef, principal: clone(executor), kind: 'intent', idempotencyKey: 'read-a',
    action: 'readback', parametersDigest: hash('params'), beforeDigest: hash('before'), afterDigest: null,
    intentDigest: null, outcome: null, ...overrides };
}
const append = async (f, overrides = {}) => f.writer.append(request(await f.writer.readHead(), f.executionRef, overrides));

test('actual signed execution authorizes a private CAS journal, never production acceptance', async () => {
  const f = await setup(); const result = await append(f);
  assert.equal(result.status, 'appended'); assert.equal(result.productionAccepted, false);
  assert.equal(result.validationLevel, 'local-reference-authorized-write');
  assert.equal(result.entry.actorId, roles.executorId); assert.equal(result.entry.authorizationDigest, f.executionRef.sha256);
  assert.equal(result.entry.trustedTime, f.options.initialTime); assert.equal(result.entry.fencingGeneration, 7);
  assert.equal(f.writer.productionCapable, false); assert.equal('compareAndAppend' in f.writer, false);
  assert.equal(journal.validateJournalChain(await f.writer.readEntries(), result.head.binding, result.head).entryCount, 1);
});

test('absent, unsigned, wrong signer, changed frozen payload and substituted envelope refs cannot write', async () => {
  for (const change of [envelope => { envelope.signature.value = Buffer.alloc(64).toString('base64url'); },
    envelope => { envelope.signature.keyId = 'recovery-key'; }, envelope => { envelope.payload.providersHash = hash('other'); }]) {
    const f = fixture(); const writer = api.createReferenceAuthorizedJournal(f.options); const envelope = clone(f.execution); change(envelope);
    await assert.rejects(writer.authorizeExecution({ envelope }), /authorized journal/);
    assert.equal((await writer.readHead()).entryCount, 0);
  }
  const f = fixture(); const writer = api.createReferenceAuthorizedJournal(f.options);
  await assert.rejects(writer.append(request(await writer.readHead(), f.executionRef)), /authorization/);
  const prepared = await setup();
  await assert.rejects(prepared.writer.append(request(await prepared.writer.readHead(), { ...prepared.executionRef, objectVersion: 'v2' })), /authorization/);
});

test('execution registration consumes its signed nonce once, not once per action', async () => {
  const f = await setup(); await assert.rejects(f.writer.authorizeExecution({ envelope: f.execution }), /replay|nonce|registered/);
  await append(f); await append(f, { idempotencyKey: 'read-b' });
  assert.equal((await f.writer.readHead()).entryCount, 2);
});

test('principal, raw payload and forged timestamp/digest fields fail before journal mutation', async () => {
  const f = await setup();
  for (const override of [{ principal: { ...executor, actorId: roles.readOnlyId } },
    { principal: { ...executor, roleId: 'rescue-role' } }, { trustedTime: '2026-10-09T05:00:01.000Z' },
    { seq: 1 }, { digest: hash('forged') }, { query: 'sensitive-query-marker' }]) {
    await assert.rejects(append(f, override), error => {
      assert.match(error.message, /authorized journal/); assert.equal(error.message.includes('sensitive-query-marker'), false); return true;
    });
  }
  assert.equal((await f.writer.readHead()).entryCount, 0);
});

test('stage-specific action policies prevent shadow or retention from authorizing serving mutations', async () => {
  for (const stage of ['T16', 'R18']) {
    const f = await setup(stage);
    for (const action of ['publish-pointer', 'activate', 'increase-traffic', 'inject-fault', 'rollback-to-predecessor'])
      await assert.rejects(append(f, { action }), /action/);
    await append(f); assert.equal((await f.writer.readHead()).entryCount, 1);
  }
  const canary = await setup(); await assert.rejects(append(canary, { action: 'ask-shadow' }), /action/);
});

test('expiry and both authorization/signer revocation block new writes and exact acknowledgements', async () => {
  for (const stop of [f => f.writer.referenceAdvanceTime('2026-10-09T05:01:00.000Z'),
    f => f.writer.referenceRevokeAuthorization(f.executionRef.sha256),
    f => f.writer.referenceRevokeSigner('execution-key', 'v1')]) {
    const f = await setup(); const prior = await f.writer.readHead(); const req = request(prior, f.executionRef);
    await f.writer.append(req); stop(f);
    await assert.rejects(f.writer.append(req), /expired|revoked|validity/);
    await assert.rejects(append(f, { idempotencyKey: 'new-after-stop' }), /expired|revoked|validity/);
    assert.equal((await f.writer.readHead()).entryCount, 1);
  }
});

test('exact retries retain the original entry time, changed requests do not rebase idempotency', async () => {
  const f = await setup(); const req = request(await f.writer.readHead(), f.executionRef); const first = await f.writer.append(req);
  f.writer.referenceAdvanceTime('2026-10-09T05:00:20.000Z'); const retry = await f.writer.append(req);
  assert.equal(retry.status, 'already-applied'); assert.equal(retry.entry.digest, first.entry.digest);
  await assert.rejects(f.writer.append({ ...req, parametersDigest: hash('changed') }), /idempotency/);
  assert.equal((await f.writer.readHead()).entryCount, 1);
});

test('competing requests keep exact CAS semantics and never silently retry a newer head', async () => {
  const f = await setup(); const head = await f.writer.readHead();
  const values = await Promise.all([f.writer.append(request(head, f.executionRef)),
    f.writer.append(request(head, f.executionRef, { idempotencyKey: 'read-b' }))]);
  assert.deepEqual(values.map(value => value.status).sort(), ['appended', 'conflict']);
  assert.equal((await f.writer.readHead()).entryCount, 1);
});

test('a new generation fences original execution even when its signed window is still valid', async () => {
  const f = await setup(); const old = request(await f.writer.readHead(), f.executionRef);
  await f.writer.append(old); await f.writer.referenceAdvanceFence(8);
  await assert.rejects(f.writer.append(old), /fenc|generation/);
  await assert.rejects(append(f, { idempotencyKey: 'new-generation' }), /fenc|generation/);
  assert.equal((await f.writer.readHead()).entryCount, 1);
});

test('signed recovery after original expiry binds frozen policy, actual new fence and rescue actor', async () => {
  const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z');
  await f.writer.referenceAdvanceFence(8); const grant = recovery(f); await f.writer.authorizeRecovery(grant);
  const req = request(await f.writer.readHead(), grant.authorizationRef, { principal: rescuer, action: 'withdraw-traffic' });
  const value = await f.writer.append(req); assert.equal(value.status, 'appended');
  assert.equal(value.entry.actorId, rescuer.actorId); assert.equal(value.entry.fencingGeneration, 8);
  assert.equal(value.entry.authorizationDigest, grant.authorizationRef.sha256);
  await assert.rejects(f.writer.authorizeRecovery(grant), /registered|replay|nonce/);
});

test('recovery rejects re-signed cross-scope/run/policy/lineage/original/ref/fence/role/TTL claims', async () => {
  for (const override of [{ scope: { ...scope, corpusId: 'other' } }, { runNonce: '4'.repeat(32) },
    { frozenPolicyHash: hash('other-policy') }, { originalExecutionAuthorizationRef: ref('other-execution') },
    { originalFencingGeneration: 6 }, { fencingGeneration: 9 }, { roleId: 'other-role' },
    { lineage: { predecessorRef: ref('foreign-predecessor'), targetRef: ref('target'), expectedPointerRevision: 3 } },
    { rollbackExpectedPointerRevision: 5 }, { approvedMaxTtlMs: 60000 }, { allowedActions: ['activate'] }]) {
    const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
    await assert.rejects(f.writer.authorizeRecovery(recovery(f, override)), /authorized journal/);
    assert.equal((await f.writer.readHead()).entryCount, 0);
  }
});

test('recovery only permits signed risk-reducing intents and exact principal/credential context', async () => {
  const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  const grant = recovery(f, { allowedActions: ['withdraw-traffic'] }); await f.writer.authorizeRecovery(grant);
  for (const action of ['activate', 'increase-traffic', 'inject-fault', 'publish-pointer', 'rollback-to-predecessor', 'set-off'])
    await assert.rejects(f.writer.append(request(await f.writer.readHead(), grant.authorizationRef, { principal: rescuer, action })), /action/);
  for (const principal of [{ ...rescuer, actorId: 'unknown' }, { ...rescuer, roleId: 'unknown' },
    { ...rescuer, credentialRef: ref('unknown') }, executor])
    await assert.rejects(f.writer.append(request(await f.writer.readHead(), grant.authorizationRef, { principal })), /principal/);
  assert.equal((await f.writer.readHead()).entryCount, 0);
});

test('a rescue may record an aborted old activation intent, but cannot claim it completed', async () => {
  const f = await setup(); const intent = await append(f, { action: 'activate' });
  f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  const grant = recovery(f); await f.writer.authorizeRecovery(grant);
  const body = { principal: rescuer, kind: 'result', action: 'activate', intentDigest: intent.entry.digest,
    afterDigest: hash('off-readback'), outcome: 'completed' };
  await assert.rejects(f.writer.append(request(await f.writer.readHead(), grant.authorizationRef, body)), /action/);
  const aborted = await f.writer.append(request(await f.writer.readHead(), grant.authorizationRef, { ...body, outcome: 'aborted' }));
  assert.equal(aborted.status, 'appended'); assert.equal(aborted.entry.outcome, 'aborted');
  assert.equal(journal.validateJournalChain(await f.writer.readEntries(), aborted.head.binding, aborted.head).entryCount, 2);
});

test('result/terminal writes require unresolved exact intents and cannot seal pending operations', async () => {
  const f = await setup(); const intent = await append(f);
  await assert.rejects(append(f, { kind: 'terminal', idempotencyKey: 'terminal-a', action: 'seal-run',
    beforeDigest: intent.head.rootDigest, afterDigest: hash('final'), outcome: 'passed' }), /chain|journal/);
  const result = await append(f, { kind: 'result', intentDigest: intent.entry.digest, afterDigest: hash('after'), outcome: 'completed' });
  const terminal = await append(f, { kind: 'terminal', idempotencyKey: 'terminal-a', action: 'seal-run',
    beforeDigest: result.head.rootDigest, afterDigest: hash('final'), outcome: 'passed' });
  assert.equal(terminal.head.terminal, true); assert.equal(terminal.head.entryCount, 3);
  await assert.rejects(f.writer.referenceAdvanceFence(8), /terminal|fenc/);
});

test('revocation or expiry while a write awaits readback cannot slip past the commit check', async () => {
  for (const stop of [f => f.writer.referenceAdvanceTime('2026-10-09T05:01:00.000Z'),
    f => f.writer.referenceRevokeAuthorization(f.executionRef.sha256)]) {
    const f = await setup(); const req = request(await f.writer.readHead(), f.executionRef);
    const pending = f.writer.append(req); stop(f); await assert.rejects(pending, /expired|revoked|validity/);
    assert.equal((await f.writer.readHead()).entryCount, 0);
  }
});

test('configuration and request data are detached, getter/Proxy free and cannot expose secrets', async () => {
  const f = fixture(); const writer = api.createReferenceAuthorizedJournal(f.options); f.options.expectedExecutionPayload.scope.corpusId = 'other';
  await writer.authorizeExecution({ envelope: f.execution }); let calls = 0;
  const trap = () => { calls += 1; throw new Error('sensitive-object-marker'); };
  for (const input of [new Proxy({}, { ownKeys: trap }), Object.defineProperty({}, 'expectedHead', { enumerable: true, get: trap })])
    await assert.rejects(writer.append(input), error => !error.message.includes('sensitive-object-marker'));
  assert.throws(() => api.createReferenceAuthorizedJournal(new Proxy({}, { ownKeys: trap })));
  assert.equal(calls, 0); assert.equal((await writer.readHead()).entryCount, 0);
});

test('reference-only factory and monotonic authority seams cannot masquerade as enterprise or reset revocation', async () => {
  const f = fixture(); assert.throws(() => api.createReferenceAuthorizedJournal({ ...f.options, executionProfile: 'enterprise' }), /reference|profile/);
  const prepared = await setup();
  assert.throws(() => prepared.writer.referenceAdvanceTime('2026-10-09T05:00:09.000Z'), /time|clock/);
  await assert.rejects(prepared.writer.referenceAdvanceFence(7), /generation|fenc/);
  assert.throws(() => prepared.writer.referenceRevokeSigner('unknown-key', 'v1'), /signer|key/);
  assert.equal(Object.isFrozen(await prepared.writer.readHead()), true);
  assert.equal(Object.isFrozen(await prepared.writer.readEntries()), true);
});

test('matching rehashed envelope refs still require real Ed25519 signer/role/key/validity verification', async () => {
  for (const alter of [f => { f.execution.signature.value = Buffer.alloc(64).toString('base64url'); },
    f => { f.execution.signature.keyId = 'recovery-key'; },
    f => { f.options.approvalOptions.keys[0].revoked = true; },
    f => { f.options.approvalOptions.keys[0].validUntil = '2026-10-09T05:00:30.000Z'; }]) {
    const f = fixture(); alter(f);
    f.options.executionAuthorizationRef.sha256 = hash(f.execution);
    const writer = api.createReferenceAuthorizedJournal(f.options);
    await assert.rejects(writer.authorizeExecution({ envelope: f.execution }), /authorization.signature/);
    assert.equal((await writer.readHead()).entryCount, 0);
  }
});

test('recovery expiry, signer revocation and later generations fence even exact rescue retries', async () => {
  for (const stop of [f => f.writer.referenceAdvanceTime('2026-10-09T05:02:30.000Z'),
    f => f.writer.referenceRevokeSigner('recovery-key', 'v1'),
    f => f.writer.referenceAdvanceFence(9)]) {
    const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
    const grant = recovery(f); await f.writer.authorizeRecovery(grant);
    const req = request(await f.writer.readHead(), grant.authorizationRef, { principal: rescuer, action: 'set-off' });
    await f.writer.append(req); await stop(f);
    await assert.rejects(f.writer.append(req), /expired|revoked|fenc|generation/);
    assert.equal((await f.writer.readHead()).entryCount, 1);
  }
});

test('authorized execution/rescue journal composes into a full terminal forensic receipt, not acceptance', async () => {
  const f = await setup(); const intent = await append(f, { action: 'activate' });
  f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  const grant = recovery(f); await f.writer.authorizeRecovery(grant);
  await f.writer.append(request(await f.writer.readHead(), grant.authorizationRef, { principal: rescuer,
    kind: 'result', action: 'activate', intentDigest: intent.entry.digest, afterDigest: hash('off'), outcome: 'aborted' }));
  f.writer.referenceAdvanceTime('2026-10-09T05:02:01.000Z');
  const prior = await f.writer.readHead(); const finalStateHash = hash('final-off-state');
  const terminal = await f.writer.append(request(prior, grant.authorizationRef, { principal: rescuer,
    kind: 'terminal', action: 'seal-run', idempotencyKey: 'seal-a', beforeDigest: prior.rootDigest,
    afterDigest: finalStateHash, outcome: 'aborted' }));
  const core = { schemaVersion: 'kg-t17-canary-receipt-core/v1', classification: 'confidential', stage: 'T17',
    scope, runNonce: f.options.expectedExecutionPayload.runNonce, manifestHash: f.options.expectedExecutionPayload.manifestHash,
    executionAuthorizationRef: f.executionRef, recoveryAuthorizationRefs: [grant.authorizationRef], predecessorAcceptanceRef: ref('prior-bundle'),
    identities: { datasetHash: hash('dataset'), rosterHash: hash('roster'), sharedConfigHash: hash('shared'), artifactsHash: hash('artifacts'),
      indexIdentityRef: ref('index-identity'), registryRef: ref('registry'), providersHash: hash('providers'), thresholdsHash: hash('thresholds'),
      armConfigHashes: { off: hash('off-config'), active: hash('active-config') } },
    reportRef: ref('report'), artifactIndexRef: ref('artifact-index'), providerReadbackRefs: [ref('provider-readback')],
    journal: { headRef: ref('head-object', hash(terminal.head)), rootDigest: terminal.head.rootDigest,
      entryCount: 3, fencingGeneration: 8, terminal: true },
    stageEvidence: { preTrafficGateReportRef: ref('gate'), rampReportRef: ref('ramp'), faultReportRef: ref('fault'),
      recoveryReportRef: ref('recovery-report'), finalReadbackRef: ref('final-readback'), finalPublicationIdentityRef: ref('final-publication'),
      terminalMode: 'off', terminalTrafficWeightBps: 0 },
    executionIdentityId: roles.executorId, terminalActorId: rescuer.actorId,
    terminalAuthorizationDigest: grant.authorizationRef.sha256, machineVerdict: 'aborted', finalStateHash,
    startedAt: f.options.initialTime, completedAt: terminal.entry.trustedTime, sealedAt: '2026-10-09T05:02:02.000Z' };
  const view = receipts.createReceiptCore(core, { head: terminal.head, entries: await f.writer.readEntries() });
  assert.equal(view.core.journal.entryCount, 3); assert.equal(view.core.terminalActorId, rescuer.actorId);
  assert.equal(view.productionAccepted, false); assert.equal(view.core.machineVerdict, 'aborted');
});

test('recovery registration pending across await can be revoked before it becomes a cached grant', async () => {
  const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  const grant = recovery(f); const pending = f.writer.authorizeRecovery(grant);
  assert.doesNotThrow(() => f.writer.referenceRevokeAuthorization(grant.authorizationRef.sha256));
  await assert.rejects(pending, /revoked/);
  await assert.rejects(f.writer.append(request(await f.writer.readHead(), grant.authorizationRef, { principal: rescuer, action: 'set-off' })), /authorization/);
  assert.equal((await f.writer.readHead()).entryCount, 0);
});

test('frozen execution/registry/policy/lineage roles cannot share object-version identities', () => {
  for (const mutate of [f => { f.options.executionAuthorizationRef.objectId = f.options.expectedExecutionPayload.registryRef.objectId; },
    f => { f.options.recoveryPolicy.credentialPolicyRef = clone(f.options.recoveryPolicy.lineage.predecessorRef); }]) {
    const f = fixture(); mutate(f);
    if (f.options.recoveryPolicy) f.options.recoveryPolicy.policyHash = hash(Object.fromEntries(Object.entries(f.options.recoveryPolicy).filter(([field]) => field !== 'policyHash')));
    assert.throws(() => api.createReferenceAuthorizedJournal(f.options), /alias|role|object/);
  }
});

test('re-signed recovery refs and credentials cannot substitute lineage/registry/policy/envelope roles', async () => {
  for (const variant of ['predecessor-credential', 'credential-policy', 'envelope-credential', 'registry-envelope', 'target-envelope']) {
    const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
    const credential = variant === 'predecessor-credential' ? f.policy.lineage.predecessorRef
      : variant === 'credential-policy' ? f.policy.credentialPolicyRef
        : variant === 'envelope-credential' ? ref('recovery-a') : rescuer.credentialRef;
    const grant = recovery(f, { credentialRef: credential });
    if (variant === 'registry-envelope') grant.authorizationRef.objectId = 'registry';
    if (variant === 'target-envelope') grant.authorizationRef.objectId = 'target';
    await assert.rejects(f.writer.authorizeRecovery(grant), /alias|role|object/);
    assert.equal((await f.writer.readHead()).entryCount, 0);
  }
});

test('exact same-role credential reuse is permitted but a same-version digest replacement is not', async () => {
  const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  await f.writer.authorizeRecovery(recovery(f));
  const second = recovery(f, { authorizationId: 'recovery-b', nonce: '4'.repeat(32) }); second.authorizationRef.objectId = 'recovery-b';
  assert.equal((await f.writer.authorizeRecovery(second)).signatureVerified, true);
  const third = recovery(f, { authorizationId: 'recovery-c', nonce: '5'.repeat(32), credentialRef: { ...rescuer.credentialRef, sha256: hash('changed') } });
  third.authorizationRef.objectId = 'recovery-c';
  await assert.rejects(f.writer.authorizeRecovery(third), /digest|alias|role|object/);
});

test('recovery cannot bootstrap without successful verification of the original execution approval', async () => {
  for (const corrupt of [false, true]) {
    const f = fixture();
    if (corrupt) {
      f.execution.signature.value = Buffer.alloc(64).toString('base64url');
      f.options.executionAuthorizationRef.sha256 = hash(f.execution);
    }
    const writer = api.createReferenceAuthorizedJournal(f.options);
    if (corrupt) await assert.rejects(writer.authorizeExecution({ envelope: f.execution }), /signature/);
    writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await writer.referenceAdvanceFence(8);
    await assert.rejects(writer.authorizeRecovery(recovery(f)), /original.*execution|execution.*verified/);
    assert.equal((await writer.readHead()).entryCount, 0);
  }
});

test('a canary preflight reserves at least one safe new fencing generation for recovery', () => {
  const f = fixture(); f.options.originalFencingGeneration = Number.MAX_SAFE_INTEGER;
  assert.throws(() => api.createReferenceAuthorizedJournal(f.options), /fenc|generation|budget/);
});

test('failed pending registration is removed, unknown revokes stay closed, and a valid retry can register', async () => {
  const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  const wrong = recovery(f, { fencingGeneration: 9 }); await assert.rejects(f.writer.authorizeRecovery(wrong), /fence|recovery/);
  assert.throws(() => f.writer.referenceRevokeAuthorization(wrong.authorizationRef.sha256), /unknown/);
  assert.equal((await f.writer.authorizeRecovery(recovery(f))).signatureVerified, true);
});

test('registered plus pending grants share the bounded capacity without losing exact revocation recognition', async () => {
  const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  const pending = [];
  for (let index = 0; index < 16; index += 1) {
    const grant = recovery(f, { authorizationId: `recovery-${index}`, nonce: (index + 10).toString(16).padStart(32, '0') });
    grant.authorizationRef.objectId = `recovery-${index}`; pending.push(f.writer.authorizeRecovery(grant));
  }
  const excess = recovery(f, { authorizationId: 'excess', nonce: 'f'.repeat(32) }); excess.authorizationRef.objectId = 'excess';
  await assert.rejects(f.writer.authorizeRecovery(excess), /capacity/);
  assert.equal((await Promise.all(pending)).every(value => value.signatureVerified), true);
  assert.equal((await f.writer.readHead()).entryCount, 0);
});

test('revocation tombstones never evict and capacity exhaustion freezes existing grants too', async () => {
  const f = await setup(); f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  const active = recovery(f); await f.writer.authorizeRecovery(active);
  for (let index = 0; index <= 64; index += 1) {
    const grant = recovery(f, { authorizationId: `pending-${index}`, nonce: (index + 100).toString(16).padStart(32, '0') });
    grant.authorizationRef.objectId = `pending-${index}`;
    const pending = f.writer.authorizeRecovery(grant);
    if (index < 64) f.writer.referenceRevokeAuthorization(grant.authorizationRef.sha256);
    else assert.throws(() => f.writer.referenceRevokeAuthorization(grant.authorizationRef.sha256), /capacity/);
    await assert.rejects(pending, /revoked|capacity/);
  }
  await assert.rejects(f.writer.append(request(await f.writer.readHead(), active.authorizationRef, { principal: rescuer, action: 'set-off' })), /capacity/);
  assert.equal((await f.writer.readHead()).entryCount, 0);
});

test('verified but revoked original execution still supplies provenance for independent recovery', async () => {
  const f = await setup(); f.writer.referenceRevokeAuthorization(f.executionRef.sha256);
  f.writer.referenceAdvanceTime('2026-10-09T05:02:00.000Z'); await f.writer.referenceAdvanceFence(8);
  const grant = recovery(f); await f.writer.authorizeRecovery(grant);
  const value = await f.writer.append(request(await f.writer.readHead(), grant.authorizationRef, { principal: rescuer, action: 'set-off' }));
  assert.equal(value.status, 'appended'); assert.equal(value.entry.authorizationDigest, grant.authorizationRef.sha256);
});
