import type { RagEvalCase, RagEvalTargetResult } from './types';

export type QualityDisposition = 'answer' | 'abstain' | 'clarify';
export interface StructuredFactAnnotation {
  id: string;
  label: string;
  /** Optional literal clause selector; it is never executed as a regular expression. */
  clause?: string;
  kind: 'number' | 'amount' | 'date' | 'status';
  expected: string | number;
  unit?: string;
  tolerance?: number;
  aliases?: string[];
}
export interface StructuredFactResult {
  id: string;
  status: 'correct' | 'incorrect' | 'unknown';
  reason: string;
}
export interface BusinessApplicability {
  validFrom?: string;
  validUntil?: string;
  attributes?: Record<string, string[]>;
}
export interface QualityContext {
  asOf?: string;
  userAttributes?: Record<string, string>;
}
export interface BusinessApplicabilityResult {
  status: 'applicable' | 'inapplicable' | 'unknown';
  reasons: string[];
}
export interface QualityAnnotation {
  facts?: StructuredFactAnnotation[];
  expectedDisposition?: QualityDisposition;
  referenceAnswer?: string;
  requiredFacts?: string[][];
  /** Independently reviewed business truth, not text copied from retrieved evidence. */
  businessReferenceAnswer?: string;
  applicability?: BusinessApplicability;
}
export interface QualitySidecar {
  schemaVersion: 'rag-eval-quality/v1';
  datasetSha256: string;
  cases: Record<string, QualityAnnotation>;
}
export const SEMANTIC_QUALITY_DIMENSIONS = [
  'factualCorrectness', 'relevance', 'keyPointCoverage', 'citationEntailment', 'faithfulness', 'businessCorrectness',
] as const;
export type SemanticDimension = typeof SEMANTIC_QUALITY_DIMENSIONS[number];
export interface SemanticQualityInput {
  caseId: string;
  question: string;
  answer: string;
  evidence: readonly { evidenceId: string; content: string }[];
  citations?: readonly { evidenceId: string }[];
  referenceAnswer?: string;
  requiredFacts?: string[][];
  businessReferenceAnswer?: string;
  applicability?: BusinessApplicabilityResult;
  signal?: AbortSignal;
}
export type SemanticJudge = (input: SemanticQualityInput) => Promise<unknown>;
export interface SemanticClaim {
  claim: string;
  evidenceIds: string[];
  supported: boolean | null;
}
export interface SemanticQualityResult {
  status: 'measured' | 'unavailable';
  scores: Record<SemanticDimension, number | null>;
  claims: SemanticClaim[];
  observedDisposition?: QualityDisposition | null;
}
export interface QualityAssessment {
  structuredFacts: StructuredFactResult[];
  applicability: BusinessApplicabilityResult;
  semantic: SemanticQualityResult;
  disposition: { expected: QualityDisposition | null; observed: QualityDisposition | 'unknown'; correct: boolean | null; source?: 'judge' };
}

/** Conservative extraction of explicitly labelled clauses, not general-purpose NLU. */
export function evaluateStructuredFacts(answer: string, annotations: readonly StructuredFactAnnotation[]): StructuredFactResult[] {
  if (typeof answer !== 'string') fail('answer must be text');
  return annotations.map((value, index) => {
    const annotation = parseFact(value, `facts[${index}]`);
    const clauses = normalize(answer).replace(/\[(?:[a-z][a-z0-9_:.-]*|\d+)\]/gu, '')
      .replace(/(\d),(?=\d{3}(?:\D|$))/gu, '$1')
      .split(/[。；;\n！？!?]/u).filter(clause => clause.includes(normalize(annotation.label))
        && (!annotation.clause || clause.includes(normalize(annotation.clause))));
    if (!clauses.length) return factResult(annotation, 'unknown', 'labelled-clause-missing');
    const results = clauses.map(clause => checkClause(clause, annotation));
    if (results.some(result => result.status === 'incorrect')) return factResult(annotation, 'incorrect', 'value-negated-or-conflicting');
    if (results.some(result => result.status === 'unknown')) return factResult(annotation, 'unknown', 'value-not-explicit');
    return factResult(annotation, 'correct', 'explicit-value-matched');
  });
}

