import assert from 'node:assert/strict';
import test from 'node:test';

const {
  validateEvalUsageObservation,
  estimateEvalGenerationCost,
  aggregateEvalUsage,
} = await import('./usage-metering.ts');

const provider = { measurement: 'provider', inputTokens: 1_000, outputTokens: 200 };
const unavailable = { measurement: 'unavailable' };

test('missing calls, costs, and stage times remain unavailable rather than zero', () => {
  const summary = aggregateEvalUsage([{ tokens: unavailable }]);
  assert.equal(summary.calls.embedding.value, null);
  assert.equal(summary.calls.generation.value, null);
  assert.equal(summary.costUsd.endToEnd.value, null);
  assert.equal(summary.latencyMs.total.sum, null);
  assert.equal(summary.calls.embedding.coverageRatio, 0);
  assert.equal(summary.providerTokenCoverageRatio, 0);
});

test('provider and estimated token observations require a complete pair', () => {
  for (const measurement of ['provider', 'estimated']) {
    assert.throws(() => validateEvalUsageObservation({ tokens: { measurement, inputTokens: 1 } }), /outputTokens/);
  }
  assert.throws(() => validateEvalUsageObservation({ tokens: { measurement: 'unavailable', inputTokens: 0 } }), /unavailable/);
  assert.throws(() => validateEvalUsageObservation({ tokens: { measurement: 'partial' } }), /partial/);
  assert.deepEqual(validateEvalUsageObservation({ tokens: provider }).tokens, provider);
});

test('zero counts are valid only when explicitly observed', () => {
  const summary = aggregateEvalUsage([{ tokens: { measurement: 'provider', inputTokens: 0, outputTokens: 0 }, calls: { generation: 0 } }]);
  assert.equal(summary.calls.generation.value, 0);
  assert.equal(summary.calls.generation.coverageRatio, 1);
  assert.equal(summary.tokens.provider.input.value, 0);
  assert.equal(summary.calls.embedding.value, null);
});

test('partial provider tokens stay in their own population and cannot produce generation cost', () => {
  const tokens = { measurement: 'partial', inputTokens: 200 };
  const summary = aggregateEvalUsage([{ tokens }]);
  assert.equal(summary.tokens.partial.input.value, 200);
  assert.equal(summary.tokens.partial.output.value, null);
  assert.equal(summary.tokens.provider.input.value, null);
  assert.equal(summary.completeTokenCoverageRatio, 0);
  assert.deepEqual(estimateEvalGenerationCost(tokens, { inputUsdPerMillion: 1, outputUsdPerMillion: 2, version: 'prices-v1' }), { measurement: 'unavailable' });
});

test('per-million pricing produces an explicitly scoped generation estimate', () => {
  const estimate = estimateEvalGenerationCost(provider, { inputUsdPerMillion: 2, outputUsdPerMillion: 5, version: 'prices-v1' });
  assert.equal(estimate.measurement, 'configured-estimate');
  assert.equal(estimate.value, 0.003);
  assert.equal(estimate.pricingVersion, 'prices-v1');
  assert.equal(estimate.tokenMeasurement, 'provider');
  const summary = aggregateEvalUsage([{ tokens: provider, costsUsd: { generation: estimate } }]);
  assert.equal(summary.costUsd.generation.value, 0.003);
  assert.equal(summary.costUsd.endToEnd.value, null);
  assert.equal(summary.costUsd.endToEnd.coverageRatio, 0);
});

test('estimated token cost discloses estimated tokens and unavailable pricing never creates zero cost', () => {
  const tokens = { ...provider, measurement: 'estimated' };
  assert.equal(estimateEvalGenerationCost(tokens, { inputUsdPerMillion: 2, outputUsdPerMillion: 5, version: 'v1' }).tokenMeasurement, 'estimated');
  assert.deepEqual(estimateEvalGenerationCost(provider), { measurement: 'unavailable' });
  assert.deepEqual(estimateEvalGenerationCost(unavailable), { measurement: 'unavailable' });
});

test('only complete stage costs produce an end-to-end total with its own coverage', () => {
  const complete = { tokens: provider, costsUsd: {
    embedding: { measurement: 'provider', value: 0.01 },
    generation: { measurement: 'configured-estimate', value: 0.02 },
    rerank: { measurement: 'provider', value: 0 },
  } };
  const summary = aggregateEvalUsage([complete, { tokens: unavailable }]);
  assert.equal(summary.costUsd.endToEnd.value, 0.03);
  assert.equal(summary.costUsd.endToEnd.measurement, 'configured-estimate');
  assert.equal(summary.costUsd.endToEnd.coverageRatio, 0.5);
  assert.equal(summary.costUsd.generation.coverageRatio, 0.5);
  assert.throws(() => validateEvalUsageObservation({ tokens: provider, costsUsd: { total: { measurement: 'provider', value: 0.03 } } }), /costsUsd.total/);
});

