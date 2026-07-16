import type { RagEvidence } from './types';
import type { RagRetrievalScope } from '../../security/retrieval-scope';

export const EVIDENCE_CONTEXT_COMPOSER_VERSION = 'evidence-context/v2' as const;

export interface ContextComposerOptions {
  maxCharacters?: number;
  includeScores?: boolean;
  scope?: RagRetrievalScope;
}

export type EvidenceContextOrder = 'retrieval' | 'document';

export interface ContextComposerV2Options {
  maxTokens?: number;
  includeScores?: boolean;
  includeStructure?: boolean;
  order?: EvidenceContextOrder;
  scope?: RagRetrievalScope;
  estimateTokens?: (value: string) => number;
  allowHeaderOnly?: boolean;
}

export interface ComposedEvidenceContextV2 {
  version: typeof EVIDENCE_CONTEXT_COMPOSER_VERSION;
  context: string;
  includedEvidence: RagEvidence[];
  includedEvidenceIds: string[];
  excludedEvidenceIds: string[];
  tokenEstimate: number;
  truncated: boolean;
  order: EvidenceContextOrder;
}

/** Compatibility API. Character accounting is delegated to the v2 packer. */
export function composeEvidenceContext(
  evidence: RagEvidence[],
  options: ContextComposerOptions = {}
): string {
  const maxCharacters = options.maxCharacters ?? 12000;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error('RAG context maxCharacters must be a positive integer.');
  }
  return composeEvidenceContextV2(evidence, {
    maxTokens: maxCharacters,
    includeScores: options.includeScores,
    includeStructure: false,
    order: 'retrieval',
    scope: options.scope,
    estimateTokens: value => value.length,
    allowHeaderOnly: true,
  }).context;
}

export function composeEvidenceContextV2(
  evidence: readonly RagEvidence[],
  options: ContextComposerV2Options = {}
): ComposedEvidenceContextV2 {
  const maxTokens = options.maxTokens ?? 4000;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error('RAG context maxTokens must be a positive integer.');
  }
  const estimateTokens = options.estimateTokens ?? estimateEvidenceContextTokens;
  assertTokenEstimator(estimateTokens);
  assertUniqueEvidenceIds(evidence);
  for (const item of evidence) {
    assertEvidenceCanEnterContext(item, options.scope);
    assertEvidenceScore(item);
  }
  const order = options.order ?? 'retrieval';
  const orderedEvidence = orderEvidence(evidence, order);
  const parts: string[] = [];
  const includedEvidence: RagEvidence[] = [];
  let truncated = false;

  for (const originalItem of orderedEvidence) {
    const header = formatEvidenceHeader(
      originalItem,
      includedEvidence.length + 1,
      options.includeScores ?? true,
      options.includeStructure ?? true
    );
    const separator = parts.length === 0 ? '' : '\n\n';
    const fullBlock = header + originalItem.content;
    const fullCandidate = parts.join('\n\n') + separator + fullBlock;
    if (safeEstimate(estimateTokens, fullCandidate) <= maxTokens) {
      parts.push(fullBlock);
      includedEvidence.push({ ...originalItem });
      continue;
    }

    const prefix = findLargestContentPrefix({
      existingContext: parts.join('\n\n'),
      separator,
      header,
      content: originalItem.content,
      maxTokens,
      estimateTokens,
    });
    if (prefix.length > 0) {
      const headerCandidate = parts.join('\n\n') + separator + header + prefix;
      if (safeEstimate(estimateTokens, headerCandidate) <= maxTokens) {
        parts.push(header + prefix);
        includedEvidence.push(truncateEvidence(originalItem, prefix));
      }
    } else if (options.allowHeaderOnly) {
      const headerCandidate = parts.join('\n\n') + separator + header;
      if (safeEstimate(estimateTokens, headerCandidate) <= maxTokens) {
        // Compatibility output may keep the header, but no empty passage is
        // claimed as included canonical evidence.
        parts.push(header);
      }
    }
    truncated = true;
    break;
  }

  if (includedEvidence.length < orderedEvidence.length) truncated = true;
  const includedIds = new Set(includedEvidence.map(item => item.id));
  const context = parts.join('\n\n');
  return {
    version: EVIDENCE_CONTEXT_COMPOSER_VERSION,
    context,
    includedEvidence,
    includedEvidenceIds: includedEvidence.map(item => item.id),
    excludedEvidenceIds: orderedEvidence
      .filter(item => !includedIds.has(item.id))
      .map(item => item.id),
    tokenEstimate: safeEstimate(estimateTokens, context),
    truncated,
    order,
  };
}

export function estimateEvidenceContextTokens(value: string): number {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) asciiCharacters++;
    else nonAsciiCharacters++;
  }
  return Math.ceil(asciiCharacters / 4) + nonAsciiCharacters;
}