function checkClause(clause: string, annotation: StructuredFactAnnotation): StructuredFactResult {
  const tail = clause.slice(clause.indexOf(normalize(annotation.label)) + normalize(annotation.label).length)
    .trim();
  if (tail.split(/[，,]/u).slice(1).some(part => !part.includes(normalize(annotation.label))
    && !/^(?:\s*)(?:但|实际|其实|而是|不是|并非|不为|不等于|更正|改为|应为)/u.test(part))) {
    return factResult(annotation, 'unknown', 'compound-clause-needs-review');
  }
  if (/至少|至多|最多|最少|超过|超出|不少于|不多于|不低于|不高于|大于|小于|以上|以下|之间|(?:\d)\s*(?:到|至|~|～|—|–)|如果|若|当.*时|unless|at least|at most|more than|less than/u.test(tail)) {
    return factResult(annotation, 'unknown', 'conditional-or-bounded-value');
  }
  if (/未知|不明|无法|待核实|不确定|可能|大约|预计|约为|左右/u.test(tail)) return factResult(annotation, 'unknown', 'uncertain-value');
  if (/不是|并非|不为|不等于|未达|没有/u.test(tail)) return factResult(annotation, 'incorrect', 'negated-value');
  const value = tail.replace(/^\s*(?::|=|应为|应是|为|是|共计|共)\s*/u, '').trim();
  if (annotation.kind === 'status') {
    if (!value) return factResult(annotation, 'unknown', 'value-missing');
    const observed = value.replace(/[“”"'‘’]/gu, '').trim();
    return factResult(annotation, [String(annotation.expected), ...(annotation.aliases ?? [])].some(item => normalize(item) === observed)
      ? 'correct' : 'incorrect', 'literal-status-comparison');
  }
  if (annotation.kind === 'date') {
    const dates = [...value.matchAll(/(?<!\d)\d{4}(?:[-/]\d{1,2}[-/]\d{1,2}|年\d{1,2}月\d{1,2}日)(?!\d)/gu)];
    if (!dates.length) return factResult(annotation, 'unknown', 'date-missing');
    const expected = calendarDate(String(annotation.expected));
    return factResult(annotation, dates.every(match => calendarDate(match[0]) === expected) ? 'correct' : 'incorrect', 'calendar-date-comparison');
  }
  const values = [...value.matchAll(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)/gu)];
  if (!values.length) return factResult(annotation, 'unknown', 'number-missing');
  let missingUnit = false;
  for (const match of values) {
    if (Math.abs(Number(match[0]) - Number(annotation.expected)) > (annotation.tolerance ?? 0) + Number.EPSILON * 16) {
      return factResult(annotation, 'incorrect', 'numeric-value-mismatch');
    }
    if (annotation.unit) {
      const unit = value.slice(match.index + match[0].length).match(/^\s*([a-z\u3400-\u9fff%¥￥$€]+)/u)?.[1];
      if (!unit) missingUnit = true;
      else if (unit !== normalize(annotation.unit)) return factResult(annotation, 'incorrect', 'unit-mismatch');
    }
  }
  return factResult(annotation, missingUnit ? 'unknown' : 'correct', missingUnit ? 'unit-missing' : 'numeric-value-comparison');
}

export function evaluateBusinessApplicability(context: QualityContext, annotation?: BusinessApplicability): BusinessApplicabilityResult {
  const validatedContext = record(context, 'quality context');
  knownKeys(validatedContext, ['asOf', 'userAttributes'], 'quality context');
  if (context.asOf !== undefined) timestamp(text(context.asOf, 'asOf'));
  if (context.userAttributes !== undefined) for (const [key, value] of Object.entries(record(context.userAttributes, 'user attributes'))) {
    text(key, 'user attribute key'); text(value, 'user attribute value');
  }
  if (!annotation) return { status: 'unknown', reasons: ['applicability-not-annotated'] };
  const policy = parseApplicability(annotation);
  const unknown: string[] = [];
  const failures: string[] = [];
  if (policy.validFrom || policy.validUntil) {
    if (!context.asOf) unknown.push('as-of-missing');
    else {
      const at = timestamp(context.asOf);
      if (policy.validFrom && at < timestamp(policy.validFrom)) failures.push('not-yet-valid');
      if (policy.validUntil && at > timestamp(policy.validUntil, true)) failures.push('expired');
    }
  }
  for (const [key, allowed] of Object.entries(policy.attributes ?? {})) {
    const observed = context.userAttributes?.[key];
    if (observed === undefined) unknown.push(`attribute-missing:${key}`);
    else if (!allowed.includes(observed)) failures.push(`attribute-not-applicable:${key}`);
  }
  if (!policy.validFrom && !policy.validUntil && !Object.keys(policy.attributes ?? {}).length) unknown.push('conditions-not-annotated');
  return failures.length ? { status: 'inapplicable', reasons: failures }
    : unknown.length ? { status: 'unknown', reasons: unknown } : { status: 'applicable', reasons: [] };
}

export async function evaluateSemanticQuality(input: SemanticQualityInput, judge?: SemanticJudge): Promise<SemanticQualityResult> {
  const scores = Object.fromEntries(SEMANTIC_QUALITY_DIMENSIONS.map(key => [key, null])) as SemanticQualityResult['scores'];
  if (!judge) return { status: 'unavailable', scores, claims: [] };
  input.signal?.throwIfAborted();
  // The model cannot mutate the evidence or the labels subsequently used by other metrics.
  const { signal, ...data } = input;
  const detached = freezeDeep(JSON.parse(JSON.stringify(data))) as Omit<SemanticQualityInput, 'signal'>;
  let raw: unknown;
  try { raw = await judge(Object.freeze({ ...detached, ...(signal ? { signal } : {}) })); }
  catch (error) {
    signal?.throwIfAborted();
    throw new Error(`[rag-eval quality] semantic judge failed for case ${input.caseId}`, { cause: error });
  }
  signal?.throwIfAborted();
  const verdict = record(raw, 'semantic verdict');
  const observedDisposition = verdict.observedDisposition;
  if (observedDisposition !== undefined && observedDisposition !== null
    && observedDisposition !== 'answer' && observedDisposition !== 'abstain' && observedDisposition !== 'clarify') fail('invalid judge disposition');
  const rawScores = record(verdict.scores, 'semantic scores');
  knownKeys(rawScores, [...SEMANTIC_QUALITY_DIMENSIONS], 'semantic scores');
  for (const dimension of SEMANTIC_QUALITY_DIMENSIONS) {
    const score = rawScores[dimension];
    if (score !== undefined && score !== null) scores[dimension] = qualityScore(score, dimension);
  }
  const evidenceIds = new Set(input.evidence.map(item => item.evidenceId));
  const citedIds = new Set(input.citations?.map(item => item.evidenceId) ?? []);
  const claims = array(verdict.claims ?? [], 'semantic claims', 0, 100).map((item, index) => {
    const claim = record(item, `claims[${index}]`);
    const ids = texts(claim.evidenceIds, `claims[${index}].evidenceIds`, 0, 100);
    if (ids.some(id => !evidenceIds.has(id))) fail(`claims[${index}] references unknown evidence`);
    if (claim.supported !== true && claim.supported !== false && claim.supported !== null) fail(`claims[${index}].supported must be boolean or null`);
    if (claim.supported === true && !ids.length) fail(`claims[${index}] supported claim requires evidence`);
    return { claim: text(claim.claim, `claims[${index}].claim`), evidenceIds: ids, supported: claim.supported };
  });
  if ((scores.faithfulness !== null && scores.faithfulness > 0 || scores.citationEntailment !== null && scores.citationEntailment > 0) && !claims.length) {
    fail('positive grounding score requires claim evidence');
  }
  for (const dimension of ['faithfulness', 'citationEntailment'] as const) {
    if (scores[dimension] !== null && scores[dimension] > 0 && !claims.some(claim => claim.supported === true)
      || scores[dimension] === 1 && claims.some(claim => claim.supported !== true)) {
      fail(`grounding score contradicts claim support for ${dimension}`);
    }
  }
  if (scores.citationEntailment !== null && scores.citationEntailment > 0
    && claims.some(claim => claim.supported === true && claim.evidenceIds.some(id => !citedIds.has(id)))) {
    fail('positive citation entailment references evidence not cited by the answer');
  }
  if (!input.referenceAnswer && !input.requiredFacts?.length) scores.factualCorrectness = null;
  if (!input.requiredFacts?.length) scores.keyPointCoverage = null;
  if (!input.evidence.length) scores.faithfulness = null;
  if (input.citations === undefined) scores.citationEntailment = null;
  if (!input.businessReferenceAnswer || input.applicability?.status !== 'applicable') scores.businessCorrectness = null;
  return { status: Object.values(scores).some(score => score !== null) || observedDisposition ? 'measured' : 'unavailable', scores, claims,
    ...(observedDisposition === undefined ? {} : { observedDisposition }) };
}

export async function assessRagEvalCase(
  evalCase: Pick<RagEvalCase, 'id' | 'query' | 'expectedAnswer' | 'expectedDisposition'> & { expectedAbstain?: boolean },
  result: Pick<RagEvalTargetResult, 'answer' | 'abstained' | 'evidence' | 'citations'> & { disposition?: QualityDisposition },
  annotation: QualityAnnotation = {},
  options: { context?: QualityContext; judge?: SemanticJudge; signal?: AbortSignal } = {}
): Promise<QualityAssessment> {
  const applicability = evaluateBusinessApplicability(options.context ?? {}, annotation.applicability);
  const expected = annotation.expectedDisposition ?? evalCase.expectedDisposition
    ?? (evalCase.expectedAbstain === undefined ? null : evalCase.expectedAbstain ? 'abstain' : 'answer');
  const semantic = await evaluateSemanticQuality({ caseId: evalCase.id, question: evalCase.query, answer: result.answer,
    evidence: result.evidence, citations: result.citations,
    referenceAnswer: annotation.referenceAnswer ?? evalCase.expectedAnswer?.referenceAnswer,
    requiredFacts: annotation.requiredFacts ?? evalCase.expectedAnswer?.requiredFacts,
    businessReferenceAnswer: annotation.businessReferenceAnswer, applicability, signal: options.signal }, options.judge);
  const structuredDisposition = result.disposition ?? (result.abstained ? 'abstain' : undefined);
  const observed = structuredDisposition ?? semantic.observedDisposition ?? 'unknown';
  return {
    structuredFacts: evaluateStructuredFacts(result.answer, annotation.facts ?? []),
    applicability,
    semantic,
    disposition: { expected, observed, correct: expected === null || observed === 'unknown' ? null : expected === observed,
      ...(!structuredDisposition && semantic.observedDisposition ? { source: 'judge' as const } : {}) },
  };
}

export function parseQualitySidecar(input: unknown, expected: { datasetSha256: string; caseIds: readonly string[] }): QualitySidecar {
  const sidecar = record(input, 'sidecar');
  knownKeys(sidecar, ['schemaVersion', 'datasetSha256', 'cases'], 'sidecar');
  if (sidecar.schemaVersion !== 'rag-eval-quality/v1') fail('unsupported sidecar schema');
  if (typeof sidecar.datasetSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sidecar.datasetSha256)
    || sidecar.datasetSha256 !== expected.datasetSha256) fail('sidecar dataset digest mismatch');
  const cases = record(sidecar.cases, 'sidecar cases');
  if (Object.keys(cases).length > 10000) fail('too many sidecar cases');
  const allowed = new Set(expected.caseIds);
  const parsed: Record<string, QualityAnnotation> = Object.create(null);
  for (const [id, annotation] of Object.entries(cases)) {
    if (!allowed.has(id)) fail('sidecar references unknown case');
    const value = record(annotation, `case ${id}`);
    knownKeys(value, ['facts', 'expectedDisposition', 'referenceAnswer', 'requiredFacts', 'businessReferenceAnswer', 'applicability'], `case ${id}`);
    const entry: QualityAnnotation = {};
    if (value.facts !== undefined) {
      entry.facts = array(value.facts, 'facts', 0, 100).map((fact, index) => parseFact(fact, `facts[${index}]`));
      if (new Set(entry.facts.map(fact => fact.id)).size !== entry.facts.length) fail('duplicate structured fact id');
    }
    if (value.expectedDisposition !== undefined) {
      if (!['answer', 'abstain', 'clarify'].includes(String(value.expectedDisposition))) fail('invalid expected disposition');
      entry.expectedDisposition = value.expectedDisposition as QualityDisposition;
    }
    for (const field of ['referenceAnswer', 'businessReferenceAnswer'] as const) if (value[field] !== undefined) entry[field] = text(value[field], field);
    if (value.requiredFacts !== undefined) entry.requiredFacts = array(value.requiredFacts, 'requiredFacts', 1, 100)
      .map((alternatives, index) => texts(alternatives, `requiredFacts[${index}]`, 1, 30));
    if (value.applicability !== undefined) entry.applicability = parseApplicability(value.applicability);
    parsed[id] = entry;
  }
  return { schemaVersion: 'rag-eval-quality/v1', datasetSha256: sidecar.datasetSha256, cases: parsed };
}

