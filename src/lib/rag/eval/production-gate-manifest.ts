import { CANONICAL_JSON_PROFILE, canonicalJson, canonicalJsonSha256 } from './canonical-json';
import { validateAuthorizationEnvelope } from './production-authorization';
import type { ExecutionAuthorizationPayload } from './production-authorization';
import type { ReceiptCore } from './production-receipts';

export const PRODUCTION_GATE_MANIFEST_SCHEMA_VERSION = 'kg-production-gate-manifest/v1' as const;
export const HARD_GATE_LIMITS = Object.freeze({
  crossTenantHits: 0, crossCorpusHits: 0, disallowedTrustHits: 0, forbiddenEvidenceHits: 0,
  forbiddenAnswerPatternHits: 0, disallowedPolicyHits: 0, disallowedLaneHits: 0,
  authenticationBypasses: 0, unredactedSecretWrites: 0, unredactedPiiWrites: 0,
  invalidAuthorizations: 0,
});

export type ProductionGateStage = 'T16' | 'T17' | 'R18';
export const STAGE_THRESHOLDS_PROFILE = 'kg-stage-thresholds/v1' as const;
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type Fields = Record<string, unknown>;
export interface ArtifactReference {
  readonly objectId: string;
  readonly objectVersion: string;
  readonly sha256: string;
}

export interface ProductionGateStageView<S extends ProductionGateStage> {
  readonly stage: S;
  readonly validationLevel: 'structural-only';
  readonly productionAuthorized: false;
  readonly canonicalProfile: typeof CANONICAL_JSON_PROFILE;
  readonly executionAuthorizationRef: ArtifactReference;
  readonly manifestHash: string;
  readonly manifest: {
    readonly schemaVersion: typeof PRODUCTION_GATE_MANIFEST_SCHEMA_VERSION;
    readonly stage: S;
    readonly base: JsonObject;
    readonly policy: JsonObject;
  };
}

export interface ManifestExecutionBinding {
  readonly validationLevel: 'structural-only';
  readonly productionAuthorized: false;
  readonly stage: ProductionGateStage;
  readonly scope: ExecutionAuthorizationPayload['scope'];
  readonly runNonce: string;
  readonly manifestHash: string;
  readonly executionAuthorizationRef: ArtifactReference;
  readonly providers: JsonObject;
  readonly identities: ReceiptCore['identities'];
  readonly thresholdsProfile: typeof STAGE_THRESHOLDS_PROFILE;
  readonly thresholds: Fields;
  readonly predecessor: JsonObject | null;
  readonly frozenRetention: JsonObject | null;
  readonly elapsedEvidenceRef: ArtifactReference | null;
}

/** Derive receipt expectations from a complete, independently supplied manifest.
 * This projection proves correspondence, not signatures, predecessor acceptance
 * or elapsed retention. Actual authority is checked by the consuming ports. */