function orderEvidence(
  evidence: readonly RagEvidence[],
  order: EvidenceContextOrder
): RagEvidence[] {
  if (order === 'retrieval') return [...evidence];
  if (order !== 'document') throw new Error('Unsupported RAG context order: ' + order);
  const sourceOrder = new Map<string, number>();
  evidence.forEach((item, index) => {
    const key = item.documentId || item.source || item.id;
    if (!sourceOrder.has(key)) sourceOrder.set(key, index);
  });
  return evidence
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftKey = left.item.documentId || left.item.source || left.item.id;
      const rightKey = right.item.documentId || right.item.source || right.item.id;
      return (
        (sourceOrder.get(leftKey) ?? left.index) - (sourceOrder.get(rightKey) ?? right.index) ||
        compareOptionalNumber(left.item.page, right.item.page) ||
        compareOptionalNumber(left.item.startOffset, right.item.startOffset) ||
        left.index - right.index
      );
    })
    .map(entry => entry.item);
}

function compareOptionalNumber(left?: number, right?: number): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function formatEvidenceHeader(
  item: RagEvidence,
  index: number,
  includeScores: boolean,
  includeStructure: boolean
): string {
  const score = item.rerankScore ?? item.retrievalScore ?? item.score;
  const scoreText = includeScores && typeof score === 'number'
    ? ' (score: ' + score.toFixed(4) + ')'
    : '';
  const sourceText = item.source ? ' (source: ' + item.source + ')' : '';
  const pageText = includeStructure && item.page !== undefined
    ? ' (page: ' + item.page + ')'
    : '';
  const sectionText = includeStructure && item.sectionPath?.length
    ? ' (section: ' + item.sectionPath.join(' > ') + ')'
    : '';
  return '[' + index + ']' + scoreText + sourceText + pageText + sectionText + '\n';
}

function assertEvidenceScore(item: RagEvidence): void {
  const scores = [item.rerankScore, item.retrievalScore, item.score];
  if (scores.some(score => score !== undefined && !Number.isFinite(score))) {
    throw new Error('RAG context evidence score must be finite.');
  }
}

function assertUniqueEvidenceIds(evidence: readonly RagEvidence[]): void {
  const seen = new Set<string>();
  for (const item of evidence) {
    if (seen.has(item.id)) {
      throw new Error('RAG context evidence IDs must be unique: ' + item.id);
    }
    seen.add(item.id);
  }
}

function findLargestContentPrefix(input: {
  existingContext: string;
  separator: string;
  header: string;
  content: string;
  maxTokens: number;
  estimateTokens: (value: string) => number;
}): string {
  let low = 0;
  let high = input.content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const prefix = truncateWithoutSplittingSurrogate(input.content, middle);
    const candidate = input.existingContext + input.separator + input.header + prefix;
    if (safeEstimate(input.estimateTokens, candidate) <= input.maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return truncateWithoutSplittingSurrogate(input.content, low);
}

function truncateEvidence(evidence: RagEvidence, selectedContent: string): RagEvidence {
  if (selectedContent.length === evidence.content.length) return { ...evidence };
  const adjustedEndOffset = evidence.startOffset === undefined || selectedContent.length === 0
    ? evidence.endOffset
    : evidence.startOffset + selectedContent.length;
  return {
    ...evidence,
    content: selectedContent,
    ...(adjustedEndOffset === undefined ? {} : { endOffset: adjustedEndOffset }),
    metadata: {
      ...evidence.metadata,
      contextTruncated: true,
    },
  };
}

function assertTokenEstimator(estimateTokens: (value: string) => number): void {
  safeEstimate(estimateTokens, '');
  safeEstimate(estimateTokens, 'token estimator probe');
}

function safeEstimate(estimateTokens: (value: string) => number, value: string): number {
  const estimate = estimateTokens(value);
  if (!Number.isFinite(estimate) || estimate < 0) {
    throw new Error('RAG context token estimator must return a finite non-negative number.');
  }
  return Math.ceil(estimate);
}

function truncateWithoutSplittingSurrogate(value: string, maximumCodeUnits: number): string {
  let end = Math.min(value.length, Math.max(0, maximumCodeUnits));
  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end--;
  }
  return value.slice(0, end);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function assertEvidenceCanEnterContext(
  evidence: RagEvidence,
  scope?: RagRetrievalScope
): void {
  if (evidence.trustLevel === 'quarantined') {
    throw new Error('RAG context rejected quarantined evidence.');
  }
  if (!scope) return;
  if (evidence.tenantId !== scope.tenantId) {
    throw new Error('RAG evidence tenant scope mismatch.');
  }
  if (evidence.corpusId !== scope.corpusId) {
    throw new Error('RAG evidence corpus scope mismatch.');
  }
  if (!scope.allowedTrustLevels.includes(evidence.trustLevel)) {
    throw new Error('RAG evidence trust level is outside the retrieval scope.');
  }
}
