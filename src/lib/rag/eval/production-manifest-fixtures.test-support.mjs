import { canonicalJsonSha256 } from './canonical-json.ts';

// These synthetic manifests exercise structure only. They deliberately contain
// no signatures, credentials, real providers or production acceptance evidence.
const hash = value => canonicalJsonSha256(value);
const ref = name => ({ objectId: name, objectVersion: 'v1', sha256: hash(name) });
const clone = value => structuredClone(value);
const scope = { environment: 'production-a', tenantId: 'tenant-a', corpusId: 'corpus-a',
  allowedTrustLevels: ['trusted', 'reviewed'] };
const scopeIdentity = { environment: scope.environment, tenantId: scope.tenantId, corpusId: scope.corpusId };
const purposes = ['secret', 'kms', 'approval', 'tamper-store', 'clock', 'ask',
  'publication-readback', 'run-journal', 'lease', 'fencing', 'deployment', 'traffic', 'fault'];
const hardGates = {
  crossTenantHits: 0, crossCorpusHits: 0, disallowedTrustHits: 0, forbiddenEvidenceHits: 0,
  forbiddenAnswerPatternHits: 0, disallowedPolicyHits: 0, disallowedLaneHits: 0,
  authenticationBypasses: 0, unredactedSecretWrites: 0, unredactedPiiWrites: 0,
  invalidAuthorizations: 0,
};
const aadFields = ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash',
  'artifactType', 'artifactId', 'caseId', 'ordinal', 'schemaVersion'];

function base() {
  const value = {
    runNonce: '0123456789abcdef0123456789abcdef', scope: clone(scope),
    dataset: { id: 'roster-a', version: 'v1', schemaVersion: 'rag-eval-dataset/v2',
      normalizedSha256: hash('normalized-dataset'),
      roster: ['11111111111111111111111111111111', '22222222222222222222222222222222'],
      rosterSha256: '' },
    artifacts: { commit: 'a'.repeat(40), releaseId: 'release-a', buildHash: hash('build'),
      imageDigest: `sha256:${hash('image')}` },
    models: Object.fromEntries(['llm', 'embedding', 'reranker'].map(name => [name, {
      id: name, version: 'v1', artifactHash: hash(name), configHash: hash(`${name}-config`),
    }])),
    indexIdentity: { publicationIdentityRef: ref('publication-target'),
      schemaManifestHash: hash('schema'), indexManifestHash: hash('index') },
    parameters: { topK: 8, graphMaxCandidates: 20, graphTimeoutMs: 500, seed: null },
    sharedConfigHash: '', hardGates: clone(hardGates),
    providers: { registryRef: ref('registry'), bindings: purposes.map(purpose => ({
      purpose, providerId: `${purpose}-provider`, adapterDigest: hash(`${purpose}-adapter`),
      version: 'v1', configHash: hash(`${purpose}-config`), conformanceRef: ref(`${purpose}-conformance`),
    })) },
    artifactPolicy: { classification: 'confidential', encryption: 'aead-envelope-per-run',
      noncePolicy: 'unique-per-object', aadFields, responseHeaders: [], redaction: 'fail-closed',
      keyPolicyRef: ref('key-policy'), accessPolicyRef: ref('access-policy'),
      lifecyclePolicyRef: ref('artifact-lifecycle') },
  };
  value.dataset.rosterSha256 = hash(value.dataset.roster);
  value.sharedConfigHash = hash(commonConfig(value));
  return value;
}

function commonConfig(value) {
  return { artifacts: value.artifacts, models: value.models, indexIdentity: value.indexIdentity,
    parameters: value.parameters };
}

function arm(value, rolloutMode) {
  const config = { ...clone(commonConfig(value)), rolloutMode };
  return { rolloutMode, config, sharedConfigHash: value.sharedConfigHash,
    armConfigHash: hash(config) };
}

function quality(stage) {
  return {
    meanRecallAtK: { min: 0.7 }, meanNdcgAtK: { min: 0.7 },
    meanRequiredFactCoverage: { min: 0.8 }, abstainAccuracy: { min: 0.9 },
    'citation.meanValidity': { min: 0.95 }, 'citation.meanCoverage': { min: 0.7 },
    'citation.metricCoverageRatio': { min: 0.8 }, retrievalMetricCoverageRatio: { min: 0.8 },
    answerMetricCoverageRatio: { min: 0.8 }, errorRate: { max: 0.01 }, timeoutRate: { max: 0.01 },
    'latencyMs.p95': { max: 5000 },
    ...(stage === 'T16' ? { semanticDegradation: { max: 0.05 } }
      : { 'multiHop.meanRequiredFactCoverage': { min: 0.8 } }),
  };
}

function frozenRetention() {
  const policy = { schemaVersion: 'kg-retention-policy/v1', oldStoreId: 'old-store',
    startEvent: 't17-stable-final-state', minimumElapsedMs: 604800000,
    minimumSuccessorReleases: 1, resetOnRollback: true, clockProviderId: 'clock-provider',
    legalHold: 'must-be-cleared', coverage: ['objects', 'versions', 'caches', 'derived', 'replicas', 'backups'] };
  const oldStoreManifest = { storeId: 'old-store', version: 'v1', contentHash: hash('old-store-content') };
  return { policy, policyHash: hash(policy), oldStoreManifest,
    oldStoreManifestHash: hash(oldStoreManifest) };
}