export function validateManifestExecutionBinding(input: unknown): ManifestExecutionBinding {
  const request = record(JSON.parse(canonicalJson(input)), '$.binding');
  keys(request, ['manifest', 'expectedExecutionPayload', 'executionAuthorizationRef'], '$.binding');
  // Reuse the closed payload schema only; this dummy signature grants nothing.
  const expected = validateAuthorizationEnvelope({ schemaVersion: 'kg-execution-authorization-envelope/v1', kind: 'execution',
    payload: request.expectedExecutionPayload, signature: { algorithm: 'Ed25519', keyId: 'shape-only', keyVersion: 'v1',
      value: Buffer.alloc(64).toString('base64url') } }).envelope.payload as ExecutionAuthorizationPayload;
  const view = expected.stage === 'T16' ? validateForT16(request.manifest)
    : expected.stage === 'T17' ? validateForT17(request.manifest) : validateForRetention(request.manifest);
  const { base, policy } = view.manifest;
  const manifestScope = record(base.scope, '$.base.scope');
  const scope = { environment: manifestScope.environment, tenantId: manifestScope.tenantId, corpusId: manifestScope.corpusId };
  const providers = record(base.providers, '$.base.providers');
  const ramp = policy.rampPlan === undefined ? null : record(policy.rampPlan, '$.policy.rampPlan');
  const frozenRetention = policy.frozenRetention === undefined ? null : record(policy.frozenRetention, '$.policy.frozenRetention');
  const thresholds = { schemaVersion: STAGE_THRESHOLDS_PROFILE, stage: expected.stage,
    hardGates: base.hardGates, quality: policy.quality ?? null, sampling: policy.sampling ?? null,
    sideEffectPolicy: policy.sideEffectPolicy ?? null, rampAbort: ramp?.abort ?? null,
    retentionPolicy: expected.stage === 'R18' ? frozenRetention?.policy : null };
  const match = (actual: unknown, frozen: unknown, path: string): void => {
    if (canonicalJson(actual) !== canonicalJson(frozen)) fail(path, 'does not match the independently frozen manifest');
  };
  match(expected.scope, scope, '$.binding.scope');
  match(expected.runNonce, base.runNonce, '$.binding.runNonce');
  match(expected.manifestHash, view.manifestHash, '$.binding.manifestHash');
  match(expected.registryRef, providers.registryRef, '$.binding.registryRef');
  match(expected.providersHash, canonicalJsonSha256(providers), '$.binding.providersHash');
  match(expected.thresholdsHash, canonicalJsonSha256(thresholds), '$.binding.thresholdsHash');
  match(reference(request.executionAuthorizationRef, '$.binding.executionAuthorizationRef'), view.executionAuthorizationRef,
    '$.binding.executionAuthorizationRef');
  if (expected.stage === 'T17') {
    const window = record(policy.window, '$.t17.window');
    const recovery = record(policy.recoveryPolicy, '$.t17.recoveryPolicy');
    match(expected.window, { startsAt: window.startsAt, endsAt: window.endsAt }, '$.binding.window');
    for (const [participant, value] of Object.entries({ executionApproverId: window.approverId,
      executorId: window.executorId, readOnlyId: window.readOnlyId, recoveryAuthorityId: recovery.authorityId })) {
      match(expected.participants[participant as keyof ExecutionAuthorizationPayload['participants']], value, '$.binding.participants');
    }
  }
  const dataset = record(base.dataset, '$.base.dataset');
  const index = record(base.indexIdentity, '$.base.indexIdentity');
  const arms = policy.arms === undefined ? null : record(policy.arms, '$.policy.arms');
  const armConfigHashes = arms === null ? null : Object.fromEntries(Object.entries(arms)
    .map(([mode, value]) => [mode, record(value, '$.policy.arms').armConfigHash]));
  const identities = { datasetHash: dataset.normalizedSha256, rosterHash: dataset.rosterSha256,
    sharedConfigHash: base.sharedConfigHash, artifactsHash: canonicalJsonSha256(base.artifacts),
    indexIdentityRef: index.publicationIdentityRef, registryRef: providers.registryRef,
    providersHash: canonicalJsonSha256(providers), thresholdsHash: canonicalJsonSha256(thresholds), armConfigHashes };
  return freezeDeep({ validationLevel: 'structural-only' as const, productionAuthorized: false as const,
    stage: expected.stage, scope: scope as ExecutionAuthorizationPayload['scope'], runNonce: expected.runNonce,
    manifestHash: view.manifestHash, executionAuthorizationRef: view.executionAuthorizationRef,
    providers: base.providers as JsonObject, identities: identities as ReceiptCore['identities'],
    thresholdsProfile: STAGE_THRESHOLDS_PROFILE, thresholds, predecessor: policy.predecessor as JsonObject ?? null,
    frozenRetention: policy.frozenRetention as JsonObject ?? null,
    elapsedEvidenceRef: expected.stage === 'R18' ? reference(policy.elapsedEvidenceRef, '$.retention.elapsedEvidenceRef') : null });
}

const PROVIDER_PURPOSES = ['secret', 'kms', 'approval', 'tamper-store', 'clock', 'ask',
  'publication-readback', 'run-journal', 'lease', 'fencing', 'deployment', 'traffic', 'fault'];
const T16_PROVIDERS = PROVIDER_PURPOSES.slice(0, 8);
const RETENTION_PROVIDERS = T16_PROVIDERS.filter(purpose => purpose !== 'ask');
const AAD_FIELDS = ['environment', 'tenantId', 'corpusId', 'runNonce', 'manifestHash',
  'artifactType', 'artifactId', 'caseId', 'ordinal', 'schemaVersion'];
const RECOVERY_ACTIONS = ['withdraw-traffic', 'revoke-existing-fault', 'set-off', 'rollback-to-predecessor'];

export function validateForT16(input: unknown): ProductionGateStageView<'T16'> {
  return validateStage(input, 'T16', 't16');
}

export function validateForT17(input: unknown): ProductionGateStageView<'T17'> {
  return validateStage(input, 'T17', 't17');
}

export function validateForRetention(input: unknown): ProductionGateStageView<'R18'> {
  return validateStage(input, 'R18', 'retention');
}

export function productionScopeHash(input: unknown): string {
  const scope = record(JSON.parse(canonicalJson(input)), '$.scope');
  keys(scope, ['environment', 'tenantId', 'corpusId', 'allowedTrustLevels'], '$.scope');
  for (const key of ['environment', 'tenantId', 'corpusId']) id(scope[key], `$.scope.${key}`);
  subset(scope.allowedTrustLevels, ['trusted', 'reviewed', 'external'], '$.scope.allowedTrustLevels');
  // Lease authority is per corpus, not per trust selection/order. The complete
  // trust policy remains bound by the independent stage manifest digest.
  return canonicalJsonSha256({ environment: scope.environment, tenantId: scope.tenantId, corpusId: scope.corpusId });
}

