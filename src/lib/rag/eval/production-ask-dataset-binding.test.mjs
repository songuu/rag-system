import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
} });

const { canonicalJson, canonicalJsonSha256: hash } = await import('./canonical-json.ts');
const { createRagEvalDatasetHash, parseRagEvalDataset } = await import('./dataset.ts');
const { fixture, bindDataset, rebindExecution } = await import('./production-ask-dataset-fixtures.test-support.mjs');
const { validateManifestExecutionBinding } = await import('./production-gate-manifest.ts');
const { validateProviderTrustPolicy } = await import('./production-provider-trust.ts');
const askTarget = await import('./production-ask-target.ts');
let subject;
try { subject = await import('./production-ask-dataset-binding.ts'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {}; }

const RAW_LIMIT = 8 * 1024 * 1024;
const NODE_LIMIT = 200_000;
const clone = value => structuredClone(value);
const rawSha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');


const bindingInput = f => ({ manifest: f.options.manifest,
  expectedExecutionPayload: f.options.expectedExecutionPayload,
  executionAuthorizationRef: f.options.executionAuthorizationRef });
const request = (f, changes = {}) => ({ caseId: f.options.manifest.base.dataset.roster[0],
  rolloutMode: 'off', phase: 'trial', ordinal: 0, ...changes });
const create = f => subject.createReferenceProductionAskDatasetBinding(f.options, f.rawDatasetJson);

function assertFixtureSound(f) {
  const reparsed = parseRagEvalDataset(JSON.parse(f.rawDatasetJson));
  assert.deepEqual(reparsed, f.normalizedDataset);
  assert.equal(createRagEvalDatasetHash(reparsed), f.options.manifest.base.dataset.normalizedSha256);
  assert.equal(hash(reparsed.cases.map(value => value.id)), f.options.manifest.base.dataset.rosterSha256);
  assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedBinding);
  assert.equal(validateProviderTrustPolicy(f.options.deploymentPolicy).policyHash, f.options.policyRef.sha256);
  const original = askTarget.createReferenceProductionAskTargetPlanner(f.options);
  assert.equal(original.planRequest(request(f)).requestIdentity.caseId, f.normalizedDataset.cases[0].id);
  return original;
}

const failure = (code, phase) => error => typeof subject.ProductionAskDatasetBindingError === 'function'
  && error instanceof subject.ProductionAskDatasetBindingError
  && error.code === code && error.phase === phase && error.productionAuthorized === false
  && error.automaticRetryAllowed === false && Object.isFrozen(error)
  && !Object.hasOwn(error, 'cause')
  && !/RAW_|secret-token|1e400|FOREIGN_|QUARANTINED_/.test(error.message);
const configFailure = failure('invalid-config', 'configuration');
const requestFailure = failure('invalid-request', 'request');

function expectedBindingProof(f, originalPlanner) {
  const descriptor = f.options.manifest.base.dataset;
  const core = { schemaVersion: 'kg-production-ask-dataset-binding/v1',
    validationLevel: 'local-reference-dataset-correspondence', classification: 'confidential',
    rawDatasetVerified: true, productionAuthorized: false, stageAcceptanceComplete: false,
    executionAuthorized: false, registryAuthenticated: false, networkEnforced: false,
    datasetFrozen: true,
    configurationHash: originalPlanner.planRequest(request(f)).configurationHash,
    rawJsonSha256: rawSha256(f.rawDatasetJson),
    binding: originalPlanner.planRequest(request(f)).binding,
    dataset: { id: descriptor.id, version: descriptor.version, schemaVersion: descriptor.schemaVersion,
      normalizedSha256: descriptor.normalizedSha256, rosterSha256: descriptor.rosterSha256,
      caseCount: f.normalizedDataset.cases.length, corpusCount: f.normalizedDataset.corpus.length },
    resourceBudget: { maxJsonBytes: RAW_LIMIT, maxDepth: 64, maxNodes: NODE_LIMIT } };
  return { ...core, bindingHash: hash(core) };
}

