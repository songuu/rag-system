import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND'
        && (specifier.startsWith('./') || specifier.startsWith('../'))
        && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const gate = await import('./production-gate-manifest.ts');

test('production manifests expose separate stage views and a versioned schema', () => {
  assert.equal(gate.PRODUCTION_GATE_MANIFEST_SCHEMA_VERSION, 'kg-production-gate-manifest/v1');
  for (const name of ['validateForT16', 'validateForT17', 'validateForRetention']) {
    assert.equal(typeof gate[name], 'function', name);
  }
});

test('safety limits are a frozen zero-tolerance contract, not configurable quality thresholds', () => {
  assert.deepEqual(gate.HARD_GATE_LIMITS, {
    crossTenantHits: 0,
    crossCorpusHits: 0,
    disallowedTrustHits: 0,
    forbiddenEvidenceHits: 0,
    forbiddenAnswerPatternHits: 0,
    disallowedPolicyHits: 0,
    disallowedLaneHits: 0,
    authenticationBypasses: 0,
    unredactedSecretWrites: 0,
    unredactedPiiWrites: 0,
    invalidAuthorizations: 0,
  });
  assert.equal(Object.isFrozen(gate.HARD_GATE_LIMITS), true);
  assert.throws(() => { gate.HARD_GATE_LIMITS.crossTenantHits = 1; }, TypeError);
});

test('all stage entry points reject absent, legacy and incomplete manifests', () => {
  for (const validate of [gate.validateForT16, gate.validateForT17, gate.validateForRetention]) {
    for (const input of [null, [], {}, { schemaVersion: 'kg-production-gate-manifest/v0' },
      { schemaVersion: 'kg-production-gate-manifest/v1' }]) {
      assert.throws(() => validate(input), /manifest|schema|required|scope|object/i);
    }
  }
});

import { hash, ref, clone, scopeIdentity, manifest } from './production-manifest-fixtures.test-support.mjs';

test('each complete stage projects a frozen structural view, never an authorization', () => {
  for (const [stage, validate] of [['T16', gate.validateForT16], ['T17', gate.validateForT17],
    ['R18', gate.validateForRetention]]) {
    const input = manifest(stage);
    const result = validate(input);
    assert.equal(result.stage, stage);
    assert.equal(result.validationLevel, 'structural-only');
    assert.equal(result.productionAuthorized, false);
    assert.equal(result.manifestHash, hash(result.manifest));
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.manifest.base.scope.allowedTrustLevels), true);
    input.base.scope.corpusId = 'changed-after-validation';
    assert.equal(result.manifest.base.scope.corpusId, 'corpus-a');
  }
});

test('T17 preflight reserves safe Pointer revisions for publication and rollback before any mutation', () => {
  const withRevision = revision => {
    const input = manifest('T17'); input.t17.lineage.expectedPointerRevision = revision;
    input.t17.recoveryPolicy.lineage.expectedPointerRevision = revision;
    input.t17.recoveryPolicy.policyHash = hash(Object.fromEntries(
      Object.entries(input.t17.recoveryPolicy).filter(([key]) => key !== 'policyHash')));
    return input;
  };
  for (const revision of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => gate.validateForT17(withRevision(revision)), /manifest.*expectedPointerRevision/);
  }
  for (const revision of [0, Number.MAX_SAFE_INTEGER - 2]) {
    assert.equal(gate.validateForT17(withRevision(revision)).manifest.policy.lineage.expectedPointerRevision, revision);
  }
});

test('deferred stage fields do not block T16 or enter its authorization digest', () => {
  const input = manifest('T16');
  input.base.providers.bindings = input.base.providers.bindings.filter(binding =>
    !['lease', 'fencing', 'deployment', 'traffic', 'fault'].includes(binding.purpose));
  const first = gate.validateForT16(input);
  input.t17 = { window: null };
  input.retention = { notScheduled: true };
  assert.equal(gate.validateForT16(input).manifestHash, first.manifestHash);
  assert.throws(() => gate.validateForT17(input), /manifest/);
});

test('execution authorization references stay outside the manifest digest to avoid a hash cycle', () => {
  for (const [stage, field, validate] of [['T16', 't16', gate.validateForT16],
    ['T17', 't17', gate.validateForT17], ['R18', 'retention', gate.validateForRetention]]) {
    const input = manifest(stage);
    const first = validate(input);
    assert.deepEqual(first.executionAuthorizationRef, input[field].executionAuthorizationRef);
    assert.equal(Object.hasOwn(first.manifest.policy, 'executionAuthorizationRef'), false);
    input[field].executionAuthorizationRef = ref('different-execution-envelope');
    const second = validate(input);
    assert.equal(second.manifestHash, first.manifestHash);
    assert.notDeepEqual(second.executionAuthorizationRef, first.executionAuthorizationRef);
    assert.equal(Object.isFrozen(second.executionAuthorizationRef), true);
  }
});

