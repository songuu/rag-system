import { createHash } from 'node:crypto';

import {
  RAG_EVAL_DATASET_SCHEMA_VERSION,
  RAG_EVAL_DATASET_SCHEMA_VERSION_V2,
  type RagEvalCase,
  type RagEvalCorpusDocument,
  type RagEvalDataset,
  type RagEvalExpectedAnswer,
  type RagEvalGoldEvidence,
  type RagEvalRelevance,
  type RagEvalScope,
  type RagEvalSecurityExpectations,
  type RagEvalSpan,
} from './types';

const RELEVANCE_VALUES = new Set<number>([1, 2, 3]);

export function parseRagEvalDataset(input: unknown): RagEvalDataset {
  const root = expectRecord(input, '$');
  if (
    root.schemaVersion !== RAG_EVAL_DATASET_SCHEMA_VERSION &&
    root.schemaVersion !== RAG_EVAL_DATASET_SCHEMA_VERSION_V2
  ) {
    fail(
      '$.schemaVersion',
      `expected ${RAG_EVAL_DATASET_SCHEMA_VERSION} or ${RAG_EVAL_DATASET_SCHEMA_VERSION_V2}, received ${String(root.schemaVersion)}`
    );
  }
  const schemaVersion = root.schemaVersion;
  const isV2 = schemaVersion === RAG_EVAL_DATASET_SCHEMA_VERSION_V2;

  const datasetId = expectNonEmptyString(root.datasetId, '$.datasetId');
  const datasetVersion = expectNonEmptyString(root.datasetVersion, '$.datasetVersion');
  const corpusInput = expectNonEmptyArray(root.corpus, '$.corpus');
  const casesInput = expectNonEmptyArray(root.cases, '$.cases');

  const corpus = corpusInput.map((document, index) =>
    parseCorpusDocument(document, `$.corpus[${index}]`, isV2)
  );
  const evidenceIds = new Set<string>();
  for (const [index, document] of corpus.entries()) {
    if (evidenceIds.has(document.evidenceId)) {
      fail(`$.corpus[${index}].evidenceId`, `duplicate value ${document.evidenceId}`);
    }
    evidenceIds.add(document.evidenceId);
  }

  const corpusByEvidenceId = new Map(
    corpus.map(document => [document.evidenceId, document])
  );
  const cases = casesInput.map((evalCase, index) =>
    parseEvalCase(evalCase, `$.cases[${index}]`, corpusByEvidenceId, isV2)
  );
  const caseIds = new Set<string>();
  for (const [index, evalCase] of cases.entries()) {
    if (caseIds.has(evalCase.id)) {
      fail(`$.cases[${index}].id`, `duplicate value ${evalCase.id}`);
    }
    caseIds.add(evalCase.id);
  }

  return {
    schemaVersion,
    datasetId,
    datasetVersion,
    corpus,
    cases,
  };
}