function expectedPlan(f, bindingProof, input) {
  const requestPlan = askTarget.createReferenceProductionAskTargetPlanner(f.options).planRequest(input);
  const core = { schemaVersion: 'kg-production-dataset-bound-ask-plan/v1',
    validationLevel: 'local-reference-dataset-bound-ask-plan', classification: 'confidential',
    rawDatasetVerified: true, productionAuthorized: false, stageAcceptanceComplete: false,
    executionAuthorized: false, registryAuthenticated: false, networkEnforced: false,
    bindingProof, requestPlan,
    caseIndex: f.normalizedDataset.cases.findIndex(value => value.id === input.caseId) };
  return { ...core, planHash: hash(core) };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value); assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function resourceUsage(value, depth = 0) {
  let nodes = 1; let maxDepth = depth;
  if (value !== null && typeof value === 'object') for (const child of Object.values(value)) {
    const nested = resourceUsage(child, depth + 1); nodes += nested.nodes;
    maxDepth = Math.max(maxDepth, nested.maxDepth);
  }
  return { nodes, maxDepth };
}

function withOverallDepth(dataset, targetDepth) {
  const copy = clone(dataset); let value = null;
  for (let depth = targetDepth; depth > 3; depth -= 1) value = { next: value };
  copy.cases[0].metadata = value;
  assert.equal(resourceUsage(copy).maxDepth, targetDepth);
  return copy;
}

function withExactNodeCount(dataset, targetNodes) {
  const copy = clone(dataset); copy.cases[0].metadata = {};
  const baseNodes = resourceUsage(copy).nodes;
  copy.cases[0].metadata.padding = Array(targetNodes - baseNodes - 1).fill(null);
  assert.equal(resourceUsage(copy).nodes, targetNodes);
  return copy;
}

function rawAtExactBytes(dataset, bytes) {
  const copy = clone(dataset); copy.corpus[0].content = '';
  const empty = JSON.stringify(copy); const remaining = bytes - Buffer.byteLength(empty, 'utf8');
  assert.ok(remaining > 0); copy.corpus[0].content = 'x'.repeat(remaining);
  const raw = JSON.stringify(copy); assert.equal(Buffer.byteLength(raw, 'utf8'), bytes);
  return { dataset: copy, raw };
}

test('complete V2 fixture independently passes original parser, hash, manifest, provider and Ask planner contracts', () => {
  for (const stage of ['T16', 'T17']) assertFixtureSound(fixture(stage));
});

test('dataset binding entry points exist and expose only the synchronous local-reference surface', () => {
  assert.equal(typeof subject.createReferenceProductionAskDatasetBinding, 'function');
  assert.equal(typeof subject.ProductionAskDatasetBindingError, 'function');
  const f = fixture(); const binding = create(f);
  assert.deepEqual(Object.keys(binding).sort(), ['bindingProof', 'executionProfile', 'planRequest', 'productionCapable']);
  assert.equal(binding.executionProfile, 'local-reference'); assert.equal(binding.productionCapable, false);
  assert.equal(typeof binding.then, 'undefined'); assert.equal(typeof binding.planRequest, 'function');
});

test('T16 and T17 exact proofs bind full normalized dataset and wrap the unchanged original request plan', () => {
  for (const stage of ['T16', 'T17']) {
    const f = fixture(stage); const original = assertFixtureSound(f); const binding = create(f);
    const proof = expectedBindingProof(f, original);
    assert.deepEqual(binding.bindingProof, proof);
    const input = request(f); const actual = binding.planRequest(input);
    assert.deepEqual(actual, expectedPlan(f, proof, input));
    assert.equal(actual.requestPlan.rawDatasetVerified, false);
    assert.equal(actual.requestPlan.planHash,
      askTarget.createReferenceProductionAskTargetPlanner(f.options).planRequest(input).planHash);
    assertDeepFrozen(binding); assertDeepFrozen(actual);
  }
});