function validateStage<S extends ProductionGateStage>(
  input: unknown, stage: S, field: 't16' | 't17' | 'retention'
): ProductionGateStageView<S> {
  // Canonicalize before reflection: getters/proxies cannot execute, and the
  // detached snapshot cannot drift between validation, hashing and later use.
  const root = record(JSON.parse(canonicalJson(input)), '$');
  keys(root, ['schemaVersion', 'base', field], '$', ['t16', 't17', 'retention']);
  literal(root.schemaVersion, PRODUCTION_GATE_MANIFEST_SCHEMA_VERSION, '$.schemaVersion');
  const base = record(root.base, '$.base');
  validateBase(base, stage);
  const policy = record(root[field], `$.${field}`);
  if (stage === 'T16') validateT16(policy, base);
  else if (stage === 'T17') validateT17(policy, base);
  else validateRetention(policy, base);

  // The envelope binds manifestHash, so its own digest must remain outside the
  // hash projection. Deferred stages and post-run results are excluded as well.
  const executionAuthorizationRef = reference(policy.executionAuthorizationRef, `$.${field}.executionAuthorizationRef`);
  const hashedPolicy = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'executionAuthorizationRef'));
  const manifest = { schemaVersion: PRODUCTION_GATE_MANIFEST_SCHEMA_VERSION, stage,
    base: base as JsonObject, policy: hashedPolicy as JsonObject };
  return freezeDeep({ stage, validationLevel: 'structural-only' as const,
    productionAuthorized: false as const, canonicalProfile: CANONICAL_JSON_PROFILE,
    executionAuthorizationRef, manifestHash: canonicalJsonSha256(manifest), manifest });
}

function validateBase(base: Fields, stage: ProductionGateStage): void {
  const p = '$.base';
  keys(base, ['runNonce', 'scope', 'dataset', 'artifacts', 'models', 'indexIdentity', 'parameters',
    'sharedConfigHash', 'hardGates', 'providers', 'artifactPolicy'], p);
  hex(base.runNonce, 32, `${p}.runNonce`);
  const scope = record(base.scope, `${p}.scope`);
  keys(scope, ['environment', 'tenantId', 'corpusId', 'allowedTrustLevels'], `${p}.scope`);
  for (const key of ['environment', 'tenantId', 'corpusId']) id(scope[key], `${p}.scope.${key}`);
  subset(scope.allowedTrustLevels, ['trusted', 'reviewed', 'external'], `${p}.scope.allowedTrustLevels`);

  const dataset = record(base.dataset, `${p}.dataset`);
  keys(dataset, ['id', 'version', 'schemaVersion', 'normalizedSha256', 'roster', 'rosterSha256'], `${p}.dataset`);
  id(dataset.id, `${p}.dataset.id`); id(dataset.version, `${p}.dataset.version`);
  literal(dataset.schemaVersion, 'rag-eval-dataset/v2', `${p}.dataset.schemaVersion`);
  digest(dataset.normalizedSha256, `${p}.dataset.normalizedSha256`);
  const roster = array(dataset.roster, `${p}.dataset.roster`, 1, 1000);
  roster.forEach((value, index) => hex(value, 32, `${p}.dataset.roster[${index}]`));
  unique(roster, `${p}.dataset.roster`);
  hashMatches(dataset.rosterSha256, roster, `${p}.dataset.rosterSha256`);

  const artifacts = record(base.artifacts, `${p}.artifacts`);
  keys(artifacts, ['commit', 'releaseId', 'buildHash', 'imageDigest'], `${p}.artifacts`);
  if (typeof artifacts.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(artifacts.commit)) {
    fail(`${p}.artifacts.commit`, 'must be an exact commit digest');
  }
  id(artifacts.releaseId, `${p}.artifacts.releaseId`); digest(artifacts.buildHash, `${p}.artifacts.buildHash`);
  if (typeof artifacts.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(artifacts.imageDigest)) {
    fail(`${p}.artifacts.imageDigest`, 'must be an immutable sha256 image digest');
  }
  const models = record(base.models, `${p}.models`);
  keys(models, ['llm', 'embedding', 'reranker'], `${p}.models`);
  for (const key of ['llm', 'embedding', 'reranker']) {
    const model = record(models[key], `${p}.models.${key}`);
    keys(model, ['id', 'version', 'artifactHash', 'configHash'], `${p}.models.${key}`);
    id(model.id, `${p}.models.${key}.id`); id(model.version, `${p}.models.${key}.version`);
    digest(model.artifactHash, `${p}.models.${key}.artifactHash`);
    digest(model.configHash, `${p}.models.${key}.configHash`);
  }
  const index = record(base.indexIdentity, `${p}.indexIdentity`);
  keys(index, ['publicationIdentityRef', 'schemaManifestHash', 'indexManifestHash'], `${p}.indexIdentity`);
  reference(index.publicationIdentityRef, `${p}.indexIdentity.publicationIdentityRef`);
  digest(index.schemaManifestHash, `${p}.indexIdentity.schemaManifestHash`);
  digest(index.indexManifestHash, `${p}.indexIdentity.indexManifestHash`);
  const parameters = record(base.parameters, `${p}.parameters`);
  keys(parameters, ['topK', 'graphMaxCandidates', 'graphTimeoutMs', 'seed'], `${p}.parameters`);
  integer(parameters.topK, 1, 1000, `${p}.parameters.topK`);
  integer(parameters.graphMaxCandidates, 1, 10000, `${p}.parameters.graphMaxCandidates`);
  integer(parameters.graphTimeoutMs, 1, 300000, `${p}.parameters.graphTimeoutMs`);
  if (parameters.seed !== null) integer(parameters.seed, 0, Number.MAX_SAFE_INTEGER, `${p}.parameters.seed`);
  hashMatches(base.sharedConfigHash, commonConfiguration(base), `${p}.sharedConfigHash`);
  const hardGates = record(base.hardGates, `${p}.hardGates`);
  keys(hardGates, Object.keys(HARD_GATE_LIMITS), `${p}.hardGates`);
  for (const key of Object.keys(HARD_GATE_LIMITS)) literal(hardGates[key], 0, `${p}.hardGates.${key}`);
  validateProviders(base.providers, stage);
  validateArtifactPolicy(base.artifactPolicy);
}