export function createRagEvalDatasetHash(dataset: RagEvalDataset): string {
  return createHash('sha256').update(stableStringify(dataset)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error('[rag-eval dataset] cannot hash an undefined value');
    }
    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function parseCorpusDocument(
  input: unknown,
  path: string,
  isV2: boolean
): RagEvalCorpusDocument {
  const document = expectRecord(input, path);
  const metadata = document.metadata;
  if (metadata !== undefined) {
    expectRecord(metadata, `${path}.metadata`);
  }

  const canonicalFields = isV2
    ? {
        documentVersion: expectNonEmptyString(
          document.documentVersion,
          `${path}.documentVersion`
        ),
        tenantId: expectNonEmptyString(document.tenantId, `${path}.tenantId`),
        corpusId: expectNonEmptyString(document.corpusId, `${path}.corpusId`),
        trustLevel: parseTrustLevel(document.trustLevel, `${path}.trustLevel`),
      }
    : {};

  return {
    evidenceId: expectNonEmptyString(document.evidenceId, `${path}.evidenceId`),
    documentId: expectNonEmptyString(document.documentId, `${path}.documentId`),
    source: expectNonEmptyString(document.source, `${path}.source`),
    content: expectNonEmptyString(document.content, `${path}.content`),
    ...canonicalFields,
    ...(metadata === undefined ? {} : { metadata: metadata as Record<string, unknown> }),
  };
}

function parseEvalCase(
  input: unknown,
  path: string,
  corpusByEvidenceId: ReadonlyMap<string, RagEvalCorpusDocument>,
  isV2: boolean
): RagEvalCase {
  const evalCase = expectRecord(input, path);
  const expectedAbstain = expectBoolean(evalCase.expectedAbstain, `${path}.expectedAbstain`);
  const goldInput = expectArray(evalCase.goldEvidence, `${path}.goldEvidence`);
  const goldEvidence = goldInput.map((gold, index) =>
    parseGoldEvidence(
      gold,
      `${path}.goldEvidence[${index}]`,
      corpusByEvidenceId,
      isV2
    )
  );

  const seenGold = new Set<string>();
  for (const [index, gold] of goldEvidence.entries()) {
    if (seenGold.has(gold.evidenceId)) {
      fail(
        `${path}.goldEvidence[${index}].evidenceId`,
        `duplicate value ${gold.evidenceId}`
      );
    }
    seenGold.add(gold.evidenceId);
  }
  if (expectedAbstain && goldEvidence.length > 0) {
    fail(`${path}.goldEvidence`, 'must be empty when expectedAbstain is true');
  }
  if (isV2 && !expectedAbstain && goldEvidence.length === 0) {
    fail(`${path}.goldEvidence`, 'must not be empty for an answerable V2 case');
  }

  const tagsInput = expectArray(evalCase.tags, `${path}.tags`);
  const tags = tagsInput.map((tag, index) =>
    expectNonEmptyString(tag, `${path}.tags[${index}]`)
  );
  const expectedAnswer =
    evalCase.expectedAnswer === undefined
      ? undefined
      : parseExpectedAnswer(evalCase.expectedAnswer, `${path}.expectedAnswer`);
  if (isV2 && !expectedAbstain && expectedAnswer === undefined) {
    fail(
      `${path}.expectedAnswer`,
      'must be present for an answerable V2 case'
    );
  }
  const v2Fields = isV2
    ? parseV2CaseFields(evalCase, path, corpusByEvidenceId, goldEvidence)
    : {};

  return {
    id: expectNonEmptyString(evalCase.id, `${path}.id`),
    query: expectNonEmptyString(evalCase.query, `${path}.query`),
    tags,
    goldEvidence,
    ...(expectedAnswer === undefined ? {} : { expectedAnswer }),
    expectedAbstain,
    ...v2Fields,
  };
}

function parseGoldEvidence(
  input: unknown,
  path: string,
  corpusByEvidenceId: ReadonlyMap<string, RagEvalCorpusDocument>,
  isV2: boolean
): RagEvalGoldEvidence {
  const gold = expectRecord(input, path);
  const evidenceId = expectNonEmptyString(gold.evidenceId, `${path}.evidenceId`);
  const corpusDocument = corpusByEvidenceId.get(evidenceId);
  if (!corpusDocument) {
    fail(`${path}.evidenceId`, `references unknown corpus evidence ${evidenceId}`);
  }
  if (typeof gold.relevance !== 'number' || !RELEVANCE_VALUES.has(gold.relevance)) {
    fail(`${path}.relevance`, 'must be one of 1, 2, or 3');
  }

  const spans = isV2
    ? expectNonEmptyArray(gold.spans, `${path}.spans`).map((span, index) =>
        parseSpan(
          span,
          `${path}.spans[${index}]`,
          corpusDocument.content.length
        )
      )
    : undefined;

  return {
    evidenceId,
    relevance: gold.relevance as RagEvalRelevance,
    ...(spans === undefined ? {} : { spans }),
  };
}

function parseV2CaseFields(
  evalCase: Record<string, unknown>,
  path: string,
  corpusByEvidenceId: ReadonlyMap<string, RagEvalCorpusDocument>,
  goldEvidence: readonly RagEvalGoldEvidence[]
): Pick<
  RagEvalCase,
  'scope' | 'allowedPolicies' | 'allowedLanes' | 'securityExpectations'
> {
  const scope = parseScope(evalCase.scope, `${path}.scope`);
  const allowedPolicies = parseUniqueStringArray(
    evalCase.allowedPolicies,
    `${path}.allowedPolicies`,
    true
  );
  const allowedLanes = parseUniqueStringArray(
    evalCase.allowedLanes,
    `${path}.allowedLanes`,
    true
  );
  const securityExpectations = parseSecurityExpectations(
    evalCase.securityExpectations,
    `${path}.securityExpectations`,
    corpusByEvidenceId
  );

  for (const [index, gold] of goldEvidence.entries()) {
    const document = corpusByEvidenceId.get(gold.evidenceId);
    if (
      !document ||
      document.tenantId !== scope.tenantId ||
      document.corpusId !== scope.corpusId
    ) {
      fail(
        `${path}.goldEvidence[${index}].evidenceId`,
        'must reference evidence inside the case scope'
      );
    }
    if (
      document.trustLevel === undefined ||
      document.trustLevel === 'quarantined' ||
      !scope.allowedTrustLevels.includes(document.trustLevel)
    ) {
      fail(
        `${path}.goldEvidence[${index}].evidenceId`,
        'must reference non-quarantined evidence allowed by the case trust scope'
      );
    }
  }

  return {
    scope,
    allowedPolicies,
    allowedLanes,
    securityExpectations,
  };
}

function parseScope(input: unknown, path: string): RagEvalScope {
  const scope = expectRecord(input, path);
  const allowedTrustLevels = parseUniqueStringArray(
    scope.allowedTrustLevels,
    `${path}.allowedTrustLevels`,
    true
  ).map((level, index) => {
    if (level !== 'trusted' && level !== 'reviewed' && level !== 'external') {
      fail(
        `${path}.allowedTrustLevels[${index}]`,
        'must be trusted, reviewed, or external'
      );
    }
    return level;
  });
  return {
    tenantId: expectNonEmptyString(scope.tenantId, `${path}.tenantId`),
    corpusId: expectNonEmptyString(scope.corpusId, `${path}.corpusId`),
    allowedTrustLevels,
  };
}

function parseSecurityExpectations(
  input: unknown,
  path: string,
  corpusByEvidenceId: ReadonlyMap<string, RagEvalCorpusDocument>
): RagEvalSecurityExpectations {
  const security = expectRecord(input, path);
  const forbiddenEvidenceIds = parseUniqueStringArray(
    security.forbiddenEvidenceIds,
    `${path}.forbiddenEvidenceIds`,
    false
  );
  const forbiddenAnswerPatterns = parseUniqueStringArray(
    security.forbiddenAnswerPatterns,
    `${path}.forbiddenAnswerPatterns`,
    false
  );
  if (
    forbiddenEvidenceIds.length === 0 &&
    forbiddenAnswerPatterns.length === 0
  ) {
    fail(path, 'must define at least one forbidden evidence id or answer pattern');
  }
  for (const [index, evidenceId] of forbiddenEvidenceIds.entries()) {
    if (!corpusByEvidenceId.has(evidenceId)) {
      fail(
        `${path}.forbiddenEvidenceIds[${index}]`,
        `references unknown corpus evidence ${evidenceId}`
      );
    }
  }
  return {
    forbiddenEvidenceIds,
    forbiddenAnswerPatterns,
  };
}

function parseSpan(input: unknown, path: string, contentLength: number): RagEvalSpan {
  const span = expectRecord(input, path);
  const startOffset = expectNonNegativeInteger(span.startOffset, `${path}.startOffset`);
  const endOffset = expectNonNegativeInteger(span.endOffset, `${path}.endOffset`);
  if (endOffset <= startOffset) {
    fail(path, 'endOffset must be greater than startOffset');
  }
  if (endOffset > contentLength) {
    fail(`${path}.endOffset`, `must not exceed evidence content length ${contentLength}`);
  }
  return { startOffset, endOffset };
}

function parseExpectedAnswer(input: unknown, path: string): RagEvalExpectedAnswer {
  const expected = expectRecord(input, path);
  const requiredFactsInput = expectNonEmptyArray(expected.requiredFacts, `${path}.requiredFacts`);
  const requiredFacts = requiredFactsInput.map((alternatives, factIndex) => {
    const alternativesInput = expectNonEmptyArray(
      alternatives,
      `${path}.requiredFacts[${factIndex}]`
    );
    return alternativesInput.map((alternative, alternativeIndex) =>
      expectNonEmptyString(
        alternative,
        `${path}.requiredFacts[${factIndex}][${alternativeIndex}]`
      )
    );
  });

  return { requiredFacts };
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, 'must be an array');
  }
  return value;
}