test('ordinary proof and plans never expose raw JSON, query, gold, facts, corpus content or security canaries', () => {
  const f = fixture(); const binding = create(f); const plan = binding.planRequest(request(f));
  for (const value of [binding.bindingProof, plan]) {
    const encoded = canonicalJson(value);
    assert.equal(/RAW_|FOREIGN_|QUARANTINED_|"query"|"goldEvidence"|"expectedAnswer"|"content"|"securityExpectations"/.test(encoded), false);
    assert.equal(encoded.includes(f.rawDatasetJson), false);
  }
});

test('T17 paired off and active arms preserve one dataset proof while retaining original distinct arm plans', () => {
  const f = fixture('T17'); const binding = create(f); const off = binding.planRequest(request(f));
  const active = binding.planRequest(request(f, { rolloutMode: 'active' }));
  assert.equal(off.bindingProof, binding.bindingProof); assert.equal(active.bindingProof, binding.bindingProof);
  assert.equal(off.requestPlan.requestIdentity.datasetHash, active.requestPlan.requestIdentity.datasetHash);
  assert.notEqual(off.requestPlan.requestIdentity.armConfigHash, active.requestPlan.requestIdentity.armConfigHash);
  assert.notEqual(off.requestPlan.planHash, active.requestPlan.planHash); assert.notEqual(off.planHash, active.planHash);
});

test('gold, corpus content, metadata and claimed normalized hash drift all fail closed', () => {
  const changes = [
    d => { d.cases[0].goldEvidence[0].relevance = 2; },
    d => { d.corpus[0].content += ' changed'; },
    d => { d.corpus[0].metadata.canary.class = 'changed'; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.dataset); f.rawDatasetJson = JSON.stringify(f.dataset);
    assert.throws(() => create(f), configFailure);
  }
  const f = fixture(); f.options.manifest.base.dataset.normalizedSha256 = hash('other');
  rebindExecution(f);
  assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedBinding);
  assert.doesNotThrow(() => askTarget.createReferenceProductionAskTargetPlanner(f.options));
  assert.throws(() => create(f), configFailure);
});

test('manifest roster order and membership remain exact even after independently rebinding dataset hash', () => {
  for (const change of [d => { d.cases.reverse(); }, d => { d.cases.pop(); }]) {
    const f = fixture(); change(f.dataset); bindDataset(f, f.dataset);
    assert.equal(createRagEvalDatasetHash(f.normalizedDataset), f.options.manifest.base.dataset.normalizedSha256);
    assert.throws(() => create(f), configFailure);
  }
});

test('case tenant, corpus and allowed trust set must correspond to base scope after full hash rebinding', () => {
  for (const change of [
    c => { c.scope.tenantId = 'tenant-other'; },
    c => { c.scope.corpusId = 'corpus-other'; },
    c => { c.scope.allowedTrustLevels = ['trusted']; },
  ]) {
    const f = fixture(); const target = f.dataset.cases[1]; change(target);
    bindDataset(f, f.dataset); assertFixtureSound(f); assert.throws(() => create(f), configFailure);
  }
});

test('parseable V1 raw datasets are rejected behind a fully valid V2 manifest and authorization', () => {
  const f = fixture(); const v1 = clone(f.dataset); v1.schemaVersion = 'rag-eval-dataset/v1';
  for (const document of v1.corpus) for (const field of ['documentVersion', 'tenantId', 'corpusId', 'trustLevel']) delete document[field];
  for (const evalCase of v1.cases) {
    delete evalCase.scope; delete evalCase.allowedPolicies; delete evalCase.allowedLanes;
    delete evalCase.securityExpectations;
    for (const gold of evalCase.goldEvidence) delete gold.spans;
  }
  bindDataset(f, v1); assert.equal(f.normalizedDataset.schemaVersion, 'rag-eval-dataset/v1');
  f.options.manifest.base.dataset.schemaVersion = 'rag-eval-dataset/v2'; rebindExecution(f);
  assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedBinding);
  assert.doesNotThrow(() => askTarget.createReferenceProductionAskTargetPlanner(f.options));
  assert.throws(() => create(f), configFailure);
});

