import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createPresentationReport as report } from './report-presentation.test-support.mjs';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)) return next(specifier + '.ts', context);
    throw error;
  }
} });
const { parseRagEvalArtifact, compareRagEvalReports, describeEvalProvenance } = await import('./report-presentation.ts');

function parsed(value) { return parseRagEvalArtifact(JSON.stringify(value)).reports[0]; }

test('import recomputes aggregate metrics from cases and preserves missing measurements', () => {
  const result = parsed(report());
  assert.equal(result.summary.meanRecallAtK, 0.5);
  assert.equal(result.summary.citation.meanCoverage, null);
  assert.equal(result.summary.tokens.inputTotal, null);
  assert.equal(result.summary.costUsd.total, null);
});

test('matrix and scoped-agent artifacts import their individual runs with a usable baseline', () => {
  const second = report({ runId: 'candidate', target: { id: 'rerank' } });
  const matrix = parseRagEvalArtifact(JSON.stringify({ schemaVersion: 'rag-eval-matrix/v1', baselineTargetId: 'rerank', targets: [
    { report: report() }, { report: second },
  ] }));
  assert.equal(matrix.baselineRunId, 'candidate');
  assert.equal(matrix.reports.length, 2);
  assert.equal(parseRagEvalArtifact(JSON.stringify({ schemaVersion: 'scoped-agent-eval/v1', reports: [report(), second] })).reports.length, 2);
});

test('paired comparison shows ranking gain separately from unchanged recall and latency cost', () => {
  const baseline = parsed(report());
  const candidate = structuredClone(baseline);
  candidate.runId = 'candidate';
  candidate.cases[0].retrieval.ndcgAtK = 0.9;
  candidate.cases[0].usage.totalLatencyMs = 50;
  const result = compareRagEvalReports(baseline, parsed(candidate));
  assert.deepEqual(result.issues, []);
  assert.equal(result.metrics.find(item => item.id === 'recall').delta, 0);
  assert.equal(result.metrics.find(item => item.id === 'ndcg').delta, 0.5);
  assert.equal(result.metrics.find(item => item.id === 'latency').delta, 20);
  assert.equal(result.metrics.find(item => item.id === 'cost').delta, null);
  assert.equal(result.cases[0].status, 'improved');
});

test('different datasets, topK, case sets, provenance or failed executions cannot imply comparable gains', () => {
  const baseline = parsed(report());
  for (const mutate of [
    item => { item.dataset.sha256 = 'b'.repeat(64); },
    item => { item.configuration.topK = 10; },
    item => { item.cases[0].caseId = 'other'; },
    item => { item.metadata.productionQualityMeasured = true; },
    item => { item.cases[0] = { caseId: 'q1', status: 'failed', error: 'timeout' }; },
  ]) {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    const result = compareRagEvalReports(baseline, parsed(candidate));
    assert.ok(result.issues.length > 0);
    assert.ok(result.metrics.every(item => item.delta === null));
  }
});

test('different metric coverage blocks that metric delta and regressions take priority', () => {
  const baseline = parsed(report());
  const candidate = structuredClone(baseline);
  candidate.cases[0].retrieval.recallAtK = 0;
  candidate.cases[0].answerMetrics.requiredFactCoverage = null;
  const result = compareRagEvalReports(baseline, parsed(candidate));
  assert.equal(result.cases[0].status, 'regressed');
  assert.equal(result.metrics.find(item => item.id === 'facts').delta, null);
  assert.match(result.metrics.find(item => item.id === 'facts').note, /标注|覆盖/);
});

test('malformed numbers, duplicate identities and unknown artifact versions are rejected', () => {
  for (const mutate of [
    item => { item.schemaVersion = 'unknown'; },
    item => { item.cases[0].retrieval.recallAtK = 2; },
    item => { item.cases.push(item.cases[0]); },
    item => { item.cases[0].evidence.push(item.cases[0].evidence[0]); },
  ]) {
    const candidate = report(); mutate(candidate);
    assert.throws(() => parsed(candidate), /评测|报告/);
  }
  assert.throws(() => parseRagEvalArtifact('{bad'), /JSON/);
});

test('fixture metadata wins over a claimed production flag and unknown provenance stays unknown', () => {
  const fixture = parsed(report({ metadata: { productionQualityMeasured: true, retrieval: 'deterministic-scoped-lexical-fixture' } }));
  assert.equal(describeEvalProvenance(fixture).kind, 'fixture');
  assert.equal(describeEvalProvenance(parsed(report({ metadata: {} }))).kind, 'unknown');
});

test('unavailable or partial usage cannot masquerade as complete measured totals', () => {
  for (const tokenMeasurement of ['unavailable', 'partial']) {
    const value = report();
    value.cases[0].usage = { ...value.cases[0].usage, tokenMeasurement, inputTokens: 10, outputTokens: 20 };
    assert.throws(() => parsed(value), /计量/);
  }
  const value = report();
  value.cases[0].usage.costUsd = 0.1;
  assert.throws(() => parsed(value), /计量/);
});

test('provider usage and estimates remain visible but do not produce interchangeable cost or token deltas', () => {
  const before = report();
  before.cases[0].usage = { ...before.cases[0].usage, inputTokens: 10, outputTokens: 20, tokenMeasurement: 'provider',
    costUsd: 0.1, costMeasurement: 'provider' };
  const after = structuredClone(before);
  after.cases[0].usage.tokenMeasurement = 'estimated';
  after.cases[0].usage.costMeasurement = 'configured-estimate';
  const result = compareRagEvalReports(parsed(before), parsed(after));
  for (const id of ['tokens', 'cost']) {
    const metric = result.metrics.find(item => item.id === id);
    assert.equal(metric.delta, null);
    assert.match(metric.note, /计量方式/);
  }
});