test('base identities, references, roster and security invariants fail closed', () => {
  const mutations = [
    input => { input.base.scope.allowedTrustLevels.push('quarantined'); },
    input => { input.base.scope.allowedTrustLevels = []; },
    input => { input.base.scope.tenantId = '../tenant'; },
    input => { input.base.dataset.roster.push(input.base.dataset.roster[0]); },
    input => { input.base.dataset.rosterSha256 = hash('different'); },
    input => { input.base.runNonce = 'short'; },
    input => { input.base.artifacts.imageDigest = 'latest'; },
    input => { input.base.indexIdentity.publicationIdentityRef.objectId = 'https://outside'; },
    input => { input.base.sharedConfigHash = hash('different'); },
    input => { input.base.hardGates.crossTenantHits = 1; },
    input => { delete input.base.hardGates.invalidAuthorizations; },
    input => { input.base.providers.bindings.pop(); input.base.providers.bindings[0].purpose = 'unknown'; },
    input => { input.base.providers.bindings[0].endpoint = 'https://unregistered'; },
    input => { input.base.providers.bindings[0].conformanceRef.sha256 = 'invalid'; },
  ];
  for (const mutate of mutations) {
    const input = manifest('T16'); mutate(input);
    assert.throws(() => gate.validateForT16(input), /manifest|canonical JSON/);
  }
});

test('arm changes are limited to rolloutMode even when supplied hashes are recomputed', () => {
  for (const [stage, name, validate] of [['T16', 'shadow', gate.validateForT16],
    ['T17', 'active', gate.validateForT17]]) {
    const field = stage.toLowerCase();
    for (const mutate of [
      arm => { arm.rolloutMode = 'off'; },
      arm => { arm.config.parameters.topK = 9; },
      arm => { arm.config.artifacts.buildHash = hash('new-build'); },
      arm => { arm.config.models.llm.version = 'v2'; },
      arm => { arm.config.indexIdentity.indexManifestHash = hash('new-index'); },
      arm => { arm.sharedConfigHash = hash('other-shared'); },
    ]) {
      const input = manifest(stage); const changed = input[field].arms[name];
      mutate(changed); changed.armConfigHash = hash(changed.config);
      assert.throws(() => validate(input), /manifest.*arm|manifest.*config/i);
    }
    const input = manifest(stage);
    input[field].arms.off.armConfigHash = hash('bad-full-arm');
    assert.throws(() => validate(input), /manifest.*arm/i);
  }
});

test('quality metrics are current, bounded and separate from immutable safety gates', () => {
  for (const mutate of [
    q => { q.customMetric = { min: 1 }; },
    q => { q.meanRecallAtK = { max: 0.8 }; },
    q => { q.meanRecallAtK.min = 1.1; },
    q => { q.retrievalMetricCoverageRatio.min = 0; },
    q => { q['latencyMs.p95'].max = 0; },
    q => { delete q['citation.meanCoverage']; },
    q => { q.crossTenantHits = { max: 10 }; },
  ]) {
    const input = manifest('T16'); mutate(input.t16.quality);
    assert.throws(() => gate.validateForT16(input), /manifest.*quality/);
  }
  const input = manifest('T17'); input.t17.sampling.trialCount = 1;
  assert.throws(() => gate.validateForT17(input), /manifest.*sampling/);
});

test('Shadow side effects and sensitive artifact policies cannot relax serving safety', () => {
  for (const mutate of [
    input => { input.t16.sideEffectPolicy.allowedEffects.push('pointer'); },
    input => { input.t16.sideEffectPolicy.zeroMutation.pop(); },
    input => { input.t16.sideEffectPolicy.exactMatch.pop(); },
    input => { input.base.artifactPolicy.responseHeaders = ['authorization']; },
    input => { input.base.artifactPolicy.responseHeaders = ['set-cookie']; },
    input => { input.base.artifactPolicy.aadFields = ['runNonce']; },
    input => { input.base.artifactPolicy.encryption = 'plaintext'; },
    input => { input.base.artifactPolicy.redaction = 'best-effort'; },
  ]) {
    const input = manifest('T16'); mutate(input);
    assert.throws(() => gate.validateForT16(input), /manifest/);
  }
});

