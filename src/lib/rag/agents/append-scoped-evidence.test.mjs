import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});
const { composeEvidenceContextV2, estimateEvidenceContextTokens } = await import('../core/context-composer.ts');
const { appendScopedEvidence, snapshotScopedRetrievalContext } = await import('./append-scoped-evidence.ts');
const scope = { tenantId: 't', corpusId: 'c', enforceIsolation: true, allowedTrustLevels: ['reviewed'] };
const evidence = (id, content = 'Known scoped fact.') => ({
  id, content, tenantId: 't', corpusId: 'c', documentId: 'doc-' + id,
  documentVersion: 'v1', trustLevel: 'reviewed', laneId: 'dense',
  source: id + '.md', retrievalScore: 0.9,
});
const pack = values => composeEvidenceContextV2(values, { scope });
const append = (contextPack, values, overrides = {}) => appendScopedEvidence({
  contextPack, evidence: values, scope, maxContextTokens: 4000, maxEvidence: 40, ...overrides,
});

test('append preserves previous numbering and clipped initial content while adding new IDs', () => {
  const first = { ...evidence('first', 'Short clipped prefix.'), startOffset: 0, endOffset: 21, metadata: { contextTruncated: true } };
  const initial = pack([first]);
  const result = append(initial, [evidence('second')]);
  assert.equal(result.contextPack.context.startsWith(initial.context + '\n\n[2]'), true);
  assert.deepEqual(result.contextPack.includedEvidence[0], first);
  assert.deepEqual(result.addedEvidenceIds, ['second']);
  assert.equal(result.stopReason, 'sufficient');
});

test('append deduplicates identical identity despite different retrieval scores', () => {
  const first = evidence('first');
  const result = append(pack([first]), [{ ...first, retrievalScore: 0.1 }]);
  assert.deepEqual(result.addedEvidenceIds, []);
  assert.equal(result.stopReason, 'no_gain');
  assert.equal(result.contextPack.includedEvidence[0].retrievalScore, 0.9);
});

for (const conflict of [
  { content: 'Conflicting replacement.' }, { documentVersion: 'v2' },
  { documentId: 'other-document' }, { startOffset: 9 }, { endOffset: 40 },
  { source: 'other-source.md' }, { page: 4 }, { tenantId: 'other-tenant' },
]) {
  test('append fails closed for an existing ID identity/content/span conflict ' + JSON.stringify(Object.keys(conflict)), () => {
    const first = evidence('first');
    assert.throws(() => append(pack([first]), [{ ...first, ...conflict }]), error =>
      error.code === 'RAG_EVIDENCE_SCOPE_VIOLATION');
  });
}

test('append checks conflicts and scope even after the evidence count budget is full', () => {
  const first = evidence('first');
  assert.throws(() => append(pack([first]), [evidence('second'), { ...first, content: 'Poisoned.' }], {
    maxEvidence: 1,
  }), error => error.code === 'RAG_EVIDENCE_SCOPE_VIOLATION');
});

test('append shares the total token budget and never expands the initial evidence', () => {
  const initial = pack([evidence('first', 'Initial short prefix.')]);
  const maximum = estimateEvidenceContextTokens(initial.context) + 60;
  const result = append(initial, [evidence('second', 'Long new evidence. '.repeat(200))], { maxContextTokens: maximum });
  assert.equal(result.contextPack.context.startsWith(initial.context), true);
  assert.equal(result.contextPack.tokenEstimate <= maximum, true);
  assert.equal(result.contextPack.includedEvidence[0].content, 'Initial short prefix.');
  assert.equal(result.contextPack.truncated, true);
  assert.equal(result.stopReason, 'budget');
});

test('append clamps context and evidence budgets to 4000 tokens and 40 evidence rows', () => {
  const initial = pack([evidence('first')]);
  const result = append(initial, Array.from({ length: 45 }, (_, index) => evidence('next-' + index)), {
    maxContextTokens: 100_000, maxEvidence: 100,
  });
  assert.equal(result.contextPack.tokenEstimate <= 4000, true);
  assert.equal(result.contextPack.includedEvidence.length, 40);
  assert.equal(result.stopReason, 'budget');
});

test('snapshot clones and freezes complete evidence and scope before caller mutation', () => {
  const callerScope = structuredClone(scope);
  const initial = pack([{ ...evidence('first'), sectionPath: ['Chapter'], metadata: { nested: { safe: true } } }]);
  const snapshot = snapshotScopedRetrievalContext(initial, callerScope);
  callerScope.tenantId = 'changed';
  callerScope.allowedTrustLevels.push('external');
  initial.includedEvidence[0].metadata.nested.safe = false;
  initial.includedEvidence[0].sectionPath.push('Injected');
  assert.equal(snapshot.scope.tenantId, 't');
  assert.deepEqual(snapshot.scope.allowedTrustLevels, ['reviewed']);
  assert.deepEqual(snapshot.contextPack.includedEvidence[0].sectionPath, ['Chapter']);
  assert.equal(snapshot.contextPack.includedEvidence[0].metadata.nested.safe, true);
  assert.equal(Object.isFrozen(snapshot.contextPack.includedEvidence[0].metadata.nested), true);
  assert.equal(Object.isFrozen(snapshot.scope.allowedTrustLevels), true);
});

test('filling the evidence budget exactly does not claim evidence was truncated', () => {
  const result = append(pack([evidence('first')]), [evidence('second')], { maxEvidence: 2 });
  assert.equal(result.stopReason, 'budget');
  assert.equal(result.contextPack.truncated, false);
  assert.deepEqual(result.contextPack.excludedEvidenceIds, []);
});