function validateProviders(input: unknown, stage: ProductionGateStage): void {
  const p = '$.base.providers'; const providers = record(input, p);
  keys(providers, ['registryRef', 'bindings'], p); reference(providers.registryRef, `${p}.registryRef`);
  const bindings = array(providers.bindings, `${p}.bindings`, 1, PROVIDER_PURPOSES.length);
  const seen = new Set<string>();
  bindings.forEach((value, index) => {
    const path = `${p}.bindings[${index}]`; const binding = record(value, path);
    keys(binding, ['purpose', 'providerId', 'adapterDigest', 'version', 'configHash', 'conformanceRef'], path);
    const purpose = choice(binding.purpose, PROVIDER_PURPOSES, `${path}.purpose`);
    if (seen.has(purpose)) fail(path, 'duplicate provider purpose');
    seen.add(purpose);
    id(binding.providerId, `${path}.providerId`); id(binding.version, `${path}.version`);
    digest(binding.adapterDigest, `${path}.adapterDigest`); digest(binding.configHash, `${path}.configHash`);
    reference(binding.conformanceRef, `${path}.conformanceRef`);
  });
  const required = stage === 'T17' ? PROVIDER_PURPOSES : stage === 'T16' ? T16_PROVIDERS : RETENTION_PROVIDERS;
  if (required.some(purpose => !seen.has(purpose))) fail(p, 'required stage provider is absent');
}

function validateArtifactPolicy(input: unknown): void {
  const p = '$.base.artifactPolicy'; const policy = record(input, p);
  keys(policy, ['classification', 'encryption', 'noncePolicy', 'aadFields', 'responseHeaders', 'redaction',
    'keyPolicyRef', 'accessPolicyRef', 'lifecyclePolicyRef'], p);
  literal(policy.classification, 'confidential', `${p}.classification`);
  literal(policy.encryption, 'aead-envelope-per-run', `${p}.encryption`);
  literal(policy.noncePolicy, 'unique-per-object', `${p}.noncePolicy`);
  literal(policy.redaction, 'fail-closed', `${p}.redaction`);
  fixedSet(policy.aadFields, AAD_FIELDS, `${p}.aadFields`);
  const headers = array(policy.responseHeaders, `${p}.responseHeaders`, 0, 16);
  headers.forEach(value => {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)
      || /authorization|cookie|token|secret|api-key/.test(value)) {
      fail(`${p}.responseHeaders`, 'must contain only non-sensitive lowercase header names');
    }
  });
  unique(headers, `${p}.responseHeaders`);
  for (const key of ['keyPolicyRef', 'accessPolicyRef', 'lifecyclePolicyRef']) reference(policy[key], `${p}.${key}`);
}

function commonConfiguration(base: Fields): Fields {
  return { artifacts: base.artifacts, models: base.models, indexIdentity: base.indexIdentity,
    parameters: base.parameters };
}

function validateT16(policy: Fields, base: Fields): void {
  const p = '$.t16';
  keys(policy, ['arms', 'sampling', 'quality', 'sideEffectPolicy', 'executionAuthorizationRef'], p);
  validateArms(policy.arms, base, 'shadow', `${p}.arms`);
  validateSampling(policy.sampling, 'T16', `${p}.sampling`);
  validateQuality(policy.quality, 'T16', `${p}.quality`);
  reference(policy.executionAuthorizationRef, `${p}.executionAuthorizationRef`);
  const effects = record(policy.sideEffectPolicy, `${p}.sideEffectPolicy`);
  keys(effects, ['schemaVersion', 'exactMatch', 'zeroMutation', 'allowedEffects', 'readbackProviderId'], `${p}.sideEffectPolicy`);
  literal(effects.schemaVersion, 'kg-shadow-side-effect-policy/v1', `${p}.sideEffectPolicy.schemaVersion`);
  fixedSet(effects.exactMatch, ['servedEvidence', 'context', 'prompt', 'cacheIdentity'], `${p}.sideEffectPolicy.exactMatch`);
  fixedSet(effects.zeroMutation, ['graphCache', 'pointer', 'outbox', 'buildJob', 'neo4j', 'milvus', 'index', 'mode', 'traffic'],
    `${p}.sideEffectPolicy.zeroMutation`);
  fixedSet(effects.allowedEffects, ['encryptedAudit', 'controlledTelemetry', 'modelBilling', 'equivalentOrdinaryCache'],
    `${p}.sideEffectPolicy.allowedEffects`);
  provider(base, 'publication-readback', effects.readbackProviderId, `${p}.sideEffectPolicy.readbackProviderId`);
}