test('T17 requires frozen predecessor, canary, lease, window and bounded ramp', () => {
  for (const mutate of [
    value => { value.predecessor.stage = 'T17'; },
    value => { delete value.frozenRetention; },
    value => { value.lineage.targetRef = clone(value.lineage.predecessorRef); },
    value => { value.lease.scopeHash = hash('other-scope'); },
    value => { value.lease.renewEveryMs = value.lease.ttlMs; },
    value => { value.lease.trafficDeadman = 'none'; },
    value => { value.rampPlan.steps[0].ttlMs = value.lease.ttlMs + 1; },
    value => { value.rampPlan.steps[1].weightBps = value.rampPlan.steps[0].weightBps; },
    value => { value.rampPlan.maxRequests = 49; },
    value => { value.rampPlan.steps[1].weightBps = 1001; },
    value => { value.window.endsAt = value.window.startsAt; },
    value => { value.window.readOnlyId = value.window.executorId; },
    value => { value.canary.instanceId = '*'; },
  ]) {
    const input = manifest('T17'); mutate(input.t17);
    assert.throws(() => gate.validateForT17(input), /manifest/);
  }
});

test('lease and recovery scope identity cannot split a corpus by trust order or policy', () => {
  const input = manifest('T17');
  const expectedScopeHash = hash(scopeIdentity);
  assert.equal(gate.productionScopeHash(input.base.scope), expectedScopeHash);
  const first = gate.validateForT17(input);
  input.base.scope.allowedTrustLevels.reverse();
  assert.equal(gate.productionScopeHash(input.base.scope), expectedScopeHash);
  assert.equal(gate.validateForT17(input).manifest.policy.lease.scopeHash,
    first.manifest.policy.lease.scopeHash);
  input.base.scope.allowedTrustLevels = ['trusted'];
  assert.equal(gate.validateForT17(input).manifest.policy.lease.scopeHash, expectedScopeHash);
  input.t17.lease.scopeHash = hash(input.base.scope);
  assert.throws(() => gate.validateForT17(input), /manifest.*lease.*scopeHash/);
});

test('FaultPlan stays a signed closed set with immutable target, TTL and revocation', () => {
  for (const mutate of [
    fault => { fault.action = 'run-shell'; },
    fault => { fault.resourceId = 'shared-neo4j-resource'; },
    fault => { fault.parameters.command = 'arbitrary command'; },
    fault => { fault.maxTtlMs = 30001; },
    fault => { fault.revokeAction = 'none'; },
    fault => { fault.stopConditions = []; },
    fault => { delete fault.killSwitchId; },
    fault => { delete fault.approvalRef; },
    fault => { fault.planHash = hash('different-plan'); },
  ]) {
    const input = manifest('T17'); mutate(input.t17.faultPlan);
    assert.throws(() => gate.validateForT17(input), /manifest.*fault/i);
  }
});

test('SafetyRecoveryPolicy is scope/lineage bound, independent and strictly risk reducing', () => {
  for (const mutate of [
    policy => { policy.authorityId = 'execution-approver'; },
    policy => { policy.allowedActions.push('activate'); },
    policy => { policy.allowedActions.push('increase-traffic'); },
    policy => { policy.allowedActions.push('new-fault'); },
    policy => { policy.scopeHash = hash('other-scope'); },
    policy => { policy.lineage.targetRef = ref('other-target'); },
    policy => { policy.maxAuthorizationTtlMs = 30001; },
    policy => { policy.policyHash = hash('different-policy'); },
  ]) {
    const input = manifest('T17'); mutate(input.t17.recoveryPolicy);
    assert.throws(() => gate.validateForT17(input), /manifest.*recovery/i);
  }
});

test('retention cannot replace the T17-frozen policy or old store, or authorize cleanup', () => {
  for (const mutate of [
    value => { value.predecessor.stage = 'T16'; },
    value => { value.frozenRetention.policy.minimumElapsedMs = 1;
      value.frozenRetention.policyHash = hash(value.frozenRetention.policy); },
    value => { value.frozenRetention.oldStoreManifest.version = 'v2';
      value.frozenRetention.oldStoreManifestHash = hash(value.frozenRetention.oldStoreManifest); },
    value => { value.frozenRetention.policy.resetOnRollback = false; },
    value => { value.frozenRetention.policy.coverage.pop(); },
    value => { value.cleanupAuthorizationRef = ref('cleanup'); },
  ]) {
    const input = manifest('R18'); mutate(input.retention);
    assert.throws(() => gate.validateForRetention(input), /manifest/);
  }
});

test('unsupported input and secrets in extra fields fail without exposing values or executing getters', () => {
  const input = manifest('T16');
  const secret = 'production-secret-label';
  input.base[secret] = 'production-secret-value';
  assert.throws(() => gate.validateForT16(input), error => {
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('production-secret-value'), false);
    return true;
  });
  let called = false;
  const hostile = Object.defineProperty({}, 'schemaVersion', { enumerable: true,
    get() { called = true; throw new Error(secret); } });
  assert.throws(() => gate.validateForT16(hostile), /canonical JSON|manifest/);
  assert.equal(called, false);
});
