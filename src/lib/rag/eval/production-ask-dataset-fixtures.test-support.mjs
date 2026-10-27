import { canonicalJsonSha256 as hash } from './canonical-json';
import { createRagEvalDatasetHash, parseRagEvalDataset } from './dataset';
import { manifest as manifestFixture, arm } from './production-manifest-fixtures.test-support.mjs';
import { fixture as providerFixture } from './production-provider-fixtures.test-support.mjs';
const clone = value => structuredClone(value);
const ref = (name, digest = hash(name)) => ({ objectId: name, objectVersion: 'v1', sha256: digest });
const policyName = stage => ({ T16: 't16', T17: 't17', R18: 'retention' })[stage];
const commonConfig = base => ({ artifacts: base.artifacts, models: base.models, indexIdentity: base.indexIdentity, parameters: base.parameters });
// Derive fixture correspondence from raw manifest and policy fields. These
// synthetic references prove shape only; they are not signatures or approval.
export function rebindExecution(f) {
  const options = f.options; const manifest = options.manifest; const base = manifest.base;
  const policy = manifest[policyName(f.stage)];
  options.policyRef = { ...options.policyRef, sha256: hash(options.deploymentPolicy) };
  base.providers.registryRef = clone(options.policyRef);
  base.sharedConfigHash = hash(commonConfig(base));
  if (policy.arms) policy.arms = Object.fromEntries(Object.keys(policy.arms).map(mode => [mode, arm(base, mode)]));
  const thresholds = { schemaVersion: 'kg-stage-thresholds/v1', stage: f.stage, hardGates: base.hardGates,
    quality: policy.quality ?? null, sampling: policy.sampling ?? null,
    sideEffectPolicy: policy.sideEffectPolicy ?? null, rampAbort: policy.rampPlan?.abort ?? null,
    retentionPolicy: f.stage === 'R18' ? policy.frozenRetention.policy : null };
  const unsignedPolicy = Object.fromEntries(Object.entries(policy)
    .filter(([name]) => name !== 'executionAuthorizationRef'));
  const manifestHash = hash({ schemaVersion: manifest.schemaVersion, stage: f.stage, base, policy: unsignedPolicy });
  const payload = options.expectedExecutionPayload;
  Object.assign(payload, { manifestHash, registryRef: clone(options.policyRef),
    providersHash: hash(base.providers), thresholdsHash: hash(thresholds) });
  const syntheticEnvelope = { schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution',
    payload: clone(payload), signature: { algorithm: 'Ed25519', keyId: 'synthetic-shape-only',
      keyVersion: 'v1', value: Buffer.alloc(64).toString('base64url') } };
  options.executionAuthorizationRef = ref(`execution-${f.stage.toLowerCase()}`, hash(syntheticEnvelope));
  policy.executionAuthorizationRef = clone(options.executionAuthorizationRef);
  const identities = { datasetHash: base.dataset.normalizedSha256,
    rosterHash: base.dataset.rosterSha256, sharedConfigHash: base.sharedConfigHash,
    artifactsHash: hash(base.artifacts), indexIdentityRef: clone(base.indexIdentity.publicationIdentityRef),
    registryRef: clone(options.policyRef), providersHash: hash(base.providers), thresholdsHash: hash(thresholds),
    armConfigHashes: policy.arms
      ? Object.fromEntries(Object.entries(policy.arms).map(([mode, value]) => [mode, value.armConfigHash]))
      : null };
  f.expectedBinding = { validationLevel: 'structural-only', productionAuthorized: false, stage: f.stage,
    scope: clone(payload.scope), runNonce: payload.runNonce, manifestHash,
    executionAuthorizationRef: clone(options.executionAuthorizationRef), providers: clone(base.providers),
    identities, thresholdsProfile: 'kg-stage-thresholds/v1', thresholds: clone(thresholds),
    predecessor: clone(policy.predecessor ?? null), frozenRetention: clone(policy.frozenRetention ?? null),
    elapsedEvidenceRef: clone(f.stage === 'R18' ? policy.elapsedEvidenceRef : null) };
}