test('raw JSON stays outside canonical planner options so a complete dataset above 256 KiB still binds', () => {
  const f = fixture(); f.dataset.corpus[0].content = 'x'.repeat(300 * 1024);
  bindDataset(f, f.dataset); assert.ok(Buffer.byteLength(f.rawDatasetJson, 'utf8') > 256 * 1024);
  assertFixtureSound(f); assert.equal(create(f).bindingProof.rawJsonSha256, rawSha256(f.rawDatasetJson));
});

test('raw UTF-8 budget accepts exactly 8 MiB and rejects one additional byte without truncation', () => {
  const atLimit = fixture(); const exact = rawAtExactBytes(atLimit.dataset, RAW_LIMIT);
  bindDataset(atLimit, exact.dataset); atLimit.rawDatasetJson = exact.raw;
  assert.equal(create(atLimit).bindingProof.rawJsonSha256, rawSha256(exact.raw));
  const over = fixture(); const oversized = rawAtExactBytes(over.dataset, RAW_LIMIT + 1);
  bindDataset(over, oversized.dataset); over.rawDatasetJson = oversized.raw;
  assert.throws(() => create(over), configFailure);
});

test('derived JSON depth budget counts root at zero and accepts 64 while rejecting 65', () => {
  const atLimit = fixture(); bindDataset(atLimit, withOverallDepth(atLimit.dataset, 64));
  assert.equal(resourceUsage(JSON.parse(atLimit.rawDatasetJson)).maxDepth, 64); create(atLimit);
  const over = fixture(); bindDataset(over, withOverallDepth(over.dataset, 65));
  assert.throws(() => create(over), configFailure);
});

test('derived JSON node budget counts every primitive, object and array and accepts 200000 while rejecting 200001', () => {
  const atLimit = fixture(); bindDataset(atLimit, withExactNodeCount(atLimit.dataset, NODE_LIMIT));
  assert.equal(resourceUsage(JSON.parse(atLimit.rawDatasetJson)).nodes, NODE_LIMIT); create(atLimit);
  const over = fixture(); bindDataset(over, withExactNodeCount(over.dataset, NODE_LIMIT + 1));
  assert.throws(() => create(over), configFailure);
});

test('non-finite numbers derived by JSON.parse are rejected before the legacy dataset hash can coerce them', () => {
  const f = fixture(); const finite = '"score":1'; assert.ok(f.rawDatasetJson.includes(finite));
  f.rawDatasetJson = f.rawDatasetJson.replace(finite, '"score":1e400');
  const parsedJson = JSON.parse(f.rawDatasetJson); assert.equal(parsedJson.corpus[0].metadata.score, Infinity);
  f.normalizedDataset = parseRagEvalDataset(parsedJson);
  f.options.manifest.base.dataset.normalizedSha256 = createRagEvalDatasetHash(f.normalizedDataset);
  rebindExecution(f);
  assert.deepEqual(validateManifestExecutionBinding(bindingInput(f)), f.expectedBinding);
  assert.doesNotThrow(() => askTarget.createReferenceProductionAskTargetPlanner(f.options));
  assert.throws(() => create(f), configFailure);
});

test('malformed JSON failures are static, frozen and never disclose parser-sensitive input or causes', () => {
  const messages = new Set();
  for (const raw of ['{"RAW_SECRET":', '{"unterminated":"secret-token}', '[1,]']) {
    const f = fixture(); f.rawDatasetJson = raw;
    assert.throws(() => create(f), error => { messages.add(error.message); return configFailure(error); });
  }
  assert.equal(messages.size, 1);
});

