import type { RagEvidence } from './types';
import type { RagRetrievalScope } from '../../security/retrieval-scope';

export interface ContextComposerOptions {
  maxCharacters?: number;
  includeScores?: boolean;
  scope?: RagRetrievalScope;
}

export function composeEvidenceContext(
  evidence: RagEvidence[],
  options: ContextComposerOptions = {}
): string {
  const maxCharacters = options.maxCharacters ?? 12000;
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error('RAG context maxCharacters must be a positive integer.');
  }
  const includeScores = options.includeScores ?? true;
  let used = 0;
  const parts: string[] = [];

  for (let index = 0; index < evidence.length; index++) {
    const originalItem = evidence[index];
    assertEvidenceCanEnterContext(originalItem, options.scope);
    const item = {
      ...originalItem,
      score: originalItem.retrievalScore ?? originalItem.score,
    };
    const scoreText =
      includeScores && typeof item.score === 'number'
        ? ` (score: ${item.score.toFixed(4)})`
        : '';
    const sourceText = item.source ? ` (source: ${item.source})` : '';
    const block = `[${index + 1}]${scoreText}${sourceText}\n${item.content}`;
    const separatorLength = parts.length === 0 ? 0 : 2;
    const remaining = maxCharacters - used - separatorLength;
    if (remaining <= 0) {
      break;
    }

    const selectedBlock =
      block.length <= remaining
        ? block
        : truncateWithoutSplittingSurrogate(block, remaining);
    parts.push(selectedBlock);
    used += separatorLength + selectedBlock.length;
    if (selectedBlock.length < block.length) {
      break;
    }
  }

  return parts.join('\n\n');
}

function truncateWithoutSplittingSurrogate(
  value: string,
  maximumCodeUnits: number
): string {
  let end = Math.min(value.length, maximumCodeUnits);
  if (
    end > 0 &&
    end < value.length &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end -= 1;
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
