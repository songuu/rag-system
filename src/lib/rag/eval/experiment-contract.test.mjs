import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ resolve(s, c, next) { try { return next(s, c); } catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && s.startsWith('.') && !s.endsWith('.ts')) return next(s + '.ts', c); throw e;
} } });
const { createExperimentContract, validateExperimentContract, compareExperimentBindings } = await import('./experiment-contract.ts');
const dataset = () => ({ schemaVersion: 'rag-eval-dataset/v2', datasetId: 'reviewed', datasetVersion: '1',
  corpus: [{ evidenceId: 'a', documentId: 'doc', documentVersion: 'v1', tenantId: 't', corpusId: 'c', trustLevel: 'reviewed', source: 'a', content: '30 days' }],
  cases: [{ id: 'q', query: 'how long?', tags: ['human-reviewed'], scope: { tenantId: 't', corpusId: 'c', allowedTrustLevels: ['reviewed'] },
    allowedPolicies: ['milvus-2step'], allowedLanes: ['dense'], securityExpectations: { forbiddenEvidenceIds: [], forbiddenAnswerPatterns: ['PRIVATE_CANARY'] },
    goldEvidence: [{ evidenceId: 'a', relevance: 3, spans: [{ startOffset: 0, endOffset: 7 }] }], expectedAbstain: false,
    expectedAnswer: { referenceAnswer: '30 days', requiredFacts: [['30 days']] } }] });
const config = () => ({ implementationSha256: 'a'.repeat(64), promptSha256: 'b'.repeat(64),
  model: { provider: 'ollama', name: 'model', revision: 'digest-1', parameters: { temperature: 0 } },
  embedding: { provider: 'ollama', name: 'embedding', revision: 'digest-2', dimensions: 1024 },
  index: { id: 'index', revision: 'generation-1' }, retrieval: { topK: 3, similarityThreshold: 0.2 },
  rerank: { enabled: false, provider: 'none', model: 'none', revision: 'none', topN: 3 },
  context: { maxTokens: 2000 }, cache: { mode: 'disabled', identity: 'none' } });
const options = () => ({ review: { reviewer: 'reviewer-1', reviewedAt: '2026-01-01T00:00:00Z' }, configuration: config(), variablePaths: ['rerank'] });
test('binds audited dataset, corpus and complete config with tamper detection', () => {
  const d = dataset(), contract = createExperimentContract(d, options());
  assert.equal(validateExperimentContract(d, contract).configurationHash, contract.configurationHash);
  const changed = structuredClone(contract); changed.configuration.model.revision = 'other';
  assert.throws(() => validateExperimentContract(d, changed), /hash|binding/i);
  d.corpus[0].content += '!'; assert.throws(() => validateExperimentContract(d, contract), /dataset|corpus/i);
});
test('rejects missing audit, unreviewed cases, unknown versions and blanket comparison exemptions', () => {
  for (const mutation of [d => { d.cases[0].tags = ['needs-review']; }, d => { d.corpus[0].documentVersion = 'unknown'; }]) {
    const d = dataset(); mutation(d); assert.throws(() => createExperimentContract(d, options()));
  }
  assert.throws(() => createExperimentContract(dataset(), { ...options(), variablePaths: ['configuration'] }));
  assert.throws(() => createExperimentContract(dataset(), { ...options(), review: { reviewer: '', reviewedAt: 'invalid' } }));
});
test('only explicitly varied factors may differ in a paired experiment', () => {
  const a = createExperimentContract(dataset(), options());
  const bOptions = options(); bOptions.configuration.rerank.enabled = true;
  const b = createExperimentContract(dataset(), bOptions);
  assert.deepEqual(compareExperimentBindings(a, b), []);
  const cOptions = options(); cOptions.configuration.model.revision = 'changed';
  assert.ok(compareExperimentBindings(a, createExperimentContract(dataset(), cOptions)).length);
});