function validateArms(input: unknown, base: Fields, treatment: 'shadow' | 'active', path: string): void {
  const arms = record(input, path); keys(arms, ['off', treatment], path);
  for (const mode of ['off', treatment]) {
    const armPath = `${path}.${mode}`; const arm = record(arms[mode], armPath);
    keys(arm, ['rolloutMode', 'sharedConfigHash', 'armConfigHash', 'config'], armPath);
    literal(arm.rolloutMode, mode, `${armPath}.rolloutMode`);
    literal(arm.sharedConfigHash, base.sharedConfigHash as string, `${armPath}.sharedConfigHash`);
    const config = record(arm.config, `${armPath}.config`);
    keys(config, ['rolloutMode', 'artifacts', 'models', 'indexIdentity', 'parameters'], `${armPath}.config`);
    literal(config.rolloutMode, mode, `${armPath}.config.rolloutMode`);
    const shared = commonConfiguration(config);
    if (canonicalJson(shared) !== canonicalJson(commonConfiguration(base))) {
      fail(`${armPath}.config`, 'only rolloutMode may differ from frozen shared configuration');
    }
    hashMatches(arm.armConfigHash, config, `${armPath}.armConfigHash`);
  }
}

function validateSampling(input: unknown, stage: 'T16' | 'T17', path: string): void {
  const sampling = record(input, path); keys(sampling, ['trialCount', 'warmupCount'], path);
  integer(sampling.trialCount, stage === 'T17' ? 2 : 1, 100, `${path}.trialCount`);
  integer(sampling.warmupCount, 0, 1000, `${path}.warmupCount`);
}

function validateQuality(input: unknown, stage: 'T16' | 'T17', path: string): void {
  const quality = record(input, path);
  const minima = ['meanRecallAtK', 'meanNdcgAtK', 'meanRequiredFactCoverage', 'abstainAccuracy',
    'citation.meanValidity', 'citation.meanCoverage', 'citation.metricCoverageRatio',
    'retrievalMetricCoverageRatio', 'answerMetricCoverageRatio'];
  const maxima = ['errorRate', 'timeoutRate', 'latencyMs.p95'];
  if (stage === 'T16') maxima.push('semanticDegradation');
  else minima.push('multiHop.meanRequiredFactCoverage');
  keys(quality, [...minima, ...maxima], path);
  for (const metric of [...minima, ...maxima]) {
    const direction = minima.includes(metric) ? 'min' : 'max';
    const threshold = record(quality[metric], `${path}.${metric}`);
    keys(threshold, [direction], `${path}.${metric}`);
    if (metric === 'latencyMs.p95') integer(threshold.max, 1, 300000, `${path}.${metric}.max`);
    else ratio(threshold[direction], `${path}.${metric}.${direction}`, /CoverageRatio$|metricCoverageRatio$/.test(metric));
  }
}

function provider(base: Fields, purpose: string, input: unknown, path: string): void {
  const bindings = record(base.providers, '$.base.providers').bindings as Fields[];
  if (!bindings.some(binding => binding.purpose === purpose && binding.providerId === input)) {
    fail(path, 'does not match the frozen provider binding');
  }
}

function validateT17(policy: Fields, base: Fields): void {
  const p = '$.t17';
  keys(policy, ['predecessor', 'arms', 'sampling', 'quality', 'canary', 'lineage', 'lease', 'rampPlan',
    'faultPlan', 'recoveryPolicy', 'window', 'frozenRetention', 'executionAuthorizationRef'], p);
  predecessor(policy.predecessor, 'T16', `${p}.predecessor`);
  reference(policy.executionAuthorizationRef, `${p}.executionAuthorizationRef`);
  validateArms(policy.arms, base, 'active', `${p}.arms`);
  validateSampling(policy.sampling, 'T17', `${p}.sampling`);
  validateQuality(policy.quality, 'T17', `${p}.quality`);
  const canary = record(policy.canary, `${p}.canary`);
  keys(canary, ['instanceId', 'hostId', 'trafficSelectorId', 'faultTargetResourceId'], `${p}.canary`);
  for (const key of Object.keys(canary)) id(canary[key], `${p}.canary.${key}`);
  validateLineage(policy.lineage, `${p}.lineage`);
  const lineage = record(policy.lineage, `${p}.lineage`);
  const index = record(base.indexIdentity, '$.base.indexIdentity');
  if (canonicalJson(lineage.targetRef) !== canonicalJson(index.publicationIdentityRef)) {
    fail(`${p}.lineage.targetRef`, 'must match the frozen index publication identity');
  }
  const lease = record(policy.lease, `${p}.lease`);
  keys(lease, ['providerId', 'authorityId', 'scopeHash', 'ttlMs', 'renewEveryMs', 'fencing', 'trafficDeadman'], `${p}.lease`);
  provider(base, 'lease', lease.providerId, `${p}.lease.providerId`);
  provider(base, 'fencing', lease.authorityId, `${p}.lease.authorityId`);
  literal(lease.scopeHash, productionScopeHash(base.scope), `${p}.lease.scopeHash`);
  const ttlMs = integer(lease.ttlMs, 1000, 300000, `${p}.lease.ttlMs`);
  integer(lease.renewEveryMs, 100, Math.floor(ttlMs / 3), `${p}.lease.renewEveryMs`);
  literal(lease.fencing, 'monotonic-generation-enforced', `${p}.lease.fencing`);
  literal(lease.trafficDeadman, 'zero-on-expiry', `${p}.lease.trafficDeadman`);
  validateRamp(policy.rampPlan, ttlMs, `${p}.rampPlan`);
  validateWindow(policy.window, base, `${p}.window`);
  validateFault(policy.faultPlan, canary, ttlMs, `${p}.faultPlan`);
  validateRecovery(policy.recoveryPolicy, policy, base, ttlMs, `${p}.recoveryPolicy`);
  validateFrozenRetention(policy.frozenRetention, base, `${p}.frozenRetention`);
}

