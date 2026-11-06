export interface RoutingEvalAction {
  intent: string;
  [key: string]: unknown;
}

export interface RoutingEvalCase {
  id: string;
  query: string;
  expectedRoute: 'direct' | 'rag';
  expectedActions: RoutingEvalAction[];
  requiresKnowledge: boolean;
  category?: string;
}

export interface RoutingEvalPrediction {
  route: 'direct' | 'rag';
  actions: RoutingEvalAction[];
}

/** Evaluate classification only: never execute actions or return input text. */
export async function evaluateRoutingCases(
  cases: readonly RoutingEvalCase[],
  predict: (query: string, index: number) => Promise<RoutingEvalPrediction | null>
) {
  let knowledgeTotal = 0;
  let knowledgeSkipped = 0;
  let predictedDirect = 0;
  let expectedDirect = 0;
  let correctDirect = 0;
  let routeCorrectDirect = 0;
  let ragCount = 0;
  let errors = 0;
  const failures: { id: string; reason: string }[] = [];
  const categories: Record<string, { total: number; incorrect: number; knowledgeSkipped: number }> = Object.create(null);
  const times: number[] = [];
  for (const [index, item] of cases.entries()) {
    if (item.requiresKnowledge) knowledgeTotal++;
    if (item.expectedRoute === 'direct') expectedDirect++;
    let prediction: RoutingEvalPrediction | null = null;
    const started = performance.now();
    try { prediction = await predict(item.query, index); }
    catch { errors++; }
    times.push(performance.now() - started);
    const route = prediction?.route ?? 'rag';
    if (route === 'direct') predictedDirect++;
    else ragCount++;
    if (item.requiresKnowledge && route === 'direct') knowledgeSkipped++;
    const exact = route === item.expectedRoute && (route !== 'direct'
      || stableValue(prediction?.actions) === stableValue(item.expectedActions));
    const group = categories[item.category ?? 'uncategorized'] ??= { total: 0, incorrect: 0, knowledgeSkipped: 0 };
    group.total++;
    if (!exact) group.incorrect++;
    if (item.requiresKnowledge && route === 'direct') group.knowledgeSkipped++;
    if (route === 'direct' && item.expectedRoute === 'direct') {
      routeCorrectDirect++;
      if (exact) correctDirect++;
    }
    if (!exact) failures.push({ id: item.id, reason: route !== item.expectedRoute ? 'route' : 'actions' });
  }
  const sorted = [...times].sort((a, b) => a - b);
  const quantile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return {
    total: cases.length,
    errors,
    ragCount,
    knowledgeSkip: { count: knowledgeSkipped, denominator: knowledgeTotal, rate: ratio(knowledgeSkipped, knowledgeTotal) },
    direct: { predicted: predictedDirect, expected: expectedDirect, routeCorrect: routeCorrectDirect, correct: correctDirect,
      routePrecision: ratio(routeCorrectDirect, predictedDirect), routeRecall: ratio(routeCorrectDirect, expectedDirect),
      strictPrecision: ratio(correctDirect, predictedDirect), strictRecall: ratio(correctDirect, expectedDirect) },
    actionExact: { count: correctDirect, denominator: routeCorrectDirect, rate: ratio(correctDirect, routeCorrectDirect) },
    latencyMs: { p50: quantile(0.5), p95: quantile(0.95), first: times[0] ?? null },
    categories,
    failures,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export interface ConversationEvalCase {
  id: string;
  query: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  expectedRoute: 'conversation' | 'rag' | 'clarify';
  requiresKnowledge: boolean;
  expectedUserTurns: number[];
}

export interface ConversationEvalPrediction {
  route: 'conversation' | 'rag' | 'clarify';
  userTurns: number[];
  omittedRequest?: boolean;
  claimsVerifiedIdentity?: boolean;
}

/** Reports only synthetic case IDs and aggregates, never input or answer text. */
export async function evaluateConversationCases(
  cases: readonly ConversationEvalCase[],
  predict: (query: string, history: ConversationEvalCase['history'], index: number) => Promise<ConversationEvalPrediction | null>,
) {
  let knowledge = 0, skipped = 0, omittedRequests = 0, invalidUserSources = 0;
  let verifiedIdentityClaims = 0, sourceDenominator = 0, sourceCorrect = 0, errors = 0;
  const failures: { id: string; reason: string }[] = [];
  const times: number[] = [];
  for (const [index, sample] of cases.entries()) {
    if (sample.requiresKnowledge) knowledge++;
    const start = performance.now();
    let prediction: ConversationEvalPrediction | null = null;
    try { prediction = await predict(sample.query, sample.history, index); } catch { errors++; }
    times.push(performance.now() - start);
    if (sample.requiresKnowledge && prediction?.route === 'conversation') skipped++;
    if (prediction?.omittedRequest) omittedRequests++;
    if (prediction?.claimsVerifiedIdentity) verifiedIdentityClaims++;
    if (prediction?.userTurns.some(turn => !Number.isInteger(turn) || sample.history[turn]?.role !== 'user')) invalidUserSources++;
    if (sample.expectedUserTurns.length) {
      sourceDenominator++;
      if (prediction?.route === sample.expectedRoute && stableValue(prediction.userTurns) === stableValue(sample.expectedUserTurns)) sourceCorrect++;
    }
    if (!prediction || prediction.route !== sample.expectedRoute) failures.push({ id: sample.id, reason: prediction ? 'route' : 'no_prediction' });
    else if (stableValue(prediction.userTurns) !== stableValue(sample.expectedUserTurns)) failures.push({ id: sample.id, reason: 'source' });
  }
  const sorted = [...times].sort((a, b) => a - b);
  const quantile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { total: cases.length, errors, knowledgeSkip: { count: skipped, denominator: knowledge, rate: ratio(skipped, knowledge) },
    omittedRequests, invalidUserSources, verifiedIdentityClaims,
    sourceExact: { count: sourceCorrect, denominator: sourceDenominator, rate: ratio(sourceCorrect, sourceDenominator) },
    latencyMs: { p50: quantile(0.5), p95: quantile(0.95), first: times[0] ?? null }, failures };
}