test('primitive raw string, closed options and extra arguments reject getters, proxies and boxed strings without hooks', () => {
  let hooks = 0; const hook = () => { hooks += 1; throw Error('secret-token'); };
  const f = fixture(); const boxed = new String(f.rawDatasetJson);
  Object.defineProperty(boxed, 'toString', { enumerable: true, get: hook });
  const proxiedBox = new Proxy(new String(f.rawDatasetJson), { ownKeys: hook, get: hook, getPrototypeOf: hook });
  for (const raw of [boxed, proxiedBox, null, {}, ['not-raw-json']]) {
    assert.throws(() => subject.createReferenceProductionAskDatasetBinding(f.options, raw), configFailure);
  }
  for (const field of ['manifest', 'expectedExecutionPayload', 'executionAuthorizationRef', 'deploymentPolicy', 'policyRef']) {
    const next = fixture(); Object.defineProperty(next.options, field, { enumerable: true, get: hook });
    assert.throws(() => subject.createReferenceProductionAskDatasetBinding(next.options, next.rawDatasetJson), configFailure);
  }
  const extra = new Proxy({}, { ownKeys: hook, get: hook, getPrototypeOf: hook });
  for (const value of [undefined, {}, extra]) {
    assert.throws(() => subject.createReferenceProductionAskDatasetBinding(f.options, f.rawDatasetJson, value), configFailure);
  }
  assert.equal(hooks, 0);
});

test('binding snapshots isolate later option drift and remain stateless after failed requests', () => {
  const f = fixture(); const binding = create(f); const input = request(f); const first = binding.planRequest(input);
  const encoded = canonicalJson(first);
  f.options.manifest.base.dataset.roster[0] = '4'.repeat(32);
  f.options.deploymentPolicy.registrations.find(value => value.purpose === 'ask').endpointOrigin = 'https://changed.example.test';
  f.dataset.cases[0].query = 'CHANGED_RAW_QUERY'; f.rawDatasetJson = JSON.stringify(f.dataset); input.ordinal = 999;
  assert.equal(canonicalJson(first), encoded); assert.throws(() => binding.planRequest(input), requestFailure);
  const valid = { caseId: first.requestPlan.requestIdentity.caseId, rolloutMode: 'off', phase: 'trial', ordinal: 0 };
  for (let index = 0; index < 3; index += 1) assert.deepEqual(binding.planRequest(valid), first);
});

test('legacy normalized hash ignores object key insertion order but preserves complete trust arrays and their order', () => {
  const first = fixture(); const reordered = JSON.parse(first.rawDatasetJson, (key, value) => {
    if (value && !Array.isArray(value) && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse());
    return value;
  });
  const second = fixture(); bindDataset(second, reordered);
  assert.equal(first.options.manifest.base.dataset.normalizedSha256,
    second.options.manifest.base.dataset.normalizedSha256);
  assert.notEqual(first.rawDatasetJson, second.rawDatasetJson);
  assert.notEqual(create(first).bindingProof.rawJsonSha256, create(second).bindingProof.rawJsonSha256);

  const permuted = fixture(); permuted.dataset.cases[0].scope.allowedTrustLevels.reverse();
  bindDataset(permuted, permuted.dataset); assertFixtureSound(permuted);
  assert.notEqual(permuted.options.manifest.base.dataset.normalizedSha256,
    first.options.manifest.base.dataset.normalizedSha256);
  assert.doesNotThrow(() => create(permuted));
});

test('dataset-bound request surface remains exact, indexed by actual case order and maps all request failures to the new error', () => {
  const f = fixture('T17'); const binding = create(f);
  for (const [caseIndex, evalCase] of f.normalizedDataset.cases.entries()) {
    assert.equal(binding.planRequest(request(f, { caseId: evalCase.id })).caseIndex, caseIndex);
  }
  let hooks = 0; const hook = () => { hooks += 1; throw Error('secret-token'); };
  const invalid = [
    { ...request(f), question: 'RAW_QUERY' },
    { ...request(f), rolloutMode: 'shadow' },
    { ...request(f), caseId: '0'.repeat(32) },
    { ...request(f), phase: 'probe' },
    { ...request(f), ordinal: 99 },
    Object.defineProperty(request(f), 'caseId', { enumerable: true, get: hook }),
    new Proxy(request(f), { ownKeys: hook, get: hook, getPrototypeOf: hook }),
  ];
  for (const input of invalid) assert.throws(() => binding.planRequest(input), requestFailure);
  const extra = new Proxy({}, { ownKeys: hook, get: hook, getPrototypeOf: hook });
  for (const value of [undefined, {}, extra]) assert.throws(() => binding.planRequest(request(f), value), requestFailure);
  assert.equal(hooks, 0);
});