function predecessor(input: unknown, stage: 'T16' | 'T17', path: string): void {
  const value = record(input, path);
  keys(value, ['stage', 'acceptanceBundleRef', 'manifestHash',
    ...(stage === 'T17' ? ['retentionPolicyHash', 'oldStoreManifestHash'] : [])], path);
  literal(value.stage, stage, `${path}.stage`);
  reference(value.acceptanceBundleRef, `${path}.acceptanceBundleRef`);
  digest(value.manifestHash, `${path}.manifestHash`);
  if (stage === 'T17') {
    digest(value.retentionPolicyHash, `${path}.retentionPolicyHash`);
    digest(value.oldStoreManifestHash, `${path}.oldStoreManifestHash`);
  }
}

function validateLineage(input: unknown, path: string): void {
  const lineage = record(input, path); keys(lineage, ['predecessorRef', 'targetRef', 'expectedPointerRevision'], path);
  const prior = reference(lineage.predecessorRef, `${path}.predecessorRef`);
  const target = reference(lineage.targetRef, `${path}.targetRef`);
  if (prior.sha256 === target.sha256) fail(path, 'predecessor and target must be distinct immutable identities');
  // Preflight must leave room for target publication (N+1) AND rollback (N+2).
  // Reject before execution, not only when a rescue authorization is requested.
  integer(lineage.expectedPointerRevision, 0, Number.MAX_SAFE_INTEGER - 2, `${path}.expectedPointerRevision`);
}

function validateRamp(input: unknown, leaseTtlMs: number, path: string): void {
  const ramp = record(input, path); keys(ramp, ['maxWeightBps', 'maxRequests', 'steps', 'abort'], path);
  const maximumWeight = integer(ramp.maxWeightBps, 1, 10000, `${path}.maxWeightBps`);
  const maximumRequests = integer(ramp.maxRequests, 1, 10000000, `${path}.maxRequests`);
  const steps = array(ramp.steps, `${path}.steps`, 1, 20);
  let previousWeight = 0; let requests = 0;
  steps.forEach((inputStep, index) => {
    const p = `${path}.steps[${index}]`; const step = record(inputStep, p);
    keys(step, ['weightBps', 'requests', 'dwellMs', 'ttlMs'], p);
    previousWeight = integer(step.weightBps, previousWeight + 1, maximumWeight, `${p}.weightBps`);
    requests += integer(step.requests, 1, maximumRequests, `${p}.requests`);
    integer(step.dwellMs, 1, 86400000, `${p}.dwellMs`);
    integer(step.ttlMs, 1, leaseTtlMs, `${p}.ttlMs`);
  });
  if (requests > maximumRequests) fail(path, 'aggregate ramp requests exceed the frozen maximum');
  const abort = record(ramp.abort, `${path}.abort`);
  keys(abort, ['maxErrorRate', 'maxTimeoutRate', 'maxP95LatencyMs'], `${path}.abort`);
  ratio(abort.maxErrorRate, `${path}.abort.maxErrorRate`); ratio(abort.maxTimeoutRate, `${path}.abort.maxTimeoutRate`);
  integer(abort.maxP95LatencyMs, 1, 300000, `${path}.abort.maxP95LatencyMs`);
}

function validateWindow(input: unknown, base: Fields, path: string): void {
  const window = record(input, path);
  keys(window, ['changeId', 'startsAt', 'endsAt', 'clockProviderId', 'ownerId', 'approverId', 'executorId',
    'readOnlyId', 'onCallId', 'rollbackOwnerId', 'credentialPolicyRef'], path);
  for (const key of ['changeId', 'ownerId', 'approverId', 'executorId', 'readOnlyId', 'onCallId', 'rollbackOwnerId']) {
    id(window[key], `${path}.${key}`);
  }
  const start = timestamp(window.startsAt, `${path}.startsAt`); const end = timestamp(window.endsAt, `${path}.endsAt`);
  if (end <= start || end - start > 86400000) fail(path, 'window must be ordered and no longer than 24 hours');
  if (window.approverId === window.executorId || window.readOnlyId === window.executorId
    || window.readOnlyId === window.approverId) fail(path, 'execution, approval and readback identities must be distinct');
  provider(base, 'clock', window.clockProviderId, `${path}.clockProviderId`);
  reference(window.credentialPolicyRef, `${path}.credentialPolicyRef`);
}