function expectNonEmptyArray(value: unknown, path: string): unknown[] {
  const result = expectArray(value, path);
  if (result.length === 0) {
    fail(path, 'must not be empty');
  }
  return result;
}

function expectNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(path, 'must be a non-empty string');
  }
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    fail(path, 'must be a boolean');
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(path, 'must be a non-negative integer');
  }
  return value;
}

function parseTrustLevel(
  value: unknown,
  path: string
): NonNullable<RagEvalCorpusDocument['trustLevel']> {
  if (
    value !== 'trusted' &&
    value !== 'reviewed' &&
    value !== 'external' &&
    value !== 'quarantined'
  ) {
    fail(path, 'must be trusted, reviewed, external, or quarantined');
  }
  return value;
}

function parseUniqueStringArray(
  value: unknown,
  path: string,
  requireNonEmpty: boolean
): string[] {
  const input = requireNonEmpty
    ? expectNonEmptyArray(value, path)
    : expectArray(value, path);
  const output = input.map((item, index) =>
    expectNonEmptyString(item, `${path}[${index}]`)
  );
  const seen = new Set<string>();
  for (const [index, item] of output.entries()) {
    if (seen.has(item)) {
      fail(`${path}[${index}]`, `duplicate value ${item}`);
    }
    seen.add(item);
  }
  return output;
}

function fail(path: string, message: string): never {
  throw new Error(`[rag-eval dataset] ${path}: ${message}`);
}