export interface CalibrationScore { caseId: string; dimension: SemanticDimension; score: number | null }
export function calibrateSemanticJudge(options: {
  calibrationCaseIds: readonly string[]; evaluationCaseIds: readonly string[];
  judgeScores: readonly CalibrationScore[]; humanScores: readonly CalibrationScore[]; tolerance?: number;
}) {
  const input = record(options, 'calibration options');
  knownKeys(input, ['calibrationCaseIds', 'evaluationCaseIds', 'judgeScores', 'humanScores', 'tolerance'], 'calibration options');
  texts(options.calibrationCaseIds, 'calibration case IDs', 1, 10000);
  texts(options.evaluationCaseIds, 'evaluation case IDs', 0, 10000);
  array(options.judgeScores, 'judge scores', 0, 60000);
  array(options.humanScores, 'human scores', 0, 60000);
  const calibrationIds = new Set(options.calibrationCaseIds);
  if (calibrationIds.size !== options.calibrationCaseIds.length) fail('duplicate calibration case');
  if (options.evaluationCaseIds.some(id => calibrationIds.has(id))) fail('calibration and evaluation case overlap');
  const tolerance = options.tolerance ?? 0.1;
  qualityScore(tolerance, 'calibration tolerance');
  const indexScores = (rows: readonly CalibrationScore[]) => {
    const indexed = new Map<string, number | null>();
    for (const row of rows) {
      const annotation = record(row, 'calibration score');
      knownKeys(annotation, ['caseId', 'dimension', 'score'], 'calibration score');
      if (!calibrationIds.has(row.caseId)) fail('calibration scores reference a non-calibration case');
      if (!SEMANTIC_QUALITY_DIMENSIONS.includes(row.dimension)) fail('unknown calibration dimension');
      const key = JSON.stringify([row.caseId, row.dimension]);
      if (indexed.has(key)) fail('duplicate calibration score');
      indexed.set(key, row.score === null ? null : qualityScore(row.score, 'calibration score'));
    }
    return indexed;
  };
  const human = indexScores(options.humanScores);
  const judge = indexScores(options.judgeScores);
  const errors: number[] = [];
  let labelled = 0;
  for (const [key, expected] of human) {
    if (expected === null) continue;
    labelled++;
    const observed = judge.get(key);
    if (observed !== null && observed !== undefined) errors.push(Math.abs(expected - observed));
  }
  return { pairedDimensions: errors.length, labelledDimensions: labelled,
    coverage: labelled ? errors.length / labelled : null,
    meanAbsoluteError: errors.length ? errors.reduce((total, error) => total + error, 0) / errors.length : null,
    agreementWithinTolerance: errors.length ? errors.filter(error => error <= tolerance + Number.EPSILON * 16).length / errors.length : null };
}

