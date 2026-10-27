import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (error) {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !/\.[cm]?[jt]s$/.test(s)) return next(s + '.ts', c);
  throw error;
} } });
const { fixture } = await import('./production-ask-dataset-fixtures.test-support.mjs');
const { createReferenceProductionAskDatasetBinding } = await import('./production-ask-dataset-binding.ts');
const { validateAskInput } = await import('../../security/request-validation.ts');
let subject; try { subject = await import('./production-ask-request-contract.ts'); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; subject = {};
}
const input = () => ({ question: '  owned query  ', corpusId: 'corpus-a', topK: 8, llmModel: 'owned-llm', embeddingModel: 'owned-embedding' });
function deploymentFixture() {
  const f = fixture('T16');
  const plan = createReferenceProductionAskDatasetBinding(f.options, f.rawDatasetJson).planRequest({
    caseId: f.dataset.cases[0].id, rolloutMode: 'off', phase: 'trial', ordinal: 0,
  }).requestPlan;
  const base = f.options.manifest.base, r = plan.requestIdentity;
  const d = { schemaVersion: 'kg-reference-ask-deployment/v1', requestPlanHash: plan.planHash,
    origin: plan.target.origin, providerRegistrationHash: plan.providerRegistrationHash, scope: plan.binding,
    rolloutMode: r.rolloutMode, sharedConfigHash: r.sharedConfigHash, armConfigHash: r.armConfigHash,
    models: { llm: base.models.llm.id, embedding: base.models.embedding.id }, parameters: base.parameters };
  return { base, plan, d };
}

test('shared request builder retains the original validator and exact eight-field bytes', () => {
  const i = input(), raw = { ...i, storageBackend: 'milvus', executionMode: 'sync', maxRetries: 0 };
  const original = validateAskInput(raw, { NODE_ENV: 'test', MODEL_PROVIDER: 'custom', CUSTOM_LLM_MODEL: i.llmModel,
    EMBEDDING_PROVIDER: 'custom', CUSTOM_EMBEDDING_MODEL: i.embeddingModel,
    RAG_ALLOWED_LLM_MODELS: i.llmModel, RAG_ALLOWED_EMBEDDING_MODELS: i.embeddingModel });
  const expected = Buffer.from(JSON.stringify({ question: original.question, topK: i.topK, corpusId: i.corpusId,
    llmModel: i.llmModel, embeddingModel: i.embeddingModel, storageBackend: 'milvus', executionMode: 'sync', maxRetries: 0 }));
  assert.deepEqual(subject.buildReferenceAskRequestBody(i), expected);
});

test('shared body extraction preserves original validator acceptance of escaped lone surrogates', () => {
  const i = { ...input(), question: '  original query\ud800  ' };
  const validated = validateAskInput({ ...i, storageBackend: 'milvus', executionMode: 'sync', maxRetries: 0 }, {
    NODE_ENV: 'test', MODEL_PROVIDER: 'custom', CUSTOM_LLM_MODEL: i.llmModel,
    EMBEDDING_PROVIDER: 'custom', CUSTOM_EMBEDDING_MODEL: i.embeddingModel,
    RAG_ALLOWED_LLM_MODELS: i.llmModel, RAG_ALLOWED_EMBEDDING_MODELS: i.embeddingModel,
  });
  const expected = Buffer.from(JSON.stringify({ question: validated.question, topK: i.topK, corpusId: i.corpusId,
    llmModel: i.llmModel, embeddingModel: i.embeddingModel, storageBackend: 'milvus', executionMode: 'sync', maxRetries: 0 }));
  assert.deepEqual(subject.buildReferenceAskRequestBody(i), expected);
});

test('shared request builder rejects body-routing injection and original invalid topK', () => {
  assert.equal(typeof subject.buildReferenceAskRequestBody, 'function');
  for (const value of [{ ...input(), url: 'https://evil.test' }, { ...input(), headers: {} },
    { ...input(), maxRetries: 2 }, { ...input(), graphMode: 'active' }, { ...input(), topK: 51 }, { ...input(), corpusId: '../outside' }]) {
    assert.throws(() => subject.buildReferenceAskRequestBody(value));
  }
});

test('shared request builder does not execute caller getters or Proxy traps', () => {
  assert.equal(typeof subject.buildReferenceAskRequestBody, 'function');
  let hooks = 0; const trap = () => { hooks++; throw Error('RAW_BODY_SECRET'); };
  const getter = input(); Object.defineProperty(getter, 'question', { enumerable: true, get: trap });
  for (const value of [getter, new Proxy(input(), { get: trap, ownKeys: trap })]) assert.throws(() => subject.buildReferenceAskRequestBody(value));
  assert.equal(hooks, 0);
});

test('shared deployment contract preserves complete original scope arm model and parameter bindings', () => {
  const { d, plan, base } = deploymentFixture();
  assert.equal(subject.validateReferenceAskDeployment(d, plan, base), undefined);
  for (const mutate of [x => { x.scope.tenantId = 'other'; }, x => { x.rolloutMode = 'shadow'; },
    x => { x.models.llm = 'wrong'; }, x => { x.parameters.topK = 1; }, x => { x.origin = 'https://evil.test'; },
    x => { x.requestPlanHash = 'f'.repeat(64); }, x => { x.providerRegistrationHash = 'f'.repeat(64); }, x => { x.extra = true; }]) {
    const changed = structuredClone(d); mutate(changed);
    assert.throws(() => subject.validateReferenceAskDeployment(changed, plan, base));
  }
});

test('deployment snapshots reject side-effect carriers before reading their content', () => {
  assert.equal(typeof subject.validateReferenceAskDeployment, 'function');
  const { d, plan, base } = deploymentFixture(); let hooks = 0;
  const trap = () => { hooks++; throw Error('RAW_DEPLOYMENT_SECRET'); };
  const getter = structuredClone(d); Object.defineProperty(getter, 'origin', { enumerable: true, get: trap });
  assert.throws(() => subject.validateReferenceAskDeployment(getter, plan, base));
  assert.throws(() => subject.validateReferenceAskDeployment(new Proxy(d, { ownKeys: trap }), plan, base));
  assert.equal(hooks, 0);
});
