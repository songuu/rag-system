import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArguments } from './prepare-rag-regression.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./prepare-rag-regression.mjs', import.meta.url));
function source() { return { schemaVersion: 'rag-feedback-export/v1', datasetId: 'feedback', datasetVersion: '1',
  snapshotId: 'support', snapshotVersion: '3',
  corpus: [{ evidenceId: 'e1', documentId: 'd1', documentVersion: '3', tenantId: 't1', corpusId: 'c1',
    trustLevel: 'reviewed', source: 'policy.txt', content: 'Refund within 30 days.' }],
  traces: [{ traceId: 't1', query: 'Refund deadline?', answer: '60 days', evidenceIds: ['e1'],
    snapshotId: 'support', snapshotVersion: '3', scope: { tenantId: 't1', corpusId: 'c1', allowedTrustLevels: ['reviewed'] },
    feedback: { value: false, comment: 'Wrong deadline' } }] }; }

test('CLI requires explicit mode and distinct local input/output paths', () => {
  for (const args of [[], ['prepare'], ['prepare', '--input', 'a'], ['auto', '--input', 'a', '--output', 'b'],
    ['prepare', '--input', 'a', '--input', 'b', '--output', 'c'],
    ['prepare', '--input', 'a', '--output', 'a'], ['export', '--input', 'a', '--output', 'b', '--annotations', 'c'],
    ['review', '--input', 'a', '--output', 'b'], ['prepare', '--input', 'a', '--output', 'b', '--force'],
    ['prepare', '--input', 'https://example.com/input.json', '--output', 'b']]) {
    assert.throws(() => parseArguments(args));
  }
  assert.equal(parseArguments(['--help']).help, true);
  assert.equal(parseArguments(['prepare', '--input', 'a', '--output', 'b']).mode, 'prepare');
});

test('CLI prepares unknown labels, requires explicit review and emits parser-compatible dataset', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rag-regression-'));
  const input = path.join(directory, 'feedback.json'), draftPath = path.join(directory, 'draft.json');
  const annotations = path.join(directory, 'annotations.json'), reviewed = path.join(directory, 'reviewed.json');
  const output = path.join(directory, 'regression.json');
  await writeFile(input, JSON.stringify(source()));
  await execute(process.execPath, [script, 'prepare', '--input', input, '--output', draftPath]);
  const draft = JSON.parse(await readFile(draftPath, 'utf8'));
  assert.equal(draft.cases[0].annotation, null);
  await assert.rejects(execute(process.execPath, [script, 'export', '--input', draftPath, '--output', output]));
  await writeFile(annotations, JSON.stringify({ schemaVersion: 'rag-feedback-review/v1', reviews: [{
    caseId: draft.cases[0].id, reviewer: 'human-a', reviewedAt: '2026-11-05T10:00:00.000Z',
    annotation: { disposition: 'answer', goldEvidence: [{ evidenceId: 'e1', relevance: 3,
      spans: [{ startOffset: 0, endOffset: 21 }] }],
      expectedAnswer: { referenceAnswer: 'Within 30 days.', requiredFacts: [['30 days']] },
      allowedPolicies: ['milvus-2step'], allowedLanes: ['dense-vector-required'],
      securityExpectations: { forbiddenEvidenceIds: [], forbiddenAnswerPatterns: ['private-data-canary'] } },
  }] }));
  await execute(process.execPath, [script, 'review', '--input', draftPath, '--annotations', annotations, '--output', reviewed]);
  await execute(process.execPath, [script, 'export', '--input', reviewed, '--output', output]);
  const dataset = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(dataset.schemaVersion, 'rag-eval-dataset/v2');
  assert.equal(dataset.cases[0].expectedAnswer.referenceAnswer, 'Within 30 days.');
  assert.equal(dataset.regressionProvenance.cases[0].reviewer, 'human-a');
  assert.equal(JSON.parse(await readFile(draftPath, 'utf8')).cases[0].review, null);
  assert.equal(JSON.parse(await readFile(input, 'utf8')).traces[0].answer, '60 days');
});

test('CLI refuses overwriting existing outputs and does not echo malformed private input', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rag-regression-io-'));
  const input = path.join(directory, 'input.json'), output = path.join(directory, 'output.json');
  await writeFile(input, JSON.stringify(source()));
  await writeFile(output, 'keep existing file');
  await assert.rejects(execute(process.execPath, [script, 'prepare', '--input', input, '--output', output]));
  assert.equal(await readFile(output, 'utf8'), 'keep existing file');
  await writeFile(input, '{"private":"SECRET_PRIVATE_DATA"');
  await assert.rejects(execute(process.execPath, [script, 'prepare', '--input', input, '--output', path.join(directory, 'other.json')]),
    error => !String(error.stdout + error.stderr).includes('SECRET_PRIVATE_DATA'));
});