function timestamp(input: unknown, path: string): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) {
    fail(path, 'must be a canonical UTC timestamp');
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input) fail(path, 'must be a valid canonical UTC timestamp');
  return parsed;
}

function validateFault(input: unknown, canary: Fields, leaseTtlMs: number, path: string): void {
  const fault = record(input, path);
  keys(fault, ['schemaVersion', 'action', 'resourceId', 'parameters', 'maxTtlMs', 'expectedImpact',
    'revokeAction', 'stopConditions', 'killSwitchId', 'planHash', 'approvalRef'], path);
  literal(fault.schemaVersion, 'kg-canary-fault-plan/v1', `${path}.schemaVersion`);
  literal(fault.action, 'isolate-canary-neo4j', `${path}.action`);
  literal(fault.resourceId, canary.faultTargetResourceId as string, `${path}.resourceId`);
  const parameters = record(fault.parameters, `${path}.parameters`);
  keys(parameters, ['dependency', 'isolation'], `${path}.parameters`);
  literal(parameters.dependency, 'neo4j', `${path}.parameters.dependency`);
  literal(parameters.isolation, 'canary-egress-only', `${path}.parameters.isolation`);
  integer(fault.maxTtlMs, 1, leaseTtlMs, `${path}.maxTtlMs`);
  literal(fault.expectedImpact, 'graph-unavailable-dense-serving-preserved', `${path}.expectedImpact`);
  literal(fault.revokeAction, 'restore-canary-neo4j-connectivity', `${path}.revokeAction`);
  fixedSet(fault.stopConditions, ['non-canary-impact', 'hard-gate', 'lease-loss', 'slo-breach', 'window-closed'], `${path}.stopConditions`);
  id(fault.killSwitchId, `${path}.killSwitchId`); reference(fault.approvalRef, `${path}.approvalRef`);
  const unsigned = Object.fromEntries(Object.entries(fault).filter(([key]) => !['planHash', 'approvalRef'].includes(key)));
  hashMatches(fault.planHash, unsigned, `${path}.planHash`);
}

function validateRecovery(input: unknown, policy: Fields, base: Fields, leaseTtlMs: number, path: string): void {
  const recovery = record(input, path);
  keys(recovery, ['schemaVersion', 'authorityId', 'roleId', 'scopeHash', 'allowedActions', 'lineage',
    'maxAuthorizationTtlMs', 'credentialPolicyRef', 'policyHash'], path);
  literal(recovery.schemaVersion, 'kg-safety-recovery-policy/v1', `${path}.schemaVersion`);
  id(recovery.authorityId, `${path}.authorityId`); id(recovery.roleId, `${path}.roleId`);
  const window = record(policy.window, '$.t17.window');
  if (['ownerId', 'approverId', 'executorId', 'readOnlyId'].some(key => window[key] === recovery.authorityId)) {
    fail(path, 'recovery authority must be independent of execution, approval and readback');
  }
  fixedSet(recovery.allowedActions, RECOVERY_ACTIONS, `${path}.allowedActions`);
  literal(recovery.scopeHash, productionScopeHash(base.scope), `${path}.scopeHash`);
  validateLineage(recovery.lineage, `${path}.lineage`);
  if (canonicalJson(recovery.lineage) !== canonicalJson(policy.lineage)) fail(`${path}.lineage`, 'must match the frozen run lineage');
  integer(recovery.maxAuthorizationTtlMs, 1, leaseTtlMs, `${path}.maxAuthorizationTtlMs`);
  reference(recovery.credentialPolicyRef, `${path}.credentialPolicyRef`);
  const unsigned = Object.fromEntries(Object.entries(recovery).filter(([key]) => key !== 'policyHash'));
  hashMatches(recovery.policyHash, unsigned, `${path}.policyHash`);
}