function manifest(stage) {
  const value = { schemaVersion: 'kg-production-gate-manifest/v1', base: base() };
  if (stage === 'T16') {
    value.t16 = {
      arms: { off: arm(value.base, 'off'), shadow: arm(value.base, 'shadow') },
      sampling: { trialCount: 2, warmupCount: 1 }, quality: quality('T16'),
      sideEffectPolicy: { schemaVersion: 'kg-shadow-side-effect-policy/v1',
        exactMatch: ['servedEvidence', 'context', 'prompt', 'cacheIdentity'],
        zeroMutation: ['graphCache', 'pointer', 'outbox', 'buildJob', 'neo4j', 'milvus', 'index', 'mode', 'traffic'],
        allowedEffects: ['encryptedAudit', 'controlledTelemetry', 'modelBilling', 'equivalentOrdinaryCache'],
        readbackProviderId: 'publication-readback-provider' },
      executionAuthorizationRef: ref('execution-t16'),
    };
  } else if (stage === 'T17') {
    const lineage = { predecessorRef: ref('publication-predecessor'),
      targetRef: ref('publication-target'), expectedPointerRevision: 3 };
    const fault = { schemaVersion: 'kg-canary-fault-plan/v1', action: 'isolate-canary-neo4j',
      resourceId: 'canary-neo4j-resource', parameters: { dependency: 'neo4j', isolation: 'canary-egress-only' },
      maxTtlMs: 10000, expectedImpact: 'graph-unavailable-dense-serving-preserved',
      revokeAction: 'restore-canary-neo4j-connectivity',
      stopConditions: ['non-canary-impact', 'hard-gate', 'lease-loss', 'slo-breach', 'window-closed'],
      killSwitchId: 'fault-kill-switch' };
    const recovery = { schemaVersion: 'kg-safety-recovery-policy/v1',
      authorityId: 'independent-recovery-authority', roleId: 'rescue-operator', scopeHash: hash(scopeIdentity),
      allowedActions: ['withdraw-traffic', 'revoke-existing-fault', 'set-off', 'rollback-to-predecessor'],
      lineage: clone(lineage), maxAuthorizationTtlMs: 10000, credentialPolicyRef: ref('rescue-credentials') };
    value.t17 = {
      predecessor: { stage: 'T16', acceptanceBundleRef: ref('t16-bundle'), manifestHash: hash('t16-manifest') },
      arms: { off: arm(value.base, 'off'), active: arm(value.base, 'active') },
      sampling: { trialCount: 3, warmupCount: 1 }, quality: quality('T17'),
      canary: { instanceId: 'canary-instance', hostId: 'canary-host', trafficSelectorId: 'canary-selector',
        faultTargetResourceId: 'canary-neo4j-resource' }, lineage,
      lease: { providerId: 'lease-provider', authorityId: 'fencing-provider', scopeHash: hash(scopeIdentity),
        ttlMs: 30000, renewEveryMs: 5000, fencing: 'monotonic-generation-enforced',
        trafficDeadman: 'zero-on-expiry' },
      rampPlan: { maxWeightBps: 1000, maxRequests: 50, steps: [
        { weightBps: 100, requests: 10, dwellMs: 30000, ttlMs: 10000 },
        { weightBps: 1000, requests: 40, dwellMs: 60000, ttlMs: 10000 }],
      abort: { maxErrorRate: 0.01, maxTimeoutRate: 0.01, maxP95LatencyMs: 5000 } },
      faultPlan: { ...fault, planHash: hash(fault), approvalRef: ref('fault-approval') },
      recoveryPolicy: { ...recovery, policyHash: hash(recovery) },
      window: { changeId: 'change-a', startsAt: '2026-10-10T00:00:00.000Z',
        endsAt: '2026-10-10T02:00:00.000Z', clockProviderId: 'clock-provider',
        ownerId: 'owner', approverId: 'execution-approver', executorId: 'executor',
        readOnlyId: 'independent-reader', onCallId: 'on-call', rollbackOwnerId: 'rollback-owner',
        credentialPolicyRef: ref('jit-policy') },
      frozenRetention: frozenRetention(), executionAuthorizationRef: ref('execution-t17'),
    };
  } else {
    const frozen = frozenRetention();
    value.retention = {
      predecessor: { stage: 'T17', acceptanceBundleRef: ref('t17-bundle'), manifestHash: hash('t17-manifest'),
        retentionPolicyHash: frozen.policyHash, oldStoreManifestHash: frozen.oldStoreManifestHash },
      frozenRetention: frozen, elapsedEvidenceRef: ref('elapsed-evidence'),
      executionAuthorizationRef: ref('execution-retention'),
    };
  }
  return value;
}

export { hash, ref, clone, scopeIdentity, arm, manifest };