function parseFact(input: unknown, path: string): StructuredFactAnnotation {
  const value = record(input, path);
  knownKeys(value, ['id', 'label', 'clause', 'kind', 'expected', 'unit', 'tolerance', 'aliases'], path);
  const id = text(value.id, `${path}.id`), label = text(value.label, `${path}.label`);
  if (!['number', 'amount', 'date', 'status'].includes(String(value.kind))) fail(`${path}.kind is invalid`);
  const kind = value.kind as StructuredFactAnnotation['kind'];
  const expected = kind === 'number' || kind === 'amount'
    ? finiteNumber(value.expected, `${path}.expected`) : text(value.expected, `${path}.expected`);
  if (kind === 'date' && calendarDate(String(expected)) === null) fail(`${path}.expected is not a valid date`);
  if (value.tolerance !== undefined && (finiteNumber(value.tolerance, `${path}.tolerance`) < 0 || !['number', 'amount'].includes(kind))) fail(`${path}.tolerance is invalid`);
  return { id, label, kind, expected,
    ...(value.clause === undefined ? {} : { clause: text(value.clause, `${path}.clause`) }),
    ...(value.unit === undefined ? {} : { unit: text(value.unit, `${path}.unit`) }),
    ...(value.tolerance === undefined ? {} : { tolerance: value.tolerance as number }),
    ...(value.aliases === undefined ? {} : { aliases: texts(value.aliases, `${path}.aliases`, 0, 30) }) };
}
function parseApplicability(input: unknown): BusinessApplicability {
  const value = record(input, 'applicability');
  knownKeys(value, ['validFrom', 'validUntil', 'attributes'], 'applicability');
  const result: BusinessApplicability = {};
  for (const key of ['validFrom', 'validUntil'] as const) if (value[key] !== undefined) {
    result[key] = text(value[key], key); timestamp(result[key], key === 'validUntil');
  }
  if (result.validFrom && result.validUntil && timestamp(result.validFrom) > timestamp(result.validUntil, true)) fail('applicability date interval is reversed');
  if (value.attributes !== undefined) {
    result.attributes = Object.create(null) as Record<string, string[]>;
    const attributes = record(value.attributes, 'applicability attributes');
    if (Object.keys(attributes).length > 50) fail('too many applicability attributes');
    for (const [key, alternatives] of Object.entries(attributes)) result.attributes[text(key, 'attribute key')] = texts(alternatives, 'attribute alternatives', 1, 100);
  }
  return result;
}
function calendarDate(value: string): string | null {
  const match = normalize(value).match(/^(\d{4})(?:[-/](\d{1,2})[-/](\d{1,2})|年(\d{1,2})月(\d{1,2})日)$/u);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2] ?? match[4]), day = Number(match[3] ?? match[5]);
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}
function timestamp(value: string, endOfDay = false): number {
  const day = calendarDate(value);
  if (day) return Date.parse(`${day}T00:00:00.000Z`) + (endOfDay ? 86_399_999 : 0);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !calendarDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) fail('invalid applicability date/time');
  return Date.parse(value);
}
function factResult(annotation: StructuredFactAnnotation, status: StructuredFactResult['status'], reason: string): StructuredFactResult {
  return { id: annotation.id, status, reason };
}
function normalize(value: string) { return value.normalize('NFKC').toLowerCase().trim(); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) fail(`${label} contains unsafe object keys or prototype`);
  return value as Record<string, unknown>;
}
function knownKeys(value: Record<string, unknown>, keys: string[], label: string) {
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${label} contains unknown fields`);
}
function array(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} must contain ${min}..${max} items`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) fail(`${label} must be nonempty text`);
  return value.trim();
}
function texts(value: unknown, label: string, min: number, max: number): string[] {
  const values = array(value, label, min, max).map(item => text(item, label));
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
  return values;
}
function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number`);
  return value;
}
function qualityScore(value: unknown, label: string) {
  const score = finiteNumber(value, `${label} score`);
  if (score < 0 || score > 1) fail(`${label} score must be in [0,1]`);
  return score;
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
function fail(message: string): never { throw new Error(`[rag-eval quality] ${message}`); }