function validateFrozenRetention(input: unknown, base: Fields, path: string): void {
  const frozen = record(input, path); keys(frozen, ['policy', 'policyHash', 'oldStoreManifest', 'oldStoreManifestHash'], path);
  const policy = record(frozen.policy, `${path}.policy`);
  keys(policy, ['schemaVersion', 'oldStoreId', 'startEvent', 'minimumElapsedMs', 'minimumSuccessorReleases',
    'resetOnRollback', 'clockProviderId', 'legalHold', 'coverage'], `${path}.policy`);
  literal(policy.schemaVersion, 'kg-retention-policy/v1', `${path}.policy.schemaVersion`);
  id(policy.oldStoreId, `${path}.policy.oldStoreId`);
  literal(policy.startEvent, 't17-stable-final-state', `${path}.policy.startEvent`);
  const elapsed = integer(policy.minimumElapsedMs, 0, Number.MAX_SAFE_INTEGER, `${path}.policy.minimumElapsedMs`);
  const releases = integer(policy.minimumSuccessorReleases, 0, 1000, `${path}.policy.minimumSuccessorReleases`);
  if (elapsed === 0 && releases === 0) fail(`${path}.policy`, 'a full-cycle time or successor release condition is required');
  literal(policy.resetOnRollback, true, `${path}.policy.resetOnRollback`);
  provider(base, 'clock', policy.clockProviderId, `${path}.policy.clockProviderId`);
  literal(policy.legalHold, 'must-be-cleared', `${path}.policy.legalHold`);
  fixedSet(policy.coverage, ['objects', 'versions', 'caches', 'derived', 'replicas', 'backups'], `${path}.policy.coverage`);
  const store = record(frozen.oldStoreManifest, `${path}.oldStoreManifest`);
  keys(store, ['storeId', 'version', 'contentHash'], `${path}.oldStoreManifest`);
  literal(store.storeId, policy.oldStoreId as string, `${path}.oldStoreManifest.storeId`);
  id(store.version, `${path}.oldStoreManifest.version`); digest(store.contentHash, `${path}.oldStoreManifest.contentHash`);
  hashMatches(frozen.policyHash, policy, `${path}.policyHash`);
  hashMatches(frozen.oldStoreManifestHash, store, `${path}.oldStoreManifestHash`);
}

function validateRetention(policy: Fields, base: Fields): void {
  const p = '$.retention';
  keys(policy, ['predecessor', 'frozenRetention', 'elapsedEvidenceRef', 'executionAuthorizationRef'], p);
  predecessor(policy.predecessor, 'T17', `${p}.predecessor`);
  validateFrozenRetention(policy.frozenRetention, base, `${p}.frozenRetention`);
  const prior = record(policy.predecessor, `${p}.predecessor`);
  const frozen = record(policy.frozenRetention, `${p}.frozenRetention`);
  literal(frozen.policyHash, prior.retentionPolicyHash as string, `${p}.frozenRetention.policyHash`);
  literal(frozen.oldStoreManifestHash, prior.oldStoreManifestHash as string, `${p}.frozenRetention.oldStoreManifestHash`);
  reference(policy.elapsedEvidenceRef, `${p}.elapsedEvidenceRef`);
  reference(policy.executionAuthorizationRef, `${p}.executionAuthorizationRef`);
}

function record(input: unknown, path: string): Fields {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path, 'required object is absent');
  return input as Fields;
}

function keys(value: Fields, required: readonly string[], path: string, optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))) fail(path, 'required field is absent');
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    fail(path, 'contains unsupported fields');
  }
}

function array(input: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum) fail(path, 'array size is outside the versioned bounds');
  return input;
}

function integer(input: unknown, minimum: number, maximum: number, path: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) {
    fail(path, 'integer is outside the versioned bounds');
  }
  return input;
}

function ratio(input: unknown, path: string, positive = false): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 1 || (positive && input === 0)) {
    fail(path, 'ratio is outside the versioned bounds');
  }
  return input;
}

function id(input: unknown, path: string): void {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input)) fail(path, 'must be a bounded opaque identifier');
}

function hex(input: unknown, length: number, path: string): void {
  if (typeof input !== 'string' || input.length !== length || !/^[a-f0-9]+$/.test(input)) fail(path, 'must be an exact lowercase hexadecimal identity');
}

function digest(input: unknown, path: string): void { hex(input, 64, path); }

function hashMatches(input: unknown, value: unknown, path: string): void {
  digest(input, path);
  if (input !== canonicalJsonSha256(value)) fail(path, 'canonical digest mismatch');
}

function literal(input: unknown, expected: string | number | boolean, path: string): void {
  if (input !== expected) fail(path, 'does not match the versioned invariant');
}

function choice(input: unknown, allowed: readonly string[], path: string): string {
  if (typeof input !== 'string' || !allowed.includes(input)) fail(path, 'is outside the closed set');
  return input;
}

function unique(values: readonly unknown[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'contains duplicate identities');
}

function subset(input: unknown, allowed: readonly string[], path: string): void {
  const values = array(input, path, 1, allowed.length);
  values.forEach(value => choice(value, allowed, path)); unique(values, path);
}

function fixedSet(input: unknown, allowed: readonly string[], path: string): void {
  subset(input, allowed, path);
  if ((input as unknown[]).length !== allowed.length) fail(path, 'required invariant is absent');
}

function reference(input: unknown, path: string): ArtifactReference {
  const value = record(input, path); keys(value, ['objectId', 'objectVersion', 'sha256'], path);
  id(value.objectId, `${path}.objectId`); id(value.objectVersion, `${path}.objectVersion`); digest(value.sha256, `${path}.sha256`);
  return value as unknown as ArtifactReference;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function fail(path: string, reason: string): never {
  // Only schema-owned paths and fixed reasons are safe in ordinary diagnostics.
  throw new Error(`[production gate manifest] ${path}: ${reason}`);
}