test('latency total is observed wall time and never the sum of overlapping stages', () => {
  const summary = aggregateEvalUsage([{ tokens: unavailable, latencyMs: { total: 10, retrieval: 8, generation: 8, rerank: 7 } }]);
  assert.equal(summary.latencyMs.total.sum, 10);
  assert.equal(summary.latencyMs.total.p95, 10);
  assert.equal(summary.latencyMs.retrieval.sum, 8);
  const absent = aggregateEvalUsage([{ tokens: unavailable, latencyMs: { retrieval: 8, generation: 8 } }]);
  assert.equal(absent.latencyMs.total.sum, null);
});

test('aggregate populations disclose provider, partial and estimated coverage separately', () => {
  const summary = aggregateEvalUsage([
    { tokens: provider, calls: { generation: 1 }, latencyMs: { total: 10 } },
    { tokens: { measurement: 'estimated', inputTokens: 800, outputTokens: 100 }, calls: { generation: 2 }, latencyMs: { total: 20 } },
    { tokens: { measurement: 'partial', outputTokens: 50 }, latencyMs: { total: 30 } },
    { tokens: unavailable },
  ]);
  assert.equal(summary.tokens.provider.input.value, 1_000);
  assert.equal(summary.tokens.estimated.input.value, 800);
  assert.equal(summary.tokens.partial.output.value, 50);
  assert.equal(summary.providerTokenCoverageRatio, 0.25);
  assert.equal(summary.completeTokenCoverageRatio, 0.5);
  assert.equal(summary.calls.generation.value, 3);
  assert.equal(summary.calls.generation.coverageRatio, 0.5);
  assert.equal(summary.latencyMs.total.coverageRatio, 0.75);
  assert.equal(summary.latencyMs.total.p50, 20);
  assert.equal(summary.latencyMs.total.p95, 30);
});

test('nonfinite, negative, fractional counts and unit mistakes fail with measurement context', () => {
  for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateEvalUsageObservation({ tokens: { ...provider, inputTokens: value } }), /tokens.inputTokens/);
    assert.throws(() => validateEvalUsageObservation({ tokens: unavailable, calls: { generation: value } }), /calls.generation/);
  }
  for (const value of [-1, NaN, Infinity, '10']) {
    assert.throws(() => validateEvalUsageObservation({ tokens: unavailable, latencyMs: { total: value } }), /latencyMs.total/);
    assert.throws(() => validateEvalUsageObservation({ tokens: unavailable, costsUsd: { generation: { measurement: 'provider', value } } }), /costsUsd.generation/);
  }
  assert.throws(() => validateEvalUsageObservation({ tokens: unavailable, latencyMs: { total: 1, retrieval: 2 } }), /exceeds.*total/);
  assert.throws(() => validateEvalUsageObservation({ tokens: unavailable, latencyMs: { totalSeconds: 1 } }), /latencyMs.totalSeconds/);
  assert.throws(() => estimateEvalGenerationCost(provider, { inputUsdPerMillion: -1, outputUsdPerMillion: 2, version: 'v1' }), /inputUsdPerMillion/);
});

test('unavailable costs cannot carry a numeric value and mixed accounting stays visible', () => {
  assert.throws(() => validateEvalUsageObservation({ tokens: provider, costsUsd: { generation: { measurement: 'unavailable', value: 0 } } }), /unavailable/);
  const summary = aggregateEvalUsage([
    { tokens: provider, costsUsd: { generation: { measurement: 'provider', value: 1 } } },
    { tokens: provider, costsUsd: { generation: { measurement: 'configured-estimate', value: 2 } } },
  ]);
  assert.equal(summary.costUsd.generation.measurement, 'mixed');
});

test('empty population remains unmeasured and input snapshots are detached', () => {
  const summary = aggregateEvalUsage([]);
  assert.equal(summary.observations, 0);
  assert.equal(summary.costUsd.endToEnd.value, null);
  assert.equal(summary.completeTokenCoverageRatio, 0);
  const input = { tokens: { ...provider }, calls: { generation: 1 } };
  const observation = validateEvalUsageObservation(input);
  input.tokens.inputTokens = 9;
  input.calls.generation = 99;
  assert.equal(observation.tokens.inputTokens, 1_000);
  assert.equal(observation.calls.generation, 1);
});