export function rawDatasetFor(base) {
  const scope = base.scope;
  const corpus = [
    { evidenceId: 'evidence-in-scope-trusted', documentId: 'doc-a', documentVersion: 'v3',
      tenantId: scope.tenantId, corpusId: scope.corpusId, trustLevel: 'trusted', source: 'fixture://trusted',
      content: 'Trusted answer evidence for the synthetic canary.',
      metadata: { canary: { class: 'gold', ordinal: 0 }, ordered: ['first', 'second'], score: 1 } },
    { evidenceId: 'evidence-in-scope-reviewed', documentId: 'doc-b', documentVersion: 'v7',
      tenantId: scope.tenantId, corpusId: scope.corpusId, trustLevel: 'reviewed', source: 'fixture://reviewed',
      content: 'Reviewed supporting evidence.', metadata: { canary: { class: 'reviewed' } } },
    { evidenceId: 'evidence-foreign-tenant', documentId: 'doc-c', documentVersion: 'v1',
      tenantId: 'tenant-other', corpusId: scope.corpusId, trustLevel: 'trusted', source: 'fixture://foreign-tenant',
      content: 'FOREIGN_TENANT_SECURITY_CANARY', metadata: { canary: { class: 'cross-tenant' } } },
    { evidenceId: 'evidence-foreign-corpus', documentId: 'doc-d', documentVersion: 'v1',
      tenantId: scope.tenantId, corpusId: 'corpus-other', trustLevel: 'reviewed', source: 'fixture://foreign-corpus',
      content: 'FOREIGN_CORPUS_SECURITY_CANARY', metadata: { canary: { class: 'cross-corpus' } } },
    { evidenceId: 'evidence-quarantined', documentId: 'doc-e', documentVersion: 'v1',
      tenantId: scope.tenantId, corpusId: scope.corpusId, trustLevel: 'quarantined', source: 'fixture://quarantine',
      content: 'QUARANTINED_SECURITY_CANARY', metadata: { canary: { class: 'quarantined' } } },
  ];
  const cases = base.dataset.roster.map((id, index) => ({
    id, query: `RAW_QUERY_CANARY_${index}`, tags: ['synthetic', index === 0 ? 'answerable' : 'abstain'],
    goldEvidence: index === 0
      ? [{ evidenceId: corpus[0].evidenceId, relevance: 3,
        spans: [{ startOffset: 0, endOffset: 7 }] }]
      : [],
    ...(index === 0 ? { expectedAnswer: { requiredFacts: [['RAW_EXPECTED_FACT_CANARY']] } } : {}),
    expectedAbstain: index !== 0,
    scope: { tenantId: scope.tenantId, corpusId: scope.corpusId,
      allowedTrustLevels: [...scope.allowedTrustLevels] },
    allowedPolicies: ['strict-grounding'], allowedLanes: ['dense', 'graph'],
    securityExpectations: { forbiddenEvidenceIds: corpus.slice(2).map(value => value.evidenceId),
      forbiddenAnswerPatterns: ['RAW_SECURITY_PATTERN_CANARY'] },
    metadata: { canary: { caseOrdinal: index }, ordered: ['alpha', 'beta'] },
  }));
  return { schemaVersion: 'rag-eval-dataset/v2', datasetId: base.dataset.id,
    datasetVersion: base.dataset.version, corpus, cases };
}

export function bindDataset(f, dataset, { updateRoster = false } = {}) {
  const parsed = parseRagEvalDataset(dataset);
  const descriptor = f.options.manifest.base.dataset;
  Object.assign(descriptor, { id: parsed.datasetId, version: parsed.datasetVersion,
    schemaVersion: parsed.schemaVersion, normalizedSha256: createRagEvalDatasetHash(parsed) });
  if (updateRoster) descriptor.roster = parsed.cases.map(value => value.id);
  descriptor.rosterSha256 = hash(descriptor.roster);
  f.dataset = dataset;
  f.normalizedDataset = parsed;
  f.rawDatasetJson = JSON.stringify(dataset);
  rebindExecution(f);
  return f;
}

export function fixture(stage = 'T16') {
  const manifest = manifestFixture(stage);
  const providers = providerFixture(stage);
  manifest.base.providers = clone(providers.request.providers);
  const scope = Object.fromEntries(['environment', 'tenantId', 'corpusId']
    .map(name => [name, manifest.base.scope[name]]));
  const window = stage === 'T17'
    ? { startsAt: manifest.t17.window.startsAt, endsAt: manifest.t17.window.endsAt }
    : { startsAt: '2026-10-09T04:00:00.000Z', endsAt: '2026-10-09T05:00:00.000Z' };
  const participants = { executionApproverId: 'execution-approver', executorId: 'executor',
    readOnlyId: 'independent-reader', resultAuthorityId: 'synthetic-result-authority',
    recoveryAuthorityId: stage === 'T17' ? manifest.t17.recoveryPolicy.authorityId : null };
  const payload = { stage, scope, runNonce: manifest.base.runNonce, manifestHash: hash('draft'),
    authorizationId: `execution-${stage.toLowerCase()}`, nonce: '3'.repeat(32),
    issuerId: participants.executionApproverId, participants,
    issuedAt: new Date(Date.parse(window.startsAt) + 5000).toISOString(),
    notBefore: new Date(Date.parse(window.startsAt) + 10000).toISOString(),
    expiresAt: new Date(Date.parse(window.endsAt) - 10000).toISOString(),
    operation: stage === 'T16' ? 'execute-t16-shadow' : 'execute-t17-canary',
    registryRef: clone(providers.policyRef), providersHash: hash(manifest.base.providers),
    thresholdsHash: hash('draft-thresholds'), window };
  const options = { executionProfile: 'local-reference', manifest,
    expectedExecutionPayload: payload, executionAuthorizationRef: ref('draft-authorization'),
    deploymentPolicy: clone(providers.policy), policyRef: clone(providers.policyRef) };
  const f = { stage, options };
  return bindDataset(f, rawDatasetFor(manifest.base));
}
