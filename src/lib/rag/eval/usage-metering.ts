export type EvalTokenMeasurement = 'provider' | 'partial' | 'estimated' | 'unavailable';
export interface EvalTokenObservation {
  measurement: EvalTokenMeasurement;
  inputTokens?: number;
  outputTokens?: number;
}
export interface EvalCostObservation {
  measurement: 'provider' | 'configured-estimate' | 'unavailable';
  value?: number;
  pricingVersion?: string;
  tokenMeasurement?: 'provider' | 'estimated';
}
export interface EvalTokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  version: string;
}
type CallStage = 'embedding' | 'generation' | 'rerank';
type LatencyStage = 'retrieval' | 'generation' | 'rerank' | 'total';
export interface EvalUsageObservation {
  tokens: EvalTokenObservation;
  calls?: Partial<Record<CallStage, number>>;
  latencyMs?: Partial<Record<LatencyStage, number>>;
  costsUsd?: Partial<Record<CallStage, EvalCostObservation>>;
}
export interface EvalObservedTotal {
  value: number | null;
  observedCount: number;
  coverageRatio: number;
}
export interface EvalObservedCostTotal extends EvalObservedTotal {
  measurement: EvalCostObservation['measurement'] | 'mixed';
}
export interface EvalObservedLatency {
  sum: number | null;
  p50: number | null;
  p95: number | null;
  observedCount: number;
  coverageRatio: number;
}
export interface EvalUsageSummary {
  observations: number;
  completeTokenCoverageRatio: number;
  providerTokenCoverageRatio: number;
  tokenMeasurementCounts: Record<EvalTokenMeasurement, number>;
  tokens: Record<Exclude<EvalTokenMeasurement, 'unavailable'>, {
    input: EvalObservedTotal; output: EvalObservedTotal;
  }>;
  calls: Record<CallStage, EvalObservedTotal>;
  latencyMs: Record<LatencyStage, EvalObservedLatency>;
  costUsd: Record<CallStage | 'endToEnd', EvalObservedCostTotal>;
}

const CALL_STAGES = ['embedding', 'generation', 'rerank'] as const;
const LATENCY_STAGES = ['retrieval', 'generation', 'rerank', 'total'] as const;

/** Unknown observations must remain absent: zero is a measurement, not a fallback. */
export function validateEvalUsageObservation(input: unknown): EvalUsageObservation {
  const value = record(input, 'observation', ['tokens', 'calls', 'latencyMs', 'costsUsd']);
  const result: EvalUsageObservation = {
    tokens: value.tokens === undefined ? { measurement: 'unavailable' } : tokens(value.tokens),
  };
  if (value.calls !== undefined) {
    const calls = record(value.calls, 'calls', CALL_STAGES);
    result.calls = {};
    for (const stage of CALL_STAGES) {
      if (calls[stage] !== undefined) result.calls[stage] = count(calls[stage], `calls.${stage}`);
    }
  }
  if (value.latencyMs !== undefined) {
    const latency = record(value.latencyMs, 'latencyMs', LATENCY_STAGES);
    result.latencyMs = {};
    for (const stage of LATENCY_STAGES) {
      if (latency[stage] !== undefined) result.latencyMs[stage] = nonnegative(latency[stage], `latencyMs.${stage}`);
    }
    for (const stage of LATENCY_STAGES) {
      if (stage !== 'total' && result.latencyMs[stage] !== undefined && result.latencyMs.total !== undefined
        && result.latencyMs[stage]! > result.latencyMs.total) fail(`latencyMs.${stage}`, 'exceeds observed total wall time');
    }
  }
  if (value.costsUsd !== undefined) {
    const costs = record(value.costsUsd, 'costsUsd', CALL_STAGES);
    result.costsUsd = {};
    for (const stage of CALL_STAGES) {
      if (costs[stage] !== undefined) result.costsUsd[stage] = cost(costs[stage], `costsUsd.${stage}`);
    }
  }
  return result;
}

