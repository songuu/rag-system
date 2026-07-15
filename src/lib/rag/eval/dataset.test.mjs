import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeImport(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { createRagEvalDatasetHash, parseRagEvalDataset, stableStringify } = await import(
  './dataset.ts'
);

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/e1a-dense-v1.json', import.meta.url), 'utf8')
);
const fixtureV2 = JSON.parse(
  await readFile(new URL('./fixtures/e1b-canonical-v2.json', import.meta.url), 'utf8')
);

test('parseRagEvalDataset accepts the E1a fixture and preserves its coverage groups', () => {
  const dataset = parseRagEvalDataset(fixture);

  assert.equal(dataset.corpus.length, 12);
  assert.equal(dataset.cases.length, 12);
  assert.equal(dataset.cases.filter(evalCase => evalCase.expectedAbstain).length, 2);
  assert.deepEqual(
    new Set(dataset.cases.flatMap(evalCase => evalCase.tags)),
    new Set([
      'identifier',
      'exact',
      'semantic',
      'paraphrase',
      'multi-hop',
      'cross-document',
      'global',
      'count',
      'architecture',
      'unanswerable',
      'abstain',
      'conflict',
      'temporal-noise',
    ])
  );
});

test('dataset hashing is stable across object key order', () => {
  const dataset = parseRagEvalDataset(fixture);
  const reordered = {
    cases: dataset.cases,
    corpus: dataset.corpus,
    datasetVersion: dataset.datasetVersion,
    datasetId: dataset.datasetId,
    schemaVersion: dataset.schemaVersion,
  };

  assert.equal(stableStringify({ beta: 2, alpha: 1 }), stableStringify({ alpha: 1, beta: 2 }));
  assert.equal(createRagEvalDatasetHash(dataset), createRagEvalDatasetHash(reordered));
  assert.match(createRagEvalDatasetHash(dataset), /^[a-f0-9]{64}$/);
});

test('parseRagEvalDataset rejects duplicate evidence IDs with a contextual path', () => {
  const invalid = structuredClone(fixture);
  invalid.corpus[1].evidenceId = invalid.corpus[0].evidenceId;

  assert.throws(
    () => parseRagEvalDataset(invalid),
    /\$\.corpus\[1\]\.evidenceId: duplicate value/
  );
});

test('parseRagEvalDataset rejects gold evidence that is not present in the corpus', () => {
  const invalid = structuredClone(fixture);
  invalid.cases[0].goldEvidence[0].evidenceId = 'missing-evidence';

  assert.throws(
    () => parseRagEvalDataset(invalid),
    /references unknown corpus evidence missing-evidence/
  );
});

test('parseRagEvalDataset rejects contradictory abstain expectations', () => {
  const invalid = structuredClone(fixture);
  invalid.cases[0].expectedAbstain = true;

  assert.throws(
    () => parseRagEvalDataset(invalid),
    /goldEvidence: must be empty when expectedAbstain is true/
  );
});

test('parseRagEvalDataset rejects empty required-fact alternatives', () => {
  const invalid = structuredClone(fixture);
  invalid.cases[0].expectedAnswer.requiredFacts[0] = [];

  assert.throws(
    () => parseRagEvalDataset(invalid),
    /expectedAnswer\.requiredFacts\[0\]: must not be empty/
  );
});

test('parseRagEvalDataset accepts E1b V2 canonical scope and gold spans', () => {
  const dataset = parseRagEvalDataset(fixtureV2);
  assert.equal(dataset.schemaVersion, 'rag-eval-dataset/v2');
  assert.equal(dataset.cases.length, 8);
  assert.equal(dataset.cases[0].scope.tenantId, 'tenant-a');
  assert.deepEqual(dataset.cases[0].goldEvidence[0].spans, [
    { startOffset: 17, endOffset: 28 },
  ]);
  assert.equal(dataset.corpus.find(item => item.evidenceId === 'quarantined-poison').trustLevel, 'quarantined');
});

test('E1b V2 rejects an out-of-bounds gold span', () => {
  const invalid = structuredClone(fixtureV2);
  invalid.cases[0].goldEvidence[0].spans[0].endOffset = 999;
  assert.throws(
    () => parseRagEvalDataset(invalid),
    /endOffset: must not exceed evidence content length/
  );
});

test('E1b V2 requires expected facts for every answerable case', () => {
  const invalid = structuredClone(fixtureV2);
  delete invalid.cases[0].expectedAnswer;
  assert.throws(
    () => parseRagEvalDataset(invalid),
    /expectedAnswer: must be present for an answerable V2 case/
  );
});

test('E1b V2 requires at least one security canary per case', () => {
  const invalid = structuredClone(fixtureV2);
  invalid.cases[0].securityExpectations = {
    forbiddenEvidenceIds: [],
    forbiddenAnswerPatterns: [],
  };
  assert.throws(
    () => parseRagEvalDataset(invalid),
    /must define at least one forbidden evidence id or answer pattern/
  );
});

test('E1b V2 rejects unknown forbidden evidence and quarantined gold', () => {
  const unknownForbidden = structuredClone(fixtureV2);
  unknownForbidden.cases[0].securityExpectations.forbiddenEvidenceIds[0] = 'missing';
  assert.throws(
    () => parseRagEvalDataset(unknownForbidden),
    /references unknown corpus evidence missing/
  );

  const quarantinedGold = structuredClone(fixtureV2);
  quarantinedGold.cases[0].goldEvidence[0].evidenceId = 'quarantined-poison';
  quarantinedGold.cases[0].goldEvidence[0].spans = [{ startOffset: 0, endOffset: 6 }];
  assert.throws(
    () => parseRagEvalDataset(quarantinedGold),
    /non-quarantined evidence allowed by the case trust scope/
  );
});

function isRelativeImport(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