/** This estimates generation only; embedding and reranking are separate charges. */
export function estimateEvalGenerationCost(input: unknown, pricing?: EvalTokenPricing): EvalCostObservation {
  const usage = tokens(input);
  if (pricing !== undefined) {
    record(pricing, 'pricing', ['inputUsdPerMillion', 'outputUsdPerMillion', 'version']);
    nonnegative(pricing.inputUsdPerMillion, 'pricing.inputUsdPerMillion');
    nonnegative(pricing.outputUsdPerMillion, 'pricing.outputUsdPerMillion');
    nonempty(pricing.version, 'pricing.version');
  }
  if (!pricing || usage.measurement === 'partial' || usage.measurement === 'unavailable') {
    return { measurement: 'unavailable' };
  }
  const value = nonnegative((usage.inputTokens! * pricing.inputUsdPerMillion
    + usage.outputTokens! * pricing.outputUsdPerMillion) / 1_000_000, 'generation cost estimate');
  return { measurement: 'configured-estimate', value, pricingVersion: pricing.version, tokenMeasurement: usage.measurement };
}

export function aggregateEvalUsage(inputs: readonly unknown[]): EvalUsageSummary {
  if (!Array.isArray(inputs)) fail('observations', 'must be an array');
  const observations = inputs.map(validateEvalUsageObservation);
  const population = observations.length;
  const tokenMeasurementCounts = { provider: 0, partial: 0, estimated: 0, unavailable: 0 };
  for (const item of observations) tokenMeasurementCounts[item.tokens.measurement]++;
  const tokenTotals = (measurement: Exclude<EvalTokenMeasurement, 'unavailable'>) => ({
    input: total(observations.map(item => item.tokens.measurement === measurement ? item.tokens.inputTokens : undefined), population),
    output: total(observations.map(item => item.tokens.measurement === measurement ? item.tokens.outputTokens : undefined), population),
  });
  const calls = (stage: CallStage) => total(observations.map(item => item.calls?.[stage]), population);
  const latency = (stage: LatencyStage): EvalObservedLatency => {
    const values = observations.flatMap(item => item.latencyMs?.[stage] === undefined ? [] : [item.latencyMs[stage]!]).sort((a, b) => a - b);
    const sum = total(values, population);
    return { sum: sum.value, p50: percentile(values, 0.5), p95: percentile(values, 0.95), observedCount: sum.observedCount, coverageRatio: sum.coverageRatio };
  };
  const stageCosts = (stage: CallStage) => costTotal(observations.map(item => item.costsUsd?.[stage]), population);
  const endToEnd = observations.map(item => {
    const values = CALL_STAGES.map(stage => item.costsUsd?.[stage]);
    // Unknown charges must never turn a generation-only estimate into a full-chain cost.
    if (values.some(value => value?.value === undefined)) return undefined;
    return { value: values.reduce((sum, value) => sum + value!.value!, 0),
      measurement: values.every(value => value!.measurement === 'provider') ? 'provider' as const : 'configured-estimate' as const };
  });
  return {
    observations: population,
    completeTokenCoverageRatio: ratio(tokenMeasurementCounts.provider + tokenMeasurementCounts.estimated, population),
    providerTokenCoverageRatio: ratio(tokenMeasurementCounts.provider, population), tokenMeasurementCounts,
    tokens: { provider: tokenTotals('provider'), partial: tokenTotals('partial'), estimated: tokenTotals('estimated') },
    calls: { embedding: calls('embedding'), generation: calls('generation'), rerank: calls('rerank') },
    latencyMs: { retrieval: latency('retrieval'), generation: latency('generation'), rerank: latency('rerank'), total: latency('total') },
    costUsd: { embedding: stageCosts('embedding'), generation: stageCosts('generation'), rerank: stageCosts('rerank'), endToEnd: costTotal(endToEnd, population) },
  };
}

function tokens(input: unknown): EvalTokenObservation {
  const value = record(input, 'tokens', ['measurement', 'inputTokens', 'outputTokens']);
  if (!['provider', 'partial', 'estimated', 'unavailable'].includes(value.measurement as string)) fail('tokens.measurement', 'must disclose provider, partial, estimated, or unavailable');
  const measurement = value.measurement as EvalTokenMeasurement;
  const result: EvalTokenObservation = { measurement };
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    if (value[key] !== undefined) result[key] = count(value[key], `tokens.${key}`);
    else if (measurement === 'provider' || measurement === 'estimated') fail(`tokens.${key}`, `is required for ${measurement} measurement`);
  }
  if (measurement === 'unavailable' && (result.inputTokens !== undefined || result.outputTokens !== undefined)) fail('tokens', 'unavailable measurement cannot carry token values');
  if (measurement === 'partial' && result.inputTokens === undefined && result.outputTokens === undefined) fail('tokens', 'partial measurement requires at least one observed token value');
  return result;
}

function cost(input: unknown, path: string): EvalCostObservation {
  const value = record(input, path, ['measurement', 'value', 'pricingVersion', 'tokenMeasurement']);
  if (!['provider', 'configured-estimate', 'unavailable'].includes(value.measurement as string)) fail(`${path}.measurement`, 'must disclose provider, configured-estimate, or unavailable');
  const measurement = value.measurement as EvalCostObservation['measurement'];
  if (measurement === 'unavailable') {
    if (value.value !== undefined || value.pricingVersion !== undefined || value.tokenMeasurement !== undefined) fail(path, 'unavailable measurement cannot carry cost values or pricing provenance');
    return { measurement };
  }
  const result: EvalCostObservation = { measurement, value: nonnegative(value.value, `${path}.value`) };
  if (value.pricingVersion !== undefined) result.pricingVersion = nonempty(value.pricingVersion, `${path}.pricingVersion`);
  if (value.tokenMeasurement !== undefined) {
    if (measurement !== 'configured-estimate' || !['provider', 'estimated'].includes(value.tokenMeasurement as string)) fail(`${path}.tokenMeasurement`, 'must describe complete tokens used for a configured estimate');
    result.tokenMeasurement = value.tokenMeasurement as 'provider' | 'estimated';
  }
  return result;
}

function total(input: readonly (number | undefined)[], population: number): EvalObservedTotal {
  const values = input.filter((value): value is number => value !== undefined);
  const value = values.length ? nonnegative(values.reduce((sum, item) => sum + item, 0), 'aggregate total') : null;
  return { value, observedCount: values.length, coverageRatio: ratio(values.length, population) };
}
function costTotal(input: readonly (EvalCostObservation | undefined)[], population: number): EvalObservedCostTotal {
  const measured = input.filter((item): item is EvalCostObservation => item?.value !== undefined);
  const measurement = new Set(measured.map(item => item.measurement));
  return { ...total(input.map(item => item?.value), population), measurement: measurement.size === 0 ? 'unavailable'
    : measurement.size > 1 ? 'mixed' : measured[0].measurement };
}
function percentile(sorted: readonly number[], probability: number): number | null {
  return sorted.length ? sorted[Math.ceil(sorted.length * probability) - 1] : null;
}
function ratio(numerator: number, denominator: number): number { return denominator ? numerator / denominator : 0; }
function record(input: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(path, 'must be an object');
  for (const key of Object.keys(input)) if (!keys.includes(key)) fail(`${path}.${key}`, 'is not a supported measurement');
  return input as Record<string, unknown>;
}
function nonnegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(path, 'must be a finite nonnegative number');
  return value;
}
function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(path, 'must be a nonnegative safe integer');
  return value;
}
function nonempty(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'must be a nonempty string');
  return value;
}
function fail(path: string, message: string): never { throw new Error(`[rag-eval usage] ${path}: ${message}`); }
